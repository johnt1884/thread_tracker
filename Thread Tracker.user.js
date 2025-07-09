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
    const OTK_TRACKED_KEYWORDS_KEY = 'otkTrackedKeywords'; // For user-defined keywords
    const OTK_BG_UPDATE_FREQ_SECONDS_KEY = 'otkBgUpdateFrequencySeconds'; // For background update frequency

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
    let threadFetchMetadata = {}; // For ETags / Last-Modified dates { threadId: { etag: "...", lastModified: "..." } }
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
            background-color: rgba(var(--otk-loading-overlay-bg-rgb, 0,0,0), var(--otk-loading-overlay-opacity, 0.8)); /* Use CSS variables */
            z-index: 100000; /* Ensure it's on top of everything, including viewer */
            display: none; /* Hidden by default */
            flex-direction: column;
            align-items: center;
            justify-content: center;
            font-family: Verdana, sans-serif;
            color: var(--otk-loading-text-color, white); /* Use CSS variable */
        `;

        const detailsElement = document.createElement('div');
        detailsElement.id = 'otk-loading-details';
        // Inherits color from parent overlay, specific text styling:
        detailsElement.style.cssText = `
            margin-bottom: 20px; 
            font-size: 16px; 
            white-space: pre-line; /* Allow \n to create line breaks */
            text-align: center; /* Ensure multi-line text is also centered */
        `;
        overlay.appendChild(detailsElement);

        const progressBarContainer = document.createElement('div');
        progressBarContainer.id = 'otk-progress-bar-container';
        progressBarContainer.style.cssText = `
            width: 60%;
            max-width: 400px;
            background-color: var(--otk-loading-progress-bar-bg-color, #333); /* Use CSS variable */
            border: 1px solid #555; /* Border color could also be a variable if needed */
            border-radius: 5px;
            padding: 2px;
        `;
        overlay.appendChild(progressBarContainer);

        const progressBar = document.createElement('div');
        progressBar.id = 'otk-progress-bar';
        progressBar.style.cssText = `
            width: 0%;
            height: 25px;
            background-color: var(--otk-loading-progress-bar-fill-color, #4CAF50); /* Use CSS variable */
            border-radius: 3px;
            text-align: center;
            line-height: 25px;
            color: var(--otk-loading-progress-bar-text-color, white); /* Use CSS variable */
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
    // Attempting to add loop=0 to disable looping.
    const embedUrl = `https://streamable.com/e/${videoId}?loop=0`;

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
            color: var(--otk-cog-icon-color); /* Apply cog icon color variable */
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
                font-size: 16px; margin-left: 10px; cursor: pointer; display: inline-block; vertical-align: middle; color: var(--otk-cog-icon-color);
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

    function hexToRgbParts(hex) {
        if (!hex) return '0,0,0'; // Default to black if invalid input
        let shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
        hex = hex.replace(shorthandRegex, function(m, r, g, b) {
            return r + r + g + g + b + b;
        });

        let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (result) {
            const r = parseInt(result[1], 16);
            const g = parseInt(result[2], 16);
            const b = parseInt(result[3], 16);
            return `${r},${g},${b}`;
        }
        return '0,0,0'; // Fallback to black if full hex parsing fails
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

        const totalMessagesToRender = allMessages.length;
        let messagesProcessedInViewer = 0;
        let imagesFoundInViewer = 0;
        let videosFoundInViewer = 0;
        const mediaLoadPromises = [];
        const updateInterval = Math.max(1, Math.floor(totalMessagesToRender / 20)); // Update progress roughly 20 times or every message

        for (let i = 0; i < totalMessagesToRender; i++) {
            const message = allMessages[i];
            renderedMessageIdsInViewer.add(message.id); 

            const boardForLink = message.board || 'b'; 
            const threadColor = getThreadColor(message.originalThreadId); 

            const messageElement = createMessageElementDOM(message, mediaLoadPromises, uniqueImageViewerHashes, boardForLink, true, 0, threadColor);
            messagesContainer.appendChild(messageElement);

            messagesProcessedInViewer++;

            if (message.attachment) {
                const ext = message.attachment.ext.toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                    imagesFoundInViewer++;
                } else if (['.webm', '.mp4'].includes(ext)) {
                    videosFoundInViewer++;
                }
            }

            if (messagesProcessedInViewer % updateInterval === 0 || messagesProcessedInViewer === totalMessagesToRender) {
                let currentProgress = (messagesProcessedInViewer / totalMessagesToRender) * 90; // Up to 90% for this stage
                let detailsStr = `Processing message ${messagesProcessedInViewer} of ${totalMessagesToRender}...`;
                if (imagesFoundInViewer > 0 || videosFoundInViewer > 0) {
                    detailsStr += ` Media: ${imagesFoundInViewer} imgs, ${videosFoundInViewer} vids.`;
                }
                updateLoadingProgress(currentProgress, detailsStr);
            }
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
            const anchoredInstanceId = localStorage.getItem(ANCHORED_MESSAGE_ID_KEY);
            if (anchoredInstanceId) {
                // The ID stored is now always the unique instance ID of the DOM element
                const anchoredElement = document.getElementById(anchoredInstanceId);
                if (anchoredElement) {
                    try {
                        // Ensure the element is within the messagesContainer before scrolling
                        if (messagesContainer.contains(anchoredElement)) {
                            anchoredElement.scrollIntoView({ behavior: 'auto', block: 'center' });
                            anchorScrolled = true;
                            consoleLog(`Scrolled to anchored instance: ${anchoredInstanceId}`);
                        } else {
                            consoleWarn(`Anchored element ${anchoredInstanceId} found in document, but not within messagesContainer. Cannot scroll.`);
                            // This might happen if the viewer was cleared and re-rendered, and old IDs persist.
                            // localStorage.removeItem(ANCHORED_MESSAGE_ID_KEY); // Consider removing if invalid
                        }
                    } catch (e) {
                        consoleError("Error scrolling to anchored instance:", e);
                    }
                } else {
                    consoleWarn(`Anchored instance ID ${anchoredInstanceId} not found in DOM to scroll to.`);
                    // Optionally remove invalid anchor from localStorage if element not found after full render
                    localStorage.removeItem(ANCHORED_MESSAGE_ID_KEY); // More aggressively remove if not found
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
        } else { // Depth 2+ quotes
            headerBorderVar = 'var(--otk-viewer-quote2plus-header-border-color)';
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

        // Generate a unique instance ID for this specific DOM element
        // This ID will be used for anchoring and precise scrolling.
        const uniqueInstanceId = `otk-instance-${message.id}-${currentDepth}-${Date.now().toString(36)}${Math.random().toString(36).substr(2, 5)}`;
        messageDiv.id = uniqueInstanceId;
        messageDiv.setAttribute('data-original-message-id', message.id); // Keep original ID for reference if needed

        // Add click listener to the messageDiv for anchoring
        messageDiv.addEventListener('click', (event) => {
            // Prevent anchoring if clicking on known interactive elements
            const targetTagName = event.target.tagName;
            if (targetTagName === 'A' || event.target.closest('a') ||
                targetTagName === 'IMG' || targetTagName === 'VIDEO' ||
                targetTagName === 'IFRAME' || event.target.closest('iframe') || // Include iframes for embeds
                event.target.isContentEditable ||
                (event.target.classList && (
                    event.target.classList.contains('thumbnail-link') || // Specific class for some links
                    event.target.classList.contains('otk-youtube-embed-wrapper') || // Wrapper for embeds
                    event.target.classList.contains('otk-twitch-embed-wrapper') ||
                    event.target.classList.contains('otk-streamable-embed-wrapper')
                )) ||
                (event.target.closest && ( // Check closest for embed wrappers too
                    event.target.closest('.otk-youtube-embed-wrapper') ||
                    event.target.closest('.otk-twitch-embed-wrapper') ||
                    event.target.closest('.otk-streamable-embed-wrapper')
                ))
            ) {
                // consoleLog(`Anchor click ignored due to interactive target:`, event.target);
                return;
            }

            // If this message is a quote (not top-level), stop event propagation
            // to prevent parent message's click handler from also firing if structures are nested.
            if (!isTopLevelMessage) {
                event.stopPropagation();
            }

            const currentlyAnchoredInstanceId = localStorage.getItem(ANCHORED_MESSAGE_ID_KEY);

            if (uniqueInstanceId === currentlyAnchoredInstanceId) {
                // Clicking the already anchored message: un-anchor it
                messageDiv.classList.remove(ANCHORED_MESSAGE_CLASS);
                localStorage.removeItem(ANCHORED_MESSAGE_ID_KEY);
                consoleLog(`Un-anchored instance: ${uniqueInstanceId} (Original ID: ${message.id})`);
            } else {
                // Clicking a new message or a different message: anchor it
                const oldAnchorElement = document.querySelector(`.${ANCHORED_MESSAGE_CLASS}`);
                if (oldAnchorElement) {
                    oldAnchorElement.classList.remove(ANCHORED_MESSAGE_CLASS);
                }
                messageDiv.classList.add(ANCHORED_MESSAGE_CLASS);
                localStorage.setItem(ANCHORED_MESSAGE_ID_KEY, uniqueInstanceId);
                consoleLog(`Anchored new instance: ${uniqueInstanceId} (Original ID: ${message.id})`);
            }
        });

        // Initial highlight check when the element is first created
        const initiallyAnchoredInstanceId = localStorage.getItem(ANCHORED_MESSAGE_ID_KEY);
        if (uniqueInstanceId === initiallyAnchoredInstanceId) {
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
                border-top: 2px dashed var(--otk-new-messages-divider-color);
                margin: 20px 0; /* Keeps vertical spacing */
                padding-top: 10px;
                padding-bottom: 10px; /* Add some padding below the text as well */
                padding-left: 15px; /* Indent text from the left */
                text-align: left; /* Align text to the left */
                color: var(--otk-new-messages-font-color);
                font-size: 12px;
                font-style: italic;
                width: 100%; /* Ensure it spans the container if not already */
                box-sizing: border-box; /* Include padding in width calculation */
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
            const keywordsString = localStorage.getItem(OTK_TRACKED_KEYWORDS_KEY) || "otk";
            const keywords = keywordsString.split(',')
                .map(k => k.trim().toLowerCase())
                .filter(k => k.length > 0);

            if (keywords.length === 0) { // Should not happen if default is "otk" but as a safeguard
                consoleWarn("scanCatalog: No valid keywords configured. Defaulting to 'otk'.");
                keywords.push("otk");
            }
            consoleLog(`scanCatalog: Using keywords for search: [${keywords.join(', ')}]`);

            catalog.forEach(page => {
                page.threads.forEach(thread => {
                    let title = (thread.sub || '').toLowerCase();
                    let com = (thread.com || '').toLowerCase();
                    const combinedText = title + " " + com;

                    if (keywords.some(keyword => combinedText.includes(keyword))) {
                        foundThreads.push({
                            id: Number(thread.no),
                            title: thread.sub || `Thread ${thread.no}` // Store original case title
                        });
                    }
                });
            });
            consoleLog(`scanCatalog: Found ${foundThreads.length} threads matching keywords:`, foundThreads.map(t => t.id));
            return foundThreads;
        } catch (error) {
            consoleError('scanCatalog error:', error);
            return [];
        }
    }

    async function fetchThreadMessages(threadId) {
        // consoleLog('[DebugRefreshV2-FTM] START for threadId:', threadId); // Removed
        const url = `https://a.4cdn.org/b/thread/${threadId}.json`;
        const headers = {}; // Initialize empty headers object
        const metadata = threadFetchMetadata[threadId];

        if (metadata) {
            // consoleLog('[DebugRefreshV2-FTM] Preparing headers for threadId:', threadId, 'Current metadata:', JSON.stringify(metadata)); // Removed
            if (metadata.etag) {
                headers['If-None-Match'] = metadata.etag;
                // consoleLog('[DebugRefreshV2-FTM] Sending If-None-Match for', threadId, ':', headers['If-None-Match']); // Removed
            } else if (metadata.lastModified) {
                headers['If-Modified-Since'] = metadata.lastModified;
                // consoleLog('[DebugRefreshV2-FTM] Sending If-Modified-Since for', threadId, ':', headers['If-Modified-Since']); // Removed
            }
        } else {
            // consoleLog('[DebugRefreshV2-FTM] No metadata found for threadId:', threadId, 'Performing full fetch.'); // Removed
        }

        let response;
        try {
            response = await fetch(url, { headers: headers });
            // consoleLog('[DebugRefreshV2-FTM] Response status for', threadId, ':', response.status, 'OK:', response.ok); // Removed

            if (response.status === 304) {
                consoleLog(`Thread ${threadId} not modified (304).`);
                return { status: 'not_modified', threadId: threadId, messages: [], counts: { fetchedMessages: 0, fetchedImages: 0, fetchedVideos: 0, newlyStoredImages: 0, newlyStoredVideos: 0 } };
            }

            const defaultEmptyReturn = { messages: [], counts: { fetchedMessages: 0, fetchedImages: 0, fetchedVideos: 0, newlyStoredImages: 0, newlyStoredVideos: 0 } };

            if (!response.ok) { // Handles non-304 errors
                consoleWarn(`Fetch error for thread ${threadId}: ${response.status} ${response.statusText}`);
                if (response.status === 404) {
                    delete threadFetchMetadata[threadId]; // Clear metadata on 404
                }
                return defaultEmptyReturn; // Return new structure on error
            }

            // If response is OK (200), store new ETag/Last-Modified
            const newEtag = response.headers.get('ETag');
            const newLastModified = response.headers.get('Last-Modified');

            if (newEtag || newLastModified) {
                threadFetchMetadata[threadId] = {}; // Initialize/clear existing for this thread
                if (newEtag) {
                    threadFetchMetadata[threadId].etag = newEtag;
                }
                if (newLastModified) {
                    threadFetchMetadata[threadId].lastModified = newLastModified;
                }
                // consoleLog('[DebugRefreshV2-FTM] Stored new metadata for threadId:', threadId, 'New metadata:', JSON.stringify(threadFetchMetadata[threadId])); // Removed
                consoleLog(`Stored new ETag/Last-Modified for thread ${threadId}.`); // Standard log
            } else {
                // consoleLog('[DebugRefreshV2-FTM] No new ETag/Last-Modified headers found on 200 OK for threadId:', threadId); // Removed
                if (metadata) { // Only clear if old metadata existed and server stopped sending new ones
                    // consoleLog('[DebugRefreshV2-FTM] Clearing old metadata for threadId:', threadId, 'as no new headers were provided.'); // Removed
                    consoleLog(`No new ETag/Last-Modified for thread ${threadId}, clearing old metadata.`); // Standard log
                    delete threadFetchMetadata[threadId];
                }
            }

            const threadData = await response.json();
            // consoleLog('[DebugRefreshV2-FTM] Successfully got JSON for threadId:', threadId, 'Post count in JSON:', threadData.posts ? threadData.posts.length : 'N/A'); // Removed
            if (!threadData.posts || threadData.posts.length === 0) {
                consoleLog(`No posts in JSON for thread ${threadId}.`);
                return defaultEmptyReturn; // Return new structure if no posts
            }

            const opPost = threadData.posts[0];
            const posts = threadData.posts;
            const processedMessages = [];
            let fetchedMessagesInThread = 0;
            let fetchedImagesInThread = 0;
            let fetchedVideosInThread = 0;
            let newlyStoredImagesInThread = 0;
            const newlyStoredVideosInThread = 0; // Stays 0 for now as videos are not stored in IDB

            for (const post of posts) {
                fetchedMessagesInThread++;
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
                                                fetchedImagesInThread++; // Count all images encountered
                                                let currentImageCount = parseInt(localStorage.getItem(LOCAL_IMAGE_COUNT_KEY) || '0');
                                                localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, (currentImageCount + 1).toString());
                                                newlyStoredImagesInThread++; // Increment if successfully stored
                                            } else if (['.webm', '.mp4'].includes(ext)) {
                                                fetchedVideosInThread++; // Count all videos encountered
                                                let currentVideoCount = parseInt(localStorage.getItem(LOCAL_VIDEO_COUNT_KEY) || '0');
                                                localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, (currentVideoCount + 1).toString());
                                                // newlyStoredVideosInThread would be incremented here if they were stored
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
                // If attachment was not stored (e.g., already in DB or download failed), but is an image/video, still count as fetched.
                // This logic is slightly complex because the primary counting for fetchedImages/Videos happens inside the IDB storage path.
                // A simpler way for fetched media is to count them when `message.attachment` is first processed.
                if (post.filename && post.ext) { // This block is outside the IDB check, runs if attachment exists
                    const ext = post.ext.toLowerCase();
                    if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                        // If not already counted by the IDB storage success path (e.g. it was already in DB or failed download)
                        // This can lead to double counting if not careful.
                        // Let's refine: `fetchedImagesInThread` should be incremented once when an image attachment is identified.
                        // The current location increments it only on successful *new* store.
                        // This will be handled by moving the increment outside the successful store block or before it.
                        // For now, the current logic for `newlyStoredImagesInThread` is correct.
                        // `fetchedImagesInThread` needs to be incremented unconditionally if `post.ext` is an image type.
                    } else if (['.webm', '.mp4'].includes(ext)) {
                        // Similar for videos.
                    }
                }
                processedMessages.push(message);
            }

            // Refined counting for fetched media (regardless of storage status)
            // This ensures fetchedImagesInThread and fetchedVideosInThread are accurate even if media was already in DB.
            // The newlyStoredImagesInThread is correctly counted only upon successful new storage.
            let trueFetchedImages = 0;
            let trueFetchedVideos = 0;
            processedMessages.forEach(msg => {
                if (msg.attachment && msg.attachment.ext) {
                    const ext = msg.attachment.ext.toLowerCase();
                    if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                        trueFetchedImages++;
                    } else if (['.webm', '.mp4'].includes(ext)) {
                        trueFetchedVideos++;
                    }
                }
            });
            fetchedImagesInThread = trueFetchedImages;
            fetchedVideosInThread = trueFetchedVideos;


            consoleLog(`[fetchThreadMessages] Processed thread ${threadId}: ${fetchedMessagesInThread} msgs, ${fetchedImagesInThread} imgs, ${fetchedVideosInThread} vids. Stored: ${newlyStoredImagesInThread} imgs.`);
            return {
                messages: processedMessages,
                counts: {
                    fetchedMessages: fetchedMessagesInThread,
                    fetchedImages: fetchedImagesInThread,
                    fetchedVideos: fetchedVideosInThread,
                    newlyStoredImages: newlyStoredImagesInThread,
                    newlyStoredVideos: newlyStoredVideosInThread // Will be 0
                }
            };
        } catch (error) {
            consoleError(`fetchThreadMessages error for thread ${threadId}:`, error);
            return { messages: [], counts: { fetchedMessages: 0, fetchedImages: 0, fetchedVideos: 0, newlyStoredImages: 0, newlyStoredVideos: 0 } }; // Return new structure on error
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

            const fetchPromisesBg = activeThreads.map(threadId =>
                fetchThreadMessages(threadId)
                    .then(messages => ({ threadId, messages, status: 'fulfilled' }))
                    .catch(error => ({ threadId, error, status: 'rejected' }))
            );

            const resultsBg = await Promise.allSettled(fetchPromisesBg);

            resultsBg.forEach(result => {
                // consoleLog('[DebugRefreshV2][BG] backgroundRefresh - Raw Promise.allSettled result:', JSON.stringify(result)); // Removed
                if (result.status === 'fulfilled' && result.value) {
                    // consoleLog('[DebugRefreshV2][BG] backgroundRefresh - Fulfilled promise value:', JSON.stringify(result.value)); // Removed
                    const { threadId, messages: newMessages, status: fetchStatus } = result.value;
                    // consoleLog('[DebugRefreshV2][BG] backgroundRefresh - Destructured - threadId:', threadId, 'fetchStatus (from wrapper):', fetchStatus, 'newMessages type:', typeof newMessages, 'is Array?:', Array.isArray(newMessages), 'length (if array):', Array.isArray(newMessages) ? newMessages.length : 'N/A'); // Removed

                    if (fetchStatus === 'rejected') {
                        consoleError(`[BG] Error fetching thread ${threadId}:`, result.value.error);
                        return;
                    }

                    // consoleLog(`[BG] Processing fetched messages for thread ${threadId}. Result:`, newMessages); // Original log
                    // consoleLog('[DebugRefreshV2][BG] backgroundRefresh - About to process newMessages for thread:', threadId, 'Value:', JSON.stringify(newMessages)); // Removed

                    // Handle 'not_modified' status from fetchThreadMessages
                    if (newMessages && typeof newMessages === 'object' && newMessages.status === 'not_modified' && newMessages.threadId === threadId) {
                        consoleLog(`[BG] Thread ${threadId} was not modified. Skipping message update for this thread.`);
                    } else if (Array.isArray(newMessages) && newMessages.length > 0) { // Regular message array
                        // consoleLog(`[DebugRefreshV2][BG] backgroundRefresh - Processing ${newMessages.length} messages for thread ${threadId}.`); // Removed
                        consoleLog(`[BG] Processing ${newMessages.length} messages for thread ${threadId}.`); // Standard log
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
                    } else if (newMessages && newMessages.length === 0) {
                        consoleLog(`[BG] No new messages returned or thread is empty for active thread ${threadId}.`);
                        // Note: Thread pruning logic based on catalog scan is primary.
                        // If fetchThreadMessages returns empty for a 404, it might have been removed from activeThreads already by catalog logic.
                        // If it's still active here, it means the catalog saw it, but it's empty or was just pruned.
                        // We don't remove it from activeThreads here solely based on empty messages if catalog still lists it.
                        // The original logic to remove from activeThreads if no messages returned was a bit aggressive here.
                        // The catalog scan is the authority for active threads.
                    }
                } else if (result.status === 'rejected') {
                    consoleError(`[BG] Promise rejected for a thread fetch operation:`, result.reason);
                }
            });

            consoleLog(`[BG] Final active threads after message processing: ${activeThreads.length}`, activeThreads);
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
        showLoadingScreen("Initializing refresh..."); // Initial message
        try {
            await new Promise(resolve => setTimeout(resolve, 50)); // Ensure loading screen renders

            updateLoadingProgress(5, "Scanning catalog for OTK threads...");
            const foundThreads = await scanCatalog();
            const foundIds = new Set(foundThreads.map(t => Number(t.id)));
            consoleLog(`[Manual] scanCatalog found ${foundThreads.length} threads:`, Array.from(foundIds));
            updateLoadingProgress(10, `Catalog scan complete. Found ${foundThreads.length} OTK threads. Syncing with local list...`);

            const previousActiveThreadIds = new Set(activeThreads.map(id => Number(id)));
            let threadsToFetch = []; // Store actual threadIds to fetch

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
                    consoleLog(`[Manual] Adding new thread ${threadIdNum} to active list.`);
                    activeThreads.push(threadIdNum);
                }
                // All found threads (new or existing) are candidates for fetching
                if (!threadsToFetch.includes(threadIdNum)) {
                    threadsToFetch.push(threadIdNum);
                }
            });
            // Also add existing active threads that are still in foundIds to threadsToFetch
            activeThreads.forEach(existingThreadId => {
                if (foundIds.has(existingThreadId) && !threadsToFetch.includes(existingThreadId)) {
                    threadsToFetch.push(existingThreadId);
                }
            });

            consoleLog(`[Manual] Active threads after catalog sync: ${activeThreads.length}`, activeThreads);
            consoleLog(`[Manual] Threads to fetch this cycle: ${threadsToFetch.length}`, threadsToFetch);
            updateLoadingProgress(15, `Preparing to fetch data for ${threadsToFetch.length} threads...`);

            let totalNewMessagesThisRefresh = 0;
            let totalNewImagesThisRefresh = 0; // Fetched images
            let totalNewVideosThisRefresh = 0; // Fetched videos
            let totalImagesStoredThisRefresh = 0;
            // totalVideosStoredThisRefresh remains 0

            let threadsProcessedCount = 0;
            const totalThreadsToProcess = threadsToFetch.length;

            // Use a sequential loop for fetching to update loading screen more granularly per thread
            for (const threadId of threadsToFetch) {
                threadsProcessedCount++;
                const progressPercentage = 15 + Math.round((threadsProcessedCount / totalThreadsToProcess) * 75); // 15% (catalog) + 75% (fetching/processing)
                
                let statusText = `Processing thread ${threadsProcessedCount}/${totalThreadsToProcess} (ID: ${threadId})...`;
                if (totalNewMessagesThisRefresh > 0 || totalNewImagesThisRefresh > 0) {
                    statusText += `\nSo far: ${totalNewMessagesThisRefresh} new msgs, ${totalNewImagesThisRefresh} imgs (${totalImagesStoredThisRefresh} stored), ${totalNewVideosThisRefresh} vids.`;
                }
                updateLoadingProgress(progressPercentage, statusText);

                try {
                    const result = await fetchThreadMessages(threadId); // fetchThreadMessages is already async

                    if (result.status === 'not_modified') {
                        consoleLog(`[Manual] Thread ${threadId} not modified. Skipping message update.`);
                        continue; // Next thread
                    }

                    const newMessagesData = result.messages; // This is an array of message objects
                    const counts = result.counts;

                    if (Array.isArray(newMessagesData)) {
                        let actualNewMessagesInThread = 0;
                        if (newMessagesData.length > 0) {
                            let existing = messagesByThreadId[threadId] || [];
                            let existingIds = new Set(existing.map(m => m.id));
                            let updatedMessages = [...existing];
                            newMessagesData.forEach(m => {
                                if (!existingIds.has(m.id)) {
                                    updatedMessages.push(m);
                                    actualNewMessagesInThread++;
                                }
                            });
                            updatedMessages.sort((a, b) => a.time - b.time);
                            messagesByThreadId[threadId] = updatedMessages;
                            if (messagesByThreadId[threadId].length > 0 && (!messagesByThreadId[threadId][0].title || messagesByThreadId[threadId][0].title === `Thread ${threadId}`)) {
                                messagesByThreadId[threadId][0].title = newMessagesData[0].title;
                            }
                        }
                        totalNewMessagesThisRefresh += actualNewMessagesInThread;
                        totalNewImagesThisRefresh += counts.fetchedImages;
                        totalNewVideosThisRefresh += counts.fetchedVideos;
                        totalImagesStoredThisRefresh += counts.newlyStoredImages;
                        // totalVideosStoredThisRefresh += counts.newlyStoredVideos; (will be 0)

                        consoleLog(`[Manual] Processed thread ${threadId}. Fetched: ${counts.fetchedMessages} msgs, ${counts.fetchedImages} imgs, ${counts.fetchedVideos} vids. Added: ${actualNewMessagesInThread} new msgs. Stored: ${counts.newlyStoredImages} imgs.`);
                    }
                } catch (error) {
                    consoleError(`[Manual] Error processing thread ${threadId} in loop:`, error);
                    // Continue to next thread
                }
            }
            
            // Final update to loading screen after loop
            let finalStatusText = `Refresh complete. Added: ${totalNewMessagesThisRefresh} new msgs, ${totalNewImagesThisRefresh} imgs (${totalImagesStoredThisRefresh} stored), ${totalNewVideosThisRefresh} vids.`;
            updateLoadingProgress(90, finalStatusText);


    // Re-filter activeThreads based on whether messagesByThreadId still has entries for them
    // This was previously commented out as too aggressive. Catalog scan is primary.
    // However, catalog scan is the main authority. This step might be redundant if catalog scan is robust.
    // For now, let's assume catalog scan + the processing logic above correctly maintains activeThreads.
    // activeThreads = activeThreads.filter(id => messagesByThreadId[id] && messagesByThreadId[id].length > 0);
    // This filtering above is too aggressive. A thread can be active and have 0 messages temporarily.
    // The main pruning of activeThreads happens after catalog scan.

    consoleLog(`[Manual] Final active threads after message processing: ${activeThreads.length}`, activeThreads);
    localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads)); // activeThreads is already updated by catalog sync
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
            // localStorage.removeItem(THEME_SETTINGS_KEY); // Active theme settings are cleared
            // localStorage.removeItem(CUSTOM_THEMES_KEY); // CUSTOM THEMES ARE PRESERVED
            localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, '0'); // Reset image count
            localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, '0'); // Reset video count
            // Note: THEME_SETTINGS_KEY (active theme) will be effectively reset when applyThemeSettings is called
            // without pre-existing settings, or if we explicitly clear it.
            // For a true "Restart" regarding active theme, THEME_SETTINGS_KEY should be cleared.
            // Custom themes (CUSTOM_THEMES_KEY) must be preserved.
            localStorage.removeItem(THEME_SETTINGS_KEY); // Clear current active theme settings
            consoleLog('[Clear] LocalStorage (threads, messages, seen embeds, media counts, ACTIVE theme) cleared/reset. CUSTOM THEMES PRESERVED.');


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
            button.classList.add('otk-tracker-button'); // Add a common class for potential shared base styles not from variables
            button.style.cssText = `
                padding: 5px 10px;
                cursor: pointer;
                background-color: var(--otk-button-bg-color);
                color: var(--otk-button-text-color);
                border: 1px solid var(--otk-button-border-color);
                border-radius: 3px;
                font-size: 13px;
                white-space: nowrap; /* Prevent button text wrapping */
                /* Transition for smooth background color change can be added here or in CSS */
                transition: background-color 0.15s ease-in-out;
            `;

            button.addEventListener('mouseover', () => {
                if (!button.disabled) { // Check if button is not disabled
                    button.classList.add('otk-button--hover');
                    // Fallback if CSS variables/classes somehow fail, or for non-variable parts of hover
                    // button.style.backgroundColor = 'var(--otk-button-hover-bg-color)'; // Direct application as fallback/override example
                }
            });
            button.addEventListener('mouseout', () => {
                if (!button.disabled) {
                    button.classList.remove('otk-button--hover');
                    button.classList.remove('otk-button--active'); // Ensure active is also removed if mouse leaves while pressed
                    // Fallback: reset to base color
                    // button.style.backgroundColor = 'var(--otk-button-bg-color)';
                }
            });
            button.addEventListener('mousedown', () => {
                if (!button.disabled) {
                    button.classList.add('otk-button--active');
                    // Fallback
                    // button.style.backgroundColor = 'var(--otk-button-active-bg-color)';
                }
            });
            button.addEventListener('mouseup', () => {
                if (!button.disabled) {
                    button.classList.remove('otk-button--active');
                    // If mouse is still over, hover effect should apply.
                    // If mouseup happens outside, mouseout would have cleared hover.
                    // If mouseup happens inside, it should revert to hover state if still over.
                    // The mouseout listener already handles removing active and hover if mouse leaves.
                    // So, if still over, ensure hover is present.
                    if (button.matches(':hover')) { // Check if mouse is still over the button
                         button.classList.add('otk-button--hover');
                    }
                    // Fallback
                    // if (button.matches(':hover')) button.style.backgroundColor = 'var(--otk-button-hover-bg-color)';
                    // else button.style.backgroundColor = 'var(--otk-button-bg-color)';
                }
            });
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
            let frequencySeconds = parseInt(localStorage.getItem(OTK_BG_UPDATE_FREQ_SECONDS_KEY) || "120", 10); // Default to 120s (2 min)
            // Validate against the new effective range (120 seconds to 3600 seconds/1 hour)
            if (isNaN(frequencySeconds) || frequencySeconds < 120 || frequencySeconds > 3600) {
                frequencySeconds = 120; // Default (2 min) if stored value is invalid or out of overall bounds
            }
            const refreshIntervalMs = frequencySeconds * 1000;

            backgroundRefreshIntervalId = setInterval(backgroundRefreshThreadsAndMessages, refreshIntervalMs);
            consoleLog(`Background refresh scheduled every ${frequencySeconds} seconds.`);
        } else {
            consoleLog('Background refresh interval already active (will use new frequency on next auto-restart if changed).');
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

    // Viewer Header Border Color (Used for Depth 0 Message Header Underline)
    if (settings.viewerHeaderBorderColor) {
        document.documentElement.style.setProperty('--otk-viewer-header-border-color', settings.viewerHeaderBorderColor);
        const hexInput = document.getElementById('otk-viewer-header-border-hex'); // idSuffix: 'viewer-header-border'
        const picker = document.getElementById('otk-viewer-header-border');
        if (hexInput) hexInput.value = settings.viewerHeaderBorderColor;
        if (picker) picker.value = settings.viewerHeaderBorderColor;
    }

    // Viewer Quote L1 Border Color (Used for Depth 1 Message Header Underline)
    if (settings.viewerQuote1HeaderBorderColor) {
        consoleLog(`[Debug applyThemeSettings] Applying viewerQuote1HeaderBorderColor: ${settings.viewerQuote1HeaderBorderColor}`);
        document.documentElement.style.setProperty('--otk-viewer-quote1-header-border-color', settings.viewerQuote1HeaderBorderColor);
        const hexInput = document.getElementById('otk-viewer-quote1-border-hex'); // idSuffix: 'viewer-quote1-border'
        const picker = document.getElementById('otk-viewer-quote1-border');
        if (hexInput) {
            hexInput.value = settings.viewerQuote1HeaderBorderColor;
            consoleLog(`  > Updated hex input ${hexInput.id} to: ${settings.viewerQuote1HeaderBorderColor}`);
        } else { consoleLog(`  > Hex input otk-viewer-quote1-border-hex not found.`); }
        if (picker) {
            picker.value = settings.viewerQuote1HeaderBorderColor;
            consoleLog(`  > Updated picker ${picker.id} to: ${settings.viewerQuote1HeaderBorderColor}`);
        } else { consoleLog(`  > Picker otk-viewer-quote1-border not found.`); }
    } else {
        consoleLog(`[Debug applyThemeSettings] viewerQuote1HeaderBorderColor not in settings.`);
    }

    // Viewer Quote L2+ Border Color
    if (settings.viewerQuote2plusHeaderBorderColor) {
        consoleLog(`[Debug applyThemeSettings] Applying viewerQuote2plusHeaderBorderColor: ${settings.viewerQuote2plusHeaderBorderColor}`);
        document.documentElement.style.setProperty('--otk-viewer-quote2plus-header-border-color', settings.viewerQuote2plusHeaderBorderColor);
        const hexInput = document.getElementById('otk-viewer-quote2plus-border-hex'); // idSuffix: 'viewer-quote2plus-border'
        const picker = document.getElementById('otk-viewer-quote2plus-border');
        if (hexInput) {
            hexInput.value = settings.viewerQuote2plusHeaderBorderColor;
            consoleLog(`  > Updated hex input ${hexInput.id} to: ${settings.viewerQuote2plusHeaderBorderColor}`);
        } else { consoleLog(`  > Hex input otk-viewer-quote2plus-border-hex not found.`); }
        if (picker) {
            picker.value = settings.viewerQuote2plusHeaderBorderColor;
            consoleLog(`  > Updated picker ${picker.id} to: ${settings.viewerQuote2plusHeaderBorderColor}`);
        } else { consoleLog(`  > Picker otk-viewer-quote2plus-border not found.`); }
    } else {
        consoleLog(`[Debug applyThemeSettings] viewerQuote2plusHeaderBorderColor not in settings.`);
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

    // Cog Icon Color
    if (settings.cogIconColor) {
        document.documentElement.style.setProperty('--otk-cog-icon-color', settings.cogIconColor);
        const hexInput = document.getElementById('otk-cog-icon-hex'); // Uses idSuffix from createThemeOptionRow
        const picker = document.getElementById('otk-cog-icon');
        if (hexInput) hexInput.value = settings.cogIconColor;
        if (picker) picker.value = settings.cogIconColor;
        // Also directly apply to the cog icon if it exists, as it's outside the options window
        const cogIconElement = document.getElementById('otk-settings-cog');
        if (cogIconElement) {
            cogIconElement.style.color = settings.cogIconColor;
        }
    } else { // Handle case where it might be reset to default (null in settings)
        const cogIconElement = document.getElementById('otk-settings-cog');
        if (cogIconElement) {
            cogIconElement.style.color = ''; // Clear inline style to use CSS variable's default
        }
    }

    // New Messages Divider Color
    if (settings.newMessagesDividerColor) {
        document.documentElement.style.setProperty('--otk-new-messages-divider-color', settings.newMessagesDividerColor);
        const hexInput = document.getElementById('otk-new-msg-divider-hex');
        const picker = document.getElementById('otk-new-msg-divider');
        if (hexInput) hexInput.value = settings.newMessagesDividerColor;
        if (picker) picker.value = settings.newMessagesDividerColor;
    }

    // New Messages Font Color
    if (settings.newMessagesFontColor) {
        document.documentElement.style.setProperty('--otk-new-messages-font-color', settings.newMessagesFontColor);
        const hexInput = document.getElementById('otk-new-msg-font-hex');
        const picker = document.getElementById('otk-new-msg-font');
        if (hexInput) hexInput.value = settings.newMessagesFontColor;
        if (picker) picker.value = settings.newMessagesFontColor;
    }

    // GUI Button Colors
    const buttonColorConfigs = [
        { key: 'guiButtonBgColor', cssVar: '--otk-button-bg-color', idSuffix: 'gui-button-bg' },
        { key: 'guiButtonTextColor', cssVar: '--otk-button-text-color', idSuffix: 'gui-button-text' },
        { key: 'guiButtonBorderColor', cssVar: '--otk-button-border-color', idSuffix: 'gui-button-border' },
        { key: 'guiButtonHoverBgColor', cssVar: '--otk-button-hover-bg-color', idSuffix: 'gui-button-hover-bg' },
        { key: 'guiButtonActiveBgColor', cssVar: '--otk-button-active-bg-color', idSuffix: 'gui-button-active-bg' }
    ];
    buttonColorConfigs.forEach(config => {
        if (settings[config.key]) {
            document.documentElement.style.setProperty(config.cssVar, settings[config.key]);
            const hexInput = document.getElementById(`otk-${config.idSuffix}-hex`); // All button colors are 'color' type
            const picker = document.getElementById(`otk-${config.idSuffix}-picker`); // Assumes picker has -picker suffix, but createThemeOptionRow uses direct idSuffix
            if (hexInput) hexInput.value = settings[config.key];
            const pickerElement = document.getElementById(`otk-${config.idSuffix}`); // Correct ID for the color input itself
            if (pickerElement) pickerElement.value = settings[config.key];
        }
    });

    // Loading Screen Colors
    // Base Hex Color for Overlay
    if (settings.loadingOverlayBaseHexColor) {
        document.documentElement.style.setProperty('--otk-loading-overlay-base-hex-color', settings.loadingOverlayBaseHexColor);
        const hexInput = document.getElementById('otk-loading-overlay-base-hex-hex'); // Assuming -hex suffix for hex text part
        const picker = document.getElementById('otk-loading-overlay-base-hex');
        if (hexInput) hexInput.value = settings.loadingOverlayBaseHexColor;
        if (picker) picker.value = settings.loadingOverlayBaseHexColor;
    }
    // Opacity
    if (settings.loadingOverlayOpacity) {
        document.documentElement.style.setProperty('--otk-loading-overlay-opacity', settings.loadingOverlayOpacity);
        const inputEl = document.getElementById('otk-loading-overlay-opacity'); // ID for number input
        if (inputEl) inputEl.value = settings.loadingOverlayOpacity;
    }
    // Text Color
    if (settings.loadingTextColor) {
        document.documentElement.style.setProperty('--otk-loading-text-color', settings.loadingTextColor);
        const hexInput = document.getElementById('otk-loading-text-hex');
        const picker = document.getElementById('otk-loading-text');
        if (hexInput) hexInput.value = settings.loadingTextColor;
        if (picker) picker.value = settings.loadingTextColor;
    }
    // Progress Bar BG
    if (settings.loadingProgressBarBgColor) {
        document.documentElement.style.setProperty('--otk-loading-progress-bar-bg-color', settings.loadingProgressBarBgColor);
        const hexInput = document.getElementById('otk-loading-progress-bg-hex');
        const picker = document.getElementById('otk-loading-progress-bg');
        if (hexInput) hexInput.value = settings.loadingProgressBarBgColor;
        if (picker) picker.value = settings.loadingProgressBarBgColor;
    }
    // Progress Bar Fill
    if (settings.loadingProgressBarFillColor) {
        document.documentElement.style.setProperty('--otk-loading-progress-bar-fill-color', settings.loadingProgressBarFillColor);
        const hexInput = document.getElementById('otk-loading-progress-fill-hex');
        const picker = document.getElementById('otk-loading-progress-fill');
        if (hexInput) hexInput.value = settings.loadingProgressBarFillColor;
        if (picker) picker.value = settings.loadingProgressBarFillColor;
    }
    // Progress Bar Text
    if (settings.loadingProgressBarTextColor) {
        document.documentElement.style.setProperty('--otk-loading-progress-bar-text-color', settings.loadingProgressBarTextColor);
        const hexInput = document.getElementById('otk-loading-progress-text-hex');
        const picker = document.getElementById('otk-loading-progress-text');
        if (hexInput) hexInput.value = settings.loadingProgressBarTextColor;
        if (picker) picker.value = settings.loadingProgressBarTextColor;
    }

    // Directly update loading screen if it exists, as its styles are set via cssText initially
    const loadingOverlayElement = document.getElementById('otk-loading-overlay');
    if (loadingOverlayElement) {
        // Get base hex color from settings or CSS variable, then convert to RGB parts
        const baseHex = settings.loadingOverlayBaseHexColor || getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-overlay-base-hex-color').trim() || '#000000';
        const rgbParts = hexToRgbParts(baseHex); // Use helper function
        const opacity = settings.loadingOverlayOpacity || getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-overlay-opacity').trim() || '0.8';
        
        loadingOverlayElement.style.backgroundColor = `rgba(${rgbParts}, ${opacity})`;
        
        // Update text color using the CSS variable (which should have been set above)
        loadingOverlayElement.style.color = `var(--otk-loading-text-color, ${getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-text-color').trim() || '#ffffff'})`;
        
        const progressBarContainer = document.getElementById('otk-progress-bar-container');
        if (progressBarContainer) {
            progressBarContainer.style.backgroundColor = `var(--otk-loading-progress-bar-bg-color, ${getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-progress-bar-bg-color').trim() || '#333333'})`;
        }
        const progressBar = document.getElementById('otk-progress-bar');
        if (progressBar) {
            progressBar.style.backgroundColor = `var(--otk-loading-progress-bar-fill-color, ${getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-progress-bar-fill-color').trim() || '#4CAF50'})`;
            progressBar.style.color = `var(--otk-loading-progress-bar-text-color, ${getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-progress-bar-text-color').trim() || '#ffffff'})`;
        }
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
        width: 420px; /* Increased width slightly for scrollbar */
        min-height: 150px; /* Minimum height when collapsed */
        max-height: 550px; /* Maximum height when expanded (title + theme heading + theme options container max-height + paddings) */
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
    titleBar.textContent = 'Options'; // Changed title

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
    // This container might not be strictly necessary anymore if we are just stacking sections.
    // For now, let's keep it but add general settings directly to contentArea or sectionsContainer.
    // Let's add general settings directly to contentArea, above the theme section.

    const generalSettingsSection = document.createElement('div');
    generalSettingsSection.id = 'otk-general-settings-section';
    generalSettingsSection.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 10px; /* Space between general option groups */
        margin-bottom: 15px; /* Space before the theme section */
    `;
    contentArea.appendChild(generalSettingsSection); // Add general settings section first

    // Add a heading for the General Settings section using the helper
    generalSettingsSection.appendChild(createSectionHeading('General Settings'));

    // --- Tracked Keyword(s) Option ---
    const trackedKeywordsGroup = document.createElement('div');
    // Apply CSS Grid styling
    trackedKeywordsGroup.style.cssText = "display: grid; grid-template-columns: 165px 1fr; align-items: center; gap: 8px; width: 100%; margin-bottom: 5px;";

    const trackedKeywordsLabel = document.createElement('label');
    trackedKeywordsLabel.textContent = "Tracked Keyword(s):";
    trackedKeywordsLabel.htmlFor = 'otk-tracked-keywords-input';
    // Ensure label is explicitly in grid column 1
    trackedKeywordsLabel.style.cssText = "min-width: 160px; text-align: right; /* margin-right: 5px; gap handles spacing */ font-size: 12px; grid-column: 1;";

    const trackedKeywordsInput = document.createElement('input');
    trackedKeywordsInput.type = 'text';
    trackedKeywordsInput.id = 'otk-tracked-keywords-input';
    trackedKeywordsInput.placeholder = "e.g., otk, item2, phrase three";
    // Input takes full width of its grid cell (1fr)
    trackedKeywordsInput.style.cssText = "width: 100%; height: 25px; box-sizing: border-box; font-size: 12px; grid-column: 2;";
    trackedKeywordsInput.value = localStorage.getItem(OTK_TRACKED_KEYWORDS_KEY) || "otk"; // Load saved value or default

    // Wrapper is not needed with CSS Grid here

    trackedKeywordsInput.addEventListener('change', () => { // Save on change (after blur or Enter)
        const valueToSave = trackedKeywordsInput.value.trim();
        if (valueToSave) {
            localStorage.setItem(OTK_TRACKED_KEYWORDS_KEY, valueToSave);
            consoleLog(`Tracked keywords saved: ${valueToSave}`);
        } else { // If input is cleared, revert to default and save that
            localStorage.setItem(OTK_TRACKED_KEYWORDS_KEY, "otk");
            trackedKeywordsInput.value = "otk"; // Reflect default in input
            consoleLog(`Tracked keywords reset to default: "otk"`);
        }
        // Alert or indication that a page refresh might be needed for scanCatalog to pick up new words immediately
        // For now, just saving. User would typically refresh data or page.
    });

    trackedKeywordsGroup.appendChild(trackedKeywordsLabel);
    trackedKeywordsGroup.appendChild(trackedKeywordsInput); // Append input directly
    generalSettingsSection.appendChild(trackedKeywordsGroup);

    // --- Background Update Frequency Option ---
    const bgUpdateFreqGroup = document.createElement('div');
    // Apply CSS Grid styling
    bgUpdateFreqGroup.style.cssText = "display: grid; grid-template-columns: 165px 1fr; align-items: center; gap: 8px; width: 100%; margin-bottom: 5px;";

    const bgUpdateFreqLabel = document.createElement('label');
    bgUpdateFreqLabel.textContent = "Update Frequency (min >= 2.0):"; // Updated label
    bgUpdateFreqLabel.htmlFor = 'otk-bg-update-freq-input';
    // Ensure label is explicitly in grid column 1
    bgUpdateFreqLabel.style.cssText = "min-width: 160px; text-align: right; /* margin-right: 5px; gap handles spacing */ font-size: 12px; grid-column: 1;";

    const bgUpdateFreqInput = document.createElement('input');
    bgUpdateFreqInput.type = 'number';
    bgUpdateFreqInput.id = 'otk-bg-update-freq-input';
    bgUpdateFreqInput.min = '2.0'; // UI min in minutes (120 seconds)
    // No max attribute for UI
    bgUpdateFreqInput.step = '0.5'; // Step by half a minute for simplicity, can be 0.1
    // Input styling for grid column 2 - allow it to take available space but also set a max-width if desired, or start alignment
    bgUpdateFreqInput.style.cssText = "width: 70px; height: 25px; box-sizing: border-box; font-size: 12px; grid-column: 2; justify-self: start;";

    // Wrapper is not needed with CSS Grid here

    // Load stored value (in seconds), convert to minutes for display. Default to 120s (2.0 min).
    let initialStoredFreqSeconds = parseInt(localStorage.getItem(OTK_BG_UPDATE_FREQ_SECONDS_KEY) || "120", 10);
    // Ensure initial value respects the new minimum if an old, smaller value was stored
    if (isNaN(initialStoredFreqSeconds) || initialStoredFreqSeconds < 120) {
        initialStoredFreqSeconds = 120;
    }
    // An internal max for display purposes isn't strictly necessary if there's no UI max,
    // but if a very large number of seconds was stored, it might look odd.
    // We'll cap it at a large but reasonable number of minutes for display if needed, e.g. 1440 min (1 day)
    // For now, just convert, the save logic will handle true upper cap.
    bgUpdateFreqInput.value = (initialStoredFreqSeconds / 60).toFixed(1);


    bgUpdateFreqInput.addEventListener('change', () => {
        let inputMinutes = parseFloat(bgUpdateFreqInput.value);
        const minSecondsStorage = 120; // 2 minutes in seconds
        const maxSecondsStorage = 3600; // 1 hour in seconds (internal cap)
        let newFrequencySecondsToStore;

        if (isNaN(inputMinutes) || inputMinutes < (minSecondsStorage / 60)) { // Check against UI min equivalent
            newFrequencySecondsToStore = 120; // Default to 120s (2 min) if input is invalid or below UI min
        } else {
            newFrequencySecondsToStore = Math.round(inputMinutes * 60);
        }

        // Clamp the seconds value for storage
        if (newFrequencySecondsToStore < minSecondsStorage) {
            newFrequencySecondsToStore = minSecondsStorage;
        } else if (newFrequencySecondsToStore > maxSecondsStorage) {
            newFrequencySecondsToStore = maxSecondsStorage;
        }

        // Update the input field to reflect the (potentially clamped and reconverted) value in minutes
        bgUpdateFreqInput.value = (newFrequencySecondsToStore / 60).toFixed(1);

        localStorage.setItem(OTK_BG_UPDATE_FREQ_SECONDS_KEY, newFrequencySecondsToStore.toString());
        consoleLog(`Background update frequency saved as: ${newFrequencySecondsToStore} seconds. UI shows: ${bgUpdateFreqInput.value} min. Restarting interval.`);
        stopBackgroundRefresh();
        startBackgroundRefresh(); // Will now use the new value from localStorage
    });

    bgUpdateFreqGroup.appendChild(bgUpdateFreqLabel);
    bgUpdateFreqGroup.appendChild(bgUpdateFreqInput); // Append input directly
    generalSettingsSection.appendChild(bgUpdateFreqGroup);

    // --- Debugging Toggle Option ---
    const debugToggleGroup = document.createElement('div');
    // Apply CSS Grid styling
    debugToggleGroup.style.cssText = "display: grid; grid-template-columns: 165px 1fr; align-items: center; gap: 8px; width: 100%; margin-bottom: 5px;";

    const debugToggleLabel = document.createElement('label');
    debugToggleLabel.textContent = "Enable Console Debugging:";
    debugToggleLabel.htmlFor = 'otk-debug-mode-checkbox';
    // Ensure label is explicitly in grid column 1
    debugToggleLabel.style.cssText = "min-width: 160px; text-align: right; /* margin-right: 5px; gap handles spacing */ font-size: 12px; grid-column: 1;";

    const debugToggleCheckbox = document.createElement('input');
    debugToggleCheckbox.type = 'checkbox';
    debugToggleCheckbox.id = 'otk-debug-mode-checkbox';
    // Checkbox styling for grid column 2 - use justify-self to align it left within its cell
    debugToggleCheckbox.style.cssText = "height: 16px; width: 16px; grid-column: 2; justify-self: start;";
    debugToggleCheckbox.checked = DEBUG_MODE;

    // Wrapper is not needed with CSS Grid here

    debugToggleCheckbox.addEventListener('change', () => {
        DEBUG_MODE = debugToggleCheckbox.checked;
        localStorage.setItem(DEBUG_MODE_KEY, DEBUG_MODE.toString());
        consoleLog(`Debug mode ${DEBUG_MODE ? 'enabled' : 'disabled'}.`);
        // Re-log this message with the new setting, if it's now enabled, it will show. If disabled, it won't.
        if (DEBUG_MODE) {
             console.log('[OTK Tracker]', `Debug mode explicitly enabled via UI.`);
        }
    });

    debugToggleGroup.appendChild(debugToggleLabel);
    debugToggleGroup.appendChild(debugToggleCheckbox); // Append checkbox directly
    generalSettingsSection.appendChild(debugToggleGroup);


    // --- Theme/Appearance Section ---
    // This section will now be added after the general settings.
    // The 'sectionsContainer' might be redundant if themeSection is the only thing in it.
    // Let's append themeSection directly to contentArea as well, after generalSettingsSection.
    const sectionsContainer = document.createElement('div'); // Keep for potential future use if more sections are added here
    contentArea.appendChild(sectionsContainer);


    const themeSection = document.createElement('div');
    themeSection.id = 'otk-options-theme-section';
    themeSection.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 10px; /* Space between color option groups */
        max-height: 330px; /* Max height for the theme options area */
        overflow-y: auto; /* Enable vertical scrollbar */
        padding-right: 10px; /* Space for scrollbar */
        padding-left: 5px; /* Minor padding for content */
    `;
    // Add a heading for the section (optional)
    const themeSectionHeading = document.createElement('h4');
    themeSectionHeading.textContent = '► Theme'; // Changed text and added indicator
    themeSectionHeading.style.cssText = `
        margin-top: 0;
        margin-bottom: 10px;
        border-bottom: 1px solid #555;
        padding-bottom: 5px;
        cursor: pointer;
        user-select: none;
    `;
    themeSection.appendChild(themeSectionHeading);

    // Create a container for the actual theme options, to be toggled
    const themeOptionsContainer = document.createElement('div');
    themeOptionsContainer.id = 'otk-theme-options-container';
    themeOptionsContainer.style.display = 'none'; // Hidden by default
    // Apply scrolling properties to this container instead of themeSection directly
    themeOptionsContainer.style.cssText += `
        display: none; /* Reiterate, will be toggled */
        flex-direction: column;
        /* gap: 10px; Will be handled by margins/padding of new structure or individual rows */
        max-height: 300px; /* Adjusted from themeSection's previous max-height */
        overflow-y: auto;
        padding-right: 10px; /* Space for scrollbar */
        padding-left: 5px; /* Minor padding for content */
    `;
    themeSection.appendChild(themeOptionsContainer);

    sectionsContainer.appendChild(themeSection); // Add theme section to main content

    document.body.appendChild(optionsWindow);

    // Event listener for toggling theme options visibility
    themeSectionHeading.addEventListener('click', () => {
        const isHidden = themeOptionsContainer.style.display === 'none';
        if (isHidden) {
            themeOptionsContainer.style.display = 'flex'; // Use 'flex' as it's a flex container
            themeSectionHeading.textContent = '▼ Theme';
        } else {
            themeOptionsContainer.style.display = 'none';
            themeSectionHeading.textContent = '► Theme';
        }
    });

    // Helper function to create a theme option row
    function createThemeOptionRow(options) {
        // options = { labelText, storageKey, cssVariable, defaultValue, inputType ('color'|'number'), unit ('px'|null), min, max, idSuffix }
        const group = document.createElement('div');
        group.style.cssText = "display: flex; align-items: center; gap: 8px; width: 100%; margin-bottom: 5px;";

        const label = document.createElement('label');
        label.textContent = options.labelText;
        // The ID for the picker/input will be 'otk-' + options.idSuffix
        label.htmlFor = `otk-${options.idSuffix}`;
        label.style.cssText = "min-width: 160px; text-align: right; margin-right: 5px; font-size: 12px; flex-shrink: 0;"; // Increased min-width for longer labels

        let hexInput = null;
        if (options.inputType === 'color') {
            hexInput = document.createElement('input');
            hexInput.type = 'text';
            hexInput.id = `otk-${options.idSuffix}-hex`;
            hexInput.style.cssText = "width: 70px; height: 25px; box-sizing: border-box; font-size: 12px;";
        }

        const mainInput = document.createElement('input');
        mainInput.type = options.inputType;
        mainInput.id = `otk-${options.idSuffix}`; // Main input gets the direct ID for the label
        if (options.inputType === 'color') {
            mainInput.style.cssText = "width: 45px; height: 25px; padding: 0px 2px; box-sizing: border-box;";
        } else if (options.inputType === 'number') {
            mainInput.style.cssText = "width: 70px; height: 25px; box-sizing: border-box; font-size: 12px;";
            if (options.min !== undefined) mainInput.min = options.min;
            if (options.max !== undefined) mainInput.max = options.max;
        }

        const defaultBtn = document.createElement('button');
        defaultBtn.textContent = 'Default';
        defaultBtn.style.cssText = "padding: 2px 5px; min-width: 60px; height: 25px; font-size: 11px;";

        group.appendChild(label);
        if (hexInput) group.appendChild(hexInput);
        group.appendChild(mainInput);
        group.appendChild(defaultBtn);

        // Determine initial value for inputs
        let initialValue = getComputedStyle(document.documentElement).getPropertyValue(options.cssVariable)?.trim() || options.defaultValue;
        if (options.unit && initialValue.endsWith(options.unit)) {
            initialValue = initialValue.replace(options.unit, '');
        }

        if (options.inputType === 'color') {
            if (hexInput) hexInput.value = initialValue;
            mainInput.value = initialValue; // Color picker also needs full hex
        } else if (options.inputType === 'number') {
            mainInput.value = initialValue;
        }

        // Event handling
        const updateSetting = (value, fromColorPicker = false) => { // Added fromColorPicker flag
            let processedValue = value.trim();
            if (options.inputType === 'color') {
                if (!/^#[0-9A-F]{6}$/i.test(processedValue) && !/^#[0-9A-F]{3}$/i.test(processedValue)) {
                    consoleWarn(`Invalid hex color for ${options.labelText}:`, processedValue);
                    // Restore previous valid values if possible, or default
                    const currentSaved = (JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {})[options.storageKey] || options.defaultValue;
                    if (hexInput) hexInput.value = currentSaved;
                    mainInput.value = currentSaved;
                    return;
                }
                // If the update is coming from the color picker, hexInput.value is already correct via its own listener.
                // If the update is from hexInput, update mainInput (color picker).
                if (!fromColorPicker && hexInput) mainInput.value = processedValue;
                // If the update is from color picker, update hexInput.
                if (fromColorPicker && hexInput) hexInput.value = processedValue;

            } else if (options.inputType === 'number') {
                const numValue = parseInt(processedValue, 10);
                if (isNaN(numValue) || (options.min !== undefined && numValue < options.min) || (options.max !== undefined && numValue > options.max)) {
                    consoleWarn(`Invalid number value for ${options.labelText}:`, processedValue);
                     const currentSaved = (JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {})[options.storageKey] || options.defaultValue;
                    mainInput.value = currentSaved.replace(options.unit || '', '');
                    return;
                }
                mainInput.value = numValue; // Update input with validated number
                processedValue = numValue + (options.unit || '');
            }

            if (options.storageKey === 'viewerQuote1HeaderBorderColor' || options.storageKey === 'viewerQuote2plusHeaderBorderColor') {
                consoleLog(`[Debug UpdateSetting] Applying to ${options.cssVariable}: ${processedValue} (StorageKey: ${options.storageKey})`);
            }

            document.documentElement.style.setProperty(options.cssVariable, processedValue);
            saveThemeSetting(options.storageKey, processedValue);
            // If this is the cog icon color, update it directly as it's not part of applyThemeSettings' normal flow for self-update
            if (options.storageKey === 'cogIconColor') {
                 const cogIcon = document.getElementById('otk-settings-cog');
                 if(cogIcon) cogIcon.style.color = processedValue;
            }
        };

        if (hexInput) { // For color inputs
            hexInput.addEventListener('change', (e) => updateSetting(e.target.value, false)); // Fire on change (blur/enter)
            mainInput.addEventListener('input', (e) => { // Color picker updates continuously
                // hexInput.value = e.target.value; // Update hex field immediately as picker changes
                updateSetting(e.target.value, true); // Pass flag true
            });
        } else { // For number inputs
            mainInput.addEventListener('change', (e) => updateSetting(e.target.value));
        }

        defaultBtn.addEventListener('click', () => {
            document.documentElement.style.removeProperty(options.cssVariable); // Reverts to CSS default
            let cssDefaultValue = getComputedStyle(document.documentElement).getPropertyValue(options.cssVariable)?.trim() || options.defaultValue;

            if (options.unit && cssDefaultValue.endsWith(options.unit)) {
                cssDefaultValue = cssDefaultValue.replace(options.unit, '');
            }
            if (options.inputType === 'color') {
                if (hexInput) hexInput.value = cssDefaultValue;
                mainInput.value = cssDefaultValue;
            } else {
                mainInput.value = cssDefaultValue;
            }
            saveThemeSetting(options.storageKey, null); // Save null to signify using default
            // If this is the cog icon color, update it directly
            if (options.storageKey === 'cogIconColor') {
                 const cogIcon = document.getElementById('otk-settings-cog');
                 if(cogIcon) cogIcon.style.color = ''; // Clear inline style to use CSS var
            }
        });
        // Initial application from saved settings (if any) is handled by applyThemeSettings call later.
        // This function just sets up the row and its default state based on current CSS or fallback.
        return group;
    }

    function createDivider() {
        const hr = document.createElement('hr');
        hr.style.cssText = "width: 98%; border: none; border-top: 1px solid #555; margin: 12px auto 8px auto;";
        return hr;
    }

    function createSectionHeading(text) {
        const h = document.createElement('h5');
        h.textContent = text;
        h.style.cssText = "margin-top: 8px; margin-bottom: 8px; color: # ઓફ ઓફ ઓફ; font-size: 13px; border-bottom: 1px solid #444; padding-bottom: 4px; font-weight: bold;";
        return h;
    }

    // Clear existing content from themeOptionsContainer before repopulating
    themeOptionsContainer.innerHTML = '';

    // --- GUI Section ---
    themeOptionsContainer.appendChild(createSectionHeading('GUI'));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Background:", storageKey: 'guiBgColor', cssVariable: '--otk-gui-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'gui-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Title Font:", storageKey: 'titleTextColor', cssVariable: '--otk-title-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'title-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Thread Titles Font:", storageKey: 'guiThreadListTitleColor', cssVariable: '--otk-gui-threadlist-title-color', defaultValue: '#e0e0e0', inputType: 'color', idSuffix: 'threadlist-title' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Thread Times Font:", storageKey: 'guiThreadListTimeColor', cssVariable: '--otk-gui-threadlist-time-color', defaultValue: '#aaa', inputType: 'color', idSuffix: 'threadlist-time' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Stats Font:", storageKey: 'actualStatsTextColor', cssVariable: '--otk-stats-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'actual-stats-text' }));
    
    // Sub-section for GUI Buttons
    const guiButtonsSubHeading = document.createElement('h6');
    guiButtonsSubHeading.textContent = "GUI Buttons";
    guiButtonsSubHeading.style.cssText = "margin-top: 15px; margin-bottom: 5px; color: #cccccc; font-size: 12px; font-weight: bold;"; // Simple sub-heading style
    themeOptionsContainer.appendChild(guiButtonsSubHeading);
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Button Background:", storageKey: 'guiButtonBgColor', cssVariable: '--otk-button-bg-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'gui-button-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Button Text:", storageKey: 'guiButtonTextColor', cssVariable: '--otk-button-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'gui-button-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Button Border:", storageKey: 'guiButtonBorderColor', cssVariable: '--otk-button-border-color', defaultValue: '#777777', inputType: 'color', idSuffix: 'gui-button-border' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Button Hover BG:", storageKey: 'guiButtonHoverBgColor', cssVariable: '--otk-button-hover-bg-color', defaultValue: '#666666', inputType: 'color', idSuffix: 'gui-button-hover-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Button Active BG:", storageKey: 'guiButtonActiveBgColor', cssVariable: '--otk-button-active-bg-color', defaultValue: '#444444', inputType: 'color', idSuffix: 'gui-button-active-bg' }));
    
    themeOptionsContainer.appendChild(createDivider());

    // --- Viewer Section ---
    themeOptionsContainer.appendChild(createSectionHeading('Viewer'));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Background:", storageKey: 'viewerBgColor', cssVariable: '--otk-viewer-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'viewer-bg' }));
    // Assuming "Header Divider" refers to the GUI's bottom border as discussed.
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "GUI Bottom Border:", storageKey: 'guiBottomBorderColor', cssVariable: '--otk-gui-bottom-border-color', defaultValue: '#555', inputType: 'color', idSuffix: 'gui-bottom-border' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "New Msgs Divider:", storageKey: 'newMessagesDividerColor', cssVariable: '--otk-new-messages-divider-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'new-msg-divider' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "New Msgs Font:", storageKey: 'newMessagesFontColor', cssVariable: '--otk-new-messages-font-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'new-msg-font' }));
    themeOptionsContainer.appendChild(createDivider());

    // --- Messages Section ---
    themeOptionsContainer.appendChild(createSectionHeading('Messages'));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Font Size (px):", storageKey: 'viewerMessageFontSize', cssVariable: '--otk-viewer-message-font-size', defaultValue: '13px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'fontsize-message-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 0 Background:", storageKey: 'msgDepth0BgColor', cssVariable: '--otk-msg-depth0-bg-color', defaultValue: '#343434', inputType: 'color', idSuffix: 'msg-depth0-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 0 Font:", storageKey: 'msgDepth0TextColor', cssVariable: '--otk-msg-depth0-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth0-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 0 Header Font:", storageKey: 'msgDepth0HeaderTextColor', cssVariable: '--otk-msg-depth0-header-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth0-header-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 0 Header Underline:", storageKey: 'viewerHeaderBorderColor', cssVariable: '--otk-viewer-header-border-color', defaultValue: '#555', inputType: 'color', idSuffix: 'viewer-header-border' }));

    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 1 Background:", storageKey: 'msgDepth1BgColor', cssVariable: '--otk-msg-depth1-bg-color', defaultValue: '#525252', inputType: 'color', idSuffix: 'msg-depth1-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 1 Font:", storageKey: 'msgDepth1TextColor', cssVariable: '--otk-msg-depth1-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth1-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 1 Header Font:", storageKey: 'msgDepth1HeaderTextColor', cssVariable: '--otk-msg-depth1-header-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth1-header-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 1 Header Underline:", storageKey: 'viewerQuote1HeaderBorderColor', cssVariable: '--otk-viewer-quote1-header-border-color', defaultValue: '#343434', inputType: 'color', idSuffix: 'viewer-quote1-border' }));

    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 2+ Background:", storageKey: 'msgDepth2plusBgColor', cssVariable: '--otk-msg-depth2plus-bg-color', defaultValue: '#484848', inputType: 'color', idSuffix: 'msg-depth2plus-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 2+ Font:", storageKey: 'msgDepth2plusTextColor', cssVariable: '--otk-msg-depth2plus-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth2plus-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 2+ Header Font:", storageKey: 'msgDepth2plusHeaderTextColor', cssVariable: '--otk-msg-depth2plus-header-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth2plus-header-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Depth 2+ Header Underline:", storageKey: 'viewerQuote2plusHeaderBorderColor', cssVariable: '--otk-viewer-quote2plus-header-border-color', defaultValue: '#2a2a2a', inputType: 'color', idSuffix: 'viewer-quote2plus-border' })); // New option
    themeOptionsContainer.appendChild(createDivider());

    // --- Options Section ---
    themeOptionsContainer.appendChild(createSectionHeading('Options Panel'));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Cog Icon Color:", storageKey: 'cogIconColor', cssVariable: '--otk-cog-icon-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'cog-icon' })); // New option
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Panel Font:", storageKey: 'optionsTextColor', cssVariable: '--otk-options-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'options-text' }));
    themeOptionsContainer.appendChild(createDivider());

    // --- Loading Screen Sub-Section (within Theme) ---
    const loadingScreenSubHeading = document.createElement('h6');
    loadingScreenSubHeading.textContent = "Loading Screen";
    loadingScreenSubHeading.style.cssText = "margin-top: 15px; margin-bottom: 5px; color: #cccccc; font-size: 12px; font-weight: bold;";
    themeOptionsContainer.appendChild(loadingScreenSubHeading);

    // Create a nested container for loading screen options for clarity if needed, or add directly
    // For simplicity, adding directly to themeOptionsContainer under this new subheading.
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Overlay Base Color:", storageKey: 'loadingOverlayBaseHexColor', cssVariable: '--otk-loading-overlay-base-hex-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'loading-overlay-base-hex' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Overlay Opacity:", storageKey: 'loadingOverlayOpacity', cssVariable: '--otk-loading-overlay-opacity', defaultValue: '0.8', inputType: 'number', min:0.0, max:1.0, step:0.05, idSuffix: 'loading-overlay-opacity' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Text Color:", storageKey: 'loadingTextColor', cssVariable: '--otk-loading-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-text' }));
    
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Progress Bar BG:", storageKey: 'loadingProgressBarBgColor', cssVariable: '--otk-loading-progress-bar-bg-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'loading-progress-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Progress Bar Fill:", storageKey: 'loadingProgressBarFillColor', cssVariable: '--otk-loading-progress-bar-fill-color', defaultValue: '#4CAF50', inputType: 'color', idSuffix: 'loading-progress-fill' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Progress Bar Text:", storageKey: 'loadingProgressBarTextColor', cssVariable: '--otk-loading-progress-bar-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-progress-text' }));

    // --- Custom Themes Section ---
    themeOptionsContainer.appendChild(createDivider());
    themeOptionsContainer.appendChild(createSectionHeading('Custom Themes'));

    const customThemeActionsWrapper = document.createElement('div');
    customThemeActionsWrapper.style.cssText = "display: flex; flex-direction: column; gap: 10px;";

    // Name input and Save button
    const saveThemeRow = document.createElement('div');
    saveThemeRow.style.cssText = "display: flex; align-items: center; gap: 8px;";
    const newThemeNameInput = document.createElement('input');
    newThemeNameInput.type = 'text';
    newThemeNameInput.id = 'otk-custom-theme-name-input';
    newThemeNameInput.placeholder = 'Enter Theme Name';
    newThemeNameInput.style.cssText = "flex-grow: 1; height: 25px; box-sizing: border-box; font-size: 12px;";
    const saveThemeButton = document.createElement('button');
    saveThemeButton.id = 'otk-save-custom-theme-btn';
    saveThemeButton.textContent = 'Save Current Theme';
    saveThemeButton.style.cssText = "padding: 4px 8px; font-size: 11px; height: 25px;";
    saveThemeRow.appendChild(newThemeNameInput);
    saveThemeRow.appendChild(saveThemeButton);
    customThemeActionsWrapper.appendChild(saveThemeRow);

    // Dropdown, Load, and Delete buttons
    const manageThemeRow = document.createElement('div');
    manageThemeRow.style.cssText = "display: flex; align-items: center; gap: 8px;";
    const customThemesDropdown = document.createElement('select');
    customThemesDropdown.id = 'otk-custom-themes-dropdown';
    customThemesDropdown.style.cssText = "flex-grow: 1; height: 25px; box-sizing: border-box; font-size: 12px;";
    const loadThemeButton = document.createElement('button');
    loadThemeButton.id = 'otk-load-custom-theme-btn';
    loadThemeButton.textContent = 'Load';
    loadThemeButton.style.cssText = "padding: 4px 8px; font-size: 11px; height: 25px;";
    const deleteThemeButton = document.createElement('button');
    deleteThemeButton.id = 'otk-delete-custom-theme-btn';
    deleteThemeButton.textContent = 'Delete';
    deleteThemeButton.style.cssText = "padding: 4px 8px; font-size: 11px; height: 25px; background-color: #803333;"; // Dark red
    deleteThemeButton.onmouseover = () => deleteThemeButton.style.backgroundColor = '#a04444';
    deleteThemeButton.onmouseout = () => deleteThemeButton.style.backgroundColor = '#803333';


    manageThemeRow.appendChild(customThemesDropdown);
    manageThemeRow.appendChild(loadThemeButton);
    manageThemeRow.appendChild(deleteThemeButton);
    customThemeActionsWrapper.appendChild(manageThemeRow);

    themeOptionsContainer.appendChild(customThemeActionsWrapper);

    const CUSTOM_THEMES_KEY = 'otkCustomThemes';

    saveThemeButton.addEventListener('click', () => {
        const themeName = newThemeNameInput.value.trim();
        if (!themeName) {
            alert("Please enter a name for the theme.");
            newThemeNameInput.focus();
            return;
        }

        const currentActiveSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        if (Object.keys(currentActiveSettings).length === 0) {
            // If no settings are explicitly saved, gather them from current computed/default values
            // This ensures a full theme object is saved.
             const allConfigs = getAllOptionConfigs(); // Helper to get all theme configs
             allConfigs.forEach(config => {
                if (!currentActiveSettings[config.storageKey]) { // Only if not already set
                    let value = getComputedStyle(document.documentElement).getPropertyValue(config.cssVariable)?.trim();
                    if (!value && config.defaultValue) value = config.defaultValue; // Fallback to defined default
                    if (value) currentActiveSettings[config.storageKey] = value;
                }
             });
        }

        // consoleLog('[Debug Save Theme] Final currentActiveSettings object that will be saved for custom theme:', JSON.parse(JSON.stringify(currentActiveSettings))); // Retained original, more concise log
        // The more verbose [SaveThemeDebug] logs are removed by this diff.
        // The check for specific border colors can also be removed if not essential for general operation.
        // For now, let's keep the original single debug line for the final object.
        consoleLog('[Debug Save Theme] Final currentActiveSettings for custom theme:', JSON.parse(JSON.stringify(currentActiveSettings)));

        let customThemes = JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY)) || [];
        const existingThemeIndex = customThemes.findIndex(t => t.name === themeName);

        if (existingThemeIndex > -1) {
            if (!confirm(`A theme named "${themeName}" already exists. Overwrite it?`)) {
                return;
            }
            customThemes[existingThemeIndex].settings = currentActiveSettings;
            consoleLog(`Custom theme "${themeName}" overwritten.`);
        } else {
            customThemes.push({ name: themeName, settings: currentActiveSettings });
            consoleLog(`Custom theme "${themeName}" saved.`);
        }

        localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(customThemes));
        newThemeNameInput.value = ''; // Clear input
        populateCustomThemesDropdown(); // To be created in next step
        alert(`Theme "${themeName}" saved successfully!`);
    });

    function populateCustomThemesDropdown() {
        const dropdown = document.getElementById('otk-custom-themes-dropdown');
        if (!dropdown) return;

        dropdown.innerHTML = ''; // Clear existing options

        // Add the "Revert to Active" / "Current Settings" option first
        const revertOption = document.createElement('option');
        revertOption.value = "__REVERT__"; // Special value
        revertOption.textContent = "‹ Active Settings ›"; // Display text
        dropdown.appendChild(revertOption);

        const customThemes = JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY)) || [];

        if (customThemes.length === 0) {
            // If no custom themes, the "Revert" option might be confusing or lonely.
            // We can disable it or change its text, or simply let it be.
            // For now, let it be. User can save a theme to make the list more useful.
            // Alternatively, add a "No Saved Themes" disabled option after it.
            const noThemesOption = document.createElement('option');
            noThemesOption.textContent = "(No Saved Themes)";
            noThemesOption.disabled = true;
            dropdown.appendChild(noThemesOption);
        } else {
            customThemes.forEach(theme => {
                const option = document.createElement('option');
                option.value = theme.name; // Actual theme name
                option.textContent = theme.name;
                dropdown.appendChild(option);
            });
        }
        dropdown.value = "__REVERT__"; // Ensure the revert option is selected by default
    }
    // Initial population of the dropdown when options window is set up
    populateCustomThemesDropdown();

    let prePreviewSettings = null; // To store settings before previewing a theme
    let currentlyPreviewingThemeName = null; // To track which theme is being previewed

    customThemesDropdown.addEventListener('change', () => {
        const selectedValue = customThemesDropdown.value;
        const customThemes = JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY)) || [];

        if (selectedValue === "__REVERT__") {
            if (prePreviewSettings) {
                consoleLog("[PreviewTheme] Reverting to pre-preview settings.");
                localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(prePreviewSettings));
                applyThemeSettings();
                // prePreviewSettings = null; // Clear after reverting, or keep if user might toggle back and forth? Let's clear.
                currentlyPreviewingThemeName = null;
            } else {
                // This case means "Active Settings" was selected but nothing was previewed yet,
                // or it was re-selected after a load. Ensure current active settings are applied.
                consoleLog("[PreviewTheme] 'Active Settings' selected. Ensuring current active settings are applied.");
                const activeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
                localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(activeSettings)); // Re-affirm
                applyThemeSettings();
                currentlyPreviewingThemeName = null;
            }
        } else { // A custom theme is selected for preview
            const themeToPreview = customThemes.find(t => t.name === selectedValue);
            if (themeToPreview) {
                if (currentlyPreviewingThemeName === null) { // Only store pre-preview if not already previewing
                    // Store current *active* settings (from THEME_SETTINGS_KEY) before applying preview
                    prePreviewSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
                    consoleLog("[PreviewTheme] Stored pre-preview settings:", JSON.parse(JSON.stringify(prePreviewSettings)));
                }

                consoleLog(`[PreviewTheme] Previewing theme "${selectedValue}". Settings:`, JSON.parse(JSON.stringify(themeToPreview.settings)));
                // Apply theme settings for preview WITHOUT saving to THEME_SETTINGS_KEY yet.
                // applyThemeSettings directly uses THEME_SETTINGS_KEY, so we need a way to apply settings without permanently saving them.
                // Option 1: Modify applyThemeSettings to take an optional settings object.
                // Option 2: Temporarily set THEME_SETTINGS_KEY, apply, then restore if needed (more complex).
                // Let's go with Option 1. (This will require modifying applyThemeSettings later)

                // For now, let's simulate by updating CSS vars and inputs directly from themeToPreview.settings
                // This is a temporary approach until applyThemeSettings is refactored.
                // This will be complex to do manually here.
                //
                // Revised approach for preview:
                // 1. Store current active settings (from THEME_SETTINGS_KEY) into prePreviewSettings (if not already previewing).
                // 2. Temporarily set THEME_SETTINGS_KEY to the preview theme's settings.
                // 3. Call applyThemeSettings(). This will make the preview active.
                // 4. The "Load" button will make this temporary state permanent.
                // 5. Selecting "__REVERT__" will restore THEME_SETTINGS_KEY from prePreviewSettings and call applyThemeSettings().

                localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(themeToPreview.settings)); // Temporarily set for applyThemeSettings
                applyThemeSettings();
                currentlyPreviewingThemeName = selectedValue;
            }
        }
    });

    loadThemeButton.addEventListener('click', () => {
        const selectedThemeNameInDropdown = customThemesDropdown.value;

        if (selectedThemeNameInDropdown === "__REVERT__") {
            alert("Cannot 'load' the active settings. They are already active or have been reverted. Select a custom theme to load.");
            return;
        }

        if (!selectedThemeNameInDropdown || customThemesDropdown.selectedOptions.length === 0 || (customThemesDropdown.selectedOptions[0] && customThemesDropdown.selectedOptions[0].disabled)) {
            alert("Please select a theme from the dropdown to load.");
            return;
        }

        // At this point, if a theme was being previewed, its settings are already in THEME_SETTINGS_KEY
        // and applied to the UI via applyThemeSettings() from the dropdown's 'change' listener.
        // So, the "Load" action is effectively confirming the preview.
        // We just need to ensure prePreviewSettings is cleared as the preview is now the active setting.

        // consoleLog(`[LoadThemeDebug] Load button clicked. Theme "${selectedThemeNameInDropdown}" is now permanently active.`); // Removed
        // THEME_SETTINGS_KEY already has the previewed theme's settings.
        // applyThemeSettings() was already called when preview started.

        // Standard log for this action:
        consoleLog(`Theme "${selectedThemeNameInDropdown}" confirmed as active theme.`);
        prePreviewSettings = null; // Clear pre-preview state as current settings are now committed.
        currentlyPreviewingThemeName = null; // No longer just previewing.
        customThemesDropdown.value = "__REVERT__"; // Set dropdown to show "Active Settings" as current state.

        alert(`Theme "${selectedThemeNameInDropdown}" is now the active theme.`);
        // No, we don't call applyThemeSettings() again unless THEME_SETTINGS_KEY changed, which it hasn't here.
        // The settings from the preview *are* the new active settings.
    });

    deleteThemeButton.addEventListener('click', () => {
        const selectedThemeName = customThemesDropdown.value;
        if (!selectedThemeName || customThemesDropdown.selectedOptions.length === 0 || customThemesDropdown.selectedOptions[0].disabled) {
            alert("Please select a theme to delete.");
            return;
        }

        if (!confirm(`Are you sure you want to delete the theme "${selectedThemeName}"? This action cannot be undone.`)) {
            return;
        }

        let customThemes = JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY)) || [];
        const updatedThemes = customThemes.filter(t => t.name !== selectedThemeName);

        if (customThemes.length === updatedThemes.length) {
            alert(`Error: Theme "${selectedThemeName}" not found for deletion.`); // Should not happen if selected from dropdown
            return;
        }

        localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(updatedThemes));
        populateCustomThemesDropdown(); // Refresh the dropdown
        alert(`Theme "${selectedThemeName}" deleted successfully!`);
        consoleLog(`Custom theme "${selectedThemeName}" deleted.`);
    });


    // --- Reset All Button ---
    // It should be outside the normal flow of generated options, or the last item.
    // For now, let's re-add it manually after all generated content.
    const resetAllColorsButton = document.createElement('button');
    resetAllColorsButton.textContent = "Reset All Colors to Default";
    resetAllColorsButton.id = 'otk-reset-all-colors-btn'; // Keep ID if applyThemeSettings uses it
    resetAllColorsButton.style.cssText = "margin-top: 20px; padding: 5px 10px; display: block; margin-left: auto; margin-right: auto;";
    themeOptionsContainer.appendChild(resetAllColorsButton);

    // Helper function to get all theme configurations (used by save and reset)
    function getAllOptionConfigs() {
        return [
            { storageKey: 'guiBgColor', cssVariable: '--otk-gui-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'gui-bg' },
            { storageKey: 'titleTextColor', cssVariable: '--otk-title-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'title-text' },
            { storageKey: 'guiThreadListTitleColor', cssVariable: '--otk-gui-threadlist-title-color', defaultValue: '#e0e0e0', inputType: 'color', idSuffix: 'threadlist-title' },
            { storageKey: 'guiThreadListTimeColor', cssVariable: '--otk-gui-threadlist-time-color', defaultValue: '#aaa', inputType: 'color', idSuffix: 'threadlist-time' },
            { storageKey: 'actualStatsTextColor', cssVariable: '--otk-stats-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'actual-stats-text' },
            { storageKey: 'viewerBgColor', cssVariable: '--otk-viewer-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'viewer-bg' },
            { storageKey: 'guiBottomBorderColor', cssVariable: '--otk-gui-bottom-border-color', defaultValue: '#555', inputType: 'color', idSuffix: 'gui-bottom-border' },
            { storageKey: 'viewerMessageFontSize', cssVariable: '--otk-viewer-message-font-size', defaultValue: '13px', inputType: 'number', unit: 'px', idSuffix: 'fontsize-message-text' },
            { storageKey: 'msgDepth0BgColor', cssVariable: '--otk-msg-depth0-bg-color', defaultValue: '#343434', inputType: 'color', idSuffix: 'msg-depth0-bg' },
            { storageKey: 'msgDepth0TextColor', cssVariable: '--otk-msg-depth0-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth0-text' },
            { storageKey: 'msgDepth0HeaderTextColor', cssVariable: '--otk-msg-depth0-header-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth0-header-text' },
            { storageKey: 'viewerHeaderBorderColor', cssVariable: '--otk-viewer-header-border-color', defaultValue: '#555', inputType: 'color', idSuffix: 'viewer-header-border' },
            { storageKey: 'msgDepth1BgColor', cssVariable: '--otk-msg-depth1-bg-color', defaultValue: '#525252', inputType: 'color', idSuffix: 'msg-depth1-bg' },
            { storageKey: 'msgDepth1TextColor', cssVariable: '--otk-msg-depth1-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth1-text' },
            { storageKey: 'msgDepth1HeaderTextColor', cssVariable: '--otk-msg-depth1-header-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth1-header-text' },
            { storageKey: 'viewerQuote1HeaderBorderColor', cssVariable: '--otk-viewer-quote1-header-border-color', defaultValue: '#343434', inputType: 'color', idSuffix: 'viewer-quote1-border' },
            { storageKey: 'msgDepth2plusBgColor', cssVariable: '--otk-msg-depth2plus-bg-color', defaultValue: '#484848', inputType: 'color', idSuffix: 'msg-depth2plus-bg' },
            { storageKey: 'msgDepth2plusTextColor', cssVariable: '--otk-msg-depth2plus-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth2plus-text' },
            { storageKey: 'msgDepth2plusHeaderTextColor', cssVariable: '--otk-msg-depth2plus-header-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth2plus-header-text' },
            { storageKey: 'viewerQuote2plusHeaderBorderColor', cssVariable: '--otk-viewer-quote2plus-header-border-color', defaultValue: '#2a2a2a', inputType: 'color', idSuffix: 'viewer-quote2plus-border' },
            { storageKey: 'cogIconColor', cssVariable: '--otk-cog-icon-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'cog-icon' },
            { storageKey: 'optionsTextColor', cssVariable: '--otk-options-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'options-text' },
            { storageKey: 'newMessagesDividerColor', cssVariable: '--otk-new-messages-divider-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'new-msg-divider' },
            { storageKey: 'newMessagesFontColor', cssVariable: '--otk-new-messages-font-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'new-msg-font' },

            // GUI Button Colors
            { storageKey: 'guiButtonBgColor', cssVariable: '--otk-button-bg-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'gui-button-bg' },
            { storageKey: 'guiButtonTextColor', cssVariable: '--otk-button-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'gui-button-text' },
            { storageKey: 'guiButtonBorderColor', cssVariable: '--otk-button-border-color', defaultValue: '#777777', inputType: 'color', idSuffix: 'gui-button-border' },
            { storageKey: 'guiButtonHoverBgColor', cssVariable: '--otk-button-hover-bg-color', defaultValue: '#666666', inputType: 'color', idSuffix: 'gui-button-hover-bg' },
            { storageKey: 'guiButtonActiveBgColor', cssVariable: '--otk-button-active-bg-color', defaultValue: '#444444', inputType: 'color', idSuffix: 'gui-button-active-bg' },

            // Loading Screen Colors
            { storageKey: 'loadingOverlayBaseHexColor', cssVariable: '--otk-loading-overlay-base-hex-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'loading-overlay-base-hex' },
            { storageKey: 'loadingOverlayOpacity', cssVariable: '--otk-loading-overlay-opacity', defaultValue: '0.8', inputType: 'number', unit: null, min:0.0, max:1.0, step:0.05, idSuffix: 'loading-overlay-opacity' },
            { storageKey: 'loadingTextColor', cssVariable: '--otk-loading-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-text' },
            { storageKey: 'loadingProgressBarBgColor', cssVariable: '--otk-loading-progress-bar-bg-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'loading-progress-bg' },
            { storageKey: 'loadingProgressBarFillColor', cssVariable: '--otk-loading-progress-bar-fill-color', defaultValue: '#4CAF50', inputType: 'color', idSuffix: 'loading-progress-fill' },
            { storageKey: 'loadingProgressBarTextColor', cssVariable: '--otk-loading-progress-bar-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-progress-text' }
        ];
    }


    resetAllColorsButton.addEventListener('click', () => {
        if (!confirm("Are you sure you want to reset all theme settings to their defaults?")) {
            return;
        }
        consoleLog("Resetting all theme settings to default...");
        const allOptionConfigs = getAllOptionConfigs();

        allOptionConfigs.forEach(opt => {
            document.documentElement.style.removeProperty(opt.cssVariable);
            saveThemeSetting(opt.storageKey, null);

            const mainInput = document.getElementById(`otk-${opt.idSuffix}`);
            const hexInput = opt.inputType === 'color' ? document.getElementById(`otk-${opt.idSuffix}-hex`) : null;

            let cssDefaultValue = getComputedStyle(document.documentElement).getPropertyValue(opt.cssVariable)?.trim() || opt.defaultValue;
            if (opt.unit && cssDefaultValue.endsWith(opt.unit)) {
                cssDefaultValue = cssDefaultValue.replace(opt.unit, '');
            }

            if (mainInput) mainInput.value = cssDefaultValue;
            if (hexInput) hexInput.value = cssDefaultValue;

            if (opt.storageKey === 'cogIconColor') {
                const cogIcon = document.getElementById('otk-settings-cog');
                if(cogIcon) cogIcon.style.color = '';
            }
        });
        // applyThemeSettings(); // Call to refresh all inputs based on new defaults
        alert("All theme settings have been reset to their defaults.");
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
            --otk-cog-icon-color: #e6e6e6; /* Default for settings cog icon */
            --otk-viewer-quote2plus-header-border-color: #2a2a2a; /* Default for Depth 2+ message header underline */
            --otk-new-messages-divider-color: #FFD700; /* Default for new message separator line */
            --otk-new-messages-font-color: #FFD700; /* Default for new message separator text */

            /* GUI Button Colors */
            --otk-button-bg-color: #555;
            --otk-button-text-color: white;
            --otk-button-border-color: #777;
            --otk-button-hover-bg-color: #666;
            --otk-button-active-bg-color: #444444; /* Ensured hex */

            /* Loading Screen Colors */
            --otk-loading-overlay-base-hex-color: #000000; /* Hex base for overlay */
            --otk-loading-overlay-opacity: 0.8;
            --otk-loading-text-color: #ffffff; /* Hex for white */
            --otk-loading-progress-bar-bg-color: #333333; /* Hex for dark grey */
            --otk-loading-progress-bar-fill-color: #4CAF50; /* Already hex */
            --otk-loading-progress-bar-text-color: #ffffff; /* Hex for white */
            /* Add more variables here as they are identified */
        }

        /* Refined Chrome Scrollbar Styling for Overlay Effect */
        #otk-messages-container::-webkit-scrollbar {
            width: 8px; /* Thinner for a more subtle overlay appearance */
        }

        #otk-messages-container::-webkit-scrollbar-track {
            background: transparent; /* Make track transparent for overlay effect */
        }

        #otk-messages-container::-webkit-scrollbar-thumb {
            background-color: var(--otk-stats-text-color, #888); /* Use a theme variable, fallback to #888 */
            border-radius: 4px; /* Slightly smaller radius for a thinner bar */
            /* The border creates a visual separation from content, enhancing overlay feel */
            border: 2px solid transparent; /* Keep border transparent initially */
            background-clip: padding-box; /* Ensures background doesn't go under the border */
        }

        #otk-messages-container::-webkit-scrollbar-thumb:hover {
            background-color: #aaa; /* Lighter on hover for better visibility */
            border-color: var(--otk-viewer-bg-color, #181818); /* Show border matching background on hover */
        }
        /* Make scrollbar visible only when scrolling or hovering over the container */
        /* This is harder to achieve with pure CSS for ::-webkit-scrollbar if not natively supported by OS/Browser settings */
        /* The transparent track and subtle thumb provide a good approximation. */
        /* True auto-hide on non-interaction often requires JavaScript or browser/OS support for overlay scrollbars. */

        /* GUI Button States */
        .otk-button--hover {
            background-color: var(--otk-button-hover-bg-color) !important;
        }
        .otk-button--active {
            background-color: var(--otk-button-active-bg-color) !important;
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
