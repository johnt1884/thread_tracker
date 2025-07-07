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
    const ANCHORED_MESSAGE_ID_KEY = 'otkAnchoredMessageId'; // For storing anchored message ID
    const ANCHORED_MESSAGE_CLASS = 'otk-anchored-message'; // CSS class for highlighting anchored message
    const MAX_QUOTE_DEPTH = 2; // Maximum depth for rendering nested quotes

    // --- Global variables ---
    let otkViewer = null;
    let viewerActiveImageCount = null; // For viewer-specific unique image count
    let viewerActiveVideoCount = null; // For viewer-specific unique video count
    let backgroundRefreshIntervalId = null;
    let isManualRefreshInProgress = false;
    const BACKGROUND_REFRESH_INTERVAL = 30000; // 30 seconds
    let lastViewerScrollTop = 0; // To store scroll position
    let renderedMessageIdsInViewer = new Set(); // To track IDs in viewer for incremental updates
    let uniqueImageViewerHashes = new Set(); // Global set for viewer's unique image hashes
    let uniqueVideoViewerHashes = new Set(); // Global set for viewer's unique video hashes
    let renderedFullSizeImageHashes = new Set(); // Tracks image hashes already rendered full-size in current viewer session

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
            // Now includes messages from all threads for which we have data, not just active ones
            if (messagesByThreadId.hasOwnProperty(threadId)) {
                allMessages = allMessages.concat(messagesByThreadId[threadId]);
            }
        }
        allMessages.sort((a, b) => a.time - b.time); // Sort by timestamp ascending
        consoleLog(`Collected and sorted ${allMessages.length} messages from all locally stored threads.`);
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
            border-bottom: 1px solid #181818; /* Original color, to match original background */
            background: #181818; /* Original background color */
            box-sizing: border-box;
        `;

        otkGui = document.createElement('div');
        otkGui.id = 'otk-tracker-gui';
        otkGui.style.cssText = `
            height: 85px;
            color: #e6e6e6; /* Original font color */
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
    function blobToDataURL(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

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

        // Global sets uniqueImageViewerHashes and uniqueVideoViewerHashes are used directly.
        // No local const declarations needed here.

        // Use a slight delay to ensure the loading screen renders before heavy processing
        await new Promise(resolve => setTimeout(resolve, 50));

        // Clear state for full rebuild (using global sets)
        renderedMessageIdsInViewer.clear();
        uniqueImageViewerHashes.clear(); // Now clearing the global set
        uniqueVideoViewerHashes.clear(); // Now clearing the global set
        renderedFullSizeImageHashes.clear(); // Clear for new viewer session
        consoleLog("[renderMessagesInViewer] Cleared renderedMessageIdsInViewer, global unique media hashes, and renderedFullSizeImageHashes for full rebuild.");

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
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            overflow-y: auto; /* This container scrolls */
            padding: 10px 25px; /* 10px top/bottom, 25px left/right for content and scrollbar */
            box-sizing: border-box;
            /* width and height are now controlled by absolute positioning */
        `;
        // Note: otk-messages-container now fills otk-viewer and handles all padding and scrolling.
        // otkViewer has 10px top/bottom padding, so messagesContainer effectively has that spacing.

        const totalMessages = allMessages.length;
        let messagesProcessed = 0;
        const mediaLoadPromises = [];

        for (let i = 0; i < totalMessages; i++) {
            const message = allMessages[i];
            renderedMessageIdsInViewer.add(message.id); // Track that this ID is being rendered

            // Determine boardForLink for this message
            const boardForLink = message.board || 'b'; // Fallback, ensure message object has 'board' if possible
            const threadColor = getThreadColor(message.originalThreadId); // Get thread color for accent

            // Use the helper function to create the message element
            // For messages directly in the viewer, isTopLevelMessage is true, currentDepth is 0
            const messageElement = createMessageElementDOM(message, mediaLoadPromises, uniqueImageViewerHashes, uniqueVideoViewerHashes, boardForLink, true, 0, threadColor);
            messagesContainer.appendChild(messageElement);

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

            let anchorScrolled = false;
            const anchoredMessageId = localStorage.getItem(ANCHORED_MESSAGE_ID_KEY);
            if (anchoredMessageId) {
                const anchoredElement = messagesContainer.querySelector(`div[data-message-id="${anchoredMessageId}"]`);
                if (anchoredElement) {
                    try {
                        anchoredElement.scrollIntoView({ behavior: 'auto', block: 'center' });
                        anchorScrolled = true;
                        consoleLog(`Scrolled to anchored message: ${anchoredMessageId}`);
                    } catch (e) {
                        consoleError("Error scrolling to anchored message:", e);
                    }
                } else {
                    consoleWarn(`Anchored message ID ${anchoredMessageId} not found in DOM to scroll to.`);
                    // Optionally remove invalid anchor from localStorage if element not found after full render
                    // localStorage.removeItem(ANCHORED_MESSAGE_ID_KEY);
                }
            }

            if (!anchorScrolled) {
                if (options.isToggleOpen && lastViewerScrollTop > 0) {
                    messagesContainer.scrollTop = lastViewerScrollTop;
                    consoleLog(`Restored scroll position to: ${lastViewerScrollTop}`);
                } else {
                    const scrollToBottom = () => {
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;
                        consoleLog('Attempted to scroll messages to bottom. Position:', messagesContainer.scrollTop, 'Height:', messagesContainer.scrollHeight);
                    };
                    setTimeout(scrollToBottom, 100);
                    setTimeout(scrollToBottom, 500);
                }
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

    // Signature includes isTopLevelMessage, currentDepth, and threadColor
    function createMessageElementDOM(message, mediaLoadPromises, uniqueImageViewerHashes, uniqueVideoViewerHashes, boardForLink, isTopLevelMessage, currentDepth, threadColor) {
        consoleLog(`[DepthCheck] Rendering message: ${message.id}, currentDepth: ${currentDepth}, MAX_QUOTE_DEPTH: ${MAX_QUOTE_DEPTH}, isTopLevel: ${isTopLevelMessage}`);
        const messageDiv = document.createElement('div');
        messageDiv.setAttribute('data-message-id', message.id);

        let backgroundColor;
        let borderLeftStyle = 'none';
        let marginLeft = '0';
        let paddingLeft = '10px'; // Default to 10px, adjusted below
        let marginTop = '15px'; // Default top margin
        let marginBottom = '15px'; // Default bottom margin
        const messageTextColor = '#e6e6e6'; // Original light text color

        if (isTopLevelMessage) { // Depth 0
            backgroundColor = '#343434'; // Original top-level background
            borderLeftStyle = threadColor ? `4px solid ${threadColor}` : '4px solid red'; // Use threadColor, fallback to red
            // marginLeft, marginTop, marginBottom remain defaults for top-level
        } else { // Quoted message (Depth 1+)
            marginLeft = '0px'; // No specific indent margin for quote itself
            marginTop = '10px';    // Specific top margin for quoted messages
            marginBottom = '0px';  // Specific bottom margin for quoted messages
            if (currentDepth === 1) {
                backgroundColor = '#525252'; // Original first quote background
            } else { // Covers currentDepth === 2 and potential deeper fallbacks
                backgroundColor = '#484848'; // Original second quote (and deeper) background
            }
        }

messageDiv.style.cssText = `
    box-sizing: border-box;
    display: block;
    background-color: ${backgroundColor};
    color: ${messageTextColor}; /* Reverted text color */

    margin-top: ${marginTop};
    margin-bottom: ${marginBottom};
    margin-left: ${marginLeft};
    padding-top: 10px;
    padding-bottom: 10px;
    padding-left: ${paddingLeft};
    padding-right: 10px; /* Standardized to 10px */

    border-left: ${borderLeftStyle};
    border-radius: 5px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);

    width: calc(100% - ${marginLeft});
    max-width: calc(100% - ${marginLeft});
    overflow-x: hidden;
