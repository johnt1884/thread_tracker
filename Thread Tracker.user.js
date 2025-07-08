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
    const SEEN_EMBED_URL_IDS_KEY = 'otkSeenEmbedUrlIds'; // For tracking unique text embeds for stats

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
    // let uniqueVideoViewerHashes = new Set(); // Removed as obsolete
    let viewerTopLevelAttachedVideoHashes = new Set(); // Viewer session: Hashes of ATTACHED videos in top-level messages
    let viewerTopLevelEmbedIds = new Set(); // Viewer session: Canonical IDs of EMBEDDED videos in top-level messages
    let renderedFullSizeImageHashes = new Set(); // Tracks image hashes already rendered full-size in current viewer session
    let mediaIntersectionObserver = null; // For lazy loading embeds

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


    // --- Media Embedding Helper Functions ---
function createYouTubeEmbedElement(videoId, timestampStr) { // Removed isInlineEmbed parameter
    let startSeconds = 0;
    if (timestampStr) {
        // Try to parse timestamp like 1h2m3s or 2m3s or 3s or just 123 (YouTube takes raw seconds for ?t=)
        // More robust parsing might be needed if youtube itself uses 1m30s format in its ?t= parameter.
        // For now, assume ?t= is always seconds from the regex, or simple h/m/s format.
        // Regex for youtubeMatch already captures 't' as a string of digits or h/m/s.
        // Let's refine the parsing for h/m/s format.
        if (timestampStr.match(/^\d+$/)) { // Pure seconds e.g. t=123
             startSeconds = parseInt(timestampStr, 10) || 0;
        } else { // Attempt to parse 1h2m3s format
            const timeParts = timestampStr.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?/);
            if (timeParts) {
                const hours = parseInt(timeParts[1], 10) || 0;
                const minutes = parseInt(timeParts[2], 10) || 0;
                const seconds = parseInt(timeParts[3], 10) || 0; // Also handles case like "123" if 's' is optional and no h/m
                if (hours > 0 || minutes > 0 || seconds > 0) { // ensure some part was parsed
                     startSeconds = (hours * 3600) + (minutes * 60) + seconds;
                } else if (timeParts[0] === timestampStr && !isNaN(parseInt(timestampStr,10)) ) { // fallback for plain numbers if regex above was too greedy with optional s
                    startSeconds = parseInt(timestampStr, 10) || 0;
                }
            }
        }
    }

    const embedUrl = `https://www.youtube.com/embed/${videoId}` + (startSeconds > 0 ? `?start=${startSeconds}&autoplay=0` : '?autoplay=0'); // Added autoplay=0

    // Create a wrapper for responsive iframe
    const wrapper = document.createElement('div');
    wrapper.className = 'otk-youtube-embed-wrapper'; // Base class
    // Add 'otk-embed-inline' if specific styling beyond size is still desired from CSS,
    // or remove if all styling is now direct. For now, let's assume it might still be useful for other tweaks.
    wrapper.classList.add('otk-embed-inline');

    wrapper.style.position = 'relative'; // Needed for the absolutely positioned iframe
    wrapper.style.overflow = 'hidden';   // Good practice for wrappers
    wrapper.style.margin = '10px 0';     // Consistent vertical margin
    wrapper.style.backgroundColor = '#000'; // Black background while loading

    // Universal fixed size for all YouTube embeds
    wrapper.style.width = '480px';
    wrapper.style.height = '270px'; // 16:9 aspect ratio for 480px width
    // No paddingBottom or conditional sizing logic needed anymore

    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.top = '0';
    iframe.style.left = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    // iframe.src = embedUrl; // Will be set by IntersectionObserver
    iframe.dataset.src = embedUrl; // Store for lazy loading
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowfullscreen', 'true');
    // Removed autoplay from here as it's in URL, added picture-in-picture and web-share
    iframe.setAttribute('allow', 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');

    wrapper.appendChild(iframe);

    if (mediaIntersectionObserver) {
        mediaIntersectionObserver.observe(wrapper);
    } else {
        // Fallback if observer isn't ready (e.g. if createYouTubeEmbedElement is called before renderMessagesInViewer)
        // This shouldn't happen in the current flow where embeds are created during renderMessagesInViewer.
        consoleWarn("[LazyLoad] mediaIntersectionObserver not ready. Iframe will load immediately:", iframe.dataset.src);
        iframe.src = iframe.dataset.src;
    }
    return wrapper;
}

// Helper function for processing text segments (either append as text or handle as quote)
function appendTextOrQuoteSegment(textElement, segment, quoteRegex, currentDepth, MAX_QUOTE_DEPTH, messagesByThreadId, uniqueImageViewerHashes, boardForLink, mediaLoadPromises) {
    // Note: mediaLoadPromises is passed down in case quote recursion generates media elements that need tracking.
    // However, createMessageElementDOM for quotes currently passes an empty array for it. This could be enhanced.
    const quoteMatch = segment.match(quoteRegex);

    if (quoteMatch && segment.startsWith(quoteMatch[0])) { // Process as quote only if segment starts with it
        // Handle quote (potentially recursive)
        if (currentDepth >= MAX_QUOTE_DEPTH) {
            // At max depth, display quote link as text or a placeholder, but don't recurse
            // To match original behavior of skipping pure ">>123" lines at max depth:
            if (segment === quoteMatch[0]) return; // Skip pure quote link if it's the entire segment

            // If "text >>123" or ">>123 text" at max depth, treat as text
            textElement.appendChild(document.createTextNode(segment));
            return;
        }

        // Not at max depth, so process the quote
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
                mediaLoadPromises, // Pass down mediaLoadPromises
                uniqueImageViewerHashes,
                // uniqueVideoViewerHashes, // Removed
                quotedMessageObject.board || boardForLink,
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

        const restOfSegment = segment.substring(quoteMatch[0].length);
        if (restOfSegment.length > 0) {
            // Recursively process the rest of the segment for more quotes or text
            // This is important if a line is like ">>123 >>456 text"
            appendTextOrQuoteSegment(textElement, restOfSegment, quoteRegex, currentDepth, MAX_QUOTE_DEPTH, messagesByThreadId, uniqueImageViewerHashes, boardForLink, mediaLoadPromises);
        }
    } else {
        // Not a quote at the start of the segment (or not a quote at all), just plain text for this segment
        if (segment.length > 0) { // Ensure non-empty segment before creating text node
            textElement.appendChild(document.createTextNode(segment));
        }
    }
}

function createTwitchEmbedElement(type, id, timestampStr) {
    let embedUrl;
    const parentDomain = 'boards.4chan.org'; // Or dynamically get current hostname if needed for wider use

    if (type === 'clip_direct' || type === 'clip_channel') {
        embedUrl = `https://clips.twitch.tv/embed?clip=${id}&parent=${parentDomain}&autoplay=false`;
    } else if (type === 'vod') {
        let timeParam = '';
        if (timestampStr) {
            // Twitch expects format like 01h30m20s
            // The regex twitchTimestampRegex captures ((?:\d+h)?(?:\d+m)?(?:\d+s)?)
            // We need to ensure it's formatted correctly if only parts are present e.g. "30m10s" or "1h5s"
            // The regex already produces a string like "1h2m3s" or "45m" or "30s".
            // If it's just seconds, e.g. "120s", that's also valid.
            // If it's "120", it needs 's' appended. The regex ensures 's' if only seconds, or h/m present.
            // The regex `((?:\d+h)?(?:\d+m)?(?:\d+s)?)` might result in empty string if no t= is found.
            // And if t= is empty like `t=`, timestampStr would be empty.
            if (timestampStr.length > 0) { // Ensure timestampStr is not empty
                 timeParam = `&time=${timestampStr}`;
            }
        }
        embedUrl = `https://player.twitch.tv/?video=${id}&parent=${parentDomain}&autoplay=false${timeParam}`;
    } else {
        consoleError(`[EmbedTwitch] Unknown Twitch embed type: ${type}`);
        return document.createTextNode(`[Invalid Twitch Embed Type: ${type}]`);
    }

    const wrapper = document.createElement('div');
    // Apply common classes for potential shared styling, and specific for twitch
    wrapper.className = 'otk-twitch-embed-wrapper otk-embed-inline'; // All embeds are now 'inline' styled (fixed small size)

    wrapper.style.position = 'relative';
    wrapper.style.overflow = 'hidden';
    wrapper.style.margin = '10px 0'; // Consistent vertical margin
    wrapper.style.backgroundColor = '#181818'; // Twitchy background color

    // Universal fixed size for all embeds
    wrapper.style.width = '480px';
    wrapper.style.height = '270px'; // 16:9 aspect ratio for 480px width

    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.top = '0';
    iframe.style.left = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.dataset.src = embedUrl; // For lazy loading
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('scrolling', 'no'); // Twitch often recommends this
    // Twitch player might have its own autoplay rules, but autoplay=false in URL is a good hint

    wrapper.appendChild(iframe);

    if (mediaIntersectionObserver) {
        mediaIntersectionObserver.observe(wrapper);
    } else {
        consoleWarn("[LazyLoad] mediaIntersectionObserver not ready for Twitch. Iframe will load immediately:", iframe.dataset.src);
        iframe.src = iframe.dataset.src;
    }
    return wrapper;
}

