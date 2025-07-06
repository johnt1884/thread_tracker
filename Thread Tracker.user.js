// ==UserScript==
// @name         Thread Tracker
// @namespace    http://tampermonkey.net/
// @version      2.7
// @description  Tracks OTK threads on /b/, stores messages and media, shows top bar with colors and controls, removes inactive threads entirely
// @match        https://boards.4chan.org/b/
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Constants for storage keys
    const THREADS_KEY = 'otkActiveThreads';
    const MESSAGES_KEY = 'otkMessagesByThreadId';
    const COLORS_KEY = 'otkThreadColors';
    const DROPPED_THREADS_KEY = 'otkDroppedThreadIds';
    const BACKGROUND_UPDATES_DISABLED_KEY = 'otkBackgroundUpdatesDisabled';
    const DEBUG_MODE_KEY = 'otkDebugModeEnabled'; // For localStorage
    const LOCAL_IMAGE_COUNT_KEY = 'otkLocalImageCount';
    const LOCAL_VIDEO_COUNT_KEY = 'otkLocalVideoCount';
    const VIEWER_OPEN_KEY = 'otkViewerOpen'; // For viewer open/closed state

    // --- Global variables ---
    let otkViewer = null;
    let viewerActiveImageCount = null; // For viewer-specific unique image count
    let viewerActiveVideoCount = null; // For viewer-specific unique video count
    let backgroundRefreshIntervalId = null;
    let isManualRefreshInProgress = false;
    const BACKGROUND_REFRESH_INTERVAL = 30000; // 30 seconds
    let lastViewerScrollTop = 0; // To store scroll position

    // IndexedDB instance
    let otkMediaDB = null;

    // Debug mode (load from localStorage, default to true)
    let DEBUG_MODE = localStorage.getItem(DEBUG_MODE_KEY) === null ? true : localStorage.getItem(DEBUG_MODE_KEY) === 'true';

    const consoleLog = (...args) => {
        if (DEBUG_MODE) {
            console.log('[OTK Tracker]', ...args);
        }
    };
    const consoleWarn = (...args) => {
        if (DEBUG_MODE) {
            console.warn('[OTK Tracker]', ...args);
        }
    };
    const consoleError = (...args) => {
        // Errors should probably always be logged, or at least have a separate toggle
        console.error('[OTK Tracker]', ...args);
    };


    // --- Loading Screen Elements Setup ---
    function setupLoadingScreen() {
        try {
            if (document.getElementById('otk-loading-overlay')) {
                consoleLog("Loading screen elements already exist.");
                return;
            }

            const overlay = document.createElement('div');
        overlay.id = 'otk-loading-overlay';
        overlay.style.cssText = `
            position: fixed; 
            top: 86px; /* Height of otkGuiWrapper (85px) + border (1px) */
            left: 0; 
            width: 100%; 
            height: calc(100vh - 86px); /* Full viewport height minus GUI height */
            background-color: rgba(0,0,0,0.8); /* 80% opacity black */
            z-index: 100000; /* Ensure it's on top of everything, including viewer */
            display: none; /* Hidden by default */
            flex-direction: column; 
            align-items: center; 
            justify-content: center; 
            font-family: Verdana, sans-serif;
            color: white;
        `;

        const detailsElement = document.createElement('div');
        detailsElement.id = 'otk-loading-details';
        detailsElement.style.cssText = "margin-bottom: 20px; font-size: 16px;";
        overlay.appendChild(detailsElement);

        const progressBarContainer = document.createElement('div');
        progressBarContainer.id = 'otk-progress-bar-container';
        progressBarContainer.style.cssText = `
            width: 60%; 
            max-width: 400px; 
            background-color: #333; 
            border: 1px solid #555; 
            border-radius: 5px; 
            padding: 2px;
        `;
        overlay.appendChild(progressBarContainer);

        const progressBar = document.createElement('div');
        progressBar.id = 'otk-progress-bar';
        progressBar.style.cssText = `
            width: 0%; 
            height: 25px; 
            background-color: #4CAF50; 
            border-radius: 3px; 
            text-align: center; 
            line-height: 25px; 
            color: white; 
            font-weight: bold; 
            transition: width 0.3s ease;
        `;
        progressBarContainer.appendChild(progressBar);

        document.body.appendChild(overlay);
        consoleLog("Loading screen elements created and appended to body.");

        // Self-check diagnostics
        consoleLog('Attempting to verify loading screen elements immediately after creation:');
        consoleLog('  Overlay found by ID:', document.getElementById('otk-loading-overlay') !== null);
        consoleLog('  Details found by ID:', document.getElementById('otk-loading-details') !== null);
        consoleLog('  Progress bar container found by ID:', document.getElementById('otk-progress-bar-container') !== null);
        consoleLog('  Progress bar fill found by ID:', document.getElementById('otk-progress-bar') !== null);
        } catch (e) {
            consoleError('CRITICAL ERROR within setupLoadingScreen itself:', e);
        }
    }

    function showLoadingScreen(initialDetailsText = "Loading...") {
        const overlay = document.getElementById('otk-loading-overlay');
        const detailsElement = document.getElementById('otk-loading-details');
        const progressBarElement = document.getElementById('otk-progress-bar');

        if (!overlay || !detailsElement || !progressBarElement) {
            consoleError("Loading screen elements not found. Cannot show loading screen.");
            return;
        }

        detailsElement.textContent = initialDetailsText;
        progressBarElement.style.width = '0%';
        progressBarElement.textContent = '0%';
        overlay.style.display = 'flex'; // Use flex as per setupLoadingScreen styles
        consoleLog(`Loading screen shown. Details: ${initialDetailsText}`);
    }

    function hideLoadingScreen() {
        const overlay = document.getElementById('otk-loading-overlay');
        if (overlay) {
            overlay.style.display = 'none';
            consoleLog("Loading screen hidden.");
        } else {
            consoleWarn("Loading screen overlay not found when trying to hide.");
        }
    }

    function updateLoadingProgress(percentage, detailsText) {
        const detailsElement = document.getElementById('otk-loading-details');
        const progressBarElement = document.getElementById('otk-progress-bar');

        if (!progressBarElement || !detailsElement) {
            consoleError("Progress bar or details element not found. Cannot update loading progress.");
            return;
        }

        percentage = Math.max(0, Math.min(100, parseFloat(percentage))); // Clamp percentage & ensure number

        progressBarElement.style.width = percentage + '%';
        progressBarElement.textContent = Math.round(percentage) + '%';

        if (detailsText !== undefined && detailsText !== null) { // Allow empty string to clear details
            detailsElement.textContent = detailsText;
        }
        consoleLog(`Loading progress: ${Math.round(percentage)}%, Details: ${detailsText === undefined ? '(no change)' : detailsText }`);
    }


    // --- IndexedDB Initialization ---

    // --- Data Handling & Utility Functions ---
    function decodeAllHtmlEntities(html) {
        if (typeof html !== 'string' || html.length === 0) return '';
        let decoded = html;
        // Loop twice to handle cases like &amp;#039; -> &#039; -> '
        for (let i = 0; i < 2; i++) {
            const txt = document.createElement('textarea');
            txt.innerHTML = decoded;
            if (txt.value === decoded) { // If no change, decoding is complete for this pass
                break;
            }
            decoded = txt.value;
        }
        return decoded;
    }

    function getAllMessagesSorted() {
        let allMessages = [];
        for (const threadId in messagesByThreadId) {
            if (activeThreads.includes(Number(threadId)) && messagesByThreadId.hasOwnProperty(threadId)) {
                allMessages = allMessages.concat(messagesByThreadId[threadId]);
            }
        }
        allMessages.sort((a, b) => a.time - b.time); // Sort by timestamp ascending
        consoleLog(`Collected and sorted ${allMessages.length} messages from ${activeThreads.length} active threads.`);
        return allMessages;
    }

    async function recalculateAndStoreMediaStats() {
        if (!otkMediaDB) {
            consoleWarn("Cannot recalculate media stats: IndexedDB not available.");
            // Ensure localStorage is at least zeroed out if DB isn't there
            localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, '0');
            localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, '0');
            return { imageCount: 0, videoCount: 0 };
        }

        consoleLog("Recalculating local media statistics from IndexedDB...");
        return new Promise((resolve, reject) => {
            let imageCount = 0;
            let videoCount = 0;

            const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
            const store = transaction.objectStore('mediaStore');
            const request = store.openCursor();

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const item = cursor.value;
                    if (item && item.ext) {
                        const ext = item.ext.toLowerCase();
                        if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                            imageCount++;
                        } else if (['.webm', '.mp4'].includes(ext)) {
                            videoCount++;
                        }
                    }
                    cursor.continue();
                } else {
                    // Cursor finished
                    localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, imageCount.toString());
                    localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, videoCount.toString());
                    consoleLog(`Recalculated stats: ${imageCount} images, ${videoCount} videos. Stored to localStorage.`);
                    resolve({ imageCount, videoCount });
                }
            };

            request.onerror = (event) => {
                consoleError("Error recalculating media stats from IndexedDB:", event.target.error);
                // Don't clear localStorage here, might have valid old counts. Or do? For safety, let's clear.
                localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, '0');
                localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, '0');
                reject(event.target.error);
            };
        });
    }

    async function initDB() {
        return new Promise((resolve, reject) => {
            consoleLog('Initializing IndexedDB...');
            const request = indexedDB.open('otkMediaDB', 2); // DB name and version - Incremented to 2

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                consoleLog(`Upgrading IndexedDB from version ${event.oldVersion} to ${event.newVersion}.`);
                consoleLog('IndexedDB upgrade needed (onupgradeneeded event).'); // Keeping original log too for clarity
                if (!db.objectStoreNames.contains('mediaStore')) {
                    const store = db.createObjectStore('mediaStore', { keyPath: 'filehash' });
                    // Index for threadId to potentially clear media for a specific thread, though not the primary clear use case.
                    store.createIndex('threadId', 'threadId', { unique: false });
                    consoleLog('MediaStore object store created with filehash as keyPath and threadId index.');
                }
            };

            request.onsuccess = (event) => {
                otkMediaDB = event.target.result;
                consoleLog('IndexedDB initialized successfully.');
                resolve(otkMediaDB);
            };

            request.onerror = (event) => {
                consoleError('IndexedDB initialization error:', event.target.error);
                otkMediaDB = null; // Ensure it's null on error
                reject(event.target.error);
            };
        });
    }

    // Color palette for thread indicators
    const COLORS = [
        '#e6194B', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
        '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
        '#008080', '#e6beff', '#9A6324', '#fffac8', '#800000',
        '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080'
    ];

    // --- GUI Setup ---
    // Create GUI structure
    let otkGuiWrapper = document.getElementById('otk-tracker-gui-wrapper');
    let otkGui = document.getElementById('otk-tracker-gui');

    if (!otkGuiWrapper) {
        otkGuiWrapper = document.createElement('div');
        otkGuiWrapper.id = 'otk-tracker-gui-wrapper';
        otkGuiWrapper.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            z-index: 9999;
            border-bottom: 1px solid #FFD700; /* Pastille Gold */
            background: #181818; /* New background color */
            box-sizing: border-box;
        `;

        otkGui = document.createElement('div');
        otkGui.id = 'otk-tracker-gui';
        otkGui.style.cssText = `
            height: 85px;
            color: #e6e6e6; /* New font color */
            font-family: Verdana, sans-serif;
            font-size: 14px;
            padding: 5px 25px;
            box-sizing: border-box;
            display: flex;
            align-items: stretch;
            user-select: none;
        `;
        otkGuiWrapper.appendChild(otkGui);
        document.body.style.paddingTop = '86px';
        document.body.insertBefore(otkGuiWrapper, document.body.firstChild);

        // Thread display container (left)
        const threadDisplayContainer = document.createElement('div');
        threadDisplayContainer.id = 'otk-thread-display-container';
        threadDisplayContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            padding-top: 3px;
            padding-bottom: 5px;
            max-width: 300px;
            flex-grow: 0;
            flex-shrink: 0;
            justify-content: center;
        `;
        otkGui.appendChild(threadDisplayContainer);

        // Center info container
        const centerInfoContainer = document.createElement('div');
        centerInfoContainer.id = 'otk-center-info-container';
        centerInfoContainer.style.cssText = `
            flex-grow: 1; /* Ensures it takes available space */
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: space-between;
            color: white;
            text-align: center;
            padding: 0 10px;
        `;
        centerInfoContainer.style.flexGrow = '1'; 
        consoleLog('[GUI Setup - Initial] centerInfoContainer.style.flexGrow explicitly set to 1.');

        const otkThreadTitleDisplay = document.createElement('div');
        otkThreadTitleDisplay.id = 'otk-thread-title-display';
        otkThreadTitleDisplay.textContent = 'Thread Tracker 2.7'; // Updated version
        otkThreadTitleDisplay.style.cssText = `
            font-weight: bold;
            font-size: 14px;
            margin-bottom: 4px;
        `;

        const otkStatsDisplay = document.createElement('div');
        otkStatsDisplay.id = 'otk-stats-display';
        otkStatsDisplay.style.cssText = `
            font-size: 11px; 
            display: flex; 
            flex-direction: column; 
            align-items: center; /* This centers the span blocks */
            width: fit-content; /* Make block only as wide as its content */
            margin: 0 auto; /* Center the block itself if parent is wider */
        `;

        const threadsTrackedStat = document.createElement('span');
        threadsTrackedStat.id = 'otk-threads-tracked-stat';
        threadsTrackedStat.textContent = 'Live Threads: 0';
        threadsTrackedStat.style.textAlign = 'left';
        threadsTrackedStat.style.minWidth = '150px';

        const totalMessagesStat = document.createElement('span');
        totalMessagesStat.id = 'otk-total-messages-stat';
        totalMessagesStat.textContent = 'Total Messages: 0';
        totalMessagesStat.style.textAlign = 'left';
        totalMessagesStat.style.minWidth = '150px';

        const localImagesStat = document.createElement('span');
        localImagesStat.id = 'otk-local-images-stat';
        localImagesStat.textContent = 'Local Images: 0';
        localImagesStat.style.textAlign = 'left';
        localImagesStat.style.minWidth = '150px';

        const localVideosStat = document.createElement('span');
        localVideosStat.id = 'otk-local-videos-stat';
        localVideosStat.textContent = 'Local Videos: 0';
        localVideosStat.style.textAlign = 'left';
        localVideosStat.style.minWidth = '150px';

        otkStatsDisplay.appendChild(threadsTrackedStat);
        otkStatsDisplay.appendChild(totalMessagesStat);
        otkStatsDisplay.appendChild(localImagesStat);
        otkStatsDisplay.appendChild(localVideosStat);
        centerInfoContainer.appendChild(otkThreadTitleDisplay);
        centerInfoContainer.appendChild(otkStatsDisplay);
        otkGui.appendChild(centerInfoContainer);

        // Button container (right)
        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'otk-button-container';
        buttonContainer.style.cssText = `
            display: flex;
            flex-direction: column;     /* Stack children vertically */
            align-items: flex-end;      /* Align children (top/bottom rows) to the right */
            justify-content: space-between; /* Push top row to top, bottom row to bottom */
            gap: 5px;                   /* Small gap between top and bottom rows if needed */
            height: 100%;               /* Occupy full height of parent for space-between */
        `;
        otkGui.appendChild(buttonContainer);
    } else { // If GUI wrapper exists, ensure consistency
        if (document.body.style.paddingTop !== '86px') {
            document.body.style.paddingTop = '86px';
        }

        if (!otkGui) { // Re-create otkGui if missing
            otkGui = document.createElement('div');
            otkGui.id = 'otk-tracker-gui';
            // Apply styles as in initial creation
            otkGui.style.cssText = `
                height: 85px;
                color: white;
                font-family: Verdana, sans-serif;
                font-size: 14px;
                padding: 5px 25px;
                box-sizing: border-box;
                display: flex;
                align-items: stretch;
                user-select: none;
            `;
            otkGuiWrapper.appendChild(otkGui);
        }

        // Ensure sub-containers exist
        if (!document.getElementById('otk-thread-display-container')) {
            const threadDisplayContainer = document.createElement('div');
            threadDisplayContainer.id = 'otk-thread-display-container';
            // Apply styles
             threadDisplayContainer.style.cssText = `
                display: flex;
                flex-direction: column;
                justify-content: flex-start;
                padding-top: 3px;
                padding-bottom: 5px;
                max-width: 300px;
                flex-grow: 0;
                flex-shrink: 0;
                justify-content: center;
            `;
            const existingButtonContainer = otkGui.querySelector('#otk-button-container');
            if (existingButtonContainer) {
                otkGui.insertBefore(threadDisplayContainer, existingButtonContainer);
            } else {
                otkGui.appendChild(threadDisplayContainer);
            }
        }

        if (!document.getElementById('otk-center-info-container')) {
            const centerInfoContainer = document.createElement('div');
            centerInfoContainer.id = 'otk-center-info-container';
            // Apply styles
            centerInfoContainer.style.cssText = `
                flex-grow: 1; /* Ensures it takes available space */
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: space-between;
                color: white;
                text-align: center;
                padding: 0 10px;
            `;
            centerInfoContainer.style.flexGrow = '1';
            consoleLog('[GUI Setup - Reconstruction] centerInfoContainer.style.flexGrow explicitly set to 1.');

            const otkThreadTitleDisplay = document.createElement('div');
            otkThreadTitleDisplay.id = 'otk-thread-title-display';
            otkThreadTitleDisplay.textContent = 'Thread Tracker 2.7'; // Updated version
            otkThreadTitleDisplay.style.cssText = `font-weight: bold; font-size: 14px; margin-bottom: 4px;`;

            const otkStatsDisplay = document.createElement('div');
            otkStatsDisplay.id = 'otk-stats-display';
            otkStatsDisplay.style.cssText = `
                font-size: 11px; 
                display: flex; 
                flex-direction: column; 
                align-items: center; /* This centers the span blocks */
                width: fit-content; /* Make block only as wide as its content */
                margin: 0 auto; /* Center the block itself if parent is wider */
            `;

            const threadsTrackedStat = document.createElement('span');
            threadsTrackedStat.id = 'otk-threads-tracked-stat';
            threadsTrackedStat.textContent = 'Live Threads: 0';
            threadsTrackedStat.style.textAlign = 'left';
            threadsTrackedStat.style.minWidth = '150px';

            const totalMessagesStat = document.createElement('span');
            totalMessagesStat.id = 'otk-total-messages-stat';
            totalMessagesStat.textContent = 'Total Messages: 0';
            totalMessagesStat.style.textAlign = 'left';
            totalMessagesStat.style.minWidth = '150px';

            const localImagesStat = document.createElement('span');
            localImagesStat.id = 'otk-local-images-stat';
            localImagesStat.textContent = 'Local Images: 0'; // Added for consistency
            localImagesStat.style.textAlign = 'left';
            localImagesStat.style.minWidth = '150px';

            const localVideosStat = document.createElement('span');
            localVideosStat.id = 'otk-local-videos-stat';
            localVideosStat.textContent = 'Local Videos: 0'; // Added for consistency
            localVideosStat.style.textAlign = 'left';
            localVideosStat.style.minWidth = '150px';

            otkStatsDisplay.appendChild(threadsTrackedStat);
            otkStatsDisplay.appendChild(totalMessagesStat);
            otkStatsDisplay.appendChild(localImagesStat); // Added for consistency
            otkStatsDisplay.appendChild(localVideosStat); // Added for consistency
            centerInfoContainer.appendChild(otkThreadTitleDisplay);
            centerInfoContainer.appendChild(otkStatsDisplay);


            const existingButtonContainer = otkGui.querySelector('#otk-button-container');
            if (existingButtonContainer) {
                otkGui.insertBefore(centerInfoContainer, existingButtonContainer);
            } else {
                otkGui.appendChild(centerInfoContainer);
            }
        }

        if (!document.getElementById('otk-button-container')) {
            const buttonContainer = document.createElement('div');
            buttonContainer.id = 'otk-button-container';
            // Apply styles
            buttonContainer.style.cssText = `
                display: flex;
                align-items: flex-end; /* Consistent with initial creation */
                gap: 10px;
            `;
            buttonContainer.style.marginLeft = 'auto'; // Ensure right alignment
            consoleLog('[GUI Setup - Reconstruction] buttonContainer.style.marginLeft explicitly set to "auto".');
            otkGui.appendChild(buttonContainer);
        }
        // Update title if it exists and shows old version
        const titleDisplay = document.getElementById('otk-thread-title-display');
        if (titleDisplay && titleDisplay.textContent !== 'Thread Tracker 2.7') {
            titleDisplay.textContent = 'Thread Tracker 2.7';
        }
    }


    // --- Data Loading and Initialization ---
    let activeThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
    let messagesByThreadId = JSON.parse(localStorage.getItem(MESSAGES_KEY)) || {};
    let threadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};
    let droppedThreadIds = JSON.parse(localStorage.getItem(DROPPED_THREADS_KEY)) || [];

    // Normalize thread IDs and exclude known dropped threads
    droppedThreadIds = droppedThreadIds.map(id => Number(id)).filter(id => !isNaN(id));
    activeThreads = activeThreads
        .map(id => Number(id))
        .filter(id => !isNaN(id) && !droppedThreadIds.includes(id));

    for (const threadId in messagesByThreadId) {
        if (!activeThreads.includes(Number(threadId))) {
            consoleLog(`Removing thread ${threadId} from messagesByThreadId during initialization (not in activeThreads or in droppedThreadIds).`);
            delete messagesByThreadId[threadId];
            delete threadColors[threadId];
        }
    }
    // Clean up droppedThreadIds after processing
    localStorage.removeItem(DROPPED_THREADS_KEY); // This seems to be a one-time cleanup
    localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesByThreadId));
    localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
    consoleLog('Initialized activeThreads from localStorage:', activeThreads);


    // --- Utility functions ---
    function padNumber(num, length) {
        return String(num).padStart(length, '0');
    }

    function decodeEntities(encodedString) {
        const txt = document.createElement('textarea');
        txt.innerHTML = encodedString;
        return txt.value;
    }

    function truncateTitleWithWordBoundary(title, maxLength) {
        if (title.length <= maxLength) return title;
        let truncated = title.substr(0, maxLength);
        let lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > 0 && lastSpace > maxLength - 20) { // Ensure lastSpace is meaningful
            return truncated.substr(0, lastSpace) + '...';
        }
        return title.substr(0, maxLength - 3) + '...'; // Fallback if no good space
    }

    function getThreadColor(threadId) {
        if (!threadColors[threadId]) {
            const usedColors = new Set(Object.values(threadColors));
            const availableColors = COLORS.filter(c => !usedColors.has(c));
            threadColors[threadId] = availableColors.length ? availableColors[0] : '#888'; // Default color if all are used
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
        }
        return threadColors[threadId];
    }

    // --- Core Logic: Rendering, Fetching, Updating ---
    function renderThreadList() {
        const threadDisplayContainer = document.getElementById('otk-thread-display-container');
        if (!threadDisplayContainer) {
            consoleError('Thread display container not found.');
            return;
        }

        threadDisplayContainer.innerHTML = ''; // Clear previous list
        // consoleLog('renderThreadList: Cleared thread display container.'); // Redundant if list is empty

        if (activeThreads.length === 0) {
            consoleLog('renderThreadList: No active threads to display.');
            // Optionally display a message in the GUI like "No active OTK threads."
            // threadDisplayContainer.textContent = "No active OTK threads.";
            return;
        }

        // Prepare display objects, ensuring messages exist for titles/times
        const threadDisplayObjects = activeThreads.map(threadId => {
            const messages = messagesByThreadId[threadId] || [];
            let title = `Thread ${threadId}`; // Default title
            let firstMessageTime = null;
            let originalThreadUrl = `https://boards.4chan.org/b/thread/${threadId}`;


            if (messages.length > 0 && messages[0]) { 
                title = messages[0].title ? decodeEntities(messages[0].title) : `Thread ${threadId}`;
                firstMessageTime = messages[0].time;
            } else {
                consoleWarn(`Thread ${threadId} has no messages or messages[0] is undefined for title/time. Using default title.`);
            }


            return {
                id: threadId,
                title: title,
                firstMessageTime: firstMessageTime,
                color: getThreadColor(threadId),
                url: originalThreadUrl
            };
        }).filter(thread => thread.firstMessageTime !== null); // Only display threads with a valid time

        // Sort by most recent first message time
        threadDisplayObjects.sort((a, b) => b.firstMessageTime - a.firstMessageTime);
        consoleLog(`renderThreadList: Prepared ${threadDisplayObjects.length} threads for display:`, threadDisplayObjects.map(t => `${t.id} (${t.title.substring(0,20)}...)`));

        const threadsToDisplayInList = threadDisplayObjects.slice(0, 3);

        threadsToDisplayInList.forEach((thread, index) => {
            const threadItemDiv = document.createElement('div');
            let marginBottom = index < (threadsToDisplayInList.length -1) ? '0px' : '3px'; 
            threadItemDiv.style.cssText = `
                display: flex;
                align-items: flex-start; 
                padding: 4px;
                border-radius: 3px;
                margin-bottom: ${marginBottom};
            `;

            const colorBox = document.createElement('div');
            colorBox.style.cssText = `
                width: 12px;
                height: 12px;
                background-color: ${thread.color};
                border-radius: 2px;
                margin-right: 6px;
                flex-shrink: 0;
                margin-top: 1px; 
            `;
            threadItemDiv.appendChild(colorBox);

            const textContentDiv = document.createElement('div');
            textContentDiv.style.display = 'flex';
            textContentDiv.style.flexDirection = 'column';
            textContentDiv.style.maxWidth = 'calc(100% - 18px)'; // Prevent overflow from colorBox

            const titleLink = document.createElement('a');
            titleLink.href = thread.url;
            titleLink.target = '_blank'; 
            const fullTitle = thread.title; 
            titleLink.textContent = truncateTitleWithWordBoundary(fullTitle, 40); // Max length adjusted
            titleLink.title = fullTitle; 
            let titleLinkStyle = `
                color: #e0e0e0;
                text-decoration: none;
                font-weight: bold;
                font-size: 12px;
                margin-bottom: 2px; 
                display: block; 
                /* width: 100%; */ /* Removed to allow natural width up to container */
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            `;

            const time = new Date(thread.firstMessageTime * 1000);
            const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const formattedTimestamp = `[${timeStr}]`;
            const timestampSpan = document.createElement('span');
            timestampSpan.textContent = formattedTimestamp;
            let timestampSpanStyle = `
                font-size: 10px;
                color: #aaa;
                margin-left: 5px; 
            `;

            titleLink.style.cssText = titleLinkStyle;
            timestampSpan.style.cssText = timestampSpanStyle;

            titleLink.onmouseover = () => { titleLink.style.textDecoration = 'underline'; };
            titleLink.onmouseout = () => { titleLink.style.textDecoration = 'none'; };

            // Click to open messages in viewer
            titleLink.onclick = (event) => {
                event.preventDefault(); // Prevent default link navigation
                consoleLog(`Thread title clicked: ${thread.id} - ${thread.title}. Ensuring viewer is open and scrolling to message.`);

                if (otkViewer && otkViewer.style.display === 'none') {
                    // toggleViewer will call renderMessagesInViewer
                    toggleViewer(); 
                } else if (otkViewer) {
                    // If viewer is already open, ensure content is rendered (might be redundant if toggleViewer always renders)
                    // and then scroll. If renderMessagesInViewer is heavy, only call if needed.
                    // For now, let's assume it's okay to call renderMessagesInViewer again to ensure freshness,
                    // or that toggleViewer's render is sufficient if it was just opened.
                    // A more optimized way would be to check if content for this thread ID is visible.
                    if (otkViewer.style.display !== 'block') { // A failsafe if toggleViewer wasn't called
                        otkViewer.style.display = 'block';
                        document.body.style.overflow = 'hidden';
                         renderMessagesInViewer(); // Render if it wasn't made visible by toggleViewer
                    }
                }
                
                // Attempt to scroll to the message after a brief delay to allow rendering
                setTimeout(() => {
                    const messagesContainer = document.getElementById('otk-messages-container');
                    if (messagesContainer) {
                        // Find the OP message for this thread.
                        // We need a reliable way to identify an OP. Assuming OP's message ID is the thread ID.
                        const opMessageElement = messagesContainer.querySelector(`div[data-message-id="${thread.id}"]`);
                        // A more robust check might be needed if multiple messages could have data-message-id="${thread.id}"
                        // (e.g. if a post quotes the OP)
                        // For now, this assumes the first such element is the one we want, or it's unique enough.
                        
                        if (opMessageElement) {
                            consoleLog(`Scrolling to message element for thread OP ${thread.id}.`);
                            opMessageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            // Highlight briefly? (Optional future enhancement)
                            // opMessageElement.style.outline = '2px solid red';
                            // setTimeout(() => { opMessageElement.style.outline = ''; }, 2000);
                        } else {
                            consoleWarn(`Could not find message element for thread OP ${thread.id} to scroll to.`);
                            // If not found, scroll to top as a fallback, or do nothing.
                            // messagesContainer.scrollTop = 0; 
                        }
                    }
                }, 100); // Delay to allow render. May need adjustment.
            };

            const titleTimeContainer = document.createElement('div');
            titleTimeContainer.style.display = 'flex';
            titleTimeContainer.style.alignItems = 'baseline'; 
            titleTimeContainer.appendChild(titleLink);
            titleTimeContainer.appendChild(timestampSpan);

            textContentDiv.appendChild(titleTimeContainer);
            threadItemDiv.appendChild(textContentDiv);
            threadDisplayContainer.appendChild(threadItemDiv);
        });


        if (threadDisplayObjects.length > 3) {
            const numberOfAdditionalThreads = threadDisplayObjects.length - 3;
            const hoverContainer = document.createElement('div');
            hoverContainer.style.cssText = `
                display: inline-block; 
                position: relative; 
            `;
            const moreIndicator = document.createElement('div');
            moreIndicator.id = 'otk-more-threads-indicator';
            moreIndicator.textContent = `(+${numberOfAdditionalThreads})`;
            moreIndicator.style.cssText = `
                font-size: 12px;
                color: #ccc;
                font-style: italic;
                cursor: pointer;
                padding: 3px 6px; 
                margin-left: 8px; 
                display: inline; 
            `;
            hoverContainer.appendChild(moreIndicator);

            if (threadsToDisplayInList.length > 0) {
                const lastThreadItemDiv = threadDisplayContainer.lastChild; 
                const textContentDiv = lastThreadItemDiv?.children[1]; 
                const titleTimeContainer = textContentDiv?.firstChild; 
                const timestampSpan = titleTimeContainer?.querySelector('span'); 

                if (timestampSpan && timestampSpan.parentNode === titleTimeContainer) {
                    timestampSpan.parentNode.insertBefore(hoverContainer, timestampSpan.nextSibling);
                } else if (titleTimeContainer) {
                    titleTimeContainer.appendChild(hoverContainer);
                    consoleWarn('Timestamp span not found for (+n), appended to title-time container.');
                } else if (textContentDiv) {
                    textContentDiv.appendChild(hoverContainer);
                     consoleWarn('Title-time container not found for (+n), appended to text content div.');
                } else {
                    threadDisplayContainer.appendChild(hoverContainer);
                    consoleWarn('Last thread item structure not found for (+n), appended to thread display container.');
                }
            } else { 
                moreIndicator.style.marginLeft = '0px'; 
                moreIndicator.style.paddingLeft = '22px'; 
                threadDisplayContainer.appendChild(hoverContainer);
            }


            let tooltip = null;
            let tooltipTimeout;

            hoverContainer.addEventListener('mouseenter', () => {
                consoleLog('hoverContainer mouseenter: showing tooltip');
                moreIndicator.style.textDecoration = 'underline';
                if (tooltip) { 
                    consoleLog('Removing existing tooltip before creating new one');
                    tooltip.remove();
                }

                tooltip = document.createElement('div');
                tooltip.id = 'otk-more-threads-tooltip';
                tooltip.style.cssText = `
                    position: absolute;
                    background-color: #343434; /* New background */
                    border: 1px solid #555;    /* New border */
                    border-radius: 4px;
                    padding: 8px;
                    z-index: 100001; /* Higher than GUI bar */
                    color: #e6e6e6; /* New font color */
                    font-size: 12px;
                    max-width: 280px; /* Slightly narrower */
                    box-shadow: 0 3px 8px rgba(0,0,0,0.6);
                    pointer-events: auto; 
                    display: block;
                    opacity: 1;
                    /* border: 1px solid red; */ /* For debugging visibility */
                `;

                const additionalThreads = threadDisplayObjects.slice(3);
                additionalThreads.forEach(thread => {
                    const tooltipLink = document.createElement('a');
                    tooltipLink.href = thread.url;
                    tooltipLink.target = '_blank';
                    tooltipLink.textContent = truncateTitleWithWordBoundary(thread.title, 40); // Truncate here too
                    tooltipLink.title = thread.title; // Full title on hover
                    tooltipLink.style.cssText = `
                        display: block; 
                        color: #cccccc; /* Adjusted for new background */
                        text-decoration: none;
                        padding: 3px 0; /* More spacing */
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    `;
                    tooltipLink.onmouseover = () => { tooltipLink.style.color = '#e6e6e6'; tooltipLink.style.textDecoration = 'underline';}; 
                    tooltipLink.onmouseout = () => { tooltipLink.style.color = '#cccccc'; tooltipLink.style.textDecoration = 'none';};
                    tooltip.appendChild(tooltipLink);
                });

                document.body.appendChild(tooltip); 
                consoleLog('Tooltip appended to body');

                const indicatorRect = moreIndicator.getBoundingClientRect();
                const tooltipRect = tooltip.getBoundingClientRect(); 

                let leftPos = indicatorRect.left;
                let topPos = indicatorRect.bottom + window.scrollY + 3; // Slightly more offset

                if (leftPos + tooltipRect.width > window.innerWidth - 10) { // 10px buffer
                    leftPos = window.innerWidth - tooltipRect.width - 10; 
                }
                if (topPos + tooltipRect.height > window.innerHeight + window.scrollY - 10) {
                    consoleLog('Adjusting tooltip position to above indicator due to bottom overflow');
                    topPos = indicatorRect.top + window.scrollY - tooltipRect.height - 3; 
                }
                 if (leftPos < 10) leftPos = 10; // Prevent going off left edge


                tooltip.style.left = `${leftPos}px`;
                tooltip.style.top = `${topPos}px`;
                consoleLog('Tooltip final position:', {left: leftPos, top: topPos});

                tooltip.addEventListener('mouseenter', () => {
                    consoleLog('Tooltip mouseenter: clearing hide timeout');
                    if (tooltipTimeout) clearTimeout(tooltipTimeout);
                });

                tooltip.addEventListener('mouseleave', () => {
                     consoleLog('Tooltip mouseleave: setting hide timeout');
                    tooltipTimeout = setTimeout(() => {
                        if (tooltip && !tooltip.matches(':hover') && !moreIndicator.matches(':hover')) {
                            consoleLog('Hiding tooltip after timeout (left tooltip)');
                            tooltip.remove();
                            tooltip = null;
                        }
                    }, 300); 
                });
            });

            hoverContainer.addEventListener('mouseleave', () => {
                consoleLog('hoverContainer mouseleave: setting hide timeout');
                moreIndicator.style.textDecoration = 'none';
                tooltipTimeout = setTimeout(() => {
                    if (tooltip && !tooltip.matches(':hover') && !moreIndicator.matches(':hover')) {
                        consoleLog('Hiding tooltip after timeout (left hoverContainer)');
                        tooltip.remove();
                        tooltip = null;
                    }
                }, 300); 
            });
        }
    }

    // Helper function to format timestamp for message headers
    function formatTimestampForHeader(unixTime) {
        const date = new Date(unixTime * 1000);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return {
            time: `${hours}:${minutes}:${seconds}`,
            date: `${day}/${month}/${year}`
        };
    }

    async function renderMessagesInViewer(options = {}) { // Added options parameter
        if (!otkViewer) {
            consoleError("Viewer element not found, cannot render messages.");
            return;
        }
        // Determine loading text based on context if possible, or keep generic
        const loadingText = options.isToggleOpen ? "Restoring view..." : "Loading all messages...";
        showLoadingScreen(loadingText);

        // Initialize sets for unique media hashes in the current view
        const uniqueImageViewerHashes = new Set();
        const uniqueVideoViewerHashes = new Set();
        
        // Use a slight delay to ensure the loading screen renders before heavy processing
        await new Promise(resolve => setTimeout(resolve, 50)); 

        otkViewer.innerHTML = ''; // Clear previous content

        const allMessages = getAllMessagesSorted();
        if (!allMessages || allMessages.length === 0) {
            otkViewer.textContent = 'No messages found to display.'; // User-friendly message
            consoleWarn(`No messages to render in viewer.`);
            updateLoadingProgress(100, "No messages to display.");
            setTimeout(hideLoadingScreen, 500); 
            return;
        }

        consoleLog(`Rendering ${allMessages.length} messages in viewer.`);

        // No thread title header needed anymore for continuous view

        const messagesContainer = document.createElement('div');
        messagesContainer.id = 'otk-messages-container'; 
        messagesContainer.style.cssText = `
            width: 100%; /* Fill parent (otkViewer's content box) */
            height: 100%; /* Fill parent */
            overflow-y: auto;
            padding-right: 20px; /* Adjusted for symmetrical content padding (target 35px effective) */
            box-sizing: border-box; /* Ensure padding is included in width/height */
        `;
        // Note: maxHeight was 'calc(100% - 20px)' before. Now using height 100% of otkViewer's content area.
        // otkViewer has 10px top/bottom padding, so messagesContainer effectively has that spacing.

        const totalMessages = allMessages.length;
        let messagesProcessed = 0;
        const mediaLoadPromises = [];

        for (let i = 0; i < totalMessages; i++) {
            const message = allMessages[i];
            const messageDiv = document.createElement('div');
            // Add data attributes for easier targeting by jump-to-message
            messageDiv.setAttribute('data-message-id', message.id);
            // To find the OP of a thread, we'd also need the thread ID.
            // Assuming message.title contains the OP's title, and if it's unique enough, or if message.id matches threadId for OPs.
            // For now, just message.id. The OP of a thread usually has post.no === thread.no.
            // We can add `data-thread-id` if we pass the original threadId into the message object during fetch.
            // For now, let's assume message.originalThreadId (if we add it) or message.title can help identify an OP.
            // Let's assume `message.title` is the thread's subject, so if `message.text` starts with it, it's likely an OP.
            // This needs a more robust way to identify OPs if `message.id` isn't always the thread ID for OPs.
            // For now, the jump-to logic will need to be smart about this.

            messageDiv.style.cssText = `
                width: 100%; /* Fill the padded parent (messagesContainer) */
                margin: 15px 0; /* Vertical margin, no horizontal auto margin */
                padding: 10px; 
                background-color: #343434; /* New message body background */
                color: #e6e6e6; /* New message body font color */
                border-radius: 5px; 
                box-shadow: 0 1px 3px rgba(0,0,0,0.1); /* Keep shadow or adjust if needed */
                box-sizing: border-box; /* Ensure padding/border don't expand beyond 100% width */
            `;

            const messageHeader = document.createElement('div');
            messageHeader.style.cssText = `
                font-size: 12px; 
                color: #e6e6e6; /* New header text color */
                font-weight: bold; /* Make header bold */
                margin-bottom: 8px; 
                padding-bottom: 5px;
                border-bottom: 1px solid #555; /* New separator for header */
                display: flex;                 /* Use flexbox for layout */
                justify-content: space-between; /* Space out No. and Timestamp */
                align-items: center;           /* Vertically align items */
                width: 100%;                   /* Ensure header spans full width of padded parent */
            `;

            const timestampParts = formatTimestampForHeader(message.time);

            const leftSpan = document.createElement('span');
            const messageIdSpan = document.createElement('span');
            messageIdSpan.textContent = `#${message.id}`;
            const timeDisplaySpan = document.createElement('span');
            timeDisplaySpan.textContent = timestampParts.time;
            timeDisplaySpan.style.marginLeft = '8px'; // Add spacing

            leftSpan.appendChild(messageIdSpan);
            leftSpan.appendChild(timeDisplaySpan);

            const dateDisplaySpan = document.createElement('span');
            dateDisplaySpan.textContent = timestampParts.date;
            dateDisplaySpan.style.paddingRight = '5px'; // Add padding for better alignment

            messageHeader.appendChild(leftSpan);
            messageHeader.appendChild(dateDisplaySpan);
            messageDiv.appendChild(messageHeader);

            const textElement = document.createElement('div');
            textElement.style.whiteSpace = 'pre-wrap'; 
            textElement.textContent = message.text; // message.text is now pre-decoded
            messageDiv.appendChild(textElement);

            if (message.attachment && message.attachment.tim) {
                const attachmentDiv = document.createElement('div');
                attachmentDiv.style.marginTop = '10px';

                const filenameLink = document.createElement('a');
                filenameLink.textContent = `${message.attachment.filename} (${message.attachment.ext.substring(1)})`;
                // Finding the original board for the link:
                // This requires messages to store their original board or threadId,
                // and then look up that thread's OP for the board.
                // For now, assuming 'b' or using a placeholder if not easily available.
                // Let's assume `message.board` is populated in fetchThreadMessages from `opPost.board`.
                const boardForLink = message.board || 'b'; // Fallback
                filenameLink.href = `https://i.4cdn.org/${boardForLink}/${message.attachment.tim}${message.attachment.ext}`;
                filenameLink.target = "_blank";
                filenameLink.style.cssText = "color: #60a5fa; display: block; margin-bottom: 5px; text-decoration: underline;"; // Light blue for dark background
                attachmentDiv.appendChild(filenameLink);

                if (message.attachment.localStoreId && otkMediaDB) {
                    try {
                        const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
                        const store = transaction.objectStore('mediaStore');
                        const request = store.get(message.attachment.localStoreId);

                        const mediaPromise = new Promise((resolveMedia) => {
                            request.onsuccess = (event) => {
                                const storedItem = event.target.result;
                                if (storedItem && storedItem.blob) {
                                    const objectURL = URL.createObjectURL(storedItem.blob);
                                    let mediaElement;
                                    const extLower = message.attachment.ext.toLowerCase();
                                    if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLower)) {
                                        mediaElement = document.createElement('img');
                                        mediaElement.onload = () => URL.revokeObjectURL(objectURL); 
                                        mediaElement.onerror = () => URL.revokeObjectURL(objectURL);
                                        mediaElement.src = objectURL;
                            if (message.attachment.filehash_db_key) {
                                uniqueImageViewerHashes.add(message.attachment.filehash_db_key);
                                consoleLog(`[StatsDebug] Added image hash (from DB load): ${message.attachment.filehash_db_key}`);
                            }
                                    } else if (['.webm', '.mp4'].includes(extLower)) {
                                        mediaElement = document.createElement('video');
                                        mediaElement.onloadeddata = () => URL.revokeObjectURL(objectURL); 
                                        mediaElement.onerror = () => URL.revokeObjectURL(objectURL);
                                        mediaElement.src = objectURL;
                                        mediaElement.controls = true;
                            if (message.attachment.filehash_db_key) {
                                uniqueVideoViewerHashes.add(message.attachment.filehash_db_key);
                                consoleLog(`[StatsDebug] Added video hash (from DB load): ${message.attachment.filehash_db_key}`);
                            }
                                    }

                                    if (mediaElement) {
                                        mediaElement.style.maxWidth = '100%';
                                        mediaElement.style.maxHeight = '400px'; // Consistent max height
                                        mediaElement.style.borderRadius = '3px';
                                        mediaElement.style.display = 'block'; // Ensure it takes block space
                                        attachmentDiv.appendChild(mediaElement);
                                    }
                                    consoleLog(`Media for post ${message.id} (key: ${message.attachment.localStoreId}) loaded from IndexedDB.`);
                                } else {
                                    consoleWarn(`Blob not found in IndexedDB for filehash ${message.attachment.localStoreId} (post ${message.id}). Displaying thumbnail.`);
                                    attachmentDiv.appendChild(createThumbnailElement(message.attachment, boardForLink));
                        // Add to set even if only thumbnail is shown, if it's considered "media in viewer"
                        if (message.attachment.filehash_db_key) {
                            const extLowerThumb = message.attachment.ext.toLowerCase();
                            if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLowerThumb)) {
                                uniqueImageViewerHashes.add(message.attachment.filehash_db_key);
                                consoleLog(`[StatsDebug] Added image hash (DB blob not found): ${message.attachment.filehash_db_key}`);
                            } else if (['.webm', '.mp4'].includes(extLowerThumb)) {
                                uniqueVideoViewerHashes.add(message.attachment.filehash_db_key);
                                consoleLog(`[StatsDebug] Added video hash (DB blob not found): ${message.attachment.filehash_db_key}`);
                            }
                        }
                                }
                                resolveMedia();
                            };
                            request.onerror = (event) => {
                                consoleError(`Error fetching media ${message.attachment.localStoreId} from IndexedDB (post ${message.id}):`, event.target.error);
                                attachmentDiv.appendChild(createThumbnailElement(message.attachment, boardForLink));
                    // Add to set even if only thumbnail is shown
                     if (message.attachment.filehash_db_key) {
                        const extLowerThumbErr = message.attachment.ext.toLowerCase();
                        if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLowerThumbErr)) {
                            uniqueImageViewerHashes.add(message.attachment.filehash_db_key);
                            consoleLog(`[StatsDebug] Added image hash (DB error): ${message.attachment.filehash_db_key}`);
                        } else if (['.webm', '.mp4'].includes(extLowerThumbErr)) {
                            uniqueVideoViewerHashes.add(message.attachment.filehash_db_key);
                            consoleLog(`[StatsDebug] Added video hash (DB error): ${message.attachment.filehash_db_key}`);
                        }
                    }
                                resolveMedia(); 
                            };
                        });
                        mediaLoadPromises.push(mediaPromise);

                    } catch (e) {
                        consoleError(`Exception accessing IndexedDB for media (post ${message.id}):`, e);
                        attachmentDiv.appendChild(createThumbnailElement(message.attachment, boardForLink));
            // Add to set even if only thumbnail is shown
            if (message.attachment && message.attachment.filehash_db_key) {
                const extLowerCatch = message.attachment.ext.toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLowerCatch)) {
                    uniqueImageViewerHashes.add(message.attachment.filehash_db_key);
                    consoleLog(`[StatsDebug] Added image hash (DB exception): ${message.attachment.filehash_db_key}`);
                } else if (['.webm', '.mp4'].includes(extLowerCatch)) {
                    uniqueVideoViewerHashes.add(message.attachment.filehash_db_key);
                    consoleLog(`[StatsDebug] Added video hash (DB exception): ${message.attachment.filehash_db_key}`);
                }
            }
                    }
                } else {
        // This case is for when media is not in IndexedDB (e.g. only thumbnail is shown from 4cdn)
        if (message.attachment && message.attachment.tim && message.attachment.filehash_db_key) {
            consoleLog(`Media for post ${message.id} not in local store or DB unavailable. Displaying thumbnail. Adding to viewer stats.`);
                        attachmentDiv.appendChild(createThumbnailElement(message.attachment, boardForLink));
            const extLowerNoDb = message.attachment.ext.toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLowerNoDb)) {
                uniqueImageViewerHashes.add(message.attachment.filehash_db_key);
                consoleLog(`[StatsDebug] Added image hash (no DB, web thumb): ${message.attachment.filehash_db_key}`);
            } else if (['.webm', '.mp4'].includes(extLowerNoDb)) {
                uniqueVideoViewerHashes.add(message.attachment.filehash_db_key);
                consoleLog(`[StatsDebug] Added video hash (no DB, web thumb): ${message.attachment.filehash_db_key}`);
            }
                    }
                }
                if (attachmentDiv.hasChildNodes()) { 
                    messageDiv.appendChild(attachmentDiv);
                }
            }
            messagesContainer.appendChild(messageDiv);
            messagesProcessed++;
            let currentProgress = (messagesProcessed / totalMessages) * 90; 
            updateLoadingProgress(currentProgress, `Processing message ${messagesProcessed} of ${totalMessages}...`);
        }
        otkViewer.appendChild(messagesContainer);