`;



        const messageHeader = document.createElement('div');

        let headerBorderColor = '#555'; // Original default border
        if (currentDepth === 1) {
            headerBorderColor = '#343434'; // Original border for depth 1
        }

        messageHeader.style.cssText = `
            font-size: 12px;
            color: ${messageTextColor}; /* Reverted text color (now #e6e6e6) */
            font-weight: bold;
            margin-bottom: 8px;
            padding-bottom: 5px;
            border-bottom: 1px solid ${headerBorderColor};
            display: flex;
            align-items: center;
            width: 100%;
        `;

        const timestampParts = formatTimestampForHeader(message.time);

        if (isTopLevelMessage) {
            messageHeader.style.justifyContent = 'space-between'; // For ID+Time (left) and Date (right)
            const idSpan = document.createElement('span');
            idSpan.textContent = `#${message.id} | ${timestampParts.time}`; // Combined ID and Time

            // const timeSpan = document.createElement('span'); // Removed
            // timeSpan.textContent = timestampParts.time;
            // timeSpan.style.textAlign = 'center';
            // timeSpan.style.flexGrow = '1';

            const dateSpan = document.createElement('span');
            dateSpan.textContent = timestampParts.date;
            // dateSpan.style.paddingRight = '5px'; // Padding might not be needed or can be adjusted

            messageHeader.appendChild(idSpan);
            // messageHeader.appendChild(timeSpan); // Removed
            messageHeader.appendChild(dateSpan);
        } else { // Simplified header for quoted messages
            messageHeader.style.justifyContent = 'flex-start'; // Align ID to the start
            const idSpan = document.createElement('span');
            idSpan.textContent = `>>${message.id}`; // Changed prefix for quoted messages
            // Time and Date spans are intentionally omitted for quoted messages
            messageHeader.appendChild(idSpan);
        }
        messageDiv.appendChild(messageHeader);

        const textElement = document.createElement('div');
        textElement.style.whiteSpace = 'pre-wrap'; // Preserve line breaks
        textElement.style.overflowWrap = 'break-word'; // Allow breaking normally unbreakable words
        textElement.style.wordBreak = 'normal'; // Prefer whole word wrapping

        if (message.text && typeof message.text === 'string') {
            const lines = message.text.split('\n');
            const quoteRegex = /^>>(\d+)/;

            lines.forEach((line, lineIndex) => {
                const quoteMatch = line.match(quoteRegex);

                if (currentDepth >= MAX_QUOTE_DEPTH) {
                    // At max depth (or beyond, though shouldn't happen with correct recursion control)
                    if (quoteMatch) {
                        // This is a >>link at max depth, skip it entirely.
                        return; // Skips this iteration of lines.forEach
                    } else {
                        // Not a quote link, so it's regular text. Render it.
                        textElement.appendChild(document.createTextNode(line));
                        if (lineIndex < lines.length - 1) {
                            textElement.appendChild(document.createElement('br'));
                        }
                    }
                } else { // currentDepth < MAX_QUOTE_DEPTH
                    if (quoteMatch) {
                        // It's a >>link and we are allowed to recurse further.
                        const quotedMessageId = quoteMatch[1];
                        let quotedMessageObject = null;
                        for (const threadIdKey in messagesByThreadId) {
                            if (messagesByThreadId.hasOwnProperty(threadIdKey)) {
                                const foundMsg = messagesByThreadId[threadIdKey].find(m => m.id === Number(quotedMessageId));
                                if (foundMsg) {
                                    quotedMessageObject = foundMsg;
                                    break;
                                }
                            }
                        }

                        if (quotedMessageObject) {
                            const quotedElement = createMessageElementDOM(
                                quotedMessageObject,
                                [], // mediaLoadPromises - see note in plan about this if issues persist
                                uniqueImageViewerHashes,
                                uniqueVideoViewerHashes,
                                quotedMessageObject.board || 'b',
                                false, // isTopLevelMessage = false for quotes
                                currentDepth + 1,
                                null // threadColor is not used for quoted message accents
                            );
                            if (quotedElement) {
                                textElement.appendChild(quotedElement);
                            }
                        } else {
                            const notFoundSpan = document.createElement('span');
                            notFoundSpan.textContent = `>>${quotedMessageId} (Not Found)`;
                            notFoundSpan.style.color = '#88ccee';
                            notFoundSpan.style.textDecoration = 'underline';
                            textElement.appendChild(notFoundSpan);
                        }

                        const restOfLine = line.substring(quoteMatch[0].length).trim();
                        if (restOfLine) {
                            const restOfLineSpan = document.createElement('span');
                            restOfLineSpan.textContent = " " + restOfLine;
                            textElement.appendChild(restOfLineSpan);
                        }
                        if (lineIndex < lines.length - 1 || restOfLine) {
                            textElement.appendChild(document.createElement('br'));
                        }
                    } else {
                        // Not a quote link, and not at max depth. Regular text.
                        textElement.appendChild(document.createTextNode(line));
                        if (lineIndex < lines.length - 1) {
                            textElement.appendChild(document.createElement('br'));
                        }
                    }
                }
            });
        } else {
            textElement.textContent = message.text || ''; // Handle null or undefined message.text
        }

        messageDiv.appendChild(textElement);

        // Add click listener to the main messageDiv for anchoring
        messageDiv.addEventListener('click', (event) => {
            // Prevent anchoring if clicking on known interactive elements
            if (event.target.tagName === 'A' ||
                event.target.closest('a') ||
                event.target.tagName === 'IMG' ||
                event.target.tagName === 'VIDEO' ||
                event.target.isContentEditable ||
                (event.target.classList && event.target.classList.contains('thumbnail-link'))) { // Example specific class
                // consoleLog("Anchor click ignored due to interactive target:", event.target);
                return;
            }

            const currentMessageId = messageDiv.getAttribute('data-message-id');
            const currentlyAnchoredId = localStorage.getItem(ANCHORED_MESSAGE_ID_KEY);

            if (currentMessageId === currentlyAnchoredId) {
                messageDiv.classList.remove(ANCHORED_MESSAGE_CLASS);
                localStorage.removeItem(ANCHORED_MESSAGE_ID_KEY);
                consoleLog(`Un-anchored message: ${currentMessageId}`);
            } else {
                const oldAnchorElement = document.querySelector(`.${ANCHORED_MESSAGE_CLASS}`);
                if (oldAnchorElement) {
                    oldAnchorElement.classList.remove(ANCHORED_MESSAGE_CLASS);
                }
                messageDiv.classList.add(ANCHORED_MESSAGE_CLASS);
                localStorage.setItem(ANCHORED_MESSAGE_ID_KEY, currentMessageId);
                consoleLog(`Anchored message: ${currentMessageId}`);
            }
        });

        // Initial highlight check when the element is first created
        const initiallyAnchoredId = localStorage.getItem(ANCHORED_MESSAGE_ID_KEY);
        if (message.id.toString() === initiallyAnchoredId) {
            messageDiv.classList.add(ANCHORED_MESSAGE_CLASS);
        }

        if (message.attachment && message.attachment.tim) {
            const attachmentDiv = document.createElement('div');
            attachmentDiv.style.marginTop = '10px';

            const filenameLink = document.createElement('a');
            filenameLink.textContent = `${message.attachment.filename} (${message.attachment.ext.substring(1)})`;
            const actualBoardForLink = boardForLink || message.board || 'b'; // Use passed boardForLink, fallback to message.board or 'b'
            filenameLink.href = `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${message.attachment.ext}`;
            filenameLink.target = "_blank";
            filenameLink.style.cssText = "color: #60a5fa; display: block; margin-bottom: 5px; text-decoration: underline;";
            attachmentDiv.appendChild(filenameLink);

            const extLower = message.attachment.ext.toLowerCase();
            const filehash = message.attachment.filehash_db_key || `${message.attachment.tim}${extLower}`; // Fallback to tim+ext if no hash

            if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLower)) {
                // Image handling with toggle logic
                let isFirstInstance = !renderedFullSizeImageHashes.has(filehash);
                if (isFirstInstance) {
                    renderedFullSizeImageHashes.add(filehash);
                }

                const img = document.createElement('img');
                img.dataset.filehash = filehash;
                img.dataset.thumbSrc = `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}s.jpg`;
                img.dataset.thumbWidth = message.attachment.tn_w;
                img.dataset.thumbHeight = message.attachment.tn_h;
                img.dataset.isThumbnail = isFirstInstance ? 'false' : 'true';
                img.style.cursor = 'pointer';
                img.style.display = 'block'; // Ensure it takes block space
                img.style.borderRadius = '3px';


                const setupInitialImageState = (dataUrlOrFallback) => { // Parameter is now dataUrl or a fallback web URL
                    img.dataset.fullSrc = dataUrlOrFallback; // Store the dataURL or the web URL

                    if (img.dataset.isThumbnail === 'true') {
                        img.src = img.dataset.thumbSrc;
                        img.style.width = img.dataset.thumbWidth + 'px';
                        img.style.height = img.dataset.thumbHeight + 'px';
                        img.style.maxWidth = ''; // Clear max constraints for thumbnail
                        img.style.maxHeight = '';
                    } else {
                        img.src = img.dataset.fullSrc;
                        img.style.maxWidth = '100%';
                        img.style.maxHeight = '400px'; // Existing constraint for full-size
                        img.style.width = 'auto'; // Let aspect ratio determine width within constraints
                        img.style.height = 'auto';// Let aspect ratio determine height within constraints
                    }
                    uniqueImageViewerHashes.add(filehash); // Add to stats regardless of initial display type
                };

                img.addEventListener('click', () => {
                    // consoleLog(`Image clicked: msgId=${message.id}, filehash=${filehash}, isThumbnail=${img.dataset.isThumbnail}, fullSrc=${img.dataset.fullSrc}`); // Logging removed
                    const currentlyThumbnail = img.dataset.isThumbnail === 'true';
                    if (currentlyThumbnail) { // Toggle to full
                        img.src = img.dataset.fullSrc;
                        img.style.maxWidth = '100%';
                        img.style.maxHeight = '400px';
                        img.style.width = 'auto';
                        img.style.height = 'auto';
                        img.dataset.isThumbnail = 'false';
                    } else { // Toggle to thumbnail
                        img.src = img.dataset.thumbSrc;
                        img.style.width = img.dataset.thumbWidth + 'px';
                        img.style.height = img.dataset.thumbHeight + 'px';
                        img.style.maxWidth = '';
                        img.style.maxHeight = '';
                        img.dataset.isThumbnail = 'true';
                    }
                });

                if (message.attachment.localStoreId && otkMediaDB) {
                    mediaLoadPromises.push(new Promise((resolveMedia) => {
                        const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
                        const store = transaction.objectStore('mediaStore');
                        const request = store.get(message.attachment.localStoreId);
                        request.onsuccess = (event) => {
                            const storedItem = event.target.result;
                            if (storedItem && storedItem.blob) {
                                blobToDataURL(storedItem.blob)
                                    .then(dataURL => {
                                        setupInitialImageState(dataURL);
                                        resolveMedia();
                                    })
                                    .catch(err => {
                                        consoleError(`Error converting blob to Data URL for ${message.attachment.localStoreId}:`, err);
                                        setupInitialImageState(null); // Fallback to web URL
                                        resolveMedia();
                                    });
                            } else {
                                consoleWarn(`Blob not found in IDB for ${message.attachment.localStoreId}. Using web URLs.`);
                                setupInitialImageState(null); // Will use web URL as fallback
                                resolveMedia();
                            }
                        };
                        request.onerror = (event) => {
                            consoleError(`Error fetching media ${message.attachment.localStoreId} from IDB:`, event.target.error);
                            setupInitialImageState(null); // Use web URL on error
                            resolveMedia();
                        };
                    }));
                } else {
                    // No local store ID or DB unavailable, setup with web URLs directly
                    setupInitialImageState(null);
                }
                attachmentDiv.appendChild(img);

            } else if (['.webm', '.mp4'].includes(extLower)) {
                // Video handling: CSP might also affect blobs for videos.
                // For now, let's assume videos are less common or direct 4cdn links are fine.
                // If videos also break, they'll need similar dataURL or a different strategy.
                let videoSrc = null;
                const setupVideo = (src) => {
                    const videoElement = document.createElement('video');
                    if (src && src.startsWith('blob:')) { // Only revoke if it's a blob URL
                        videoElement.onloadeddata = () => URL.revokeObjectURL(src);
                        videoElement.onerror = () => URL.revokeObjectURL(src);
                    }
                    videoElement.src = src || `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${extLower}`; // Fallback
                    videoElement.controls = true;
                    videoElement.style.maxWidth = '100%';
                    videoElement.style.maxHeight = '400px'; // Consistent max height
                    videoElement.style.borderRadius = '3px';
                    videoElement.style.display = 'block';
                    attachmentDiv.appendChild(videoElement);
                    if (message.attachment.filehash_db_key) {
                        uniqueVideoViewerHashes.add(message.attachment.filehash_db_key);
                    }
                };

                if (message.attachment.localStoreId && otkMediaDB) {
                     mediaLoadPromises.push(new Promise((resolveMedia) => {
                        const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
                        const store = transaction.objectStore('mediaStore');
                        const request = store.get(message.attachment.localStoreId);
                        request.onsuccess = (event) => {
                            const storedItem = event.target.result;
                            if (storedItem && storedItem.blob) {
                                videoSrc = URL.createObjectURL(storedItem.blob);
                                setupVideo(videoSrc);
                            } else {
                                setupVideo(null); // Fallback to web URL
                            }
                            resolveMedia();
                        };
                        request.onerror = (event) => {
                            consoleError(`Error fetching video ${message.attachment.localStoreId} from IDB:`, event.target.error);
                            setupVideo(null); // Fallback to web URL
                            resolveMedia();
                        };
                    }));
                } else {
                    setupVideo(null); // No local, use web URL
                }
            }
            // Fallback for other file types or if something went wrong (though images/videos are main media)
            // This part might need adjustment if createThumbnailElement was handling non-image/video files too.
            // For now, assume if not image/video, it doesn't go through this specific media path.

            if (attachmentDiv.hasChildNodes()) {
                messageDiv.appendChild(attachmentDiv);
            }
        }
        return messageDiv;
    }

    // Signature simplified: scroll-related parameters removed
    async function appendNewMessagesToViewer(newMessages) {
        consoleLog(`[appendNewMessagesToViewer] Called with ${newMessages.length} new messages.`);
        const messagesContainer = document.getElementById('otk-messages-container');
        if (!messagesContainer) {
            consoleError("[appendNewMessagesToViewer] messagesContainer not found. Aborting append.");
            // Potentially hide loading screen if it was shown by refreshThreadsAndMessages
            hideLoadingScreen();
            return;
        }

        // oldScrollHeight is no longer passed directly, but we might need to know if user *was* at bottom.
        // This check can be done in refreshThreadsAndMessages or approximated.
        // For now, referenceElement approach will dominate if a reference is found.

        if (messagesContainer.children.length > 0 && newMessages.length > 0) {
            const separatorDiv = document.createElement('div');
            separatorDiv.style.cssText = `
                border-top: 2px dashed #FFD700;
                margin: 20px 0;
                padding-top: 10px;
                text-align: center;
                color: #FFD700;
                font-size: 12px;
                font-style: italic;
            `;
            const now = new Date();
            const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            separatorDiv.textContent = `--- New messages below loaded at ${timeString} ---`;
            messagesContainer.appendChild(separatorDiv);
            consoleLog("[appendNewMessagesToViewer] Appended separator line.");
        }

        const mediaLoadPromises = [];
        for (const message of newMessages) {
            const boardForLink = message.board || 'b';
            const threadColor = getThreadColor(message.originalThreadId); // Get thread color for accent
            // For messages directly appended to the viewer, isTopLevelMessage is true, currentDepth is 0
            const messageElement = createMessageElementDOM(message, mediaLoadPromises, uniqueImageViewerHashes, uniqueVideoViewerHashes, boardForLink, true, 0, threadColor);
            messagesContainer.appendChild(messageElement);
            renderedMessageIdsInViewer.add(message.id);
            consoleLog(`[appendNewMessagesToViewer] Appended message ${message.id}.`);
        }

        consoleLog(`[appendNewMessagesToViewer] Appended ${newMessages.length} elements. Waiting for media promises.`);

        Promise.all(mediaLoadPromises).then(async () => { // Make async to use await for setTimeout promise
            consoleLog("[appendNewMessagesToViewer] Media promises resolved.");

            hideLoadingScreen(); // Hide loading screen first
            await new Promise(resolve => setTimeout(resolve, 50)); // Brief pause for DOM to settle after hiding overlay

            // Scroll adjustment logic is removed. The browser will maintain the current scroll position
            // relative to the existing content. If new content is added at the bottom, the user
            // will need to scroll down to see it if they weren't already at the bottom.
            consoleLog("[appendNewMessagesToViewer] Scroll position intentionally not adjusted after append.");

            viewerActiveImageCount = uniqueImageViewerHashes.size;
            viewerActiveVideoCount = uniqueVideoViewerHashes.size;
            updateDisplayedStatistics();
            consoleLog("[appendNewMessagesToViewer] Stats updated.");

        }).catch(async err => { // Make async
            consoleError("[appendNewMessagesToViewer] Error in media promises:", err);
            hideLoadingScreen(); // Ensure loading screen is hidden on error too
            // No scroll adjustment on error either with the new approach.
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
                    originalThreadId: threadId, // Store the original thread ID for color lookup
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

            // New logic for incremental append or full render
            const messagesContainer = document.getElementById('otk-messages-container'); // Still needed to check if viewer is open and has container
            let viewerIsOpen = otkViewer && otkViewer.style.display === 'block';

            // Scroll position logic is removed from here for append.
            // toggleViewer handles scroll restoration for open/close.

            // Consolidate all messages fetched in this cycle to check for new ones
            let allFetchedMessagesThisCycle = [];
            for (const threadId of activeThreads) {
                if (messagesByThreadId[threadId]) {
                    allFetchedMessagesThisCycle = allFetchedMessagesThisCycle.concat(messagesByThreadId[threadId]);
                }
            }
            allFetchedMessagesThisCycle.sort((a, b) => a.time - b.time); // Ensure sorted if order matters for append logic

            const newMessagesToAppend = allFetchedMessagesThisCycle.filter(m => !renderedMessageIdsInViewer.has(m.id));

            if (viewerIsOpen && newMessagesToAppend.length > 0) {
                consoleLog(`[Manual Refresh] Viewer is open, appending ${newMessagesToAppend.length} new messages.`);
                // Call simplified: only pass newMessagesToAppend
                await appendNewMessagesToViewer(newMessagesToAppend);
            } else if (viewerIsOpen) {
                // Viewer is open but no new messages, or an issue occurred in filtering.
                // Could be a full re-render or do nothing if content is identical.
                // For safety, a full re-render if something changed overall but no *new* messages.
                // However, if newMessagesToAppend is 0, implies all messages are already rendered.
                // Let's assume if newMessagesToAppend is 0, no DOM change is needed unless other state changed.
                // The original logic was a full re-render:
                consoleLog('[Manual Refresh] Viewer is open, but no new messages to append. Re-rendering for consistency (or doing nothing if truly no changes).');
                // To avoid unnecessary full re-renders if only existing messages were updated (which is rare for 4chan),
                // we might only re-render if the *set* of messages changed, not just content.
                // For now, let's stick to re-rendering if no append, to match original behavior branch.
                await renderMessagesInViewer({ isToggleOpen: false }); // Ensures scroll to bottom if no scroll preservation needed.
            }
            // If viewer is not open, no specific viewer update action here, it will populate on next open.

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
            /* overflow-y: hidden; */ /* Ensure viewer itself doesn't show scrollbars */
            box-sizing: border-box;
            background-color: #181818; /* Original viewer background */
            color: #e6e6e6; /* Original default text color for viewer */
            padding: 0; /* No padding, will be handled by messagesContainer */
            border-top: 1px solid #181818; /* Original border, to match original GUI background */
            display: none;
            overflow-x: hidden; /* Prevent horizontal scrollbar on the viewer itself */
        `;
        consoleLog("Applied basic styling to otkViewer: background #181818, default text color #e6e6e6, padding (0), border-top #181818, overflow-x: hidden.");
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
            // Count all messages from all stored threads for "Total Messages"
            for (const threadId in messagesByThreadId) {
                if (messagesByThreadId.hasOwnProperty(threadId)) {
                    totalMessagesCount += (messagesByThreadId[threadId] || []).length;
                }
            }
            const paddingLength = 4;
            threadsTrackedElem.textContent = `- ${padNumber(liveThreadsCount, paddingLength)} Live Thread${liveThreadsCount === 1 ? '' : 's'}`;
            // totalMessagesElem now reflects all stored messages, not just from activeThreads
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

        // Inject CSS for anchored messages
        const styleElement = document.createElement('style');
        styleElement.textContent = `
            .${ANCHORED_MESSAGE_CLASS} {
                background-color: #4a4a3a !important; /* Slightly noticeable dark yellow/greenish */
                border: 1px solid #FFD700 !important;
                /* Add other styles if needed, e.g., box-shadow */
            }
        `;
        document.head.appendChild(styleElement);
        consoleLog("Injected CSS for anchored messages.");

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