function createStreamableEmbedElement(videoId) {
    // Streamable embed URL format is typically https://streamable.com/e/VIDEO_ID
    const embedUrl = `https://streamable.com/e/${videoId}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'otk-streamable-embed-wrapper otk-embed-inline'; // Common class for fixed-size embeds

    wrapper.style.position = 'relative';
    wrapper.style.overflow = 'hidden';
    wrapper.style.margin = '10px 0';     // Consistent vertical margin
    wrapper.style.backgroundColor = '#111'; // Dark background for Streamable

    // Universal fixed size for all embeds
    wrapper.style.width = '480px';
    wrapper.style.height = '270px'; // Assuming 16:9 for consistency, adjust if Streamable common aspect is different

    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.top = '0';
    iframe.style.left = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.dataset.src = embedUrl; // For lazy loading
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('scrolling', 'no');
    // Streamable embeds generally don't need parent param and handle autoplay via their own player

    wrapper.appendChild(iframe);

    if (mediaIntersectionObserver) {
        mediaIntersectionObserver.observe(wrapper);
    } else {
        consoleWarn("[LazyLoad] mediaIntersectionObserver not ready for Streamable. Iframe will load immediately:", iframe.dataset.src);
        iframe.src = iframe.dataset.src;
    }
    return wrapper;
}


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
            border-bottom: 1px solid var(--otk-gui-bottom-border-color);
            background: var(--otk-gui-bg-color);
            box-sizing: border-box;
        `;

        otkGui = document.createElement('div');
        otkGui.id = 'otk-tracker-gui';
        otkGui.style.cssText = `
            height: 85px;
            color: var(--otk-gui-text-color); /* This is now for general GUI text */
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
            /* margin-bottom will be handled by titleContainer */
            display: inline; /* To allow cog to sit next to it */
            color: var(--otk-title-text-color); /* Apply specific color variable */
        `;

        const cogIcon = document.createElement('span');
        cogIcon.id = 'otk-settings-cog';
        cogIcon.innerHTML = '&#x2699;'; // Gear icon ⚙️
        cogIcon.style.cssText = `
            font-size: 16px;
            margin-left: 10px;
            cursor: pointer;
            display: inline-block; /* Allows margin and proper alignment */
            vertical-align: middle; /* Aligns cog with text better */
        `;
        cogIcon.title = "Open Settings";

        const titleContainer = document.createElement('div');
        titleContainer.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center; /* Center title and cog */
            margin-bottom: 4px;
        `;
        titleContainer.appendChild(otkThreadTitleDisplay);
        titleContainer.appendChild(cogIcon);

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
        threadsTrackedStat.style.color = 'var(--otk-stats-text-color)';

        const totalMessagesStat = document.createElement('span');
        totalMessagesStat.id = 'otk-total-messages-stat';
        totalMessagesStat.textContent = 'Total Messages: 0';
        totalMessagesStat.style.textAlign = 'left';
        totalMessagesStat.style.minWidth = '150px';
        totalMessagesStat.style.color = 'var(--otk-stats-text-color)';

        const localImagesStat = document.createElement('span');
        localImagesStat.id = 'otk-local-images-stat';
        localImagesStat.textContent = 'Local Images: 0';
        localImagesStat.style.textAlign = 'left';
        localImagesStat.style.minWidth = '150px';
        localImagesStat.style.color = 'var(--otk-stats-text-color)';

        const localVideosStat = document.createElement('span');
        localVideosStat.id = 'otk-local-videos-stat';
        localVideosStat.textContent = 'Local Videos: 0';
        localVideosStat.style.textAlign = 'left';
        localVideosStat.style.minWidth = '150px';
        localVideosStat.style.color = 'var(--otk-stats-text-color)';

        otkStatsDisplay.appendChild(threadsTrackedStat);
        otkStatsDisplay.appendChild(totalMessagesStat);
        otkStatsDisplay.appendChild(localImagesStat);
        otkStatsDisplay.appendChild(localVideosStat);
        // centerInfoContainer.appendChild(otkThreadTitleDisplay); // Replaced by titleContainer
        centerInfoContainer.appendChild(titleContainer); // Add the container with title and cog
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
                color: var(--otk-gui-text-color); /* This is now for general GUI text */
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
            otkThreadTitleDisplay.style.cssText = `
                font-weight: bold; font-size: 14px; display: inline;
                color: var(--otk-title-text-color); /* Apply specific color variable */
            `; // Removed margin-bottom, display inline

            const cogIcon = document.createElement('span');
            cogIcon.id = 'otk-settings-cog'; // Ensure ID is consistent if needed for re-binding
            cogIcon.innerHTML = '&#x2699;';
            cogIcon.style.cssText = `
                font-size: 16px; margin-left: 10px; cursor: pointer; display: inline-block; vertical-align: middle;
            `;
            cogIcon.title = "Open Settings";
            // Note: Event listener for cog a V2 feature, or needs to be re-attached if GUI is rebuilt this way.
            // For now, just ensuring structure. If setupOptionsWindow is called after this, it might re-bind.

            const titleContainer = document.createElement('div');
            titleContainer.style.cssText = `
                display: flex; align-items: center; justify-content: center; margin-bottom: 4px;
            `;
            titleContainer.appendChild(otkThreadTitleDisplay);
            titleContainer.appendChild(cogIcon);

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
            threadsTrackedStat.style.color = 'var(--otk-stats-text-color)';

            const totalMessagesStat = document.createElement('span');
            totalMessagesStat.id = 'otk-total-messages-stat';
            totalMessagesStat.textContent = 'Total Messages: 0';
            totalMessagesStat.style.textAlign = 'left';
            totalMessagesStat.style.minWidth = '150px';
            totalMessagesStat.style.color = 'var(--otk-stats-text-color)';

            const localImagesStat = document.createElement('span');
            localImagesStat.id = 'otk-local-images-stat';
            localImagesStat.textContent = 'Local Images: 0'; // Added for consistency
            localImagesStat.style.textAlign = 'left';
            localImagesStat.style.minWidth = '150px';
            localImagesStat.style.color = 'var(--otk-stats-text-color)';

            const localVideosStat = document.createElement('span');
            localVideosStat.id = 'otk-local-videos-stat';
            localVideosStat.textContent = 'Local Videos: 0'; // Added for consistency
            localVideosStat.style.textAlign = 'left';
            localVideosStat.style.minWidth = '150px';
            localVideosStat.style.color = 'var(--otk-stats-text-color)';

            otkStatsDisplay.appendChild(threadsTrackedStat);
            otkStatsDisplay.appendChild(totalMessagesStat);
            otkStatsDisplay.appendChild(localImagesStat); // Added for consistency
            otkStatsDisplay.appendChild(localVideosStat); // Added for consistency
            // centerInfoContainer.appendChild(otkThreadTitleDisplay); // Replaced
            centerInfoContainer.appendChild(titleContainer); // Add new container
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
                color: var(--otk-gui-threadlist-title-color);
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
                color: var(--otk-gui-threadlist-time-color);
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
        // uniqueVideoViewerHashes.clear(); // Removed as the set itself will be removed
        viewerTopLevelAttachedVideoHashes.clear(); // Clear new set for attached videos in top-level messages
        viewerTopLevelEmbedIds.clear(); // Clear new set for embeds in top-level messages
        renderedFullSizeImageHashes.clear(); // Clear for new viewer session
        consoleLog("[renderMessagesInViewer] Cleared renderedMessageIdsInViewer, unique image hashes, top-level video tracking sets, and renderedFullSizeImageHashes for full rebuild.");

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

        // Initialize or re-initialize IntersectionObserver for media within this container
        if (mediaIntersectionObserver) {
            mediaIntersectionObserver.disconnect(); // Clean up previous observer if any
            consoleLog('[LazyLoad] Disconnected previous mediaIntersectionObserver.');
        }

        // Define handleIntersection here if it's not accessible globally or from main's scope
        // For this structure, assuming handleIntersection defined in main() is accessible.
        // If not, it would need to be passed or redefined.
        // Let's assume it's accessible from main's scope for now.
        // To be certain, we can define it again or ensure it's truly global to the IIFE.
        // For safety, let's make sure `handleIntersection` is available.
        // It was defined in main(), so it should be in scope for functions called after main's execution.
        // However, renderMessagesInViewer can be called independently.
        // Let's ensure handleIntersection is defined at a scope accessible by renderMessagesInViewer.
        // Moving its definition to be globally available within the IIFE.
        // (This will be a separate change if current diff doesn't cover that move) - *Actually, previous diff added it inside main, let's adjust that assumption.*
        // For now, let's assume it's available. If ReferenceError, we'll move it.

        const observerOptions = {
            root: messagesContainer, // THIS IS THE KEY: root is the scrollable container
            rootMargin: '0px 0px 300px 0px',
            threshold: 0.01
        };

        // Re-using the handleIntersection from main's scope (or it needs to be global)
        // If handleIntersection is defined inside main, it won't be accessible here directly unless passed or global.
        // Let's assume for now it WILL be made accessible (e.g. defined at IIFE scope).
        // The previous diff put handleIntersection in main, so this will cause an error.
        // I will need to adjust the location of handleIntersection definition.
        // For this step, I will proceed assuming it's accessible.
        // The actual creation:
        // mediaIntersectionObserver = new IntersectionObserver(handleIntersection, observerOptions);
        // consoleLog('[LazyLoad] Initialized new mediaIntersectionObserver for messagesContainer.');
        // This needs `handleIntersection` to be in scope. The previous diff added it inside `main`.
        // I will adjust the previous diff in my mind and assume `handleIntersection` is now at the IIFE's top level scope.
        // So, the following line should work under that assumption:

        // Re-evaluating: The `handleIntersection` function was defined inside `main`.
        // It's better to define it at a higher scope if it's to be used by `renderMessagesInViewer`
        // and potentially other functions. Let's define it at the IIFE scope.
        // This means I need a step to move `handleIntersection` first.
        // For now, I'll put a placeholder here and then make a specific change for `handleIntersection`.

        // Now that handleIntersection is at IIFE scope, this should work:
        mediaIntersectionObserver = new IntersectionObserver(handleIntersection, observerOptions);
        consoleLog('[LazyLoad] Initialized new mediaIntersectionObserver for messagesContainer.');
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
            const messageElement = createMessageElementDOM(message, mediaLoadPromises, uniqueImageViewerHashes, boardForLink, true, 0, threadColor);
            messagesContainer.appendChild(messageElement);

            messagesProcessed++;
            let currentProgress = (messagesProcessed / totalMessages) * 90;
            updateLoadingProgress(currentProgress, `Processing message ${messagesProcessed} of ${totalMessages}...`);
        }
        otkViewer.appendChild(messagesContainer);

// After processing all messages, update global viewer counts
consoleLog(`[StatsDebug] Unique image hashes for viewer: ${uniqueImageViewerHashes.size}`, uniqueImageViewerHashes);
// consoleLog(`[StatsDebug] Unique video hashes for viewer: ${uniqueVideoViewerHashes.size}`, uniqueVideoViewerHashes); // Removed due to uniqueVideoViewerHashes being obsolete
// viewerActiveImageCount = uniqueImageViewerHashes.size; // MOVED TO AFTER PROMISES
// viewerActiveVideoCount = uniqueVideoViewerHashes.size; // MOVED TO AFTER PROMISES
// updateDisplayedStatistics(); // Refresh stats display -- MOVED TO AFTER PROMISES

        Promise.all(mediaLoadPromises).then(() => {
            consoleLog("All inline media load attempts complete.");
            updateLoadingProgress(95, "Finalizing view...");
    viewerActiveImageCount = uniqueImageViewerHashes.size;
    viewerActiveVideoCount = viewerTopLevelAttachedVideoHashes.size + viewerTopLevelEmbedIds.size;
    consoleLog(`[StatsDebug] Viewer counts updated: Images=${viewerActiveImageCount}, Videos (top-level attached + top-level embed)=${viewerActiveVideoCount}`);
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
    function createMessageElementDOM(message, mediaLoadPromises, uniqueImageViewerHashes, boardForLink, isTopLevelMessage, currentDepth, threadColor) {
        consoleLog(`[DepthCheck] Rendering message: ${message.id}, currentDepth: ${currentDepth}, MAX_QUOTE_DEPTH: ${MAX_QUOTE_DEPTH}, isTopLevel: ${isTopLevelMessage}`);

        // --- Define all media patterns once at the top of the function ---
        const youtubePatterns = [
            { regex: /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?=.*v=([a-zA-Z0-9_-]+))(?:[?&%#\w\-=\.\/;:]+)+$/, idGroup: 1 },
            { regex: /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 },
            { regex: /^(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 }
        ];
        const youtubeTimestampRegex = /[?&]t=([0-9hm_s]+)/;
        const inlineYoutubePatterns = [
            { type: 'watch', regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:[^#&?\s]*&)*v=([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;]*)?/, idGroup: 1 },
            { type: 'short', regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;]*)?/, idGroup: 1 },
            { type: 'youtu.be', regex: /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;]*)?/, idGroup: 1 }
        ];

        const twitchPatterns = [
            { type: 'clip_direct', regex: /^(?:https?:\/\/)?clips\.twitch\.tv\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 },
            { type: 'clip_channel', regex: /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 },
            { type: 'vod', regex: /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/videos\/(\d+)(?:[?&%#\w\-=\.\/;:]*)?$/, idGroup: 1 }
        ];
        const twitchTimestampRegex = /[?&]t=((?:\d+h)?(?:\d+m)?(?:\d+s)?)/;
        const inlineTwitchPatterns = [
            { type: 'clip_direct', regex: /(?:https?:\/\/)?clips\.twitch\.tv\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 },
            { type: 'clip_channel', regex: /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/([a-zA-Z0-9_-]+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 },
            { type: 'vod', regex: /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/videos\/(\d+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 }
        ];

        const streamablePatterns = [
            { type: 'video', regex: /^(?:https?:\/\/)?streamable\.com\/([a-zA-Z0-9]+)(?:[?#][^\s]*)?$/, idGroup: 1 }
        ];
        const inlineStreamablePatterns = [
            { type: 'video', regex: /(?:https?:\/\/)?streamable\.com\/([a-zA-Z0-9]+)(?:[?&%#\w\-=\.\/;:]*)?/, idGroup: 1 }
        ];
        // --- End of media pattern definitions ---

        const messageDiv = document.createElement('div');
        messageDiv.setAttribute('data-message-id', message.id);

        let backgroundColor;
        let marginLeft = '0';
        let paddingLeft = '10px'; // Default to 10px
        let marginTop = '15px'; // Default top margin
        let marginBottom = '15px'; // Default bottom margin
        const messageTextColor = '#e6e6e6'; // This will be replaced by depth-specific text color vars
        // let positionStyle = ''; // REMOVED - No longer needed for relative positioning

        let backgroundColorVar;
        if (isTopLevelMessage) { // Depth 0
            backgroundColorVar = 'var(--otk-msg-depth0-bg-color)';
            // marginLeft, marginTop, marginBottom remain defaults for top-level
        } else { // Quoted message (Depth 1+)
            marginLeft = '0px'; // No specific indent margin for quote itself
            marginTop = '10px';    // Specific top margin for quoted messages
            marginBottom = '0px';  // Specific bottom margin for quoted messages
            if (currentDepth === 1) {
                backgroundColorVar = 'var(--otk-msg-depth1-bg-color)';
            } else { // Covers currentDepth === 2 and potential deeper fallbacks
                backgroundColorVar = 'var(--otk-msg-depth2plus-bg-color)';
            }
        }

messageDiv.style.cssText = `
    box-sizing: border-box;
    display: block;
    background-color: ${backgroundColorVar};
    color: ${ isTopLevelMessage ? 'var(--otk-msg-depth0-text-color)' : (currentDepth === 1 ? 'var(--otk-msg-depth1-text-color)' : 'var(--otk-msg-depth2plus-text-color)') };
    /* position: relative; REMOVED - No longer needed */

    margin-top: ${marginTop};
    margin-bottom: ${marginBottom};
    margin-left: ${marginLeft};
    padding-top: 10px;
    padding-bottom: 10px;
    padding-left: ${paddingLeft};
    padding-right: 10px; /* Standardized to 10px */

    /* border-left: ; REMOVED - Replaced by new rectangle element */
    border-radius: 5px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);

    width: calc(100% - ${marginLeft});
    max-width: calc(100% - ${marginLeft});
    overflow-x: hidden;