// After processing all messages, update global viewer counts
consoleLog(`[StatsDebug] Unique image hashes for viewer: ${uniqueImageViewerHashes.size}`, uniqueImageViewerHashes);
consoleLog(`[StatsDebug] Unique video hashes for viewer: ${uniqueVideoViewerHashes.size}`, uniqueVideoViewerHashes);
// viewerActiveImageCount = uniqueImageViewerHashes.size; // MOVED TO AFTER PROMISES
// viewerActiveVideoCount = uniqueVideoViewerHashes.size; // MOVED TO AFTER PROMISES
// updateDisplayedStatistics(); // Refresh stats display -- MOVED TO AFTER PROMISES

        Promise.all(mediaLoadPromises).then(() => {
            consoleLog("All inline media load attempts complete.");
            updateLoadingProgress(95, "Finalizing view...");
    viewerActiveImageCount = uniqueImageViewerHashes.size; // MOVED HERE
    viewerActiveVideoCount = uniqueVideoViewerHashes.size; // MOVED HERE
    updateDisplayedStatistics(); // Update stats after all media processing is attempted.

            if (options.isToggleOpen && lastViewerScrollTop > 0) {
                messagesContainer.scrollTop = lastViewerScrollTop;
                consoleLog(`Restored scroll position to: ${lastViewerScrollTop}`);
                // Reset lastViewerScrollTop after use if we only want it for the immediate next open.
                // If we want it to persist across multiple toggles until a refresh, don't reset here.
                // For now, let's not reset, allowing multiple toggles to the same spot.
                // lastViewerScrollTop = 0; 
            } else {
                const scrollToBottom = () => {
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    consoleLog('Attempted to scroll messages to bottom. Position:', messagesContainer.scrollTop, 'Height:', messagesContainer.scrollHeight);
                };
                setTimeout(scrollToBottom, 100); // Initial scroll attempt
                setTimeout(scrollToBottom, 500); // Follow-up scroll attempt after more potential reflows
            }
            
            updateLoadingProgress(100, "View ready!"); // Update text for 100%
            setTimeout(hideLoadingScreen, 200); 
        }).catch(err => {
            consoleError("Error occurred during media loading promises:", err);
            updateLoadingProgress(100, "Error loading some media. View may be incomplete.");
            if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight; // Still try to scroll
            setTimeout(hideLoadingScreen, 500);
        });
    }

    function createThumbnailElement(attachment, board) {
        const thumbLink = document.createElement('a');
        thumbLink.href = `https://i.4cdn.org/${board}/${attachment.tim}${attachment.ext}`;
        thumbLink.target = '_blank';

        const thumbImg = document.createElement('img');
        thumbImg.src = `https://i.4cdn.org/${board}/${attachment.tim}s.jpg`; // Standard thumbnail URL format
        thumbImg.alt = attachment.filename;
        thumbImg.style.maxWidth = `${attachment.tn_w}px`;
        thumbImg.style.maxHeight = `${attachment.tn_h}px`;
        thumbImg.style.border = '1px solid #555';
        thumbImg.style.borderRadius = '3px';
        
        thumbLink.appendChild(thumbImg);
        return thumbLink;
    }

    async function scanCatalog() {
        const url = 'https://a.4cdn.org/b/catalog.json';
        try {
            const response = await fetch(url, { cache: 'no-store' }); // Avoid browser caching catalog
            if (!response.ok) throw new Error(`Catalog fetch failed: ${response.status} ${response.statusText}`);
            const catalog = await response.json();

            let foundThreads = [];
            catalog.forEach(page => {
                page.threads.forEach(thread => {
                    let title = thread.sub || '';
                    let com = thread.com || '';
                    if ((title + com).toLowerCase().includes('otk')) {
                        foundThreads.push({
                            id: Number(thread.no), 
                            title: title || `Thread ${thread.no}` // Ensure title exists
                        });
                    }
                });
            });
            consoleLog(`scanCatalog: Found ${foundThreads.length} OTK threads:`, foundThreads.map(t => t.id));
            return foundThreads;
        } catch (error) {
            consoleError('scanCatalog error:', error);
            return []; 
        }
    }

    async function fetchThreadMessages(threadId) {
        const url = `https://a.4cdn.org/b/thread/${threadId}.json`;
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) {
                consoleLog(`fetchThreadMessages: Thread ${threadId} not found (Status: ${response.status}). Likely pruned or deleted.`);
                return [];
            }
            const threadData = await response.json();
            if (!threadData.posts || threadData.posts.length === 0) {
                consoleLog(`fetchThreadMessages: No posts in thread ${threadId}.`);
                return [];
            }

            const opPost = threadData.posts[0];
            const posts = threadData.posts;
            const processedMessages = [];

            for (const post of posts) {
                const message = {
                    id: post.no,
                    time: post.time,
                    text: '', // Will be populated after decoding
                    title: opPost.sub ? decodeEntities(opPost.sub) : `Thread ${threadId}`, // Assuming decodeEntities here handles what it needs for title
                    attachment: null
                };

                if (post.com) {
                    let rawText = post.com.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
                    // Specific log for problematic strings if they occur
                    if (rawText.includes('&#039;') || rawText.includes('&amp;#039;')) {
                        consoleLog(`[Entity Debug] Original post.com for post ${post.no}:`, post.com);
                        consoleLog(`[Entity Debug] Text after tag strip for post ${post.no}:`, rawText);
                    }
                    message.text = decodeAllHtmlEntities(rawText);
                    if (rawText.includes('&#039;') || rawText.includes('&amp;#039;')) {
                        consoleLog(`[Entity Debug] Text after decodeAllHtmlEntities for post ${post.no}:`, message.text);
                    }
                } else {
                    message.text = '';
                }

                if (post.filename && post.tim && post.ext) {
                    let filehash_db_key;
                    const postMd5 = post.md5 ? post.md5.trim() : null;

                    if (postMd5 && postMd5.length > 0 && postMd5 !== "                                        ") { // Check for valid MD5
                        filehash_db_key = postMd5;
                    } else {
                        filehash_db_key = `${post.tim}${post.ext}`;
                        consoleWarn(`MD5 hash not available or invalid for post ${post.no}, file ${post.filename}. Falling back to tim+ext for DB key: ${filehash_db_key}`);
                    }
                    
                    message.attachment = {
                        filename: post.filename,
                        ext: post.ext,
                        tn_w: post.tn_w,
                        tn_h: post.tn_h,
                        tim: post.tim, // Keep original tim for reference / thumbnail URL
                        w: post.w,
                        h: post.h,
                        fsize: post.fsize,
                        md5: post.md5, // Original MD5 from API
                        filehash_db_key: filehash_db_key, // The key used for IndexedDB
                        localStoreId: null // Will be set to filehash_db_key if stored
                    };

                    // Check if media is already in IndexedDB
                    if (otkMediaDB) {
                        try {
                            const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
                            const store = transaction.objectStore('mediaStore');
                            const dbRequest = store.get(filehash_db_key);

                            const dbResult = await new Promise((resolve, reject) => {
                                dbRequest.onsuccess = () => resolve(dbRequest.result);
                                dbRequest.onerror = (dbEvent) => {
                                    consoleError(`IndexedDB 'get' error for key ${filehash_db_key} (post ${post.no}):`, dbEvent.target.error);
                                    reject(dbEvent.target.error);
                                };
                            });

                            if (dbResult) {
                                consoleLog(`Media with key ${filehash_db_key} (post ${post.no}) already in IndexedDB.`);
                                message.attachment.localStoreId = filehash_db_key;
                            } else {
                                // Not in DB, try to download and store
                                const mediaUrl = `https://i.4cdn.org/${opPost.board || 'b'}/${post.tim}${post.ext}`;
                                consoleLog(`Downloading media for post ${post.no} (DB key: ${filehash_db_key}) from ${mediaUrl}`);
                                const mediaResponse = await fetch(mediaUrl);
                                if (mediaResponse.ok) {
                                    const blob = await mediaResponse.blob();
                                    const storeTransaction = otkMediaDB.transaction(['mediaStore'], 'readwrite');
                                    const mediaStore = storeTransaction.objectStore('mediaStore');
                                    
                                    // Stored object's key property must match the store's keyPath ('filehash')
                                    const itemToStore = {
                                        filehash: filehash_db_key, // This is the keyPath value
                                        blob: blob,
                                        originalThreadId: threadId,
                                        filename: post.filename,
                                        ext: post.ext, // Store ext for easier type identification for stats
                                        timestamp: Date.now()
                                    };
                                    
                                    const putRequest = mediaStore.put(itemToStore);
                                    await new Promise((resolvePut, rejectPut) => {
                                        putRequest.onsuccess = () => {
                                            message.attachment.localStoreId = filehash_db_key; // localStoreId still refers to the value of the key
                                            consoleLog(`Stored media with key ${filehash_db_key} (post ${post.no}) in IndexedDB.`);
                                            
                                            // Update local media counts
                                            const ext = post.ext.toLowerCase();
                                            if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                                                let currentImageCount = parseInt(localStorage.getItem(LOCAL_IMAGE_COUNT_KEY) || '0');
                                                localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, (currentImageCount + 1).toString());
                                            } else if (['.webm', '.mp4'].includes(ext)) {
                                                let currentVideoCount = parseInt(localStorage.getItem(LOCAL_VIDEO_COUNT_KEY) || '0');
                                                localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, (currentVideoCount + 1).toString());
                                            }
                                            updateDisplayedStatistics(); // Refresh stats display

                                            resolvePut();
                                        };
                                        putRequest.onerror = (putEvent) => {
                                            consoleError(`IndexedDB 'put' error for key ${filehash_db_key} (post ${post.no}):`, putEvent.target.error);
                                            rejectPut(putEvent.target.error);
                                        };
                                    });
                                } else {
                                    consoleWarn(`Failed to download media for post ${post.no} (DB key: ${filehash_db_key}). Status: ${mediaResponse.status}`);
                                }
                            }
                        } catch (dbError) {
                            consoleError(`General IndexedDB error for post ${post.no} (DB key: ${filehash_db_key}):`, dbError);
                        }
                    } else {
                        consoleWarn('otkMediaDB not available for media operations (post ${post.no}).');
                    }
                }
                processedMessages.push(message);
            }
            return processedMessages;
        } catch (error) {
            consoleError(`fetchThreadMessages error for thread ${threadId}:`, error);
            return [];
        }
    }

    async function backgroundRefreshThreadsAndMessages() {
        if (isManualRefreshInProgress) {
            consoleLog('[BG] Manual refresh in progress, skipping background refresh.');
            return;
        }
        consoleLog('[BG] Performing background refresh...');
        try {
            consoleLog('[BG] Calling scanCatalog...');
            const foundThreads = await scanCatalog();
            const foundIds = new Set(foundThreads.map(t => Number(t.id)));
            consoleLog(`[BG] scanCatalog found ${foundThreads.length} threads:`, Array.from(foundIds));

            const previousActiveThreadIds = new Set(activeThreads.map(id => Number(id)));
            consoleLog('[BG] Previous active threads:', Array.from(previousActiveThreadIds));

            // Remove threads no longer in catalog
            activeThreads = activeThreads.filter(threadId => {
                const isLive = foundIds.has(Number(threadId));
                if (!isLive) {
                    consoleLog(`[BG] Removing thread ${threadId} (not in catalog).`);
                    delete messagesByThreadId[threadId]; 
                    delete threadColors[threadId];     
                }
                return isLive;
            });

            // Add new threads
            foundThreads.forEach(t => {
                const threadIdNum = Number(t.id);
                if (!previousActiveThreadIds.has(threadIdNum) && !activeThreads.includes(threadIdNum)) { // Check if it's truly new
                    consoleLog(`[BG] Adding new thread ${threadIdNum} from catalog scan.`);
                    activeThreads.push(threadIdNum);
                    // Messages will be fetched below, color assigned on render or first message.
                }
            });
            consoleLog(`[BG] Active threads after catalog sync: ${activeThreads.length}`, activeThreads);

            for (const threadId of [...activeThreads]) { 
                consoleLog(`[BG] Fetching messages for thread ${threadId}...`);
                let newMessages = await fetchThreadMessages(threadId); 
                consoleLog(`[BG] Fetched ${newMessages.length} messages for thread ${threadId}.`);

                if (newMessages.length > 0) {
                    let existing = messagesByThreadId[threadId] || [];
                    let existingIds = new Set(existing.map(m => m.id));
                    let updatedMessages = [...existing]; // Start with existing

                    newMessages.forEach(m => {
                        if (!existingIds.has(m.id)) {
                            updatedMessages.push(m);
                            // existingIds.add(m.id); // Not strictly needed here as we rebuild `merged`
                        } else {
                            // Optionally update existing message if needed, though 4chan posts are immutable mostly
                        }
                    });
                    updatedMessages.sort((a, b) => a.time - b.time); 
                    messagesByThreadId[threadId] = updatedMessages;
                     // Ensure OP's title is used for the thread if messagesByThreadId was empty
                    if (messagesByThreadId[threadId].length > 0 && (!messagesByThreadId[threadId][0].title || messagesByThreadId[threadId][0].title === `Thread ${threadId}`)) {
                         messagesByThreadId[threadId][0].title = newMessages[0].title;
                    }

                } else {
                    // Thread might have 404'd since catalog scan
                    if (activeThreads.includes(Number(threadId))) { // Check if it was really active
                        consoleLog(`[BG] No messages returned for active thread ${threadId}. It might have been pruned. Removing.`);
                        activeThreads = activeThreads.filter(id => id !== Number(threadId));
                        delete messagesByThreadId[threadId];
                        delete threadColors[threadId];
                    }
                }
            }

            consoleLog(`[BG] Final active threads after message fetch: ${activeThreads.length}`, activeThreads);
            consoleLog('[BG] Saving data to localStorage...');
            localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
            localStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesByThreadId));
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));

            consoleLog('[BG] Data saved. Dispatching otkMessagesUpdated event.');
            window.dispatchEvent(new CustomEvent('otkMessagesUpdated')); 
            renderThreadList();
            updateDisplayedStatistics();
            consoleLog('[BG] Background refresh complete.');

        } catch (error) {
            consoleError('[BG] Error during background refresh:', error.message, error.stack);
        }
    }

    async function refreshThreadsAndMessages() { // Manual Refresh
        consoleLog('[Manual] Refreshing threads and messages...');
        isManualRefreshInProgress = true;
        showLoadingScreen("Refreshing data from 4chan...");
        try {
            // Use a slight delay to ensure the loading screen renders
            await new Promise(resolve => setTimeout(resolve, 50));

            const foundThreads = await scanCatalog();
            const foundIds = new Set(foundThreads.map(t => Number(t.id)));
            consoleLog(`[Manual] scanCatalog found ${foundThreads.length} threads:`, Array.from(foundIds));
            updateLoadingProgress(20, `Found ${foundThreads.length} OTK threads. Syncing and fetching details...`);

            const previousActiveThreadIds = new Set(activeThreads.map(id => Number(id)));

            activeThreads = activeThreads.filter(threadId => {
                const isLive = foundIds.has(Number(threadId));
                if (!isLive) {
                    consoleLog(`[Manual] Removing thread ${threadId} (not in catalog).`);
                    delete messagesByThreadId[threadId];
                    delete threadColors[threadId];
                }
                return isLive;
            });

            foundThreads.forEach(t => {
                const threadIdNum = Number(t.id);
                if (!previousActiveThreadIds.has(threadIdNum) && !activeThreads.includes(threadIdNum)) {
                    consoleLog(`[Manual] Adding new thread ${threadIdNum}.`);
                    activeThreads.push(threadIdNum);
                    getThreadColor(threadIdNum); 
                }
            });
            consoleLog(`[Manual] Active threads after catalog sync: ${activeThreads.length}`, activeThreads);

            const totalThreadsToFetch = activeThreads.length;
            let threadsFetched = 0;

            for (const threadId of [...activeThreads]) {
                threadsFetched++;
                const baseProgress = 20; // After catalog scan
                const loopProgress = totalThreadsToFetch > 0 ? (threadsFetched / totalThreadsToFetch) * 70 : 70; // 70% of progress for fetching
                updateLoadingProgress(baseProgress + loopProgress, `Fetching thread ${threadsFetched} of ${totalThreadsToFetch} (${threadId})...`);
                
                consoleLog(`[Manual] Fetching messages for thread ${threadId}...`);
                let newMessages = await fetchThreadMessages(threadId); 
                consoleLog(`[Manual] Fetched ${newMessages.length} messages for thread ${threadId}.`);

                if (newMessages.length > 0) {
                    let existing = messagesByThreadId[threadId] || [];
                    let existingIds = new Set(existing.map(m => m.id));
                    let updatedMessages = [...existing];
                    newMessages.forEach(m => {
                        if (!existingIds.has(m.id)) {
                            updatedMessages.push(m);
                        }
                    });
                    updatedMessages.sort((a, b) => a.time - b.time);
                    messagesByThreadId[threadId] = updatedMessages;
                    if (messagesByThreadId[threadId].length > 0 && (!messagesByThreadId[threadId][0].title || messagesByThreadId[threadId][0].title === `Thread ${threadId}`)) {
                         messagesByThreadId[threadId][0].title = newMessages[0].title;
                    }
                } else {
                     if (activeThreads.includes(Number(threadId))) { 
                        consoleLog(`[Manual] No messages for active thread ${threadId}. Removing.`);
                        activeThreads = activeThreads.filter(id => id !== Number(threadId));
                        delete messagesByThreadId[threadId];
                        delete threadColors[threadId];
                    }
                }
            }

            consoleLog(`[Manual] Final active threads after message fetch: ${activeThreads.length}`, activeThreads);
            localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
            localStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesByThreadId));
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));

            consoleLog('[Manual] Core refresh actions complete.');
            updateLoadingProgress(95, "Finalizing data and updating display...");
            renderThreadList();
            window.dispatchEvent(new CustomEvent('otkMessagesUpdated'));
            updateDisplayedStatistics();

            if (otkViewer && otkViewer.style.display === 'block') {
                consoleLog('[Manual Refresh] Viewer is open, re-rendering content.');
                await renderMessagesInViewer({isToggleOpen: false}); // Pass flag to ensure scroll to bottom
            }

            updateLoadingProgress(100, "Refresh complete!");
            setTimeout(hideLoadingScreen, 500);

        } catch (error) {
            consoleError('[Manual] Error during core refresh:', error);
            updateLoadingProgress(100, "Error during refresh. Check console.");
            setTimeout(hideLoadingScreen, 1500); // Keep error message visible a bit longer
        } finally {
            isManualRefreshInProgress = false;
        }
    }

    async function clearAndRefresh() {
        consoleLog('[Clear] Clear and Refresh initiated...');
        isManualRefreshInProgress = true; 
        try {
            activeThreads = [];
            messagesByThreadId = {};
            threadColors = {};
            localStorage.removeItem(THREADS_KEY);
            localStorage.removeItem(MESSAGES_KEY);
            localStorage.removeItem(COLORS_KEY);
            localStorage.removeItem(DROPPED_THREADS_KEY);
            localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, '0'); // Reset image count
            localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, '0'); // Reset video count
            consoleLog('[Clear] LocalStorage (including media counts) cleared/reset.');

            if (otkMediaDB) {
                consoleLog('[Clear] Clearing IndexedDB mediaStore...');
                const transaction = otkMediaDB.transaction(['mediaStore'], 'readwrite');
                const store = transaction.objectStore('mediaStore');
                const request = store.clear();
                await new Promise((resolve, reject) => {
                    request.onsuccess = () => {
                        consoleLog('[Clear] IndexedDB mediaStore cleared successfully.');
                        resolve();
                    };
                    request.onerror = (event) => {
                        consoleError('[Clear] Error clearing IndexedDB mediaStore:', event.target.error);
                        reject(event.target.error);
                    };
                });
            } else {
                consoleWarn('[Clear] otkMediaDB not initialized, skipping IndexedDB clear.');
            }

            consoleLog('[Clear] Calling refreshThreadsAndMessages to repopulate...');
            await refreshThreadsAndMessages(); 

            consoleLog('[Clear] Dispatching otkClearViewerDisplay event.');
            window.dispatchEvent(new CustomEvent('otkClearViewerDisplay')); 
            consoleLog('[Clear] Clear and Refresh complete.');
        } catch (error) {
            consoleError('[Clear] Error during clear and refresh:', error);
        } finally {
            isManualRefreshInProgress = false; 
            consoleLog('[Clear] Manual refresh flag reset.');
            // Re-render and update stats after clearing everything and initial fetch
            renderThreadList();
            updateDisplayedStatistics();
        }
    }


    function ensureViewerExists() {
        if (!document.getElementById('otk-viewer')) {
            otkViewer = document.createElement('div');
            otkViewer.id = 'otk-viewer';
            document.body.appendChild(otkViewer);
            consoleLog('Viewer element created.');
        } else {
            otkViewer = document.getElementById('otk-viewer');
            consoleLog('Viewer element already exists.');
        }

        otkViewer.style.cssText = `
            position: fixed;
            top: 86px; 
            left: 0;
            width: 100vw;
            bottom: 0; 
            background-color: #181818; /* New background color */
            opacity: 1; /* Ensure full opacity */
            z-index: 9998; 
            /* overflow-y: auto; */ /* Removed: messagesContainer will handle scroll */
            box-sizing: border-box;
            color: #e6e6e6; /* New default text color for viewer */
            padding: 10px 5px 10px 25px; /* Mirror otk-gui horizontal padding, reduced right padding for scrollbar */
            border-top: 1px solid #FFD700; /* Match GUI divider */
            display: none;
            overflow-x: hidden; /* Prevent horizontal scrollbar on the viewer itself */
        `;
        consoleLog("Applied basic styling to otkViewer: background #181818, default text color #e6e6e6, padding 10px 25px, border-top #FFD700, overflow-x: hidden.");
    }

    function toggleViewer() {
        if (!otkViewer) {
            consoleWarn('Viewer element not found. Attempting to create.');
            ensureViewerExists(); 
            if (!otkViewer) { 
                consoleError('Viewer element could not be initialized.');
                return;
            }
        }

        const isViewerVisible = otkViewer.style.display !== 'none';
        if (isViewerVisible) {
            const messagesContainer = document.getElementById('otk-messages-container');
            if (messagesContainer) {
                lastViewerScrollTop = messagesContainer.scrollTop;
                consoleLog(`Viewer closed. Scroll position saved: ${lastViewerScrollTop}`);
            }
            otkViewer.style.display = 'none';
            document.body.style.overflow = 'auto'; 
            localStorage.setItem(VIEWER_OPEN_KEY, 'false');
            consoleLog('Viewer hidden state saved to localStorage.');
            // Reset viewer-specific counts and update stats to reflect totals
            viewerActiveImageCount = null;
            viewerActiveVideoCount = null;
            updateDisplayedStatistics();
        } else {
            otkViewer.style.display = 'block';
            document.body.style.overflow = 'hidden'; 
            localStorage.setItem(VIEWER_OPEN_KEY, 'true');
            consoleLog('Viewer shown. State saved to localStorage. Rendering all messages.');
            // renderMessagesInViewer will calculate and set viewerActive counts and then call updateDisplayedStatistics
            renderMessagesInViewer({isToggleOpen: true}); // Pass flag
        }
    }

    function updateDisplayedStatistics() {
        const threadsTrackedElem = document.getElementById('otk-threads-tracked-stat');
        const totalMessagesElem = document.getElementById('otk-total-messages-stat');
        const localImagesElem = document.getElementById('otk-local-images-stat');
        const localVideosElem = document.getElementById('otk-local-videos-stat');

        if (threadsTrackedElem && totalMessagesElem && localImagesElem && localVideosElem) {
            const liveThreadsCount = activeThreads.length;
            let totalMessagesCount = 0;
            for (const threadId in messagesByThreadId) {
                if (messagesByThreadId.hasOwnProperty(threadId) && activeThreads.includes(Number(threadId))) {
                    totalMessagesCount += messagesByThreadId[threadId].length;
                }
            }
            const paddingLength = 4;
            threadsTrackedElem.textContent = `- ${padNumber(liveThreadsCount, paddingLength)} Live Thread${liveThreadsCount === 1 ? '' : 's'}`;
            totalMessagesElem.textContent = `- ${padNumber(totalMessagesCount, paddingLength)} Total Message${totalMessagesCount === 1 ? '' : 's'}`;

            const imageCountFromStorage = parseInt(localStorage.getItem(LOCAL_IMAGE_COUNT_KEY) || '0');
            const videoCountFromStorage = parseInt(localStorage.getItem(LOCAL_VIDEO_COUNT_KEY) || '0');

            consoleLog(`[StatsDebug] updateDisplayedStatistics: viewerActiveImageCount = ${viewerActiveImageCount}, viewerActiveVideoCount = ${viewerActiveVideoCount}`);
            consoleLog(`[StatsDebug] updateDisplayedStatistics: imageCountFromStorage = ${imageCountFromStorage}, videoCountFromStorage = ${videoCountFromStorage}`);

            const imageCountToDisplay = viewerActiveImageCount !== null ? viewerActiveImageCount : imageCountFromStorage;
            const videoCountToDisplay = viewerActiveVideoCount !== null ? viewerActiveVideoCount : videoCountFromStorage;

            consoleLog(`[StatsDebug] updateDisplayedStatistics: imageCountToDisplay = ${imageCountToDisplay}, videoCountToDisplay = ${videoCountToDisplay}`);

            localImagesElem.textContent = `- ${padNumber(imageCountToDisplay, paddingLength)} Image${imageCountToDisplay === 1 ? '' : 's'}`;
            localVideosElem.textContent = `- ${padNumber(videoCountToDisplay, paddingLength)} Video${videoCountToDisplay === 1 ? '' : 's'}`;

            // consoleLog(`Statistics updated: Live Threads: ${liveThreadsCount}, Total Messages: ${totalMessagesCount}, Images: ${imageCountToDisplay}, Videos: ${videoCountToDisplay}`);
        } else {
            consoleWarn('One or more statistics elements not found in GUI. Threads, Messages, Images, or Videos.');
        }
    }

    // --- Button Implementations & Event Listeners ---
    const buttonContainer = document.getElementById('otk-button-container');
    if (buttonContainer) {
        function createTrackerButton(text, id = null) {
            const button = document.createElement('button');
            if (id) button.id = id;
            button.textContent = text;
            button.style.cssText = `
                padding: 5px 10px;
                cursor: pointer;
                background-color: #555;
                color: white;
                border: 1px solid #777;
                border-radius: 3px;
                font-size: 13px;
                white-space: nowrap; /* Prevent button text wrapping */
            `;
            button.onmouseover = () => button.style.backgroundColor = '#666';
            button.onmouseout = () => button.style.backgroundColor = '#555';
            button.onmousedown = () => button.style.backgroundColor = '#444'; 
            button.onmouseup = () => button.style.backgroundColor = '#666'; 
            return button;
        }

        const btnToggleViewer = createTrackerButton('Toggle Viewer', 'otk-toggle-viewer-btn');
        btnToggleViewer.addEventListener('click', toggleViewer);
        // Appended to bottomRowContainer later

        const btnRefresh = createTrackerButton('Refresh Data', 'otk-refresh-data-btn');
        btnRefresh.addEventListener('click', async () => {
            consoleLog('[GUI] "Refresh Data" button clicked.');
            // sessionStorage.setItem('otkManualRefreshClicked', 'true'); // Not currently used elsewhere
            btnRefresh.disabled = true; 
            // isManualRefreshInProgress is set within refreshThreadsAndMessages
            try {
                await refreshThreadsAndMessages();
                consoleLog('[GUI] Data refresh complete.');
            } catch (error) {
                consoleError('[GUI] Error during data refresh:', error);
            } finally {
                // isManualRefreshInProgress is reset within refreshThreadsAndMessages
                btnRefresh.disabled = false; 
                consoleLog('[GUI] Refresh operation finished.');
            }
        });
        // Appended to bottomRowContainer later

        // Create topRowContainer for the checkbox
        const topRowContainer = document.createElement('div');
        // No specific styles for topRowContainer itself yet, alignment is handled by otk-button-container

        // Create bottomRowContainer for the buttons
        const bottomRowContainer = document.createElement('div');
        bottomRowContainer.style.cssText = `
            display: flex;
            flex-direction: row;
            gap: 10px;
            align-items: center;
        `;

        const controlsWrapper = document.createElement('div');
        controlsWrapper.style.cssText = `
            display: flex;
            flex-direction: column;
            justify-content: space-around; 
            align-items: flex-start; 
            gap: 4px; /* Increased gap */
            height: auto; /* Allow it to size based on content */
        `;

        // Debug mode checkbox and label are removed from here.
        // DEBUG_MODE is now only toggled via localStorage or by editing the script.

        const bgUpdateCheckboxContainer = document.createElement('div');
        bgUpdateCheckboxContainer.style.cssText = `display: flex; align-items: center;`;
        const bgUpdateCheckbox = document.createElement('input');
        bgUpdateCheckbox.type = 'checkbox';
        bgUpdateCheckbox.id = 'otk-disable-bg-update-checkbox';
        bgUpdateCheckbox.checked = localStorage.getItem(BACKGROUND_UPDATES_DISABLED_KEY) === 'true';
        bgUpdateCheckbox.style.marginRight = '5px';

        const bgUpdateLabel = document.createElement('label');
        bgUpdateLabel.htmlFor = 'otk-disable-bg-update-checkbox';
        bgUpdateLabel.textContent = 'Disable Background Updates'; // Restored full text
        bgUpdateLabel.style.cssText = `font-size: 11px; color: #e6e6e6; white-space: normal; cursor: pointer; line-height: 1.2;`; // New font color

        bgUpdateCheckboxContainer.appendChild(bgUpdateCheckbox);
        bgUpdateCheckboxContainer.appendChild(bgUpdateLabel);
        controlsWrapper.appendChild(bgUpdateCheckboxContainer); 

        const btnClearRefresh = createTrackerButton('Restart Tracker', 'otk-restart-tracker-btn');
        btnClearRefresh.style.alignSelf = 'center'; // Override parent's align-items:stretch to allow natural width & centering
        btnClearRefresh.style.marginTop = '4px'; // Retain margin for spacing from checkbox if column is short

        const thirdButtonColumn = document.createElement('div');
        thirdButtonColumn.style.cssText = `
            display: flex;          /* It's a flex container for controlsWrapper */
            flex-direction: column; /* Stack its children (controlsWrapper) */
            justify-content: center;/* Center controlsWrapper vertically */
            align-items: center;    /* Center controlsWrapper horizontally */
            /* height: 100%; Removed, let it size by content */
            /* min-width: 130px; Removed, let it size by content */
        `;
        // controlsWrapper has align-self: center and width: fit-content, which is good.
        // Ensure controlsWrapper takes appropriate width for its content (checkbox + label)
        // and centers itself within the stretched column.
        controlsWrapper.style.width = 'fit-content'; 
        controlsWrapper.style.alignSelf = 'center'; 

        thirdButtonColumn.appendChild(controlsWrapper);
        // btnClearRefresh is handled below
        // buttonContainer.appendChild(thirdButtonColumn); // This is now part of topRowContainer

        // Append elements to their respective row containers
        topRowContainer.appendChild(thirdButtonColumn);

        bottomRowContainer.appendChild(btnToggleViewer);
        bottomRowContainer.appendChild(btnRefresh);
        bottomRowContainer.appendChild(btnClearRefresh);

        // Append row containers to the main buttonContainer
        buttonContainer.appendChild(topRowContainer);
        buttonContainer.appendChild(bottomRowContainer);

        btnClearRefresh.addEventListener('click', async () => {
            consoleLog('[GUI] "Restart Thread Tracker" button clicked.');
            if (!confirm("Are you sure you want to restart the tracker? This will clear all tracked threads, messages, and downloaded media.")) {
                consoleLog('[GUI] Restart cancelled by user.');
                return;
            }
            btnClearRefresh.disabled = true;
            // isManualRefreshInProgress will be handled by clearAndRefresh
            try {
                await clearAndRefresh(); 
                consoleLog('[GUI] Clear and refresh sequence complete.');
            } catch (error) {
                consoleError('[GUI] Error during clear and refresh sequence:', error);
            } finally {
                btnClearRefresh.disabled = false;
                consoleLog('[GUI] Restart operation finished.');
            }
        });

        if (bgUpdateCheckbox.checked) {
            consoleLog('Background updates are initially disabled by user preference.');
        } else {
            // startBackgroundRefresh(); // Will be called in main() after DB init
        }

        bgUpdateCheckbox.addEventListener('change', () => {
            if (bgUpdateCheckbox.checked) {
                stopBackgroundRefresh();
                localStorage.setItem(BACKGROUND_UPDATES_DISABLED_KEY, 'true');
                consoleLog('Background updates disabled via checkbox.');
            } else {
                startBackgroundRefresh(); // Attempt to start immediately
                localStorage.setItem(BACKGROUND_UPDATES_DISABLED_KEY, 'false');
                consoleLog('Background updates enabled via checkbox.');
            }
        });

    } else {
        consoleError('Button container not found. GUI buttons cannot be added.');
    }

    // --- Background Refresh Control ---
    function startBackgroundRefresh() {
        if (localStorage.getItem(BACKGROUND_UPDATES_DISABLED_KEY) === 'true') {
            consoleLog('Background updates are disabled. Not starting refresh interval.');
            return;
        }
        if (backgroundRefreshIntervalId === null) { // Only start if not already running
            backgroundRefreshIntervalId = setInterval(backgroundRefreshThreadsAndMessages, BACKGROUND_REFRESH_INTERVAL);
            consoleLog(`Background refresh scheduled every ${BACKGROUND_REFRESH_INTERVAL / 1000} seconds.`);
        } else {
            consoleLog('Background refresh interval already active.');
        }
    }

    function stopBackgroundRefresh() {
        if (backgroundRefreshIntervalId) {
            clearInterval(backgroundRefreshIntervalId);
            backgroundRefreshIntervalId = null;
            consoleLog('Background refresh stopped.');
        } else {
            consoleLog('Background refresh was not running.');
        }
    }

    // --- Initial Actions / Main Execution ---
    async function main() {
        consoleLog("Starting OTK Thread Tracker script (v2.7)...");
        consoleLog('Attempting to call setupLoadingScreen...');
        setupLoadingScreen(); // Create loading screen elements early
        consoleLog('Call to setupLoadingScreen finished.');
        ensureViewerExists(); // Ensure viewer div is in DOM early

        try {
            await initDB(); 
            consoleLog("IndexedDB initialization attempt complete.");

            // Recalculate and display initial media stats
            await recalculateAndStoreMediaStats(); // This updates localStorage
            updateDisplayedStatistics(); // This reads from localStorage and updates GUI

            // Restore viewer state
            if (localStorage.getItem(VIEWER_OPEN_KEY) === 'true' && otkViewer) {
                consoleLog('Viewer state restored to open. Rendering all messages.');
                otkViewer.style.display = 'block';
                document.body.style.overflow = 'hidden';
                renderMessagesInViewer(); // Auto-populate with all messages
            }


            // Load initial data and render list (stats are already updated)
            renderThreadList();
            // updateDisplayedStatistics(); // Already called after recalculate

            // Start background refresh if not disabled
            if (localStorage.getItem(BACKGROUND_UPDATES_DISABLED_KEY) !== 'true') {
                consoleLog("Background updates enabled. Starting refresh interval. First refresh will occur after the interval has passed once.");
                startBackgroundRefresh(); // Start the interval; it will perform the first refresh.
            } else {
                consoleLog("Background updates are disabled by user preference. No background interval started.");
            }

            consoleLog("OTK Thread Tracker script initialized and running.");

        } catch (error) {
            consoleError("Critical error during main initialization sequence:", error);
            const errorDisplay = document.getElementById('otk-thread-title-display');
            if (errorDisplay) {
                errorDisplay.textContent = "Tracker Error! Check Console.";
                errorDisplay.style.color = "red";
            }
        }
    }

    // Kick off the script using the main async function
    main().finally(() => {
        // Final verification log after main execution sequence
        const centerInfo = document.getElementById('otk-center-info-container');
        if (centerInfo) {
            consoleLog('[Final Check] Computed flex-grow for centerInfoContainer:', window.getComputedStyle(centerInfo).flexGrow);
        } else {
            consoleWarn('[Final Check] centerInfoContainer not found for flex-grow check.');
        }
    });

})();