`;

        // Removed the side rectangle logic that was here:
        // if (isTopLevelMessage && threadColor) { ... }

        const messageHeader = document.createElement('div');

        // Determine headerBorderColor using CSS variables
        let headerBorderVar;
        if (isTopLevelMessage) { // Depth 0
            headerBorderVar = 'var(--otk-viewer-header-border-color)';
        } else if (currentDepth === 1) { // Depth 1 quote
            headerBorderVar = 'var(--otk-viewer-quote1-header-border-color)';
        } else { // Deeper quotes can use the same as depth 1 or a new variable if desired later
            headerBorderVar = 'var(--otk-viewer-quote1-header-border-color)';
        }

        messageHeader.style.cssText = `
            font-size: 12px;
            color: ${ isTopLevelMessage ? 'var(--otk-msg-depth0-header-text-color)' : (currentDepth === 1 ? 'var(--otk-msg-depth1-header-text-color)' : 'var(--otk-msg-depth2plus-header-text-color)') };
            font-weight: bold;
            margin-bottom: 8px;
            padding-bottom: 5px;
            border-bottom: 1px solid ${headerBorderVar};
            display: flex;
            align-items: center;
            width: 100%;
        `;

        const timestampParts = formatTimestampForHeader(message.time);

        if (isTopLevelMessage) {
            messageHeader.style.justifyContent = 'space-between'; // For ID+Time (left) and Date (right)

            // Create a container for the color square and the ID/Time text
            const leftHeaderContent = document.createElement('span');
            leftHeaderContent.style.display = 'flex'; // Use flex to align square and text
            leftHeaderContent.style.alignItems = 'center'; // Vertically align items in the flex container

            if (threadColor) {
                const colorSquare = document.createElement('span');
                colorSquare.style.cssText = `
                    display: inline-block;
                    width: 10px; /* Adjust size as needed */
                    height: 10px; /* Adjust size as needed */
                    background-color: ${threadColor};
                    margin-right: 6px; /* Space between square and '#' */
                    border-radius: 2px; /* Optional: for rounded corners */
                    flex-shrink: 0; /* Prevent square from shrinking */
                `;
                leftHeaderContent.appendChild(colorSquare);
            }

            const idTextSpan = document.createElement('span');
            idTextSpan.textContent = `#${message.id} | ${timestampParts.time}`; // Combined ID and Time
            leftHeaderContent.appendChild(idTextSpan);

            // const timeSpan = document.createElement('span'); // Removed
            // timeSpan.textContent = timestampParts.time;
            // timeSpan.style.textAlign = 'center';
            // timeSpan.style.flexGrow = '1';

            const dateSpan = document.createElement('span');
            dateSpan.textContent = timestampParts.date;
            // dateSpan.style.paddingRight = '5px'; // Padding might not be needed or can be adjusted

            messageHeader.appendChild(leftHeaderContent); // Add the new container
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
        textElement.style.fontSize = 'var(--otk-viewer-message-font-size)'; // Apply font size variable

        if (message.text && typeof message.text === 'string') {
            const lines = message.text.split('\n');
            const quoteRegex = /^>>(\d+)/;

            lines.forEach((line, lineIndex) => {
                const trimmedLine = line.trim();
                let processedAsEmbed = false;

                // All pattern definitions have been moved to the top of createMessageElementDOM.
                // The duplicate Streamable pattern block will also be removed by this change
                // as we are replacing the entire section where they were previously defined.

                let soleUrlEmbedMade = false;

                // Check for Sole YouTube URL
                if (!soleUrlEmbedMade) {
                    for (const patternObj of youtubePatterns) {
                        const match = trimmedLine.match(patternObj.regex);
                        if (match) {
                            const videoId = match[patternObj.idGroup];
                            let timestampStr = null;
                            const timeMatch = trimmedLine.match(youtubeTimestampRegex);
                            if (timeMatch && timeMatch[1]) timestampStr = timeMatch[1];
                            if (videoId) {
                                const canonicalEmbedId = `youtube_${videoId}`;
                                if (isTopLevelMessage) {
                                    // Add to viewer-specific top-level set
                                    viewerTopLevelEmbedIds.add(canonicalEmbedId);

                                    // Existing global stat update logic (SEEN_EMBED_URL_IDS_KEY, LOCAL_VIDEO_COUNT_KEY)
                                    let seenEmbeds = JSON.parse(localStorage.getItem(SEEN_EMBED_URL_IDS_KEY)) || [];
                                    if (!seenEmbeds.includes(canonicalEmbedId)) {
                                        seenEmbeds.push(canonicalEmbedId);
                                        localStorage.setItem(SEEN_EMBED_URL_IDS_KEY, JSON.stringify(seenEmbeds));
                                        let currentVideoCount = parseInt(localStorage.getItem(LOCAL_VIDEO_COUNT_KEY) || '0');
                                        localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, (currentVideoCount + 1).toString());
                                        updateDisplayedStatistics(); // This updates global, not viewer-specific directly
                                    }
                                }
                                textElement.appendChild(createYouTubeEmbedElement(videoId, timestampStr));
                                soleUrlEmbedMade = true; processedAsEmbed = true; break;
                            }
                        }
                    }
                }

                // Check for Sole Twitch URL
                if (!soleUrlEmbedMade) {
                    for (const patternObj of twitchPatterns) {
                        const match = trimmedLine.match(patternObj.regex);
                        if (match) {
                            const id = match[patternObj.idGroup];
                            let timestampStr = null;
                            if (patternObj.type === 'vod') {
                                const timeMatch = trimmedLine.match(twitchTimestampRegex);
                                if (timeMatch && timeMatch[1]) timestampStr = timeMatch[1];
                            }
                            if (id) {
                                const canonicalEmbedId = `twitch_${patternObj.type}_${id}`;
                                if (isTopLevelMessage) {
                                    // Add to viewer-specific top-level set
                                    viewerTopLevelEmbedIds.add(canonicalEmbedId);

                                    // Existing global stat update logic
                                    let seenEmbeds = JSON.parse(localStorage.getItem(SEEN_EMBED_URL_IDS_KEY)) || [];
                                    if (!seenEmbeds.includes(canonicalEmbedId)) {
                                        seenEmbeds.push(canonicalEmbedId);
                                        localStorage.setItem(SEEN_EMBED_URL_IDS_KEY, JSON.stringify(seenEmbeds));
                                        let currentVideoCount = parseInt(localStorage.getItem(LOCAL_VIDEO_COUNT_KEY) || '0');
                                        localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, (currentVideoCount + 1).toString());
                                        updateDisplayedStatistics();
                                    }
                                }
                                textElement.appendChild(createTwitchEmbedElement(patternObj.type, id, timestampStr));
                                soleUrlEmbedMade = true; processedAsEmbed = true; break;
                            }
                        }
                    }
                }

                // Check for Sole Streamable URL
                if (!soleUrlEmbedMade) {
                    for (const patternObj of streamablePatterns) {
                        const match = trimmedLine.match(patternObj.regex);
                        if (match) {
                            const videoId = match[patternObj.idGroup];
                            // Streamable doesn't have standard URL timestamps to parse here
                            if (videoId) {
                                const canonicalEmbedId = `streamable_${videoId}`;
                                if (isTopLevelMessage) {
                                    // Add to viewer-specific top-level set
                                    viewerTopLevelEmbedIds.add(canonicalEmbedId);

                                    // Existing global stat update logic
                                    let seenEmbeds = JSON.parse(localStorage.getItem(SEEN_EMBED_URL_IDS_KEY)) || [];
                                    if (!seenEmbeds.includes(canonicalEmbedId)) {
                                        seenEmbeds.push(canonicalEmbedId);
                                        localStorage.setItem(SEEN_EMBED_URL_IDS_KEY, JSON.stringify(seenEmbeds));
                                        let currentVideoCount = parseInt(localStorage.getItem(LOCAL_VIDEO_COUNT_KEY) || '0');
                                        localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, (currentVideoCount + 1).toString());
                                        updateDisplayedStatistics();
                                    }
                                }
                                textElement.appendChild(createStreamableEmbedElement(videoId));
                                soleUrlEmbedMade = true; processedAsEmbed = true; break;
                            }
                        }
                    }
                }

                if (!soleUrlEmbedMade) {
                    let currentTextSegment = line;

                    while (currentTextSegment.length > 0) {
                        let earliestMatch = null;
                        let earliestMatchPattern = null;
                        let earliestMatchType = null;

                        // Find earliest YouTube inline match
                        for (const patternObj of inlineYoutubePatterns) {
                            const matchAttempt = currentTextSegment.match(patternObj.regex);
                            if (matchAttempt) {
                                if (earliestMatch === null || matchAttempt.index < earliestMatch.index) {
                                    earliestMatch = matchAttempt;
                                    earliestMatchPattern = patternObj;
                                    earliestMatchType = 'youtube';
                                }
                            }
                        }
                        // Find earliest Twitch inline match
                        for (const patternObj of inlineTwitchPatterns) {
                            const matchAttempt = currentTextSegment.match(patternObj.regex);
                            if (matchAttempt) {
                                if (earliestMatch === null || matchAttempt.index < earliestMatch.index) {
                                    earliestMatch = matchAttempt;
                                    earliestMatchPattern = patternObj;
                                    earliestMatchType = 'twitch';
                                }
                            }
                        }
                        // Find earliest Streamable inline match
                        for (const patternObj of inlineStreamablePatterns) {
                            const matchAttempt = currentTextSegment.match(patternObj.regex);
                            if (matchAttempt) {
                                if (earliestMatch === null || matchAttempt.index < earliestMatch.index) {
                                    earliestMatch = matchAttempt;
                                    earliestMatchPattern = patternObj; // type is 'video'
                                    earliestMatchType = 'streamable';
                                }
                            }
                        }

                        if (earliestMatch) {
                            processedAsEmbed = true;

                            if (earliestMatch.index > 0) {
                                appendTextOrQuoteSegment(textElement, currentTextSegment.substring(0, earliestMatch.index), quoteRegex, currentDepth, MAX_QUOTE_DEPTH, messagesByThreadId, uniqueImageViewerHashes, boardForLink, mediaLoadPromises);
                            }

                            const matchedUrl = earliestMatch[0];
                            const id = earliestMatch[earliestMatchPattern.idGroup];
                            let timestampStr = null; // Relevant for YT & Twitch VODs
                            let embedElement = null;
                            let canonicalEmbedId = null;

                            if (earliestMatchType === 'youtube') {
                                const timeMatchInUrl = matchedUrl.match(youtubeTimestampRegex);
                                if (timeMatchInUrl && timeMatchInUrl[1]) timestampStr = timeMatchInUrl[1];
                                if (id) {
                                    canonicalEmbedId = `youtube_${id}`;
                                    embedElement = createYouTubeEmbedElement(id, timestampStr);
                                }
                            } else if (earliestMatchType === 'twitch') {
                                if (earliestMatchPattern.type === 'vod') {
                                    const timeMatchInUrl = matchedUrl.match(twitchTimestampRegex);
                                    if (timeMatchInUrl && timeMatchInUrl[1]) timestampStr = timeMatchInUrl[1];
                                }
                                if (id) {
                                    canonicalEmbedId = `twitch_${earliestMatchPattern.type}_${id}`;
                                    embedElement = createTwitchEmbedElement(earliestMatchPattern.type, id, timestampStr);
                                }
                            } else if (earliestMatchType === 'streamable') {
                                if (id) {
                                    canonicalEmbedId = `streamable_${id}`;
                                    embedElement = createStreamableEmbedElement(id);
                                }
                            }

                            if (embedElement) {
                                if (isTopLevelMessage && canonicalEmbedId) {
                                    // Add to viewer-specific top-level set
                                    viewerTopLevelEmbedIds.add(canonicalEmbedId);

                                    // Existing global stat update logic
                                    let seenEmbeds = JSON.parse(localStorage.getItem(SEEN_EMBED_URL_IDS_KEY)) || [];
                                    if (!seenEmbeds.includes(canonicalEmbedId)) {
                                        seenEmbeds.push(canonicalEmbedId);
                                        localStorage.setItem(SEEN_EMBED_URL_IDS_KEY, JSON.stringify(seenEmbeds));
                                        let currentVideoCount = parseInt(localStorage.getItem(LOCAL_VIDEO_COUNT_KEY) || '0');
                                        localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, (currentVideoCount + 1).toString());
                                        updateDisplayedStatistics();
                                    }
                                }
                                textElement.appendChild(embedElement);
                            }

                            currentTextSegment = currentTextSegment.substring(earliestMatch.index + matchedUrl.length);
                        } else {
                            if (currentTextSegment.length > 0) {
                                appendTextOrQuoteSegment(textElement, currentTextSegment, quoteRegex, currentDepth, MAX_QUOTE_DEPTH, messagesByThreadId, uniqueImageViewerHashes, boardForLink, mediaLoadPromises);
                            }
                            currentTextSegment = "";
                        }
                    }
                }

                if (lineIndex < lines.length - 1 && (trimmedLine.length > 0 || processedAsEmbed)) {
                    textElement.appendChild(document.createElement('br'));
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
                    // if (src && src.startsWith('blob:')) { // Only revoke if it's a blob URL
                        // videoElement.onloadeddata = () => URL.revokeObjectURL(src); // Commented out for now
                        // videoElement.onerror = () => URL.revokeObjectURL(src); // Commented out for now
                    // }
                    // Note: By not revoking, blob URLs will persist. This fixes playback after refresh/append,
                    // but a more sophisticated memory management strategy for these URLs might be needed later.
                    videoElement.src = src || `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${extLower}`; // Fallback
                    videoElement.controls = true;
                    videoElement.style.maxWidth = '100%';
                    videoElement.style.maxHeight = '400px'; // Consistent max height
                    videoElement.style.borderRadius = '3px';
                    videoElement.style.display = 'block';
                    attachmentDiv.appendChild(videoElement);
                    if (message.attachment.filehash_db_key) {
                        if (isTopLevelMessage) {
                            viewerTopLevelAttachedVideoHashes.add(message.attachment.filehash_db_key);
                        }
                        // uniqueVideoViewerHashes.add() removed as it's now obsolete for stats.
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
            const messageElement = createMessageElementDOM(message, mediaLoadPromises, uniqueImageViewerHashes, boardForLink, true, 0, threadColor);
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
            viewerActiveVideoCount = viewerTopLevelAttachedVideoHashes.size + viewerTopLevelEmbedIds.size;
            consoleLog(`[StatsDebug][appendNewMessagesToViewer] Viewer counts updated: Images=${viewerActiveImageCount}, Videos (top-level attached + top-level embed)=${viewerActiveVideoCount}`);
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
            localStorage.removeItem(SEEN_EMBED_URL_IDS_KEY); // Clear seen embed IDs
            localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, '0'); // Reset image count
            localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, '0'); // Reset video count
            consoleLog('[Clear] LocalStorage (including media counts and seen embeds) cleared/reset.');

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
            /* background-color: #181818; */ /* New background color - replaced by variable below */
            opacity: 1; /* Ensure full opacity */
            z-index: 9998;
            /* overflow-y: hidden; */ /* Ensure viewer itself doesn't show scrollbars */
            box-sizing: border-box;
            background-color: var(--otk-viewer-bg-color); /* Original viewer background */
            color: var(--otk-gui-text-color); /* Viewer default text color, can be same as GUI or new variable later */
            padding: 0; /* No padding, will be handled by messagesContainer */
            border-top: 1px solid #181818; /* Assuming border might be different or themed later, keep for now */
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

// --- IIFE Scope Helper for Intersection Observer ---
function handleIntersection(entries, observerInstance) {
    entries.forEach(entry => {
        // The outer if (entry.isIntersecting) was removed in the previous correction,
        // which was good. The issue is the double declaration.
        // The structure should be:
        // entries.forEach(entry => {
        //    const wrapper = entry.target;
        //    const iframe = wrapper.querySelector('iframe'); // Declared ONCE
        //    if (iframe) {
        //        if (entry.isIntersecting) { ... } else { ... }
        //    }
        // });
        // The file content provided in the last read_files shows this structure:
        // function handleIntersection(entries, observerInstance) {
        //    entries.forEach(entry => {
        //        if (entry.isIntersecting) { // This 'if' is from my analysis, not the actual code block that had the error.
        //            const wrapper = entry.target;
        //            const iframe = wrapper.querySelector('iframe'); // First
        //            const iframe = wrapper.querySelector('iframe'); // Second - THIS IS THE ERROR
        //
        //            if (iframe) { ...
        // Let's correct based on the actual problematic code block.
        // The `if (entry.isIntersecting)` was part of my *description* of the error location,
        // not necessarily the code structure itself that contained the double declaration.
        // The actual error is simpler: two `const iframe` lines back-to-back.

            const wrapper = entry.target;
            const iframe = wrapper.querySelector('iframe'); // Keep this one

            // const iframe = wrapper.querySelector('iframe'); // REMOVE THIS REDECLARATION

            if (iframe) { // Ensure iframe exists
                if (entry.isIntersecting) {
                    // Element is now visible
                    if (iframe.dataset.src && (!iframe.src || iframe.src === 'about:blank')) {
                        consoleLog('[LazyLoad] Loading iframe for:', iframe.dataset.src);
                        iframe.src = iframe.dataset.src;
                        // Do NOT unobserve: observerInstance.unobserve(wrapper);
                        // We want to keep observing to handle scroll-out for unloading.
                    }
                } else {
                    // Element is no longer visible
                    if (iframe.src && iframe.src !== 'about:blank') {
                        consoleLog('[LazyLoad] Unloading iframe (scrolled out of view):', iframe.src);
                        // Attempt to pause YouTube videos via postMessage (best effort)
                        if (iframe.src.includes("youtube.com/embed")) {
                            try {
                                iframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', 'https://www.youtube.com');
                            } catch (e) {
                                consoleWarn('[LazyLoad] Error attempting to postMessage pause to YouTube:', e);
                            }
                        }
                        // For other platforms, pausing via postMessage is less standardized or might require their specific player APIs.
                        // This part would need expansion for Twitch, Streamable, Rumble if simple src reset isn't enough.

                        iframe.src = 'about:blank'; // Unload the content to save resources
                        // The data-src attribute remains, so it can be reloaded if it scrolls back into view.
                    }
                }
            }
        // REMOVED EXTRA CLOSING BRACE HERE
    });
}

// --- Theme Settings Persistence ---
const THEME_SETTINGS_KEY = 'otkThemeSettings';

function saveThemeSetting(key, value) {
    let settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
    if (value === null || value === undefined) {
        delete settings[key];
    } else {
        settings[key] = value;
    }
    localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(settings));
    consoleLog("Saved theme setting:", key, value);
}

function applyThemeSettings() {
    let settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
    consoleLog("Applying theme settings:", settings);

    if (settings.guiBgColor) {
        document.documentElement.style.setProperty('--otk-gui-bg-color', settings.guiBgColor);
        // Also update the input fields in the options window if it's already set up
        const guiBgHexInput = document.getElementById('otk-color-gui-bg-hex');
        const guiBgPicker = document.getElementById('otk-color-gui-bg-picker');
        if (guiBgHexInput) guiBgHexInput.value = settings.guiBgColor;
        if (guiBgPicker) guiBgPicker.value = settings.guiBgColor;
    }

    if (settings.titleTextColor) {
        document.documentElement.style.setProperty('--otk-title-text-color', settings.titleTextColor);
        const titleTextColorHexInput = document.getElementById('otk-color-title-text-hex');
        const titleTextColorPicker = document.getElementById('otk-color-title-text-picker');
        if (titleTextColorHexInput) titleTextColorHexInput.value = settings.titleTextColor;
        if (titleTextColorPicker) titleTextColorPicker.value = settings.titleTextColor;
    }

    // Updated for Options Panel Text (formerly guiTextColor)
    if (settings.optionsTextColor) {
        document.documentElement.style.setProperty('--otk-options-text-color', settings.optionsTextColor);
        const optionsTextColorHexInput = document.getElementById('otk-color-options-text-hex');
        const optionsTextColorPicker = document.getElementById('otk-color-options-text-picker');
        if (optionsTextColorHexInput) optionsTextColorHexInput.value = settings.optionsTextColor;
        if (optionsTextColorPicker) optionsTextColorPicker.value = settings.optionsTextColor;
    }

    // Added for Actual Stats Text
    if (settings.actualStatsTextColor) {
        document.documentElement.style.setProperty('--otk-stats-text-color', settings.actualStatsTextColor);
        const actualStatsTextColorHexInput = document.getElementById('otk-color-actual-stats-text-hex');
        const actualStatsTextColorPicker = document.getElementById('otk-color-actual-stats-text-picker');
        if (actualStatsTextColorHexInput) actualStatsTextColorHexInput.value = settings.actualStatsTextColor;
        if (actualStatsTextColorPicker) actualStatsTextColorPicker.value = settings.actualStatsTextColor;
    }

    if (settings.viewerBgColor) {
        document.documentElement.style.setProperty('--otk-viewer-bg-color', settings.viewerBgColor);
        const viewerBgHexInput = document.getElementById('otk-color-viewer-bg-hex');
        const viewerBgPicker = document.getElementById('otk-color-viewer-bg-picker');
        if (viewerBgHexInput) viewerBgHexInput.value = settings.viewerBgColor;
        if (viewerBgPicker) viewerBgPicker.value = settings.viewerBgColor;
    }

    if (settings.guiThreadListTitleColor) {
        document.documentElement.style.setProperty('--otk-gui-threadlist-title-color', settings.guiThreadListTitleColor);
        const inputHex = document.getElementById('otk-color-threadlist-title-hex');
        const inputPicker = document.getElementById('otk-color-threadlist-title-picker');
        if (inputHex) inputHex.value = settings.guiThreadListTitleColor;
        if (inputPicker) inputPicker.value = settings.guiThreadListTitleColor;
    }

    if (settings.guiThreadListTimeColor) {
        document.documentElement.style.setProperty('--otk-gui-threadlist-time-color', settings.guiThreadListTimeColor);
        const inputHex = document.getElementById('otk-color-threadlist-time-hex');
        const inputPicker = document.getElementById('otk-color-threadlist-time-picker');
        if (inputHex) inputHex.value = settings.guiThreadListTimeColor;
        if (inputPicker) inputPicker.value = settings.guiThreadListTimeColor;
    }

    // Viewer Header Border Color
    if (settings.viewerHeaderBorderColor) {
        document.documentElement.style.setProperty('--otk-viewer-header-border-color', settings.viewerHeaderBorderColor);
        const hexInput = document.getElementById('otk-color-viewer-header-border-hex');
        const picker = document.getElementById('otk-color-viewer-header-border-picker');
        if (hexInput) hexInput.value = settings.viewerHeaderBorderColor;
        if (picker) picker.value = settings.viewerHeaderBorderColor;
    }

    // Viewer Quote L1 Border Color
    if (settings.viewerQuote1HeaderBorderColor) {
        document.documentElement.style.setProperty('--otk-viewer-quote1-header-border-color', settings.viewerQuote1HeaderBorderColor);
        const hexInput = document.getElementById('otk-color-viewer-quote1-border-hex');
        const picker = document.getElementById('otk-color-viewer-quote1-border-picker');
        if (hexInput) hexInput.value = settings.viewerQuote1HeaderBorderColor;
        if (picker) picker.value = settings.viewerQuote1HeaderBorderColor;
    }

    // Message Background Colors
    ['Depth 0', 'Depth 1', 'Depth 2+'].forEach((label, index) => {
        const key = `msgDepth${index === 2 ? '2plus' : index}BgColor`;
        const cssVar = `--otk-msg-depth${index === 2 ? '2plus' : index}-bg-color`;
        const idSuffix = `msg-depth${index === 2 ? '2plus' : index}-bg`;
        if (settings[key]) {
            document.documentElement.style.setProperty(cssVar, settings[key]);
            const hexInput = document.getElementById(`otk-color-${idSuffix}-hex`);
            const picker = document.getElementById(`otk-color-${idSuffix}-picker`);
            if (hexInput) hexInput.value = settings[key];
            if (picker) picker.value = settings[key];
        }
    });

    // Message Body Text Colors
    ['Depth 0', 'Depth 1', 'Depth 2+'].forEach((label, index) => {
        const key = `msgDepth${index === 2 ? '2plus' : index}TextColor`;
        const cssVar = `--otk-msg-depth${index === 2 ? '2plus' : index}-text-color`;
        const idSuffix = `msg-depth${index === 2 ? '2plus' : index}-text`;
        if (settings[key]) {
            document.documentElement.style.setProperty(cssVar, settings[key]);
            const hexInput = document.getElementById(`otk-color-${idSuffix}-hex`);
            const picker = document.getElementById(`otk-color-${idSuffix}-picker`);
            if (hexInput) hexInput.value = settings[key];
            if (picker) picker.value = settings[key];
        }
    });

    // Message Header Text Colors
    ['Depth 0', 'Depth 1', 'Depth 2+'].forEach((label, index) => {
        const key = `msgDepth${index === 2 ? '2plus' : index}HeaderTextColor`;
        const cssVar = `--otk-msg-depth${index === 2 ? '2plus' : index}-header-text-color`;
        const idSuffix = `msg-depth${index === 2 ? '2plus' : index}-header-text`;
        if (settings[key]) {
            document.documentElement.style.setProperty(cssVar, settings[key]);
            const hexInput = document.getElementById(`otk-color-${idSuffix}-hex`);
            const picker = document.getElementById(`otk-color-${idSuffix}-picker`);
            if (hexInput) hexInput.value = settings[key];
            if (picker) picker.value = settings[key];
        }
    });

    // Viewer Message Font Size
    if (settings.viewerMessageFontSize) {
        document.documentElement.style.setProperty('--otk-viewer-message-font-size', settings.viewerMessageFontSize);
        const input = document.getElementById('otk-fontsize-message-text');
        if (input) input.value = settings.viewerMessageFontSize.replace('px','');
    }

    if (settings.guiBottomBorderColor) {
        document.documentElement.style.setProperty('--otk-gui-bottom-border-color', settings.guiBottomBorderColor);
        const hexInput = document.getElementById('otk-color-gui-bottom-border-hex');
        const picker = document.getElementById('otk-color-gui-bottom-border-picker');
        if (hexInput) hexInput.value = settings.guiBottomBorderColor;
        if (picker) picker.value = settings.guiBottomBorderColor;
    }
}


function setupOptionsWindow() {
    consoleLog("Setting up Options Window...");

    // Check if window already exists
    if (document.getElementById('otk-options-window')) {
        consoleLog("Options window already exists.");
        return;
    }

    const optionsWindow = document.createElement('div');
    optionsWindow.id = 'otk-options-window';
    optionsWindow.style.cssText = `
        position: fixed;
        top: 100px;
        left: 100px;
        width: 400px; /* Initial width, can be adjusted */
        min-height: 200px; /* Initial min-height */
        background-color: #2c2c2c; /* Slightly lighter than GUI for distinction */
        border: 1px solid #444;
        border-radius: 5px;
        z-index: 10000; /* Below loading screen, above viewer/GUI */
        display: none; /* Hidden by default */
        flex-direction: column;
        box-shadow: 0 5px 15px rgba(0,0,0,0.5);
        color: var(--otk-options-text-color); /* Use specific variable for options window text */
    `;

    const titleBar = document.createElement('div');
    titleBar.id = 'otk-options-title-bar';
    titleBar.style.cssText = `
        padding: 8px 12px;
        background-color: #383838;
        color: #f0f0f0;
        font-weight: bold;
        cursor: move; /* For dragging */
        border-bottom: 1px solid #444;
        border-top-left-radius: 5px;
        border-top-right-radius: 5px;
        display: flex;
        justify-content: space-between;
        align-items: center;
    `;
    titleBar.textContent = 'Theme Options';

    const closeButton = document.createElement('span');
    closeButton.id = 'otk-options-close-btn';
    closeButton.innerHTML = '&#x2715;'; // 'X' character
    closeButton.style.cssText = `
        cursor: pointer;
        font-size: 16px;
        padding: 0 5px;
    `;
    closeButton.title = "Close Settings";

    titleBar.appendChild(closeButton);
    optionsWindow.appendChild(titleBar);

    const contentArea = document.createElement('div');
    contentArea.id = 'otk-options-content';
    contentArea.style.cssText = `
        padding: 15px;
        flex-grow: 1; /* Allows content to fill space */
        overflow-y: auto; /* If content gets too long */
        /* display: flex; Will be handled by section container */
        /* flex-direction: column; */
        /* gap: 10px; */
    `;
    optionsWindow.appendChild(contentArea);

    // --- Main Sections Container (for tabs or collapsible sections later) ---
    const sectionsContainer = document.createElement('div');
    contentArea.appendChild(sectionsContainer);

    // --- Theme/Appearance Section ---
    const themeSection = document.createElement('div');
    themeSection.id = 'otk-options-theme-section';
    themeSection.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 10px; /* Space between color option groups */
    `;
    // Add a heading for the section (optional)
    const themeSectionHeading = document.createElement('h4');
    themeSectionHeading.textContent = 'Appearance Settings';
    themeSectionHeading.style.cssText = "margin-top: 0; margin-bottom: 10px; border-bottom: 1px solid #555; padding-bottom: 5px;";
    themeSection.appendChild(themeSectionHeading);

    sectionsContainer.appendChild(themeSection); // Add theme section to main content

    document.body.appendChild(optionsWindow);

    // --- GUI Background Color Option --- (Now appends to themeSection)
    const guiBgGroup = document.createElement('div');
    guiBgGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";

    const guiBgLabel = document.createElement('label');
    guiBgLabel.textContent = "GUI Background:";
    guiBgLabel.htmlFor = 'otk-color-gui-bg-picker'; // Associate with picker
    guiBgLabel.style.minWidth = '130px';
    guiBgLabel.style.textAlign = 'right';
    guiBgLabel.style.marginRight = '5px';

    const guiBgHexInput = document.createElement('input');
    guiBgHexInput.type = 'text';
    guiBgHexInput.id = 'otk-color-gui-bg-hex';
    guiBgHexInput.style.width = '70px';
    guiBgHexInput.style.height = '25px';
    guiBgHexInput.style.boxSizing = 'border-box'; /* Include padding & border in height */

    const guiBgPicker = document.createElement('input');
    guiBgPicker.type = 'color';
    guiBgPicker.id = 'otk-color-gui-bg-picker';
    guiBgPicker.style.width = '45px'; /* Standardize width */
    guiBgPicker.style.height = '25px'; /* Standardize height */
    guiBgPicker.style.padding = '0px 2px'; /* Minimal padding, some browsers add their own */

    const guiBgDefaultBtn = document.createElement('button');
    guiBgDefaultBtn.textContent = 'Default';
    guiBgDefaultBtn.style.padding = '2px 5px';
    guiBgDefaultBtn.style.minWidth = '60px';
    guiBgDefaultBtn.style.height = '25px';

    guiBgGroup.appendChild(guiBgLabel);
    guiBgGroup.appendChild(guiBgHexInput);
    guiBgGroup.appendChild(guiBgPicker);
    guiBgGroup.appendChild(guiBgDefaultBtn);
    themeSection.appendChild(guiBgGroup); // Changed from contentArea

    // Logic for GUI Background Color
    const initialGuiBgColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-gui-bg-color').trim();

    const updateGuiBgColor = (color) => {
        color = color.trim();
        if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) {
            // Basic validation, not perfect for all hex forms but good enough for now
            // Potentially revert to a known good color or do nothing
            consoleWarn("Invalid hex color for GUI BG:", color);
            return; // Or set to a default/previous valid color
        }
        document.documentElement.style.setProperty('--otk-gui-bg-color', color);
        guiBgHexInput.value = color;
        guiBgPicker.value = color; // HTML5 color picker needs full 6-digit hex
        saveThemeSetting('guiBgColor', color);
    };

    guiBgHexInput.addEventListener('input', (e) => updateGuiBgColor(e.target.value));
    guiBgPicker.addEventListener('input', (e) => updateGuiBgColor(e.target.value));
    guiBgDefaultBtn.addEventListener('click', () => {
        document.documentElement.style.removeProperty('--otk-gui-bg-color');
        guiBgHexInput.value = initialGuiBgColor; // Reset inputs to original default
        guiBgPicker.value = initialGuiBgColor;
        saveThemeSetting('guiBgColor', null); // null or undefined to signify default
    });

    // Placeholder for "Reset All Colors" button (to be added later in this step or next)
    // const resetAllButton = document.createElement('button');
    // resetAllButton.textContent = "Reset All Colors to Default";
    // resetAllButton.style.marginTop = "15px";
    // contentArea.appendChild(resetAllButton);

    // --- GUI Title Text Color Option ---
    const titleTextColorGroup = document.createElement('div');
    titleTextColorGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";

    const titleTextColorLabel = document.createElement('label');
    titleTextColorLabel.textContent = "Title Text:";
    titleTextColorLabel.htmlFor = 'otk-color-title-text-picker';
    titleTextColorLabel.style.minWidth = '130px';
    titleTextColorLabel.style.textAlign = 'right';
    titleTextColorLabel.style.marginRight = '5px';

    const titleTextColorHexInput = document.createElement('input');
    titleTextColorHexInput.type = 'text';
    titleTextColorHexInput.id = 'otk-color-title-text-hex';
    titleTextColorHexInput.style.width = '70px';
    titleTextColorHexInput.style.height = '25px';
    titleTextColorHexInput.style.boxSizing = 'border-box';

    const titleTextColorPicker = document.createElement('input');
    titleTextColorPicker.type = 'color';
    titleTextColorPicker.id = 'otk-color-title-text-picker';
    titleTextColorPicker.style.width = '45px';
    titleTextColorPicker.style.height = '25px';
    titleTextColorPicker.style.padding = '0px 2px';

    const titleTextColorDefaultBtn = document.createElement('button');
    titleTextColorDefaultBtn.textContent = 'Default';
    titleTextColorDefaultBtn.style.padding = '2px 5px';
    titleTextColorDefaultBtn.style.minWidth = '60px';
    titleTextColorDefaultBtn.style.height = '25px';

    titleTextColorGroup.appendChild(titleTextColorLabel);
    titleTextColorGroup.appendChild(titleTextColorHexInput);
    titleTextColorGroup.appendChild(titleTextColorPicker);
    titleTextColorGroup.appendChild(titleTextColorDefaultBtn);
    themeSection.appendChild(titleTextColorGroup); // Changed from contentArea

    // Logic for Title Text Color
    const initialTitleTextColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-title-text-color').trim();

    const updateTitleTextColor = (color) => {
        color = color.trim();
        if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) {
            consoleWarn("Invalid hex color for Title Text:", color);
            return;
        }
        document.documentElement.style.setProperty('--otk-title-text-color', color);
        titleTextColorHexInput.value = color;
        titleTextColorPicker.value = color;
        saveThemeSetting('titleTextColor', color);
    };

    titleTextColorHexInput.addEventListener('input', (e) => updateTitleTextColor(e.target.value));
    titleTextColorPicker.addEventListener('input', (e) => updateTitleTextColor(e.target.value));
    titleTextColorDefaultBtn.addEventListener('click', () => {
        document.documentElement.style.removeProperty('--otk-title-text-color');
        titleTextColorHexInput.value = initialTitleTextColor;
        titleTextColorPicker.value = initialTitleTextColor;
        saveThemeSetting('titleTextColor', null);
    });

    // --- Options Panel Text Color Option --- (Formerly GUI Stats Text)
    const optionsTextColorGroup = document.createElement('div');
    optionsTextColorGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";

    const optionsTextColorLabel = document.createElement('label');
    optionsTextColorLabel.textContent = "Options Panel Text:"; // Relabeled
    optionsTextColorLabel.htmlFor = 'otk-color-options-text-picker';
    optionsTextColorLabel.style.minWidth = '130px';
    optionsTextColorLabel.style.textAlign = 'right';
    optionsTextColorLabel.style.marginRight = '5px';

    const optionsTextColorHexInput = document.createElement('input');
    optionsTextColorHexInput.type = 'text';
    optionsTextColorHexInput.id = 'otk-color-options-text-hex'; // New ID
    optionsTextColorHexInput.style.width = '70px';
    optionsTextColorHexInput.style.height = '25px';
    optionsTextColorHexInput.style.boxSizing = 'border-box';

    const optionsTextColorPicker = document.createElement('input');
    optionsTextColorPicker.type = 'color';
    optionsTextColorPicker.id = 'otk-color-options-text-picker'; // New ID
    optionsTextColorPicker.style.width = '45px';
    optionsTextColorPicker.style.height = '25px';
    optionsTextColorPicker.style.padding = '0px 2px';

    const optionsTextColorDefaultBtn = document.createElement('button');
    optionsTextColorDefaultBtn.textContent = 'Default';
    optionsTextColorDefaultBtn.style.padding = '2px 5px';
    optionsTextColorDefaultBtn.style.minWidth = '60px';
    optionsTextColorDefaultBtn.style.height = '25px';

    optionsTextColorGroup.appendChild(optionsTextColorLabel);
    optionsTextColorGroup.appendChild(optionsTextColorHexInput);
    optionsTextColorGroup.appendChild(optionsTextColorPicker);
    optionsTextColorGroup.appendChild(optionsTextColorDefaultBtn);
    themeSection.appendChild(optionsTextColorGroup); // Changed from contentArea

    // Logic for Options Panel Text Color (uses --otk-options-text-color)
    const initialOptionsTextColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-options-text-color').trim();

    const updateOptionsTextColor = (color) => {
        color = color.trim();
        if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) {
            consoleWarn("Invalid hex color for Options Panel Text:", color);
            return;
        }
        document.documentElement.style.setProperty('--otk-options-text-color', color); // Updated variable
        optionsTextColorHexInput.value = color;
        optionsTextColorPicker.value = color;
        saveThemeSetting('optionsTextColor', color); // Updated Key for localStorage
    };

    optionsTextColorHexInput.addEventListener('input', (e) => updateOptionsTextColor(e.target.value));
    optionsTextColorPicker.addEventListener('input', (e) => updateOptionsTextColor(e.target.value));
    optionsTextColorDefaultBtn.addEventListener('click', () => {
        document.documentElement.style.removeProperty('--otk-options-text-color'); // Updated variable
        optionsTextColorHexInput.value = initialOptionsTextColor;
        optionsTextColorPicker.value = initialOptionsTextColor;
        saveThemeSetting('optionsTextColor', null); // Updated key
    });

    // --- Actual Stats Text Color Option ---
    const actualStatsTextColorGroup = document.createElement('div');
    actualStatsTextColorGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";

    const actualStatsTextColorLabel = document.createElement('label');
    actualStatsTextColorLabel.textContent = "Stats Text (Actual):";
    actualStatsTextColorLabel.htmlFor = 'otk-color-actual-stats-text-picker';
    actualStatsTextColorLabel.style.minWidth = '130px';
    actualStatsTextColorLabel.style.textAlign = 'right';
    actualStatsTextColorLabel.style.marginRight = '5px';

    const actualStatsTextColorHexInput = document.createElement('input');
    actualStatsTextColorHexInput.type = 'text';
    actualStatsTextColorHexInput.id = 'otk-color-actual-stats-text-hex';
    actualStatsTextColorHexInput.style.width = '70px';
    actualStatsTextColorHexInput.style.height = '25px';
    actualStatsTextColorHexInput.style.boxSizing = 'border-box';

    const actualStatsTextColorPicker = document.createElement('input');
    actualStatsTextColorPicker.type = 'color';
    actualStatsTextColorPicker.id = 'otk-color-actual-stats-text-picker';
    actualStatsTextColorPicker.style.width = '45px';
    actualStatsTextColorPicker.style.height = '25px';
    actualStatsTextColorPicker.style.padding = '0px 2px';

    const actualStatsTextColorDefaultBtn = document.createElement('button');
    actualStatsTextColorDefaultBtn.textContent = 'Default';
    actualStatsTextColorDefaultBtn.style.padding = '2px 5px';
    actualStatsTextColorDefaultBtn.style.minWidth = '60px';
    actualStatsTextColorDefaultBtn.style.height = '25px';

    actualStatsTextColorGroup.appendChild(actualStatsTextColorLabel);
    actualStatsTextColorGroup.appendChild(actualStatsTextColorHexInput);
    actualStatsTextColorGroup.appendChild(actualStatsTextColorPicker);
    actualStatsTextColorGroup.appendChild(actualStatsTextColorDefaultBtn);
    themeSection.appendChild(actualStatsTextColorGroup); // Changed from contentArea

    // Logic for Actual Stats Text Color (uses --otk-stats-text-color)
    const initialActualStatsTextColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-stats-text-color').trim();

    const updateActualStatsTextColor = (color) => {
        color = color.trim();
        if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) {
            consoleWarn("Invalid hex color for Actual Stats Text:", color);
            return;
        }
        document.documentElement.style.setProperty('--otk-stats-text-color', color);
        actualStatsTextColorHexInput.value = color;
        actualStatsTextColorPicker.value = color;
        saveThemeSetting('actualStatsTextColor', color);
    };

    actualStatsTextColorHexInput.addEventListener('input', (e) => updateActualStatsTextColor(e.target.value));
    actualStatsTextColorPicker.addEventListener('input', (e) => updateActualStatsTextColor(e.target.value));
    actualStatsTextColorDefaultBtn.addEventListener('click', () => {
        document.documentElement.style.removeProperty('--otk-stats-text-color');
        actualStatsTextColorHexInput.value = initialActualStatsTextColor;
        actualStatsTextColorPicker.value = initialActualStatsTextColor;
        saveThemeSetting('actualStatsTextColor', null);
    });

    // --- Viewer Background Color Option ---
    const viewerBgGroup = document.createElement('div');
    viewerBgGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";

    const viewerBgLabel = document.createElement('label');
    viewerBgLabel.textContent = "Viewer Background:";
    viewerBgLabel.htmlFor = 'otk-color-viewer-bg-picker';
    viewerBgLabel.style.minWidth = '130px';
    viewerBgLabel.style.textAlign = 'right';
    viewerBgLabel.style.marginRight = '5px';

    const viewerBgHexInput = document.createElement('input');
    viewerBgHexInput.type = 'text';
    viewerBgHexInput.id = 'otk-color-viewer-bg-hex';
    viewerBgHexInput.style.width = '70px';
    viewerBgHexInput.style.height = '25px';
    viewerBgHexInput.style.boxSizing = 'border-box';

    const viewerBgPicker = document.createElement('input');
    viewerBgPicker.type = 'color';
    viewerBgPicker.id = 'otk-color-viewer-bg-picker';
    viewerBgPicker.style.width = '45px';
    viewerBgPicker.style.height = '25px';
    viewerBgPicker.style.padding = '0px 2px';

    const viewerBgDefaultBtn = document.createElement('button');
    viewerBgDefaultBtn.textContent = 'Default';
    viewerBgDefaultBtn.style.padding = '2px 5px';
    viewerBgDefaultBtn.style.minWidth = '60px';
    viewerBgDefaultBtn.style.height = '25px';

    viewerBgGroup.appendChild(viewerBgLabel);
    viewerBgGroup.appendChild(viewerBgHexInput);
    viewerBgGroup.appendChild(viewerBgPicker);
    viewerBgGroup.appendChild(viewerBgDefaultBtn);
    themeSection.appendChild(viewerBgGroup); // Changed from contentArea

    // Logic for Viewer Background Color
    const initialViewerBgColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-viewer-bg-color').trim();

    const updateViewerBgColor = (color) => {
        color = color.trim();
        if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) {
            consoleWarn("Invalid hex color for Viewer BG:", color);
            return;
        }
        document.documentElement.style.setProperty('--otk-viewer-bg-color', color);
        viewerBgHexInput.value = color;
        viewerBgPicker.value = color;
        saveThemeSetting('viewerBgColor', color);
    };

    viewerBgHexInput.addEventListener('input', (e) => updateViewerBgColor(e.target.value));
    viewerBgPicker.addEventListener('input', (e) => updateViewerBgColor(e.target.value));
    viewerBgDefaultBtn.addEventListener('click', () => {
        document.documentElement.style.removeProperty('--otk-viewer-bg-color');
        viewerBgHexInput.value = initialViewerBgColor;
        viewerBgPicker.value = initialViewerBgColor;
        saveThemeSetting('viewerBgColor', null);
    });

    // --- Thread List Titles Color Option ---
    const threadListTitleColorGroup = document.createElement('div');
    threadListTitleColorGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";

    const threadListTitleColorLabel = document.createElement('label');
    threadListTitleColorLabel.textContent = "Thread List Titles:";
    threadListTitleColorLabel.htmlFor = 'otk-color-threadlist-title-picker';
    threadListTitleColorLabel.style.minWidth = '130px';
    threadListTitleColorLabel.style.textAlign = 'right';
    threadListTitleColorLabel.style.marginRight = '5px';

    const threadListTitleColorHexInput = document.createElement('input');
    threadListTitleColorHexInput.type = 'text';
    threadListTitleColorHexInput.id = 'otk-color-threadlist-title-hex';
    threadListTitleColorHexInput.style.width = '70px';
    threadListTitleColorHexInput.style.height = '25px';
    threadListTitleColorHexInput.style.boxSizing = 'border-box';

    const threadListTitleColorPicker = document.createElement('input');
    threadListTitleColorPicker.type = 'color';
    threadListTitleColorPicker.id = 'otk-color-threadlist-title-picker';
    threadListTitleColorPicker.style.width = '45px';
    threadListTitleColorPicker.style.height = '25px';
    threadListTitleColorPicker.style.padding = '0px 2px';

    const threadListTitleColorDefaultBtn = document.createElement('button');
    threadListTitleColorDefaultBtn.textContent = 'Default';
    threadListTitleColorDefaultBtn.style.padding = '2px 5px';
    threadListTitleColorDefaultBtn.style.minWidth = '60px';
    threadListTitleColorDefaultBtn.style.height = '25px';

    threadListTitleColorGroup.appendChild(threadListTitleColorLabel);
    threadListTitleColorGroup.appendChild(threadListTitleColorHexInput);
    threadListTitleColorGroup.appendChild(threadListTitleColorPicker);
    threadListTitleColorGroup.appendChild(threadListTitleColorDefaultBtn);
    contentArea.appendChild(threadListTitleColorGroup);

    // Logic for Thread List Titles Color
    const initialThreadListTitleColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-gui-threadlist-title-color').trim();

    const updateThreadListTitleColor = (color) => {
        color = color.trim();
        if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) {
            consoleWarn("Invalid hex color for Thread List Titles:", color);
            return;
        }
        document.documentElement.style.setProperty('--otk-gui-threadlist-title-color', color);
        threadListTitleColorHexInput.value = color;
        threadListTitleColorPicker.value = color;
        saveThemeSetting('guiThreadListTitleColor', color);
    };

    threadListTitleColorHexInput.addEventListener('input', (e) => updateThreadListTitleColor(e.target.value));
    threadListTitleColorPicker.addEventListener('input', (e) => updateThreadListTitleColor(e.target.value));
    threadListTitleColorDefaultBtn.addEventListener('click', () => {
        document.documentElement.style.removeProperty('--otk-gui-threadlist-title-color');
        threadListTitleColorHexInput.value = initialThreadListTitleColor;
        threadListTitleColorPicker.value = initialThreadListTitleColor;
        saveThemeSetting('guiThreadListTitleColor', null);
    });

    // --- Thread List Timestamps Color Option ---
    const threadListTimeColorGroup = document.createElement('div');
    threadListTimeColorGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";

    const threadListTimeColorLabel = document.createElement('label');
    threadListTimeColorLabel.textContent = "Thread List Times:";
    threadListTimeColorLabel.htmlFor = 'otk-color-threadlist-time-picker';
    threadListTimeColorLabel.style.minWidth = '130px';
    threadListTimeColorLabel.style.textAlign = 'right';
    threadListTimeColorLabel.style.marginRight = '5px';

    const threadListTimeColorHexInput = document.createElement('input');
    threadListTimeColorHexInput.type = 'text';
    threadListTimeColorHexInput.id = 'otk-color-threadlist-time-hex';
    threadListTimeColorHexInput.style.width = '70px';
    threadListTimeColorHexInput.style.height = '25px';
    threadListTimeColorHexInput.style.boxSizing = 'border-box';

    const threadListTimeColorPicker = document.createElement('input');
    threadListTimeColorPicker.type = 'color';
    threadListTimeColorPicker.id = 'otk-color-threadlist-time-picker';
    threadListTimeColorPicker.style.width = '45px';
    threadListTimeColorPicker.style.height = '25px';
    threadListTimeColorPicker.style.padding = '0px 2px';

    const threadListTimeColorDefaultBtn = document.createElement('button');
    threadListTimeColorDefaultBtn.textContent = 'Default';
    threadListTimeColorDefaultBtn.style.padding = '2px 5px';
    threadListTimeColorDefaultBtn.style.minWidth = '60px';
    threadListTimeColorDefaultBtn.style.height = '25px';

    threadListTimeColorGroup.appendChild(threadListTimeColorLabel);
    threadListTimeColorGroup.appendChild(threadListTimeColorHexInput);
    threadListTimeColorGroup.appendChild(threadListTimeColorPicker);
    threadListTimeColorGroup.appendChild(threadListTimeColorDefaultBtn);
    contentArea.appendChild(threadListTimeColorGroup);

    // Logic for Thread List Timestamps Color
    const initialThreadListTimeColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-gui-threadlist-time-color').trim();

    const updateThreadListTimeColor = (color) => {
        color = color.trim();
        if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) {
            consoleWarn("Invalid hex color for Thread List Times:", color);
            return;
        }
        document.documentElement.style.setProperty('--otk-gui-threadlist-time-color', color);
        threadListTimeColorHexInput.value = color;
        threadListTimeColorPicker.value = color;
        saveThemeSetting('guiThreadListTimeColor', color);
    };

    threadListTimeColorHexInput.addEventListener('input', (e) => updateThreadListTimeColor(e.target.value));
    threadListTimeColorPicker.addEventListener('input', (e) => updateThreadListTimeColor(e.target.value));
    threadListTimeColorDefaultBtn.addEventListener('click', () => {
        document.documentElement.style.removeProperty('--otk-gui-threadlist-time-color');
        threadListTimeColorHexInput.value = initialThreadListTimeColor;
        threadListTimeColorPicker.value = initialThreadListTimeColor;
        saveThemeSetting('guiThreadListTimeColor', null);
    });

    // --- Viewer Header Border Color Option ---
    const viewerHeaderBorderColorGroup = document.createElement('div');
    viewerHeaderBorderColorGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";
    const viewerHeaderBorderColorLabel = document.createElement('label');
    viewerHeaderBorderColorLabel.textContent = "Viewer Header Border:";
    viewerHeaderBorderColorLabel.htmlFor = 'otk-color-viewer-header-border-picker';
    viewerHeaderBorderColorLabel.style.cssText = "min-width: 130px; text-align: right; margin-right: 5px;";
    const viewerHeaderBorderColorHexInput = document.createElement('input');
    viewerHeaderBorderColorHexInput.type = 'text';
    viewerHeaderBorderColorHexInput.id = 'otk-color-viewer-header-border-hex';
    viewerHeaderBorderColorHexInput.style.cssText = "width: 70px; height: 25px; box-sizing: border-box;";
    const viewerHeaderBorderColorPicker = document.createElement('input');
    viewerHeaderBorderColorPicker.type = 'color';
    viewerHeaderBorderColorPicker.id = 'otk-color-viewer-header-border-picker';
    viewerHeaderBorderColorPicker.style.cssText = "width: 45px; height: 25px; padding: 0px 2px;";
    const viewerHeaderBorderColorDefaultBtn = document.createElement('button');
    viewerHeaderBorderColorDefaultBtn.textContent = 'Default';
    viewerHeaderBorderColorDefaultBtn.style.cssText = "padding: 2px 5px; min-width: 60px; height: 25px;";
    viewerHeaderBorderColorGroup.append(viewerHeaderBorderColorLabel, viewerHeaderBorderColorHexInput, viewerHeaderBorderColorPicker, viewerHeaderBorderColorDefaultBtn);
    contentArea.appendChild(viewerHeaderBorderColorGroup);
    const initialViewerHeaderBorderColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-viewer-header-border-color').trim();
    const updateViewerHeaderBorderColor = (color) => {
        color = color.trim();
        if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) return;
        document.documentElement.style.setProperty('--otk-viewer-header-border-color', color);
        viewerHeaderBorderColorHexInput.value = color;
        viewerHeaderBorderColorPicker.value = color;
        saveThemeSetting('viewerHeaderBorderColor', color);
    };
    viewerHeaderBorderColorHexInput.addEventListener('input', (e) => updateViewerHeaderBorderColor(e.target.value));
    viewerHeaderBorderColorPicker.addEventListener('input', (e) => updateViewerHeaderBorderColor(e.target.value));
    viewerHeaderBorderColorDefaultBtn.addEventListener('click', () => {
        document.documentElement.style.removeProperty('--otk-viewer-header-border-color');
        viewerHeaderBorderColorHexInput.value = initialViewerHeaderBorderColor;
        viewerHeaderBorderColorPicker.value = initialViewerHeaderBorderColor;
        saveThemeSetting('viewerHeaderBorderColor', null);
    });

    // --- Viewer Quote L1 Border Color Option ---
    const viewerQuote1BorderColorGroup = document.createElement('div');
    viewerQuote1BorderColorGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";
    const viewerQuote1BorderColorLabel = document.createElement('label');
    viewerQuote1BorderColorLabel.textContent = "Quote L1 Header Border:";
    viewerQuote1BorderColorLabel.htmlFor = 'otk-color-viewer-quote1-border-picker';
    viewerQuote1BorderColorLabel.style.cssText = "min-width: 130px; text-align: right; margin-right: 5px;";
    const viewerQuote1BorderColorHexInput = document.createElement('input');
    viewerQuote1BorderColorHexInput.type = 'text';
    viewerQuote1BorderColorHexInput.id = 'otk-color-viewer-quote1-border-hex';
    viewerQuote1BorderColorHexInput.style.cssText = "width: 70px; height: 25px; box-sizing: border-box;";
    const viewerQuote1BorderColorPicker = document.createElement('input');
    viewerQuote1BorderColorPicker.type = 'color';
    viewerQuote1BorderColorPicker.id = 'otk-color-viewer-quote1-border-picker';
    viewerQuote1BorderColorPicker.style.cssText = "width: 45px; height: 25px; padding: 0px 2px;";
    const viewerQuote1BorderColorDefaultBtn = document.createElement('button');
    viewerQuote1BorderColorDefaultBtn.textContent = 'Default';
    viewerQuote1BorderColorDefaultBtn.style.cssText = "padding: 2px 5px; min-width: 60px; height: 25px;";
    viewerQuote1BorderColorGroup.append(viewerQuote1BorderColorLabel, viewerQuote1BorderColorHexInput, viewerQuote1BorderColorPicker, viewerQuote1BorderColorDefaultBtn);
    contentArea.appendChild(viewerQuote1BorderColorGroup);
    const initialViewerQuote1BorderColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-viewer-quote1-header-border-color').trim();
    const updateViewerQuote1BorderColor = (color) => {
        color = color.trim();
        if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) return;
        document.documentElement.style.setProperty('--otk-viewer-quote1-header-border-color', color);
        viewerQuote1BorderColorHexInput.value = color;
        viewerQuote1BorderColorPicker.value = color;
        saveThemeSetting('viewerQuote1HeaderBorderColor', color);
    };
    viewerQuote1BorderColorHexInput.addEventListener('input', (e) => updateViewerQuote1BorderColor(e.target.value));
    viewerQuote1BorderColorPicker.addEventListener('input', (e) => updateViewerQuote1BorderColor(e.target.value));
    viewerQuote1BorderColorDefaultBtn.addEventListener('click', () => {
        document.documentElement.style.removeProperty('--otk-viewer-quote1-header-border-color');
        viewerQuote1BorderColorHexInput.value = initialViewerQuote1BorderColor;
        viewerQuote1BorderColorPicker.value = initialViewerQuote1BorderColor;
        saveThemeSetting('viewerQuote1HeaderBorderColor', null);
    });

    // --- Message Background Colors ---
    ['Depth 0', 'Depth 1', 'Depth 2+'].forEach((label, index) => {
        const key = `msgDepth${index === 2 ? '2plus' : index}BgColor`;
        const cssVar = `--otk-msg-depth${index === 2 ? '2plus' : index}-bg-color`;
        const idSuffix = `msg-depth${index === 2 ? '2plus' : index}-bg`; // Used for IDs

        const group = document.createElement('div');
        group.style.cssText = "display: flex; align-items: center; gap: 8px;";
        const lbl = document.createElement('label');
        lbl.textContent = `Msg BG (${label}):`;
        lbl.htmlFor = `otk-color-${idSuffix}-picker`;
        lbl.style.cssText = "min-width: 130px; text-align: right; margin-right: 5px;";
        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.id = `otk-color-${idSuffix}-hex`;
        hexInput.style.cssText = "width: 70px; height: 25px; box-sizing: border-box;";
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.id = `otk-color-${idSuffix}-picker`;
        picker.style.cssText = "width: 45px; height: 25px; padding: 0px 2px;";
        const defaultBtn = document.createElement('button');
        defaultBtn.textContent = 'Default';
        defaultBtn.style.cssText = "padding: 2px 5px; min-width: 60px; height: 25px;";

        group.append(lbl, hexInput, picker, defaultBtn);
        themeSection.appendChild(group); // Changed from contentArea

        const initialColor = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
        const updateColor = (color) => {
            color = color.trim();
            if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) return;
            document.documentElement.style.setProperty(cssVar, color);
            hexInput.value = color;
            picker.value = color;
            saveThemeSetting(key, color);
        };
        hexInput.addEventListener('input', (e) => updateColor(e.target.value));
        picker.addEventListener('input', (e) => updateColor(e.target.value));
        defaultBtn.addEventListener('click', () => {
            document.documentElement.style.removeProperty(cssVar);
            hexInput.value = initialColor;
            picker.value = initialColor;
            saveThemeSetting(key, null);
        });
    });

    // --- Message Body Text Colors ---
    ['Depth 0', 'Depth 1', 'Depth 2+'].forEach((label, index) => {
        const key = `msgDepth${index === 2 ? '2plus' : index}TextColor`;
        const cssVar = `--otk-msg-depth${index === 2 ? '2plus' : index}-text-color`;
        const idSuffix = `msg-depth${index === 2 ? '2plus' : index}-text`; // Used for IDs

        const group = document.createElement('div');
        group.style.cssText = "display: flex; align-items: center; gap: 8px;";
        const lbl = document.createElement('label');
        lbl.textContent = `Msg Text (${label}):`;
        lbl.htmlFor = `otk-color-${idSuffix}-picker`;
        lbl.style.cssText = "min-width: 130px; text-align: right; margin-right: 5px;";
        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.id = `otk-color-${idSuffix}-hex`;
        hexInput.style.cssText = "width: 70px; height: 25px; box-sizing: border-box;";
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.id = `otk-color-${idSuffix}-picker`;
        picker.style.cssText = "width: 45px; height: 25px; padding: 0px 2px;";
        const defaultBtn = document.createElement('button');
        defaultBtn.textContent = 'Default';
        defaultBtn.style.cssText = "padding: 2px 5px; min-width: 60px; height: 25px;";

        group.append(lbl, hexInput, picker, defaultBtn);
        themeSection.appendChild(group); // Changed from contentArea

        const initialColor = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
        const updateColor = (color) => {
            color = color.trim();
            if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) return;
            document.documentElement.style.setProperty(cssVar, color);
            hexInput.value = color;
            picker.value = color;
            saveThemeSetting(key, color);
        };
        hexInput.addEventListener('input', (e) => updateColor(e.target.value));
        picker.addEventListener('input', (e) => updateColor(e.target.value));
        defaultBtn.addEventListener('click', () => {
            document.documentElement.style.removeProperty(cssVar);
            hexInput.value = initialColor;
            picker.value = initialColor;
            saveThemeSetting(key, null);
        });
    });

    // --- Message Header Text Colors ---
    ['Depth 0', 'Depth 1', 'Depth 2+'].forEach((label, index) => {
        const key = `msgDepth${index === 2 ? '2plus' : index}HeaderTextColor`;
        const cssVar = `--otk-msg-depth${index === 2 ? '2plus' : index}-header-text-color`;
        const idSuffix = `msg-depth${index === 2 ? '2plus' : index}-header-text`;

        const group = document.createElement('div');
        group.style.cssText = "display: flex; align-items: center; gap: 8px;";
        const lbl = document.createElement('label');
        lbl.textContent = `Msg Header (${label}):`;
        lbl.htmlFor = `otk-color-${idSuffix}-picker`;
        lbl.style.cssText = "min-width: 130px; text-align: right; margin-right: 5px;";
        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.id = `otk-color-${idSuffix}-hex`;
        hexInput.style.cssText = "width: 70px; height: 25px; box-sizing: border-box;";
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.id = `otk-color-${idSuffix}-picker`;
        picker.style.cssText = "width: 45px; height: 25px; padding: 0px 2px;";
        const defaultBtn = document.createElement('button');
        defaultBtn.textContent = 'Default';
        defaultBtn.style.cssText = "padding: 2px 5px; min-width: 60px; height: 25px;";

        group.append(lbl, hexInput, picker, defaultBtn);
        themeSection.appendChild(group); // Changed from contentArea

        const initialColor = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
        const updateColor = (color) => {
            color = color.trim();
            if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) return;
            document.documentElement.style.setProperty(cssVar, color);
            hexInput.value = color;
            picker.value = color;
            saveThemeSetting(key, color);
        };
        hexInput.addEventListener('input', (e) => updateColor(e.target.value));
        picker.addEventListener('input', (e) => updateColor(e.target.value));
        defaultBtn.addEventListener('click', () => {
            document.documentElement.style.removeProperty(cssVar);
            hexInput.value = initialColor;
            picker.value = initialColor;
            saveThemeSetting(key, null);
        });
    });

    // --- Viewer Message Font Size Option ---
    const msgFontSizeGroup = document.createElement('div');
    msgFontSizeGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";

    const msgFontSizeLabel = document.createElement('label');
    msgFontSizeLabel.textContent = "Message Font Size (px):";
    msgFontSizeLabel.htmlFor = 'otk-fontsize-message-text';
    msgFontSizeLabel.style.cssText = "min-width: 130px; text-align: right; margin-right: 5px;";

    const msgFontSizeInput = document.createElement('input');
    msgFontSizeInput.type = 'number';
    msgFontSizeInput.id = 'otk-fontsize-message-text';
    msgFontSizeInput.min = '8';
    msgFontSizeInput.max = '24';
    msgFontSizeInput.style.cssText = "width: 70px; height: 25px; box-sizing: border-box;";

    const msgFontSizeDefaultBtn = document.createElement('button');
    msgFontSizeDefaultBtn.textContent = 'Default';
    msgFontSizeDefaultBtn.style.cssText = "padding: 2px 5px; min-width: 60px; height: 25px;";

    msgFontSizeGroup.append(msgFontSizeLabel, msgFontSizeInput, msgFontSizeDefaultBtn);
    themeSection.appendChild(msgFontSizeGroup); // Changed from contentArea

    const initialMsgFontSize = getComputedStyle(document.documentElement).getPropertyValue('--otk-viewer-message-font-size').trim().replace('px', '');

    const updateMsgFontSize = (size) => {
        size = parseInt(size, 10);
        if (isNaN(size) || size < parseInt(msgFontSizeInput.min, 10) || size > parseInt(msgFontSizeInput.max, 10)) {
            consoleWarn("Invalid font size:", size);
            // Optionally revert to initialMsgFontSize or clamp
            msgFontSizeInput.value = initialMsgFontSize; // Revert to initial if invalid
            return;
        }
        document.documentElement.style.setProperty('--otk-viewer-message-font-size', `${size}px`);
        msgFontSizeInput.value = size; // Ensure input reflects validated size
        saveThemeSetting('viewerMessageFontSize', `${size}px`);
    };

    msgFontSizeInput.addEventListener('change', (e) => updateMsgFontSize(e.target.value)); // 'change' is better for number input validation
    msgFontSizeDefaultBtn.addEventListener('click', () => {
        document.documentElement.style.removeProperty('--otk-viewer-message-font-size');
        msgFontSizeInput.value = initialMsgFontSize;
        saveThemeSetting('viewerMessageFontSize', null);
    });

    // --- GUI Bottom Border Color Option ---
    const guiBottomBorderColorGroup = document.createElement('div');
    guiBottomBorderColorGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";
    const guiBottomBorderColorLabel = document.createElement('label');
    guiBottomBorderColorLabel.textContent = "GUI Bottom Border:";
    guiBottomBorderColorLabel.htmlFor = 'otk-color-gui-bottom-border-picker';
    guiBottomBorderColorLabel.style.cssText = "min-width: 130px; text-align: right; margin-right: 5px;";
    const guiBottomBorderColorHexInput = document.createElement('input');
    guiBottomBorderColorHexInput.type = 'text';
    guiBottomBorderColorHexInput.id = 'otk-color-gui-bottom-border-hex';
    guiBottomBorderColorHexInput.style.cssText = "width: 70px; height: 25px; box-sizing: border-box;";
    const guiBottomBorderColorPicker = document.createElement('input');
    guiBottomBorderColorPicker.type = 'color';
    guiBottomBorderColorPicker.id = 'otk-color-gui-bottom-border-picker';
    guiBottomBorderColorPicker.style.cssText = "width: 45px; height: 25px; padding: 0px 2px;";
    const guiBottomBorderColorDefaultBtn = document.createElement('button');
    guiBottomBorderColorDefaultBtn.textContent = 'Default';
    guiBottomBorderColorDefaultBtn.style.cssText = "padding: 2px 5px; min-width: 60px; height: 25px;";
    guiBottomBorderColorGroup.append(guiBottomBorderColorLabel, guiBottomBorderColorHexInput, guiBottomBorderColorPicker, guiBottomBorderColorDefaultBtn);
    themeSection.appendChild(guiBottomBorderColorGroup); // Appending to themeSection

    const initialGuiBottomBorderColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-gui-bottom-border-color').trim();
    const updateGuiBottomBorderColor = (color) => {
        color = color.trim();
        if (!/^#[0-9A-F]{6}$/i.test(color) && !/^#[0-9A-F]{3}$/i.test(color)) return;
        document.documentElement.style.setProperty('--otk-gui-bottom-border-color', color);
        guiBottomBorderColorHexInput.value = color;
        guiBottomBorderColorPicker.value = color;
        saveThemeSetting('guiBottomBorderColor', color);
    };
    guiBottomBorderColorHexInput.addEventListener('input', (e) => updateGuiBottomBorderColor(e.target.value));
    guiBottomBorderColorPicker.addEventListener('input', (e) => updateGuiBottomBorderColor(e.target.value));
    guiBottomBorderColorDefaultBtn.addEventListener('click', () => {
        document.documentElement.style.removeProperty('--otk-gui-bottom-border-color');
        guiBottomBorderColorHexInput.value = initialGuiBottomBorderColor;
        guiBottomBorderColorPicker.value = initialGuiBottomBorderColor;
        saveThemeSetting('guiBottomBorderColor', null);
    });


    const resetAllColorsButton = document.createElement('button');
    resetAllColorsButton.textContent = "Reset All Colors to Default";
    resetAllColorsButton.id = 'otk-reset-all-colors-btn';
    resetAllColorsButton.style.marginTop = "20px"; // Add some space above it
    resetAllColorsButton.style.padding = "5px 10px";
    themeSection.appendChild(resetAllColorsButton); // Changed from contentArea

    resetAllColorsButton.addEventListener('click', () => {
        if (!confirm("Are you sure you want to reset all color settings to their defaults?")) {
            return;
        }
        consoleLog("Resetting all implemented color settings to default...");

        // GUI Background Color
        document.documentElement.style.removeProperty('--otk-gui-bg-color');
        const guiBgHexInput = document.getElementById('otk-color-gui-bg-hex');
        const guiBgPicker = document.getElementById('otk-color-gui-bg-picker');
        if (guiBgHexInput) guiBgHexInput.value = initialGuiBgColor; // initialGuiBgColor is in scope
        if (guiBgPicker) guiBgPicker.value = initialGuiBgColor;
        saveThemeSetting('guiBgColor', null);

        // Title Text Color
        document.documentElement.style.removeProperty('--otk-title-text-color');
        const titleTextColorHexInput = document.getElementById('otk-color-title-text-hex');
        const titleTextColorPicker = document.getElementById('otk-color-title-text-picker');
        if (titleTextColorHexInput) titleTextColorHexInput.value = initialTitleTextColor; // initialTitleTextColor is in scope
        if (titleTextColorPicker) titleTextColorPicker.value = initialTitleTextColor;
        saveThemeSetting('titleTextColor', null);

        // Options Panel Text Color (formerly GUI Text Color / Stats Text)
        document.documentElement.style.removeProperty('--otk-options-text-color');
        const optionsTextColorHexInput = document.getElementById('otk-color-options-text-hex');
        const optionsTextColorPicker = document.getElementById('otk-color-options-text-picker');
        if (optionsTextColorHexInput) optionsTextColorHexInput.value = initialOptionsTextColor; // initialOptionsTextColor is in scope
        if (optionsTextColorPicker) optionsTextColorPicker.value = initialOptionsTextColor;
        saveThemeSetting('optionsTextColor', null);

        // Actual Stats Text Color
        document.documentElement.style.removeProperty('--otk-stats-text-color');
        const actualStatsTextColorHexInput = document.getElementById('otk-color-actual-stats-text-hex');
        const actualStatsTextColorPicker = document.getElementById('otk-color-actual-stats-text-picker');
        if (actualStatsTextColorHexInput) actualStatsTextColorHexInput.value = initialActualStatsTextColor; // initialActualStatsTextColor is in scope
        if (actualStatsTextColorPicker) actualStatsTextColorPicker.value = initialActualStatsTextColor;
        saveThemeSetting('actualStatsTextColor', null);

        // Viewer Background Color
        document.documentElement.style.removeProperty('--otk-viewer-bg-color');
        const viewerBgHexInput = document.getElementById('otk-color-viewer-bg-hex');
        const viewerBgPicker = document.getElementById('otk-color-viewer-bg-picker');
        if (viewerBgHexInput) viewerBgHexInput.value = initialViewerBgColor; // initialViewerBgColor is in scope
        if (viewerBgPicker) viewerBgPicker.value = initialViewerBgColor;
        saveThemeSetting('viewerBgColor', null);

        // GUI Thread List Titles
        document.documentElement.style.removeProperty('--otk-gui-threadlist-title-color');
        const threadListTitleColorHexInput = document.getElementById('otk-color-threadlist-title-hex');
        const threadListTitleColorPicker = document.getElementById('otk-color-threadlist-title-picker');
        if (threadListTitleColorHexInput) threadListTitleColorHexInput.value = initialThreadListTitleColor; // in scope
        if (threadListTitleColorPicker) threadListTitleColorPicker.value = initialThreadListTitleColor;
        saveThemeSetting('guiThreadListTitleColor', null);

        // GUI Thread List Times
        document.documentElement.style.removeProperty('--otk-gui-threadlist-time-color');
        const threadListTimeColorHexInput = document.getElementById('otk-color-threadlist-time-hex');
        const threadListTimeColorPicker = document.getElementById('otk-color-threadlist-time-picker');
        if (threadListTimeColorHexInput) threadListTimeColorHexInput.value = initialThreadListTimeColor; // in scope
        if (threadListTimeColorPicker) threadListTimeColorPicker.value = initialThreadListTimeColor;
        saveThemeSetting('guiThreadListTimeColor', null);

        // Viewer Header Border
        document.documentElement.style.removeProperty('--otk-viewer-header-border-color');
        const viewerHeaderBorderColorHexInput = document.getElementById('otk-color-viewer-header-border-hex');
        const viewerHeaderBorderColorPicker = document.getElementById('otk-color-viewer-header-border-picker');
        if (viewerHeaderBorderColorHexInput) viewerHeaderBorderColorHexInput.value = initialViewerHeaderBorderColor; // in scope
        if (viewerHeaderBorderColorPicker) viewerHeaderBorderColorPicker.value = initialViewerHeaderBorderColor;
        saveThemeSetting('viewerHeaderBorderColor', null);

        // Viewer Quote L1 Border
        document.documentElement.style.removeProperty('--otk-viewer-quote1-header-border-color');
        const viewerQuote1BorderColorHexInput = document.getElementById('otk-color-viewer-quote1-border-hex');
        const viewerQuote1BorderColorPicker = document.getElementById('otk-color-viewer-quote1-border-picker');
        if (viewerQuote1BorderColorHexInput) viewerQuote1BorderColorHexInput.value = initialViewerQuote1BorderColor; // in scope
        if (viewerQuote1BorderColorPicker) viewerQuote1BorderColorPicker.value = initialViewerQuote1BorderColor;
        saveThemeSetting('viewerQuote1HeaderBorderColor', null);

        // Message BG, Text, Header Text Colors by Depth
        ['Depth 0', 'Depth 1', 'Depth 2+'].forEach((label, index) => {
            const depthSuffix = index === 2 ? '2plus' : index;
            // BG
            const bgKey = `msgDepth${depthSuffix}BgColor`;
            const bgCssVar = `--otk-msg-depth${depthSuffix}-bg-color`;
            const bgIdSuffix = `msg-depth${depthSuffix}-bg`;
            document.documentElement.style.removeProperty(bgCssVar);
            const bgHexInput = document.getElementById(`otk-color-${bgIdSuffix}-hex`);
            const bgPicker = document.getElementById(`otk-color-${bgIdSuffix}-picker`);
            // Need to fetch initial default for these dynamically created inputs or re-use the one from their setup.
            // For simplicity now, just clearing. Proper reset would re-fetch or store initial defaults globally.
            // This requires initial<Type>Color variables to be accessible or re-fetched.
            // For now, this will clear the override; the CSS default will apply. The input fields might not update to CSS default.
            // This part needs the initial<ColorName> variables to be accessible.
            // Let's assume they are in scope (they are defined within setupOptionsWindow for each group)
            // This is a simplification: a more robust reset would get defaults from CSS again for inputs.
            const initialBg = getComputedStyle(document.documentElement).getPropertyValue(bgCssVar).trim();
            if (bgHexInput) bgHexInput.value = initialBg;
            if (bgPicker) bgPicker.value = initialBg;
            saveThemeSetting(bgKey, null);

            // Text
            const textKey = `msgDepth${depthSuffix}TextColor`;
            const textCssVar = `--otk-msg-depth${depthSuffix}-text-color`;
            const textIdSuffix = `msg-depth${depthSuffix}-text`;
            document.documentElement.style.removeProperty(textCssVar);
            const textHexInput = document.getElementById(`otk-color-${textIdSuffix}-hex`);
            const textPicker = document.getElementById(`otk-color-${textIdSuffix}-picker`);
            const initialText = getComputedStyle(document.documentElement).getPropertyValue(textCssVar).trim();
            if (textHexInput) textHexInput.value = initialText;
            if (textPicker) textPicker.value = initialText;
            saveThemeSetting(textKey, null);

            // Header Text
            const headerTextKey = `msgDepth${depthSuffix}HeaderTextColor`;
            const headerTextCssVar = `--otk-msg-depth${depthSuffix}-header-text-color`;
            const headerTextIdSuffix = `msg-depth${depthSuffix}-header-text`;
            document.documentElement.style.removeProperty(headerTextCssVar);
            const headerTextHexInput = document.getElementById(`otk-color-${headerTextIdSuffix}-hex`);
            const headerTextPicker = document.getElementById(`otk-color-${headerTextIdSuffix}-picker`);
            const initialHeaderText = getComputedStyle(document.documentElement).getPropertyValue(headerTextCssVar).trim();
            if (headerTextHexInput) headerTextHexInput.value = initialHeaderText;
            if (headerTextPicker) headerTextPicker.value = initialHeaderText;
            saveThemeSetting(headerTextKey, null);
        });

        // Viewer Message Font Size
        document.documentElement.style.removeProperty('--otk-viewer-message-font-size');
        const msgFontSizeInput = document.getElementById('otk-fontsize-message-text');
        if (msgFontSizeInput) msgFontSizeInput.value = initialMsgFontSize; // in scope
        saveThemeSetting('viewerMessageFontSize', null);

        // GUI Bottom Border Color
        document.documentElement.style.removeProperty('--otk-gui-bottom-border-color');
        const guiBottomBorderColorHexInput = document.getElementById('otk-color-gui-bottom-border-hex');
        const guiBottomBorderColorPicker = document.getElementById('otk-color-gui-bottom-border-picker');
        if (guiBottomBorderColorHexInput) guiBottomBorderColorHexInput.value = initialGuiBottomBorderColor; // in scope
        if (guiBottomBorderColorPicker) guiBottomBorderColorPicker.value = initialGuiBottomBorderColor;
        saveThemeSetting('guiBottomBorderColor', null);

        alert("All customized color and font size settings have been reset to their defaults.");
    });


    // Event Listeners for cog and close
    const cogIcon = document.getElementById('otk-settings-cog');
    if (cogIcon) {
        cogIcon.addEventListener('click', () => {
            optionsWindow.style.display = optionsWindow.style.display === 'none' ? 'flex' : 'none';
            consoleLog("Toggled options window visibility to:", optionsWindow.style.display);
        });
    } else {
        consoleError("Cog icon not found for options window toggle.");
    }

    closeButton.addEventListener('click', () => {
        optionsWindow.style.display = 'none';
        consoleLog("Options window closed.");
    });

    // Make window draggable
    let isDragging = false;
    let offsetX, offsetY;

    titleBar.addEventListener('mousedown', (e) => {
        // Prevent dragging if clicking on the close button itself
        if (e.target === closeButton || closeButton.contains(e.target)) {
            return;
        }
        isDragging = true;
        offsetX = e.clientX - optionsWindow.offsetLeft;
        offsetY = e.clientY - optionsWindow.offsetTop;
        titleBar.style.userSelect = 'none'; // Prevent text selection during drag
        document.body.style.userSelect = 'none'; // Prevent text selection on body during drag
        consoleLog("Draggable window: mousedown");
    });

    document.addEventListener('mousemove', (e) => {
        if (isDragging) {
            // Ensure optionsWindow is not moved off-screen, with some buffer
            let newLeft = e.clientX - offsetX;
            let newTop = e.clientY - offsetY;

            const buffer = 10; // pixels
            const maxLeft = window.innerWidth - optionsWindow.offsetWidth - buffer;
            const maxTop = window.innerHeight - optionsWindow.offsetHeight - buffer;

            newLeft = Math.max(buffer, Math.min(newLeft, maxLeft));
            newTop = Math.max(buffer, Math.min(newTop, maxTop));

            optionsWindow.style.left = newLeft + 'px';
            optionsWindow.style.top = newTop + 'px';
        }
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            titleBar.style.userSelect = ''; // Re-enable text selection
            document.body.style.userSelect = '';
            consoleLog("Draggable window: mouseup");
            // Future: save position to localStorage here if desired
            // localStorage.setItem('otkOptionsWindowPos', JSON.stringify({top: optionsWindow.style.top, left: optionsWindow.style.left}));
        }
    });

    consoleLog("Options Window setup complete with drag functionality.");
}

// --- Initial Actions / Main Execution ---
async function main() {
    consoleLog("Starting OTK Thread Tracker script (v2.7)...");

    // Inject CSS for anchored messages
    const styleElement = document.createElement('style');
    styleElement.textContent = `
        :root {
            --otk-gui-bg-color: #181818;
            --otk-gui-text-color: #e6e6e6; /* General text in the main GUI bar */
            --otk-options-text-color: #e6e6e6; /* For text within the options panel */
            --otk-title-text-color: #e6e6e6; /* Default for main title */
            --otk-stats-text-color: #e6e6e6; /* For the actual stats text numbers in GUI bar */
            --otk-viewer-bg-color: #181818;
            --otk-gui-threadlist-title-color: #e0e0e0;
            --otk-gui-threadlist-time-color: #aaa;
            --otk-viewer-header-border-color: #555;
            --otk-viewer-quote1-header-border-color: #343434; /* For depth 1 quote headers */
            --otk-msg-depth0-bg-color: #343434;
            --otk-msg-depth1-bg-color: #525252;
            --otk-msg-depth2plus-bg-color: #484848;
            --otk-msg-depth0-text-color: #e6e6e6;
            --otk-msg-depth1-text-color: #e6e6e6;
            --otk-msg-depth2plus-text-color: #e6e6e6;
            --otk-msg-depth0-header-text-color: #e6e6e6;
            --otk-msg-depth1-header-text-color: #e6e6e6;
            --otk-msg-depth2plus-header-text-color: #e6e6e6;
            --otk-viewer-message-font-size: 13px; /* Default font size for message text */
            --otk-gui-bottom-border-color: #555; /* Default for GUI bottom border */
            /* Add more variables here as they are identified */
        }

        .${ANCHORED_MESSAGE_CLASS} {
            background-color: #4a4a3a !important; /* Slightly noticeable dark yellow/greenish */
            border: 1px solid #FFD700 !important;
            /* Add other styles if needed, e.g., box-shadow */
        }
            .otk-youtube-embed-wrapper.otk-embed-inline {
                /* max-width and margins are now controlled by inline styles in createYouTubeEmbedElement */
                /* This class can be used for other common styles for these embeds if needed */
            }
    `;
    document.head.appendChild(styleElement);
    consoleLog("Injected CSS for anchored messages.");

    setupOptionsWindow(); // Call to create the options window shell and event listeners
    applyThemeSettings(); // Apply any saved theme settings

    consoleLog('Attempting to call setupLoadingScreen...');
    setupLoadingScreen(); // Create loading screen elements early
    consoleLog('Call to setupLoadingScreen finished.');
    ensureViewerExists(); // Ensure viewer div is in DOM early

    // Note: mediaIntersectionObserver itself is initialized within renderMessagesInViewer

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
