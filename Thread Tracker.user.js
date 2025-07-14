// ==UserScript==
// @name         Thread Tracker
// @namespace    http://tampermonkey.net/
// @version      2.7
// @description  Tracks OTK threads on /b/, stores messages and media, shows top bar with colors and controls, removes inactive threads entirely
// @match        https://boards.4chan.org/b/
// @grant        GM_xmlhttpRequest
// @connect      publish.x.com
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
    const TWEET_EMBED_MODE_KEY = 'otkTweetEmbedMode'; // For tweet embed theme
    const TWEET_CACHE_KEY = 'otkTweetCache'; // For caching tweet HTML
    const twitterPatterns = [
        { regex: /^(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/\w+\/status\/(\d+)/, idGroup: 1 }
    ];
    const inlineTwitterPatterns = [
        { regex: /(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/\w+\/status\/(\d+)/, idGroup: 1 }
    ];

    // --- Global variables ---
    let otkViewer = null;
    let tweetCache = JSON.parse(localStorage.getItem(TWEET_CACHE_KEY)) || {};
    let viewerActiveImageCount = null; // For viewer-specific unique image count
    let viewerActiveVideoCount = null; // For viewer-specific unique video count
    let backgroundRefreshIntervalId = null;
    let isManualRefreshInProgress = false;
    let isSuspended = false;
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

            // As a final failsafe for the stuck button issue, find the refresh button and ensure its state is visually correct.
            const btnRefresh = document.getElementById('otk-refresh-data-btn');
            if (btnRefresh && !btnRefresh.disabled) {
                btnRefresh.classList.remove('otk-button--active');
                // Re-apply the base background color directly to override any lingering :active styles.
                btnRefresh.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--otk-button-bg-color').trim();
            }
        } else {
            consoleWarn("Loading screen overlay not found when trying to hide.");
        }
    }

    function showSuspendedScreen() {
        const overlay = document.createElement('div');
        overlay.id = 'otk-suspended-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.9);
            z-index: 100001;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: Verdana, sans-serif;
            color: white;
            font-size: 24px;
        `;
        overlay.textContent = 'Thread Tracker is suspended due to inactivity.';
        document.body.appendChild(overlay);
    }

    function hideSuspendedScreen() {
        const overlay = document.getElementById('otk-suspended-overlay');
        if (overlay) {
            overlay.remove();
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
function appendTextOrQuoteSegment(textElement, segment, quoteRegex, currentDepth, MAX_QUOTE_DEPTH, messagesByThreadId, embedWrappers, uniqueImageViewerHashes, boardForLink, mediaLoadPromises, parentMessageId) {
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
            mediaLoadPromises, // Pass down the array for mediaLoadPromises for quotes
                embedWrappers,
                uniqueImageViewerHashes,
                // uniqueVideoViewerHashes, // Removed
                quotedMessageObject.board || boardForLink,
                false, // isTopLevelMessage = false for quotes
                currentDepth + 1,
                null, // threadColor is not used for quoted message accents
                parentMessageId // Pass the PARENT message's ID for the quote
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
            appendTextOrQuoteSegment(textElement, restOfSegment, quoteRegex, currentDepth, MAX_QUOTE_DEPTH, messagesByThreadId, uniqueImageViewerHashes, boardForLink, mediaLoadPromises, parentMessageId);
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

    return wrapper;
}


function createTweetEmbedElement(tweetId) {
    const embedMode = localStorage.getItem('otk-tweet-embed-mode') || 'default';
    if (embedMode === 'disabled') {
        const disabledSpan = document.createElement('span');
        disabledSpan.style.display = 'none';
        return disabledSpan;
    }

    const cacheKey = `${tweetId}-${embedMode}`;
    const embedContainer = document.createElement('div');
    embedContainer.className = 'otk-tweet-embed';
    embedContainer.style.display = 'inline-block';
    embedContainer.style.minHeight = '100px';

    const processTweet = () => {
        if (tweetCache[cacheKey]) {
            embedContainer.innerHTML = tweetCache[cacheKey];
            if (window.twttr && window.twttr.widgets) {
                window.twttr.widgets.load(embedContainer);
            }
            return;
        }

        const embedUrl = `https://publish.x.com/oembed?url=https://twitter.com/any/status/${tweetId}&theme=${embedMode}&omit_script=true`;
        GM_xmlhttpRequest({
            method: "GET",
            url: embedUrl,
            onload: function(response) {
                try {
                    const data = JSON.parse(response.responseText);
                    if (data.html) {
                        tweetCache[cacheKey] = data.html;
                        localStorage.setItem('otk-tweet-cache', JSON.stringify(tweetCache));
embedContainer.innerHTML = data.html;

                        const tweetObserver = new IntersectionObserver((entries, observer) => {
                            entries.forEach(entry => {
                                if (entry.isIntersecting) {
                                    if (window.twttr && window.twttr.widgets) {
                                        window.twttr.widgets.load(entry.target);
                                        observer.unobserve(entry.target);
                                    }
                                }
                            });
                        });
                        tweetObserver.observe(embedContainer);
                    } else {
                        embedContainer.textContent = "[Tweet not found]";
                    }
                } catch (e) {
                    embedContainer.textContent = "[Tweet parse error]";
                    console.error("Error parsing tweet embed JSON", e);
                }
            },
            onerror: function(err) {
                embedContainer.textContent = "[Tweet fetch error]";
                console.error("Error loading tweet embed:", err);
            }
        });
    };

    if (window.twttr && window.twttr.widgets) {
        processTweet();
    } else {
        const script = document.createElement("script");
        script.src = "https://platform.twitter.com/widgets.js";
        script.onload = () => {
            processTweet();
        };
        document.head.appendChild(script);
    }

    return embedContainer;
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
        const allThreadIds = Object.keys(messagesByThreadId);
        for (const threadId of allThreadIds) {
            if (messagesByThreadId.hasOwnProperty(threadId) && Array.isArray(messagesByThreadId[threadId])) {
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
            align-items: flex-start;
            width: fit-content;
            margin: 0 0 0 -20px;
        `;

        const threadsTrackedStat = document.createElement('div');
        threadsTrackedStat.id = 'otk-threads-tracked-stat';
        threadsTrackedStat.style.display = 'flex';

        const totalMessagesStat = document.createElement('div');
        totalMessagesStat.id = 'otk-total-messages-stat';

        const localImagesStat = document.createElement('div');
        localImagesStat.id = 'otk-local-images-stat';
        localImagesStat.style.display = 'flex';

        const localVideosStat = document.createElement('div');
        localVideosStat.id = 'otk-local-videos-stat';
        localVideosStat.style.display = 'flex';

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

    function animateCounter(element, start, end, duration) {
            element.style.color = 'var(--otk-background-updates-stats-text-color)';
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            element.textContent = ` (+${Math.floor(progress * (end - start) + start)} new)`;
            if (progress < 1) {
                window.requestAnimationFrame(step);
            }
        };
        window.requestAnimationFrame(step);
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
    function renderThreadList(liveThreadIds) {
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
        const threadDisplayObjects = liveThreadIds.map(threadId => {
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

        const allMessages = getAllMessagesSorted();
        const newMessages = allMessages.filter(m => !renderedMessageIdsInViewer.has(m.id));
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

        mediaIntersectionObserver = new IntersectionObserver(handleIntersection, {
            root: messagesContainer,
            rootMargin: '0px 0px 300px 0px',
            threshold: 0.01
        });
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
        otkViewer.appendChild(messagesContainer);

        const totalMessagesToRender = newMessages.length;
        let messagesProcessedInViewer = 0;
        let imagesFoundInViewer = 0;
        let videosFoundInViewer = 0;
        const mediaLoadPromises = [];
        const embedWrappers = [];
        const updateInterval = Math.max(1, Math.floor(totalMessagesToRender / 20)); // Update progress roughly 20 times or every message

        for (let i = 0; i < totalMessagesToRender; i++) {
            const message = newMessages[i];
            renderedMessageIdsInViewer.add(message.id);

            const boardForLink = message.board || 'b';
            const threadColor = getThreadColor(message.originalThreadId);

            const messageElement = createMessageElementDOM(message, mediaLoadPromises, embedWrappers, uniqueImageViewerHashes, boardForLink, true, 0, threadColor, null); // Top-level messages have no parent
            if (messageElement) {
                messagesContainer.appendChild(messageElement);
            }

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
                let detailsStr = `Rendering messages (${messagesProcessedInViewer}/${totalMessagesToRender})...`; // Simplified
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
            embedWrappers.forEach(wrapper => mediaIntersectionObserver.observe(wrapper));
            if (window.twttr && window.twttr.widgets) {
                const tweetEmbeds = otkViewer.querySelectorAll('.otk-tweet-embed');
                if (tweetEmbeds.length > 0) {
                    consoleLog(`[Twitter] Found ${tweetEmbeds.length} tweet embeds to render.`);
                    window.twttr.widgets.load(tweetEmbeds);
                }
            }
            consoleLog("All inline media load attempts complete.");
            updateLoadingProgress(95, "Finalizing view...");
    viewerActiveImageCount = uniqueImageViewerHashes.size;
    viewerActiveVideoCount = viewerTopLevelAttachedVideoHashes.size + viewerTopLevelEmbedIds.size;
    consoleLog(`[StatsDebug] Viewer counts updated: Images=${viewerActiveImageCount}, Videos (top-level attached + top-level embed)=${viewerActiveVideoCount}`);
    updateDisplayedStatistics(); // Update stats after all media processing is attempted.

            let anchorScrolled = false;
            const storedAnchoredInstanceId = localStorage.getItem(ANCHORED_MESSAGE_ID_KEY);

            if (storedAnchoredInstanceId) {
                const anchoredElement = document.getElementById(storedAnchoredInstanceId);

                if (anchoredElement && messagesContainer.contains(anchoredElement)) {
                    try {
                        anchoredElement.scrollIntoView({ behavior: 'auto', block: 'center' });
                        anchorScrolled = true;
                        consoleLog(`Scrolled to anchored message instance: ${storedAnchoredInstanceId}`);
                        if (!anchoredElement.classList.contains(ANCHORED_MESSAGE_CLASS)) {
                            anchoredElement.classList.add(ANCHORED_MESSAGE_CLASS);
                        }
                    } catch (e) {
                        consoleError("Error scrolling to anchored message:", e);
                    }
                } else {
                    consoleWarn(`Anchored message instance ${storedAnchoredInstanceId} not found. Clearing anchor.`);
                    localStorage.removeItem(ANCHORED_MESSAGE_ID_KEY);
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

// Helper function to populate attachmentDiv with media (images/videos)
function _populateAttachmentDivWithMedia(
    attachmentDiv, // The div to append media to
    message,       // The message object
    actualBoardForLink, // Board string for URLs
    mediaLoadPromises,  // Array for async operations
    uniqueImageViewerHashes, // Set for tracking unique images shown
    isTopLevelMessage,     // Boolean, for some media logic (e.g., video stats)
    layoutStyle,           // 'new_design' or 'default', to condition New Design specific logic
    renderedFullSizeImageHashes, // Set for tracking full-size images
    viewerTopLevelAttachedVideoHashes, // Set for video stats
    otkMediaDB // IndexedDB instance
) {
    // Ensure message.attachment and message.attachment.ext exist before using them
    if (!message.attachment || !message.attachment.ext) {
        // consoleWarn(" populateAttachmentDivWithMedia: Attachment or extension missing.", message.id);
        return; // Nothing to process
    }

    const extLower = message.attachment.ext.toLowerCase();
    const filehash = message.attachment.filehash_db_key || `${message.attachment.tim}${extLower}`;

    if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLower)) {
        // --- IMAGE LOGIC ---
        // Unified image logic (derived from New Design's more feature-rich version)
        let defaultToThumbnail;
        let isFirstFullSizeRender = !renderedFullSizeImageHashes.has(filehash);

        const { w, h } = message.attachment;
        if ((w <= 570 && h <= 730) || (w <= 2050 && h <= 530)) {
            defaultToThumbnail = false;
        } else {
            defaultToThumbnail = true;
        }

        const img = document.createElement('img');
        img.dataset.filehash = filehash;
        img.dataset.thumbWidth = message.attachment.tn_w;
        img.dataset.thumbHeight = message.attachment.tn_h;
        img.dataset.isThumbnail = defaultToThumbnail ? 'true' : 'false';
        img.style.cursor = 'pointer';
        img.style.display = 'block';
        img.style.borderRadius = '3px';

        const webFullSrc = `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${message.attachment.ext}`;
        const webThumbSrc = `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}s.jpg`;
        img.dataset.fullSrc = webFullSrc;
        img.dataset.thumbSrc = webThumbSrc;

        const setImageProperties = (src) => {
            if (img.dataset.isThumbnail === 'true') {
                img.src = src || img.dataset.thumbSrc;
                img.style.width = message.attachment.tn_w + 'px';
                img.style.height = message.attachment.tn_h + 'px';
                img.style.maxWidth = ''; img.style.maxHeight = '';
            } else {
                img.src = src || img.dataset.fullSrc;
                img.style.maxWidth = '85%';
                img.style.width = message.attachment.w + 'px';
                img.style.height = message.attachment.h + 'px';
            }
        };

        img.addEventListener('click', () => {
            const currentlyThumbnail = img.dataset.isThumbnail === 'true';
            if (currentlyThumbnail) {
                if (message.attachment.localStoreId && otkMediaDB) {
                    const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
                    const store = transaction.objectStore('mediaStore');
                    const request = store.get(message.attachment.localStoreId);
                    request.onsuccess = (event) => {
                        const storedItem = event.target.result;
                        if (storedItem && storedItem.blob) {
                            blobToDataURL(storedItem.blob).then(dataURL => {
                                img.src = dataURL;
                                img.style.maxWidth = '85%';
                                img.style.width = message.attachment.w + 'px';
                                img.style.height = message.attachment.h + 'px';
                                img.dataset.isThumbnail = 'false';
                            });
                        }
                    };
                } else {
                    img.src = img.dataset.fullSrc;
                    img.style.maxWidth = '85%';
                    img.style.width = message.attachment.w + 'px';
                    img.style.height = message.attachment.h + 'px';
                    img.dataset.isThumbnail = 'false';
                }
            } else {
                if (message.attachment.localThumbStoreId && otkMediaDB) {
                    const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
                    const store = transaction.objectStore('mediaStore');
                    const request = store.get(message.attachment.localThumbStoreId);
                    request.onsuccess = (event) => {
                        const storedItem = event.target.result;
                        if (storedItem && storedItem.blob) {
                            blobToDataURL(storedItem.blob).then(dataURL => {
                                img.src = dataURL;
                                img.style.width = message.attachment.tn_w + 'px';
                                img.style.height = message.attachment.tn_h + 'px';
                                img.style.maxWidth = '';
                                img.style.maxHeight = '';
                                img.dataset.isThumbnail = 'true';
                            });
                        }
                    };
                } else {
                    img.src = img.dataset.thumbSrc;
                    img.style.width = message.attachment.tn_w + 'px';
                    img.style.height = message.attachment.tn_h + 'px';
                    img.style.maxWidth = '';
                    img.style.maxHeight = '';
                    img.dataset.isThumbnail = 'true';
                }
            }
        });

        if (message.attachment.localStoreId && otkMediaDB) {
            const transaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
            const store = transaction.objectStore('mediaStore');
            const request = store.get(defaultToThumbnail ? message.attachment.localThumbStoreId : message.attachment.localStoreId);
            request.onsuccess = (event) => {
                const storedItem = event.target.result;
                if (storedItem && storedItem.blob) {
                    blobToDataURL(storedItem.blob).then(dataURL => {
                        setImageProperties(dataURL);
                    });
                } else {
                    setImageProperties();
                }
            };
            request.onerror = (event) => {
                consoleError(`Error fetching image ${filehash} from IDB: ${event.target.error}`);
                setImageProperties();
            };
        } else {
            setImageProperties();
        }
        attachmentDiv.appendChild(img);

    } else if (extLower.endsWith('webm') || extLower.endsWith('mp4')) {
        // --- VIDEO LOGIC ---
        const setupVideo = (src) => {
            const videoElement = document.createElement('video');
            if (!message.attachment.tim || !message.attachment.ext) {
                consoleError(`Video attachment for message ${message.id} is missing 'tim' or 'ext'. Cannot construct video src.`);
                // Potentially don't append, or append a placeholder? For now, it will have no src.
            } else {
                videoElement.src = src || `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${extLower.startsWith('.') ? extLower : '.' + extLower}`; // Ensure ext has a dot
            }
            videoElement.controls = true;
            videoElement.style.maxWidth = '85%';
            videoElement.style.width = message.attachment.w + 'px';
            videoElement.style.height = message.attachment.h + 'px';
            videoElement.style.borderRadius = '3px';
            videoElement.style.display = 'block';
            attachmentDiv.appendChild(videoElement);
            if (src) {
                videoElement.load();
            }
            if (message.attachment.filehash_db_key && isTopLevelMessage) {
                viewerTopLevelAttachedVideoHashes.add(message.attachment.filehash_db_key);
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
                        setupVideo(URL.createObjectURL(storedItem.blob));
                    } else {
                        setupVideo(null);
                    }
                    resolveMedia();
                };
                request.onerror = (event) => {
                    consoleError(`Error fetching video ${filehash} from IDB: ${event.target.error}`);
                    setupVideo(null);
                    resolveMedia();
                };
            }));
        } else {
            setupVideo(null);
        }
    }
}

    // Signature now includes parentMessageId
    function createMessageElementDOM(message, mediaLoadPromises, embedWrappers, uniqueImageViewerHashes, boardForLink, isTopLevelMessage, currentDepth, threadColor, parentMessageId = null) {
        const layoutStyle = localStorage.getItem('otkMessageLayoutStyle') || 'default';
        consoleLog(`[DepthCheck] Rendering message: ${message.id}, parent: ${parentMessageId}, currentDepth: ${currentDepth}, MAX_QUOTE_DEPTH: ${MAX_QUOTE_DEPTH}, isTopLevel: ${isTopLevelMessage}, layoutStyle: ${layoutStyle}`);

        const allThemeSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        let depthKeyPart;
        if (isTopLevelMessage) { // Depth 0
            depthKeyPart = '0';
        } else if (currentDepth === 1) { // Depth 1
            depthKeyPart = '1';
        } else { // Depth 2+
            depthKeyPart = '2plus';
        }

        const disableUnderlineKey = `otkMsgDepth${depthKeyPart}DisableHeaderUnderline`;
        const displayFilenamesKey = `otkMsgDepth${depthKeyPart}DisplayMediaFilename`;

        // Default for disableUnderline is false (meaning, underline is ON by default)
        const shouldDisableUnderline = allThemeSettings[disableUnderlineKey] === true;

        // Default for displayFilenames is true (meaning, filenames are SHOWN by default)
        let shouldDisplayFilenames;
        if (allThemeSettings.hasOwnProperty(displayFilenamesKey)) {
            shouldDisplayFilenames = allThemeSettings[displayFilenamesKey] === true;
        } else {
            shouldDisplayFilenames = true; // Default value
        }

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

        if (layoutStyle === 'new_design') {
            const messageDiv = document.createElement('div');
            messageDiv.setAttribute('data-message-id', message.id);
            let currentMessageOwnText; // Declare here

            // Apply base class for new design structure based on depth
            if (isTopLevelMessage) {
                messageDiv.className = 'otk-message-container-main';
            } else {
                if (currentDepth === 1) {
                    messageDiv.className = 'otk-message-container-quote-depth-1';
                } else { // currentDepth >= 2
                    messageDiv.className = 'otk-message-container-quote-depth-2';
                }
            }

            const quoteRegex = /^>>(\d+)/;
            let quotedMessagesContainer = null; // To hold >>123 quotes if any

            // Process text to extract and render >>ddd quotes first
            if (message.text && typeof message.text === 'string') {
                const lines = message.text.split('\n');
                const remainingLines = []; // Store lines that are not >>ddd quotes to be processed later

                lines.forEach(line => {
                    const quoteMatch = line.match(quoteRegex);
                    if (quoteMatch && line.startsWith(quoteMatch[0]) && currentDepth < MAX_QUOTE_DEPTH) {
                        // This line is a >>ddd quote and should be rendered as a block
                        if (!quotedMessagesContainer) {
                            quotedMessagesContainer = document.createElement('div');
                            // No specific class for this container yet, styling comes from children
                        }
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
                            consoleLog(`[QuoteDebug] new_design: Calling createMessageElementDOM for quote ${quotedMessageId}. mediaLoadPromises is an array: ${Array.isArray(mediaLoadPromises)}`);
                            const quotedElement = createMessageElementDOM(
                                quotedMessageObject,
                                mediaLoadPromises,
                                embedWrappers,
                                uniqueImageViewerHashes,
                                quotedMessageObject.board || boardForLink,
                                false, // isTopLevelMessage = false for quotes
                                currentDepth + 1,
                                null, // threadColor is not used for quoted message accents in new design
                                message.id // Pass the PARENT message's ID for the quote
                            );
                            if (quotedElement) {
                                quotedMessagesContainer.appendChild(quotedElement);
                            }
                        } else {
                            const notFoundSpan = document.createElement('div'); // Render as a div for block display
                            notFoundSpan.textContent = `${line} (Not Found)`;
                            notFoundSpan.style.color = 'var(--otk-newdesign-header-text-color, #555)'; // Use a theme color
                            notFoundSpan.style.padding = '4px 0';
                            quotedMessagesContainer.appendChild(notFoundSpan);
                        }
                        // Check if there's text after the quote on the same line
                        const restOfLine = line.substring(quoteMatch[0].length).trim();
                        if (restOfLine.length > 0) {
                            remainingLines.push(restOfLine); // Add this trailing text to be processed with main content
                        }
                    } else {
                        remainingLines.push(line);
                    }
                });

                if (quotedMessagesContainer) {
                    messageDiv.appendChild(quotedMessagesContainer);
                }
                // Assign to the block-scoped currentMessageOwnText
                currentMessageOwnText = remainingLines.join('\n');
            } else {
                 // If message.text was initially null or not a string, or not processed above
                currentMessageOwnText = message.text || '';
            }


            // Now create the main content block for the current message (color square, header, text)
            const postDiv = document.createElement('div');
            postDiv.className = 'otk-post-div';

            if (isTopLevelMessage) {
                const colorSquareDiv = document.createElement('div');
                colorSquareDiv.className = 'otk-color-square';
                // threadColor for the square is implicitly handled by --otk-newdesign-colorsquare-bg if that's how it's set up
                // Or, if threadColor should override it:
                if (threadColor) { // Only apply if a specific thread color is provided
                   colorSquareDiv.style.backgroundColor = threadColor;
                } else {
                   colorSquareDiv.style.backgroundColor = 'var(--otk-newdesign-colorsquare-bg)';
                }
                postDiv.appendChild(colorSquareDiv);
            }

            const textWrapperDiv = document.createElement('div');
            textWrapperDiv.className = 'otk-text-wrapper';

            const messageHeader = document.createElement('div');
            messageHeader.className = 'otk-header-div';
            messageHeader.style.justifyContent = 'flex-start'; // Override CSS for left alignment

            const timestampParts = formatTimestampForHeader(message.time);
            const headerContent = document.createElement('span'); // Use a single span for all content

            let prefix = "";
            if (!isTopLevelMessage) {
                prefix = "⤷ ";
            }

            headerContent.textContent = `${prefix}#${message.id} | ${timestampParts.time} | ${timestampParts.date}`;

            messageHeader.appendChild(headerContent);
            textWrapperDiv.appendChild(messageHeader);


            const textElement = document.createElement('div');
            textElement.className = 'otk-content-div'; // Apply class for styling
            if (shouldDisableUnderline) { // Apply to all depths when underline is hidden
                messageHeader.style.borderBottom = 'none';
                messageHeader.style.paddingBottom = '0';
                messageHeader.style.marginBottom = '0';
                textElement.style.marginTop = '0px';
                textElement.style.paddingTop = '0px';
            }
            // The white-space, overflow-wrap, word-break are handled by CSS class '.otk-content-div'

            // Process currentMessageOwnText for embeds and remaining text
            if (currentMessageOwnText && typeof currentMessageOwnText === 'string') {
                const lines = currentMessageOwnText.split('\n');
                // The quoteRegex here is for inline quotes like "text >>123 text", not block quotes.
                // Block quotes >>123 on their own lines were handled above.
                const inlineQuoteRegex = />>(\d+)/;


                lines.forEach((line, lineIndex) => {
                    const trimmedLine = line.trim();
                    let processedAsEmbed = false;
                    let soleUrlEmbedMade = false;

                    // Check for Sole YouTube URL
                    // Removed isTopLevelMessage restriction for new_design path
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
                                    viewerTopLevelEmbedIds.add(canonicalEmbedId); // Simplified tracking
                                    let seenEmbeds = JSON.parse(localStorage.getItem(SEEN_EMBED_URL_IDS_KEY)) || [];
                                    if (!seenEmbeds.includes(canonicalEmbedId)) { /* ... update stats ... */ }

                                    const embedElement = createYouTubeEmbedElement(videoId, timestampStr);
                                    textElement.appendChild(embedElement);
                                    embedWrappers.push(embedElement);
                                    soleUrlEmbedMade = true; processedAsEmbed = true; break;
                                }
                            }
                        }
                    }
                    // Similar checks for Twitch and Streamable sole URLs... (omitted for brevity, but structure is the same)
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
                                    const embedElement = createTwitchEmbedElement(patternObj.type, id, timestampStr);
                                    textElement.appendChild(embedElement);
                                    embedWrappers.push(embedElement);
                                    soleUrlEmbedMade = true; processedAsEmbed = true; break;
                                }
                            }
                        }
                    }
                    if (!soleUrlEmbedMade) {
                        for (const patternObj of streamablePatterns) {
                            const match = trimmedLine.match(patternObj.regex);
                            if (match) {
                                const videoId = match[patternObj.idGroup];
                                if (videoId) {
                                    const embedElement = createStreamableEmbedElement(videoId);
                                    textElement.appendChild(embedElement);
                                    embedWrappers.push(embedElement);
                                    soleUrlEmbedMade = true; processedAsEmbed = true; break;
                                }
                            }
                        }
                    }
                    if (!soleUrlEmbedMade) {
                        for (const patternObj of twitterPatterns) {
                            const match = trimmedLine.match(patternObj.regex);
                            if (match) {
                                const tweetId = match[patternObj.idGroup];
                                if (tweetId) {
                                    const tweetEmbed = createTweetEmbedElement(tweetId, textElement);
                                    if (tweetEmbed) {
                                        textElement.appendChild(tweetEmbed);
                                        embedWrappers.push(tweetEmbed);
                                    }
                                    soleUrlEmbedMade = true;
                                    processedAsEmbed = true;
                                    break;
                                }
                            }
                        }
                    }

                    if (!soleUrlEmbedMade) {
                        let currentTextSegment = line;
                        // Simpler inline processing for the new theme: only look for >>ddd for "not found" or simple link.
                        // Actual recursive quote rendering is handled by the block logic above.
                        // This loop is for text lines that might contain inline links or simple text.
                        // For new theme, appendTextOrQuoteSegment might be too complex if block quotes are already handled.
                        // Let's simplify: just append text, and make >>ddd links clickable but not expanding.

                        // Simplified text processing for new design:
                        // Split by >>ddd to make them links, otherwise just text.
                        // This avoids recursive expansion here as it's done at block level.
                        // Robust inline processing for text, >>ddd links, and media embeds
                        while (currentTextSegment.length > 0) {
                            let earliestMatch = null;
                            let earliestMatchPattern = null; // For media embeds
                            let earliestMatchType = null;    // 'youtube', 'twitch', 'streamable'
                            let earliestMatchIsQuoteLink = false;

                            // Find earliest inline YouTube match
                            for (const patternObj of inlineYoutubePatterns) {
                                const matchAttempt = currentTextSegment.match(patternObj.regex);
                                if (matchAttempt && (earliestMatch === null || matchAttempt.index < earliestMatch.index)) {
                                    earliestMatch = matchAttempt;
                                    earliestMatchPattern = patternObj;
                                    earliestMatchType = 'youtube';
                                    earliestMatchIsQuoteLink = false;
                                }
                            }

                            // Find earliest inline Twitter match
                            for (const patternObj of inlineTwitterPatterns) {
                                const matchAttempt = currentTextSegment.match(patternObj.regex);
                                if (matchAttempt && (earliestMatch === null || matchAttempt.index < earliestMatch.index)) {
                                    earliestMatch = matchAttempt;
                                    earliestMatchPattern = patternObj;
                                    earliestMatchType = 'twitter';
                                    earliestMatchIsQuoteLink = false;
                                }
                            }
                            // Find earliest inline Twitch match
                            for (const patternObj of inlineTwitchPatterns) {
                                const matchAttempt = currentTextSegment.match(patternObj.regex);
                                if (matchAttempt && (earliestMatch === null || matchAttempt.index < earliestMatch.index)) {
                                    earliestMatch = matchAttempt;
                                    earliestMatchPattern = patternObj;
                                    earliestMatchType = 'twitch';
                                    earliestMatchIsQuoteLink = false;
                                }
                            }
                            // Find earliest inline Streamable match
                            for (const patternObj of inlineStreamablePatterns) {
                                const matchAttempt = currentTextSegment.match(patternObj.regex);
                                if (matchAttempt && (earliestMatch === null || matchAttempt.index < earliestMatch.index)) {
                                    earliestMatch = matchAttempt;
                                    earliestMatchPattern = patternObj;
                                    earliestMatchType = 'streamable';
                                    earliestMatchIsQuoteLink = false;
                                }
                            }

                            // Find earliest >>ddd quote link match
                            const quoteLinkMatch = currentTextSegment.match(inlineQuoteRegex); // inlineQuoteRegex is />>(\d+)/
                            if (quoteLinkMatch && (earliestMatch === null || quoteLinkMatch.index < earliestMatch.index)) {
                                earliestMatch = quoteLinkMatch;
                                earliestMatchType = null; // Not a media embed
                                earliestMatchIsQuoteLink = true;
                            }

                            if (earliestMatch) {
                                processedAsEmbed = true; // Mark that some processing (embed or link) happened
                                // Text before the match
                                if (earliestMatch.index > 0) {
                                    textElement.appendChild(document.createTextNode(currentTextSegment.substring(0, earliestMatch.index)));
                                }

                                const matchedText = earliestMatch[0];

                                if (earliestMatchIsQuoteLink) {
                                    const qId = earliestMatch[1];
                                    const qLink = document.createElement('a');
                                    // Try to find the actual rendered instance ID for better linking
                                    const targetInstance = document.querySelector(`#otk-messages-container [data-original-message-id="${qId}"]`);
                                    qLink.href = targetInstance ? `#${targetInstance.id}` : `#otk-instance-${qId}-unknown`;
                                    qLink.textContent = matchedText;
                                    qLink.style.color = 'var(--otk-newdesign-header-text-color, #555)'; // Example link color
                                    qLink.onclick = (e) => {
                                        e.preventDefault();
                                        const targetEl = targetInstance || document.querySelector(`[data-message-id="${qId}"]`);
                                        if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    };
                                    textElement.appendChild(qLink);
                                } else { // It's a media embed
                                    const id = earliestMatch[earliestMatchPattern.idGroup];
                                    let timestampStr = null;
                                    let embedElement = null;
                                    let canonicalEmbedId = null;

                                    if (earliestMatchType === 'youtube') {
                                        const timeMatchInUrl = matchedText.match(youtubeTimestampRegex);
                                        if (timeMatchInUrl && timeMatchInUrl[1]) timestampStr = timeMatchInUrl[1];
                                        if (id) {
                                            canonicalEmbedId = `youtube_${id}`;
                                            embedElement = createYouTubeEmbedElement(id, timestampStr);
                                        }
                                    } else if (earliestMatchType === 'twitch') {
                                        if (earliestMatchPattern.type === 'vod') {
                                            const timeMatchInUrl = matchedText.match(twitchTimestampRegex);
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
                                    } else if (earliestMatchType === 'twitter') {
                                        if (id) {
                                            canonicalEmbedId = `twitter_${id}`;
                                            embedElement = createTweetEmbedElement(id);
                                        }
                                    }

                                    if (embedElement) {
                                        // Statistics for embeds are only updated if they are in a top-level message.
                                        if (isTopLevelMessage && canonicalEmbedId) {
                                            viewerTopLevelEmbedIds.add(canonicalEmbedId);
                                            let seenEmbeds = JSON.parse(localStorage.getItem(SEEN_EMBED_URL_IDS_KEY)) || [];
                                            if (!seenEmbeds.includes(canonicalEmbedId)) {
                                                seenEmbeds.push(canonicalEmbedId);
                                                localStorage.setItem(SEEN_EMBED_URL_IDS_KEY, JSON.stringify(seenEmbeds));
                                                let currentVideoCount = parseInt(localStorage.getItem(LOCAL_VIDEO_COUNT_KEY) || '0');
                                                localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, (currentVideoCount + 1).toString());
                                                updateDisplayedStatistics({});
                                            }
                                        }
                                        textElement.appendChild(embedElement);
                                        embedWrappers.push(embedElement);
                                    }
                                }
                                currentTextSegment = currentTextSegment.substring(earliestMatch.index + matchedText.length);
                            } else { // No more embeds or >>ddd links in the rest of the segment
                                if (currentTextSegment.length > 0) {
                                    textElement.appendChild(document.createTextNode(currentTextSegment));
                                }
                                currentTextSegment = ""; // Done with this line/segment
                            }
                        }
                    }
                    // End of robust inline processing

                    if (lineIndex < lines.length - 1 && (trimmedLine.length > 0 || processedAsEmbed)) {
                        textElement.appendChild(document.createElement('br'));
                    }
                });
            } else {
                textElement.textContent = message.text || '';
            }

            if (shouldDisableUnderline && textElement.firstChild && textElement.firstChild.nodeName === 'BR') {
                textElement.removeChild(textElement.firstChild);
            }

            textWrapperDiv.appendChild(textElement);
            postDiv.appendChild(textWrapperDiv);
            messageDiv.appendChild(postDiv); // Append the postDiv after any block quotes

            // Attachment handling (can be similar to original, appended to messageDiv)
            if (message.attachment && message.attachment.tim) {
                const actualBoardForLink = boardForLink || message.board || 'b'; // Define actualBoardForLink here
                const attachmentDiv = document.createElement('div');
                attachmentDiv.style.marginTop = '10px'; // Standard margin for attachments
                // ... (rest of attachment logic is complex and largely reusable, will integrate carefully)
                // For now, let's assume the attachment logic from the 'else' block can be adapted and called here.
                // This includes filename link, image/video display, IDB loading.
                // Key: ensure it appends to this 'messageDiv' or 'textWrapperDiv' as appropriate for new layout.
                // Example.html doesn't show attachments, so standard placement below text is fine.

                if (shouldDisplayFilenames) {
                    const filenameLink = document.createElement('a');
                    filenameLink.className = 'attachment-filename';
                    filenameLink.textContent = `${message.attachment.filename} (${message.attachment.ext.substring(1)})`;
                    filenameLink.href = `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${message.attachment.ext}`;
                    filenameLink.target = "_blank";
                    // Use shared link styling for attachments for consistency, or new design specific if needed
                    filenameLink.style.cssText = "color: #60a5fa; display: block; margin-bottom: 5px; text-decoration: underline;";
                    attachmentDiv.appendChild(filenameLink);
                }

                // Call helper function to populate media
                _populateAttachmentDivWithMedia(
                    attachmentDiv,
                    message,
                    actualBoardForLink,
                    mediaLoadPromises,
                    uniqueImageViewerHashes,
                    isTopLevelMessage,
                    'new_design', // layoutStyle
                    renderedFullSizeImageHashes, // Specific to New Design image handling
                    viewerTopLevelAttachedVideoHashes,
                    otkMediaDB
                );

                // Always append attachmentDiv if message.attachment.tim exists,
                // trusting _populateAttachmentDivWithMedia to handle content.
                // Removed: if (attachmentDiv.hasChildNodes())
                textWrapperDiv.appendChild(attachmentDiv);
            }

            // Click listener for anchoring
            const persistentInstanceId = `otk-msg-${parentMessageId || 'toplevel'}-${message.id}`;
            messageDiv.id = persistentInstanceId;
            messageDiv.setAttribute('data-original-message-id', message.id);

            messageDiv.addEventListener('click', (event) => {
                const target = event.target;
                let preventAnchor = false;

                // Standard interactive elements that should not trigger anchoring
                if (target.matches('a, img, video, iframe, input, button, select, textarea') ||
                    target.closest('a, img, video, iframe, input, button, select, textarea') ||
                    target.isContentEditable) {
                    preventAnchor = true;
                }

                // Specific wrapper classes for embeds that should not trigger anchoring
                if (!preventAnchor) {
                    const specificWrappers = [
                        '.thumbnail-link',
                        '.otk-youtube-embed-wrapper',
                        '.otk-twitch-embed-wrapper',
                        '.otk-streamable-embed-wrapper'
                    ];
                    if (specificWrappers.some(cls => target.matches(cls) || target.closest(cls))) {
                        preventAnchor = true;
                    }
                }

                if (preventAnchor) {
                    return; // Do not anchor
                }

                if (!isTopLevelMessage) {
                    event.stopPropagation();
                }

                const isThisMessageAlreadyAnchored = messageDiv.classList.contains(ANCHORED_MESSAGE_CLASS);

                // Un-highlight all currently anchored messages
                document.querySelectorAll(`.${ANCHORED_MESSAGE_CLASS}`).forEach(el => {
                    el.classList.remove(ANCHORED_MESSAGE_CLASS);
                });

                if (isThisMessageAlreadyAnchored) {
                    // If the clicked message was the anchor, un-anchor it
                    localStorage.removeItem(ANCHORED_MESSAGE_ID_KEY);
                    consoleLog(`Un-anchored message instance: ${persistentInstanceId}`);
                } else {
                    // Otherwise, anchor this new message
                    messageDiv.classList.add(ANCHORED_MESSAGE_CLASS);
                    localStorage.setItem(ANCHORED_MESSAGE_ID_KEY, persistentInstanceId);
                    consoleLog(`Anchored new message instance: ${persistentInstanceId}`);
                }
            });

            // Initial highlight check
            const initiallyStoredAnchoredId = localStorage.getItem(ANCHORED_MESSAGE_ID_KEY);
            if (persistentInstanceId === initiallyStoredAnchoredId) {
                messageDiv.classList.add(ANCHORED_MESSAGE_CLASS);
            }

            return messageDiv;

        } else { // layoutStyle === 'default' or unknown (original logic)
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

            let headerBorderBottomStyle = `1px solid ${headerBorderVar}`;
            let headerPaddingBottomStyle = '5px';
            // let headerDisplayStlye = 'flex'; // Default display style for the header - will be set directly

            // if (shouldDisableUnderline) { // This logic will be handled after initial style.cssText set
            // }

            messageHeader.style.cssText = `
                font-size: 12px;
                color: ${ isTopLevelMessage ? 'var(--otk-msg-depth0-header-text-color)' : (currentDepth === 1 ? 'var(--otk-msg-depth1-header-text-color)' : 'var(--otk-msg-depth2plus-header-text-color)') };
                font-weight: bold;
                margin-bottom: 8px; /* Default margin */
                padding-bottom: ${headerPaddingBottomStyle}; /* Default padding for underline */
                border-bottom: ${headerBorderBottomStyle}; /* Default border for underline */
                display: flex; /* Default display */
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
            // Apply depth-specific font size for default layout
            if (isTopLevelMessage) {
                textElement.style.fontSize = 'var(--otk-msg-depth0-content-font-size)';
            } else if (currentDepth === 1) {
                textElement.style.fontSize = 'var(--otk-msg-depth1-content-font-size)';
            } else { // currentDepth >= 2
                textElement.style.fontSize = 'var(--otk-msg-depth2plus-content-font-size)';
            }

            if (shouldDisableUnderline) { // Apply to all depths when underline is hidden
                messageHeader.style.borderBottom = 'none';
                messageHeader.style.paddingBottom = '0';
                messageHeader.style.marginBottom = '0';
                textElement.style.marginTop = '0px';
                textElement.style.paddingTop = '0px';
            }

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
                                            updateDisplayedStatistics({}); // This updates global, not viewer-specific directly
                                        }
                                    }
                                    const embedElement = createYouTubeEmbedElement(videoId, timestampStr);
                                    textElement.appendChild(embedElement);
                                    embedWrappers.push(embedElement);
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
                                            updateDisplayedStatistics({});
                                        }
                                    }
                                    const embedElement = createTwitchEmbedElement(patternObj.type, id, timestampStr);
                                    textElement.appendChild(embedElement);
                                    embedWrappers.push(embedElement);
                                    soleUrlEmbedMade = true; processedAsEmbed = true; break;
                                }
                            }
                        }
                    }

                    // Check for Sole Streamable URL
                    if (!soleUrlEmbedMade) {
                        for (const patternObj of twitterPatterns) {
                            const match = trimmedLine.match(patternObj.regex);
                            if (match) {
                                const tweetId = match[patternObj.idGroup];
                                if (tweetId) {
                                    const tweetEmbed = createTweetEmbedElement(tweetId, textElement);
                                    if (tweetEmbed) {
                                        textElement.appendChild(tweetEmbed);
                                        embedWrappers.push(tweetEmbed);
                                    }
                                    soleUrlEmbedMade = true;
                                    processedAsEmbed = true;
                                    break;
                                }
                            }
                        }
                    }
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
                                            updateDisplayedStatistics({});
                                        }
                                    }
                                    const embedElement = createStreamableEmbedElement(videoId);
                                    textElement.appendChild(embedElement);
                                    embedWrappers.push(embedElement);
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

                            // Find earliest Twitter inline match
                            for (const patternObj of inlineTwitterPatterns) {
                                const matchAttempt = currentTextSegment.match(patternObj.regex);
                                if (matchAttempt) {
                                    if (earliestMatch === null || matchAttempt.index < earliestMatch.index) {
                                        earliestMatch = matchAttempt;
                                        earliestMatchPattern = patternObj;
                                        earliestMatchType = 'twitter';
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
                                    appendTextOrQuoteSegment(textElement, currentTextSegment.substring(0, earliestMatch.index), quoteRegex, currentDepth, MAX_QUOTE_DEPTH, messagesByThreadId, embedWrappers, uniqueImageViewerHashes, boardForLink, mediaLoadPromises, message.id);
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
                                } else if (earliestMatchType === 'twitter') {
                                    if (id) {
                                        canonicalEmbedId = `twitter_${id}`;
                                        embedElement = createTweetEmbedElement(id);
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
                                            updateDisplayedStatistics({});
                                        }
                                    }
                                    textElement.appendChild(embedElement);
                                    embedWrappers.push(embedElement);
                                }

                                currentTextSegment = currentTextSegment.substring(earliestMatch.index + matchedUrl.length);
                            } else {
                                if (currentTextSegment.length > 0) {
                                    appendTextOrQuoteSegment(textElement, currentTextSegment, quoteRegex, currentDepth, MAX_QUOTE_DEPTH, messagesByThreadId, embedWrappers, uniqueImageViewerHashes, boardForLink, mediaLoadPromises, message.id);
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

            if (shouldDisableUnderline && textElement.firstChild && textElement.firstChild.nodeName === 'BR') {
                textElement.removeChild(textElement.firstChild);
            }

            messageDiv.appendChild(textElement);

            // Click listener for anchoring
            const persistentInstanceId = `otk-msg-${parentMessageId || 'toplevel'}-${message.id}`;
            messageDiv.id = persistentInstanceId;
            messageDiv.setAttribute('data-original-message-id', message.id);

            messageDiv.addEventListener('click', (event) => {
                const target = event.target;
                let preventAnchor = false;

                // Standard interactive elements that should not trigger anchoring
                if (target.matches('a, img, video, iframe, input, button, select, textarea') ||
                    target.closest('a, img, video, iframe, input, button, select, textarea') ||
                    target.isContentEditable) {
                    preventAnchor = true;
                }

                // Specific wrapper classes for embeds that should not trigger anchoring
                if (!preventAnchor) {
                    const specificWrappers = [
                        '.thumbnail-link',
                        '.otk-youtube-embed-wrapper',
                        '.otk-twitch-embed-wrapper',
                        '.otk-streamable-embed-wrapper'
                    ];
                    if (specificWrappers.some(cls => target.matches(cls) || target.closest(cls))) {
                        preventAnchor = true;
                    }
                }

                if (preventAnchor) {
                    return; // Do not anchor
                }

                if (!isTopLevelMessage) {
                    event.stopPropagation();
                }

                const isThisMessageAlreadyAnchored = messageDiv.classList.contains(ANCHORED_MESSAGE_CLASS);

                // Un-highlight all currently anchored messages
                document.querySelectorAll(`.${ANCHORED_MESSAGE_CLASS}`).forEach(el => {
                    el.classList.remove(ANCHORED_MESSAGE_CLASS);
                });

                if (isThisMessageAlreadyAnchored) {
                    // If the clicked message was the anchor, un-anchor it
                    localStorage.removeItem(ANCHORED_MESSAGE_ID_KEY);
                    consoleLog(`Un-anchored message instance: ${persistentInstanceId}`);
                } else {
                    // Otherwise, anchor this new message
                    messageDiv.classList.add(ANCHORED_MESSAGE_CLASS);
                    localStorage.setItem(ANCHORED_MESSAGE_ID_KEY, persistentInstanceId);
                    consoleLog(`Anchored new message instance: ${persistentInstanceId}`);
                }
            });

            // Initial highlight check when the element is first created
            const initiallyStoredAnchoredId = localStorage.getItem(ANCHORED_MESSAGE_ID_KEY);
            if (persistentInstanceId === initiallyStoredAnchoredId) {
                messageDiv.classList.add(ANCHORED_MESSAGE_CLASS);
            }
            // The erroneous duplicated block that was here has been removed.
            if (message.attachment && message.attachment.tim) {
                const actualBoardForLink = boardForLink || message.board || 'b'; // Use passed boardForLink, fallback to message.board or 'b'
                const attachmentDiv = document.createElement('div');
                attachmentDiv.style.marginTop = '10px';

                if (shouldDisplayFilenames) {
                    const filenameLink = document.createElement('a');
                    filenameLink.className = 'attachment-filename';
                    filenameLink.textContent = `${message.attachment.filename} (${message.attachment.ext.substring(1)})`;
                    filenameLink.href = `https://i.4cdn.org/${actualBoardForLink}/${message.attachment.tim}${message.attachment.ext}`;
                    filenameLink.target = "_blank";
                    filenameLink.style.cssText = "color: #60a5fa; display: block; margin-bottom: 5px; text-decoration: underline;";
                    attachmentDiv.appendChild(filenameLink);
                }

                // Call helper function to populate media
                _populateAttachmentDivWithMedia(
                    attachmentDiv,
                    message,
                    actualBoardForLink,
                    mediaLoadPromises,
                    uniqueImageViewerHashes,
                    isTopLevelMessage,
                    'default', // layoutStyle
                    renderedFullSizeImageHashes, // Pass for consistent image thumbnail logic
                    viewerTopLevelAttachedVideoHashes,
                    otkMediaDB
                );

                // Always append attachmentDiv if message.attachment.tim exists,
                // trusting _populateAttachmentDivWithMedia to handle content.
                // Removed: if (attachmentDiv.hasChildNodes())
                messageDiv.appendChild(attachmentDiv);
            }
            return messageDiv;
        } // End of else (default layout)
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
            const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            separatorDiv.textContent = `--- ${currentTime} : ${newMessages.length} New Messages Loaded ---`;
            messagesContainer.appendChild(separatorDiv);
            consoleLog("[appendNewMessagesToViewer] Appended separator line.");
        }

        const mediaLoadPromises = [];
        for (const message of newMessages) {
            const boardForLink = message.board || 'b';
            const threadColor = getThreadColor(message.originalThreadId); // Get thread color for accent
            // For messages directly appended to the viewer, isTopLevelMessage is true, currentDepth is 0, and parent is null
            const messageElement = createMessageElementDOM(message, mediaLoadPromises, [], uniqueImageViewerHashes, boardForLink, true, 0, threadColor, null);
            messagesContainer.appendChild(messageElement);
            renderedMessageIdsInViewer.add(message.id);
            consoleLog(`[appendNewMessagesToViewer] Appended message ${message.id}.`);
        }

        consoleLog(`[appendNewMessagesToViewer] Appended ${newMessages.length} elements. Waiting for media promises.`);

        Promise.all(mediaLoadPromises).then(async () => { // Make async to use await for setTimeout promise
            if (window.twttr && window.twttr.widgets) {
                const tweetEmbeds = messagesContainer.querySelectorAll('.otk-tweet-embed');
                if (tweetEmbeds.length > 0) {
                    consoleLog(`[Twitter] Found ${tweetEmbeds.length} new tweet embeds to render.`);
                    window.twttr.widgets.load(tweetEmbeds);
                }
            }
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
                                        timestamp: Date.now(),
                                        isThumbnail: false // Mark that this is not a thumbnail
                                    };

                                    const putRequest = mediaStore.put(itemToStore);
                                    await new Promise((resolvePut, rejectPut) => {
                                        putRequest.onsuccess = () => {
                                            message.attachment.localStoreId = filehash_db_key;
                                            consoleLog(`Stored full media with key ${filehash_db_key} (post ${post.no}) in IndexedDB.`);

                                            const extLower = post.ext.toLowerCase();
                                            if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLower)) {
                                                // This is where newlyStoredImagesInThread was incremented.
                                                // It will now be incremented after the trueFetchedImages loop.
                                                // fetchedImagesInThread will also be handled later.
                                                let currentImageCount = parseInt(localStorage.getItem(LOCAL_IMAGE_COUNT_KEY) || '0');
                                                localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, (currentImageCount + 1).toString());
                                                // newlyStoredImagesInThread++; // This specific increment is moved
                                            } else if (['.webm', '.mp4'].includes(extLower)) {
                                                // fetchedVideosInThread handled later
                                                let currentVideoCount = parseInt(localStorage.getItem(LOCAL_VIDEO_COUNT_KEY) || '0');
                                                localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, (currentVideoCount + 1).toString());
                                            }
                                            updateDisplayedStatistics({});
                                            resolvePut();
                                        };
                                        putRequest.onerror = (putEvent) => {
                                            consoleError(`IndexedDB 'put' error for full media key ${filehash_db_key} (post ${post.no}):`, putEvent.target.error);
                                            rejectPut(putEvent.target.error);
                                        };
                                    });
                                } else {
                                    consoleWarn(`Failed to download full media for post ${post.no} (DB key: ${filehash_db_key}). Status: ${mediaResponse.status}`);
                                }
                            }

                            // --- Thumbnail Fetching and Storing (if image) ---
                            const extLower = post.ext.toLowerCase();
                            if (['.jpg', '.jpeg', '.png', '.gif'].includes(extLower)) { // Only try to fetch thumbs for image types
                                const thumbnail_filehash_db_key = filehash_db_key + '_thumb';
                                message.attachment.localThumbStoreId = null; // Initialize

                                // Create a new transaction specifically for getting the thumbnail
                                const thumbGetTransaction = otkMediaDB.transaction(['mediaStore'], 'readonly');
                                const thumbGetStore = thumbGetTransaction.objectStore('mediaStore');
                                const thumbDbRequest = thumbGetStore.get(thumbnail_filehash_db_key);

                                const thumbDbResult = await new Promise((resolve, reject) => {
                                    thumbDbRequest.onsuccess = () => resolve(thumbDbRequest.result);
                                    // thumbGetTransaction will complete after this promise resolves or rejects
                                    thumbGetTransaction.oncomplete = () => consoleLog(`Thumb get transaction completed for ${thumbnail_filehash_db_key}`);
                                    thumbGetTransaction.onerror = (event) => consoleError(`Thumb get transaction error for ${thumbnail_filehash_db_key}:`, event.target.error);

                                    thumbDbRequest.onerror = (dbEvent) => {
                                        consoleError(`IndexedDB 'get' error for thumbnail key ${thumbnail_filehash_db_key} (post ${post.no}):`, dbEvent.target.error);
                                        reject(dbEvent.target.error);
                                    };
                                });

                                if (thumbDbResult) {
                                    consoleLog(`Thumbnail with key ${thumbnail_filehash_db_key} (post ${post.no}) already in IndexedDB.`);
                                    message.attachment.localThumbStoreId = thumbnail_filehash_db_key;
                                } else {
                                    const thumbUrl = `https://i.4cdn.org/${opPost.board || 'b'}/${post.tim}s.jpg`;
                                    consoleLog(`Downloading thumbnail for post ${post.no} (DB key: ${thumbnail_filehash_db_key}) from ${thumbUrl}`);
                                    try {
                                        const thumbResponse = await fetch(thumbUrl);
                                        if (thumbResponse.ok) {
                                            const thumbBlob = await thumbResponse.blob();
                                            const thumbStoreTransaction = otkMediaDB.transaction(['mediaStore'], 'readwrite'); // New transaction
                                            const thumbMediaStore = thumbStoreTransaction.objectStore('mediaStore');
                                            const thumbItemToStore = {
                                                filehash: thumbnail_filehash_db_key,
                                                blob: thumbBlob,
                                                originalThreadId: threadId,
                                                filename: `${post.filename}_thumb.jpg`, // Adjust filename
                                                ext: '.jpg', // Thumbnails are typically jpg
                                                timestamp: Date.now(),
                                                isThumbnail: true // Mark that this IS a thumbnail
                                            };
                                            const thumbPutRequest = thumbMediaStore.put(thumbItemToStore);
                                            await new Promise((resolvePut, rejectPut) => {
                                                thumbPutRequest.onsuccess = () => {
                                                    message.attachment.localThumbStoreId = thumbnail_filehash_db_key;
                                                    consoleLog(`Stored thumbnail with key ${thumbnail_filehash_db_key} (post ${post.no}) in IndexedDB.`);
                                                    // Do NOT increment LOCAL_IMAGE_COUNT_KEY or newlyStoredImagesInThread for thumbnails here
                                                    // to avoid double counting if the main image is also counted.
                                                    resolvePut();
                                                };
                                                thumbPutRequest.onerror = (putEvent) => {
                                                    consoleError(`IndexedDB 'put' error for thumbnail key ${thumbnail_filehash_db_key} (post ${post.no}):`, putEvent.target.error);
                                                    rejectPut(putEvent.target.error);
                                                };
                                            });
                                        } else {
                                            consoleWarn(`Failed to download thumbnail for post ${post.no} (DB key: ${thumbnail_filehash_db_key}). Status: ${thumbResponse.status}`);
                                        }
                                    } catch (thumbFetchError) {
                                        consoleError(`Error fetching thumbnail for post ${post.no} (DB key: ${thumbnail_filehash_db_key}):`, thumbFetchError);
                                    }
                                }
                            }
                            // --- End Thumbnail Fetching ---

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

    async function backgroundRefreshThreadsAndMessages(options = {}) { // Added options parameter
        const { skipViewerUpdate = false, isBackground = false } = options; // Destructure with default

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

            // Per user request, messages should never be removed unless the "Restart Tracker" button is clicked.
            // Therefore, we no longer check for "dead" threads to remove them from the active list.
            // We only add new threads that are not already in the active list.
            foundThreads.forEach(t => {
                const threadIdNum = Number(t.id);
                if (!previousActiveThreadIds.has(threadIdNum)) {
                    consoleLog(`[BG] Adding new thread ${threadIdNum} from catalog scan.`);
                    activeThreads.push(threadIdNum);
                }
            });
            consoleLog(`[BG] Active threads after catalog sync: ${activeThreads.length}`, activeThreads);

            const fetchPromisesBg = activeThreads.map(threadId => {
                return fetchThreadMessages(threadId)
                    .then(result => ({ threadId, messages: result, status: 'fulfilled' }))
                    .catch(error => ({ threadId, error, status: 'rejected' }));
            });

            const resultsBg = await Promise.all(fetchPromisesBg);

            let allNewMessages = [];
            resultsBg.forEach(result => {
                // consoleLog('[DebugRefreshV2][BG] backgroundRefresh - Raw Promise.allSettled result:', JSON.stringify(result)); // Removed
                if (result.status === 'fulfilled' && result) {
                    // consoleLog('[DebugRefreshV2][BG] backgroundRefresh - Fulfilled promise value:', JSON.stringify(result.value)); // Removed
                    const { threadId, messages: newMessagesResult, status: fetchStatus } = result;
                    // consoleLog('[DebugRefreshV2][BG] backgroundRefresh - Destructured - threadId:', threadId, 'fetchStatus (from wrapper):', fetchStatus, 'newMessages type:', typeof newMessages, 'is Array?:', Array.isArray(newMessages), 'length (if array):', Array.isArray(newMessages) ? newMessages.length : 'N/A'); // Removed

                    if (fetchStatus === 'rejected') {
                        consoleError(`[BG] Error fetching thread ${threadId}:`, result.error);
                        return;
                    }

                    // consoleLog(`[BG] Processing fetched messages for thread ${threadId}. Result:`, newMessages); // Original log
                    // consoleLog('[DebugRefreshV2][BG] backgroundRefresh - About to process newMessages for thread:', threadId, 'Value:', JSON.stringify(newMessages)); // Removed

                    // Handle 'not_modified' status from fetchThreadMessages
                    if (newMessagesResult && typeof newMessagesResult === 'object' && newMessagesResult.status === 'not_modified' && newMessagesResult.threadId === threadId) {
                        consoleLog(`[BG] Thread ${threadId} was not modified. Skipping message update for this thread.`);
                    } else if (newMessagesResult && Array.isArray(newMessagesResult.messages) && newMessagesResult.messages.length > 0) { // Regular message array
                        // consoleLog(`[DebugRefreshV2][BG] backgroundRefresh - Processing ${newMessages.length} messages for thread ${threadId}.`); // Removed
                        consoleLog(`[BG] Processing ${newMessagesResult.messages.length} messages for thread ${threadId}.`); // Standard log
                        let existing = messagesByThreadId[threadId] || [];
                        let existingIds = new Set(existing.map(m => m.id));
                        let updatedMessages = [...existing];
                        let newMessagesInThread = [];
                        newMessagesResult.messages.forEach(m => {
                            if (!existingIds.has(m.id)) {
                                updatedMessages.push(m);
                                newMessagesInThread.push(m);
                            }
                        });
                        allNewMessages.push(...newMessagesInThread);
                        updatedMessages.sort((a, b) => a.time - b.time);
                        messagesByThreadId[threadId] = updatedMessages;
                        if (messagesByThreadId[threadId].length > 0 && (!messagesByThreadId[threadId][0].title || messagesByThreadId[threadId][0].title === `Thread ${threadId}`)) {
                            messagesByThreadId[threadId][0].title = newMessagesResult.messages[0].title;
                        }
                    } else if (newMessagesResult && newMessagesResult.messages.length === 0) {
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

            consoleLog('[BG] Background refresh complete.');

        } catch (error) {
            consoleError('[BG] Error during background refresh:', error.message, error.stack);
        }
    }

    async function refreshThreadsAndMessages(options = {}) { // Manual Refresh / Called by Clear
        const { skipViewerUpdate = false } = options; // Destructure with default

        consoleLog('[Manual] Refreshing threads and messages...');
        isManualRefreshInProgress = true;
        showLoadingScreen("Initializing refresh..."); // Initial message
        try {
            localStorage.removeItem('otkNewMessagesCount');
            localStorage.removeItem('otkNewImagesCount');
            localStorage.removeItem('otkNewVideosCount');
            const refreshButton = document.getElementById('otk-refresh-data-btn');
            if (refreshButton) {
                refreshButton.classList.remove('otk-button-pulse');
            }
            await new Promise(resolve => setTimeout(resolve, 50)); // Ensure loading screen renders

            updateLoadingProgress(5, "Scanning catalog for OTK threads...");
            const foundThreads = await scanCatalog();
            const foundIds = new Set(foundThreads.map(t => Number(t.id)));
            consoleLog(`[Manual] scanCatalog found ${foundThreads.length} threads:`, Array.from(foundIds));
            updateLoadingProgress(10, `Catalog scan complete. Found ${foundThreads.length} OTK threads. Syncing with local list...`);

            const previousActiveThreadIds = new Set(activeThreads.map(id => Number(id)));
            let threadsToFetch = []; // Store actual threadIds to fetch

            // Per user request, messages should never be removed unless the "Restart Tracker" button is clicked.
            foundThreads.forEach(t => {
                const threadIdNum = Number(t.id);
                if (!previousActiveThreadIds.has(threadIdNum)) {
                    consoleLog(`[Manual] Adding new thread ${threadIdNum} to active list.`);
                    activeThreads.push(threadIdNum);
                }
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

            const fetchPromises = threadsToFetch.map(threadId => fetchThreadMessages(threadId));
            const results = await Promise.all(fetchPromises);

            results.forEach((result, index) => {
                const threadId = threadsToFetch[index];
                threadsProcessedCount++;
                const progressPercentage = 15 + Math.round((threadsProcessedCount / totalThreadsToProcess) * 75);
                let statusText = `Processing thread ${threadsProcessedCount}/${totalThreadsToProcess} (ID: ${threadId})...`;
                updateLoadingProgress(progressPercentage, statusText);

                if (result.status === 'not_modified') {
                    consoleLog(`[Manual] Thread ${threadId} not modified. Skipping message update.`);
                    return;
                }

                const newMessagesData = result.messages;
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

                    consoleLog(`[Manual] Processed thread ${threadId}. Fetched: ${counts.fetchedMessages} msgs, ${counts.fetchedImages} imgs, ${counts.fetchedVideos} vids. Added: ${actualNewMessagesInThread} new msgs. Stored: ${counts.newlyStoredImages} imgs.`);
                }
            });

            // Final update to loading screen after loop
            let finalStatusText = `Refresh processing complete. Finalizing...`; // Simplified
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
            renderThreadList(Array.from(foundIds));
            window.dispatchEvent(new CustomEvent('otkMessagesUpdated'));
            updateDisplayedStatistics({ catalogThreadIds: foundIds });

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

            if (!skipViewerUpdate) { // Only perform viewer updates if not skipped
                if (viewerIsOpen && newMessagesToAppend.length > 0) {
                    consoleLog(`[Manual Refresh] Viewer is open, appending ${newMessagesToAppend.length} new messages.`);
                    await appendNewMessagesToViewer(newMessagesToAppend);
                }
            } else {
                consoleLog('[Refresh] Viewer update skipped as requested by options.');
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
        const viewerWasOpen = otkViewer && otkViewer.style.display === 'block';

        // Clear viewer content and related state immediately if viewer was open
        if (viewerWasOpen) {
            consoleLog('[Clear] Viewer was open, clearing its content and state immediately.');
            otkViewer.innerHTML = ''; // Clear existing viewer DOM
            renderedMessageIdsInViewer.clear(); // Clear the set of rendered message IDs
            uniqueImageViewerHashes.clear();
            viewerTopLevelAttachedVideoHashes.clear();
            viewerTopLevelEmbedIds.clear();
            renderedFullSizeImageHashes.clear();
            viewerActiveImageCount = null; // Reset viewer-specific counts
            viewerActiveVideoCount = null;
            lastViewerScrollTop = 0; // Reset scroll position memory
        }

        isManualRefreshInProgress = true;
        try {
            activeThreads = [];
            messagesByThreadId = {};
            threadColors = {};
            localStorage.removeItem(THREADS_KEY);
            localStorage.removeItem(MESSAGES_KEY);
            localStorage.removeItem(COLORS_KEY);
            localStorage.removeItem(DROPPED_THREADS_KEY);
            localStorage.removeItem(SEEN_EMBED_URL_IDS_KEY);
            localStorage.setItem(LOCAL_IMAGE_COUNT_KEY, '0');
            localStorage.setItem(LOCAL_VIDEO_COUNT_KEY, '0');
            localStorage.removeItem('otkNewMessagesCount');
            localStorage.removeItem('otkNewImagesCount');
            localStorage.removeItem('otkNewVideosCount');
            localStorage.removeItem(THEME_SETTINGS_KEY);
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

            consoleLog('[Clear] Calling refreshThreadsAndMessages to repopulate data (viewer updates will be skipped by refresh function)...');
            await refreshThreadsAndMessages({ skipViewerUpdate: true });

            // Explicitly re-render the viewer if it was open, using the fresh data.
            if (viewerWasOpen) {
                consoleLog('[Clear] Re-rendering viewer with fresh data after clear.');
                await renderMessagesInViewer(); // isToggleOpen: false typically scrolls to bottom or default.
            }
            // window.dispatchEvent(new CustomEvent('otkClearViewerDisplay')); // Removed as direct render is now handled.
            consoleLog('[Clear] Clear and Refresh data processing complete.');
        } catch (error) {
            consoleError('[Clear] Error during clear and refresh:', error);
        } finally {
            isManualRefreshInProgress = false;
            consoleLog('[Clear] Manual refresh flag reset.');
            renderThreadList([]); // Update GUI bar with (now minimal) live threads
            updateDisplayedStatistics({}); // Update stats based on cleared and re-fetched data
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
            updateDisplayedStatistics({});
        } else {
            otkViewer.style.display = 'block';
            document.body.style.overflow = 'hidden';
            localStorage.setItem(VIEWER_OPEN_KEY, 'true');
            consoleLog('Viewer shown. State saved to localStorage. Applying layout and rendering all messages.');

            // Apply correct layout class before rendering
            const currentLayoutToggle = localStorage.getItem('otkMessageLayoutStyle') || 'default';
            if (currentLayoutToggle === 'new_design') {
                otkViewer.classList.add('otk-message-layout-newdesign');
                otkViewer.classList.remove('otk-message-layout-default');
            } else {
                otkViewer.classList.add('otk-message-layout-default');
                otkViewer.classList.remove('otk-message-layout-newdesign');
            }
            // renderMessagesInViewer will calculate and set viewerActive counts and then call updateDisplayedStatistics
            renderMessagesInViewer(); // Pass flag
        }
    }

    function updateDisplayedStatistics(options = {}) {
    const {
        catalogThreadIds = null,
        isBackgroundUpdate = false,
        newMessagesCount = 0,
        newImagesCount = 0,
        newVideosCount = 0
    } = options;

    const threadsTrackedElem = document.getElementById('otk-threads-tracked-stat');
    const totalMessagesElem = document.getElementById('otk-total-messages-stat');
    const localImagesElem = document.getElementById('otk-local-images-stat');
    const localVideosElem = document.getElementById('otk-local-videos-stat');

    if (threadsTrackedElem && totalMessagesElem && localImagesElem && localVideosElem) {
        // Use activeThreads.length for the count of all tracked threads.
        // Use catalogThreadIds.size for "Live" threads if provided, otherwise it's 0.
        const liveThreadsCount = catalogThreadIds ? catalogThreadIds.size : 0;
        let totalMessagesCount = 0;
        for (const threadId in messagesByThreadId) {
            if (messagesByThreadId.hasOwnProperty(threadId)) {
                totalMessagesCount += (messagesByThreadId[threadId] || []).length;
            }
        }

        const paddingLength = 4;
        if (catalogThreadIds) {
            threadsTrackedElem.innerHTML = `<span>- ${padNumber(liveThreadsCount, paddingLength)} Live Thread${liveThreadsCount === 1 ? '' : 's'}</span>`;
        }

        const baseMessagesText = `- ${padNumber(totalMessagesCount, paddingLength)} Total Message${totalMessagesCount === 1 ? '' : 's'}`;
        let newMessagesTotal = parseInt(localStorage.getItem('otkNewMessagesCount') || '0');
        if (isBackgroundUpdate) {
            newMessagesTotal += newMessagesCount;
            localStorage.setItem('otkNewMessagesCount', newMessagesTotal);
        }

        let newMessagesText = '';
        if (newMessagesTotal > 0) {
            newMessagesText = `<span class="new-stat" style="color: var(--otk-background-updates-stats-text-color);"> (+${newMessagesTotal})</span>`;
        }
        totalMessagesElem.innerHTML = `<span>${baseMessagesText}</span> ${newMessagesText}`;

        const imageCountFromStorage = parseInt(localStorage.getItem(LOCAL_IMAGE_COUNT_KEY) || '0');
        const videoCountFromStorage = parseInt(localStorage.getItem(LOCAL_VIDEO_COUNT_KEY) || '0');

        const imageCountToDisplay = viewerActiveImageCount !== null ? viewerActiveImageCount : imageCountFromStorage;
        const videoCountToDisplay = viewerActiveVideoCount !== null ? viewerActiveVideoCount : videoCountFromStorage;

        const baseImagesText = `- ${padNumber(imageCountToDisplay, paddingLength)} Image${imageCountToDisplay === 1 ? '' : 's'}`;
        let newImagesTotal = parseInt(localStorage.getItem('otkNewImagesCount') || '0');
        if (isBackgroundUpdate) {
            newImagesTotal += newImagesCount;
            localStorage.setItem('otkNewImagesCount', newImagesTotal);
        }
        let newImagesText = '';
        if (newImagesTotal > 0) {
            newImagesText = `<span class="new-stat" style="color: var(--otk-background-updates-stats-text-color);"> (+${newImagesTotal})</span>`;
        }
        localImagesElem.innerHTML = `<span>${baseImagesText}</span>&nbsp;${newImagesText}`;

        const baseVideosText = `- ${padNumber(videoCountToDisplay, paddingLength)} Video${videoCountToDisplay === 1 ? '' : 's'}`;
        let newVideosTotal = parseInt(localStorage.getItem('otkNewVideosCount') || '0');
        if (isBackgroundUpdate) {
            newVideosTotal += newVideosCount;
            localStorage.setItem('otkNewVideosCount', newVideosTotal);
        }
        let newVideosText = '';
        if (newVideosTotal > 0) {
            newVideosText = `<span class="new-stat" style="color: var(--otk-background-updates-stats-text-color);"> (+${newVideosTotal})</span>`;
        }
        localVideosElem.innerHTML = `<span>${baseVideosText}</span>&nbsp;${newVideosText}`;
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
            if (isManualRefreshInProgress) {
                consoleLog('[GUI] "Refresh Data" button clicked, but a refresh is already in progress. Ignoring.');
                return; // Ignore click if a refresh is already happening
            }
            consoleLog('[GUI] "Refresh Data" button clicked.');
            // isManualRefreshInProgress is set to true at the start of refreshThreadsAndMessages
            // and false in its finally block. This prevents the race condition without disabling the button.
            try {
                await refreshThreadsAndMessages();
                consoleLog('[GUI] Data refresh complete.');
            } catch (error) {
                consoleError('[GUI] Error during data refresh:', error);
            } finally {
                stopBackgroundRefresh();
                startBackgroundRefresh();
            }
            // No finally block needed here to re-enable the button, as it's never disabled.
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
        // Apply the new CSS variable for the font color
        bgUpdateLabel.style.cssText = `font-size: 11px; color: var(--otk-disable-bg-font-color, #e6e6e6); white-space: normal; cursor: pointer; line-height: 1.2;`;

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
    let scrollTimeout = null;

    function startBackgroundRefresh() {
        if (localStorage.getItem(BACKGROUND_UPDATES_DISABLED_KEY) === 'true') {
            consoleLog('Background updates are disabled. Not starting refresh interval.');
            return;
        }
        if (backgroundRefreshIntervalId === null) { // Only start if not already running
            const minUpdateMinutes = parseInt(localStorage.getItem('otkMinUpdateMinutes') || '2', 10);
            const maxUpdateMinutes = parseInt(localStorage.getItem('otkMaxUpdateMinutes') || '5', 10);
            const minUpdateSeconds = minUpdateMinutes * 60;
            const maxUpdateSeconds = maxUpdateMinutes * 60;
            const randomIntervalSeconds = Math.floor(Math.random() * (maxUpdateSeconds - minUpdateSeconds + 1)) + minUpdateSeconds;
            let refreshIntervalMs = randomIntervalSeconds * 1000;

            const nextUpdateTimestamp = Date.now() + refreshIntervalMs;
            localStorage.setItem('otkNextUpdateTimestamp', nextUpdateTimestamp);

            const lastUpdateTimestamp = parseInt(localStorage.getItem('otkNextUpdateTimestamp') || '0', 10);
            if (Date.now() > lastUpdateTimestamp) {
                refreshIntervalMs = 0;
            }


            backgroundRefreshIntervalId = setTimeout(() => {
                if (isSuspended) {
                    consoleLog(`[BG] Updates suspended.`);
                    stopBackgroundRefresh();
                    showSuspendedScreen();
                    return;
                }
                backgroundRefreshThreadsAndMessages({ isBackground: true });
                backgroundRefreshIntervalId = null; // Reset for the next cycle
                startBackgroundRefresh(); // Schedule the next update
            }, refreshIntervalMs);

            consoleLog(`Background refresh scheduled in ${minUpdateMinutes}-${maxUpdateMinutes} minutes. Next update at ~${new Date(Date.now() + refreshIntervalMs).toLocaleTimeString()}`);
        }
    }

    function stopBackgroundRefresh() {
        if (backgroundRefreshIntervalId) {
            clearTimeout(backgroundRefreshIntervalId);
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
                    if (iframe.contentWindow && iframe.src.includes("youtube.com/embed")) { // Check 2: src is a YouTube embed & contentWindow exists
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
    });
}

// --- Theme Settings Persistence ---
const THEME_SETTINGS_KEY = 'otkThemeSettings';

function forceViewerRerenderAfterThemeChange() {
    if (otkViewer && otkViewer.style.display === 'block') {
        renderedMessageIdsInViewer.clear();
        otkViewer.innerHTML = ''; // Clear the viewer content

        // Ensure the correct layout class is applied before rendering
        // This might be redundant if updateViewerLayoutMode also handles it,
        // but explicit application here ensures the class is set based on the current theme state.
        const currentLayoutToggle = localStorage.getItem('otkMessageLayoutStyle') || 'default';
        if (currentLayoutToggle === 'new_design') {
            otkViewer.classList.add('otk-message-layout-newdesign');
            otkViewer.classList.remove('otk-message-layout-default');
        } else {
            otkViewer.classList.add('otk-message-layout-default');
            otkViewer.classList.remove('otk-message-layout-newdesign');
        }
        // updateViewerLayoutMode(); // This function seems to be missing or was from a different context.
                                 // If it's intended to re-apply layout classes based on theme,
                                 // the logic above handles it. If it does more, it needs to be defined.
                                 // For now, assuming the direct class manipulation is sufficient.

        renderMessagesInViewer({ isToggleOpen: true }); // Re-render all messages
        consoleLog("Viewer force re-rendered after theme change.");
    }
}

let stagedThemeSettings = {};

function saveThemeSetting(key, value) {
    stagedThemeSettings[key] = value;
    consoleLog("Staged theme setting:", key, value);
}

function applyThemeSettings() {
    let settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
    consoleLog("Applying theme settings:", settings);

    // Helper to update a color input pair (hex text and color swatch)
    const updateColorInputs = (idSuffix, colorValue) => {
        const hexInput = document.getElementById(`otk-${idSuffix}-hex`);
        const pickerInput = document.getElementById(`otk-${idSuffix}`); // Correct ID for color swatch
        if (hexInput) hexInput.value = colorValue;
        if (pickerInput) pickerInput.value = colorValue;
    };

    if (settings.guiBgColor) {
        document.documentElement.style.setProperty('--otk-gui-bg-color', settings.guiBgColor);
        updateColorInputs('gui-bg', settings.guiBgColor);
    }

    if (settings.titleTextColor) {
        document.documentElement.style.setProperty('--otk-title-text-color', settings.titleTextColor);
        updateColorInputs('title-text', settings.titleTextColor);
    }

    if (settings.optionsTextColor) {
        document.documentElement.style.setProperty('--otk-options-text-color', settings.optionsTextColor);
        updateColorInputs('options-text', settings.optionsTextColor);
    }

    if (settings.actualStatsTextColor) {
        document.documentElement.style.setProperty('--otk-stats-text-color', settings.actualStatsTextColor);
        updateColorInputs('actual-stats-text', settings.actualStatsTextColor);
    }

    if (settings.viewerBgColor) {
        document.documentElement.style.setProperty('--otk-viewer-bg-color', settings.viewerBgColor);
        updateColorInputs('viewer-bg', settings.viewerBgColor);
    }

    if (settings.guiThreadListTitleColor) {
        document.documentElement.style.setProperty('--otk-gui-threadlist-title-color', settings.guiThreadListTitleColor);
        updateColorInputs('threadlist-title', settings.guiThreadListTitleColor);
    }

    if (settings.guiThreadListTimeColor) {
        document.documentElement.style.setProperty('--otk-gui-threadlist-time-color', settings.guiThreadListTimeColor);
        updateColorInputs('threadlist-time', settings.guiThreadListTimeColor);
    }

    // Viewer Header Border Color
    if (settings.viewerHeaderBorderColor) {
        document.documentElement.style.setProperty('--otk-viewer-header-border-color', settings.viewerHeaderBorderColor);
        updateColorInputs('viewer-header-border', settings.viewerHeaderBorderColor);
    }

    // Viewer Quote L1 Border Color
    if (settings.viewerQuote1HeaderBorderColor) {
        document.documentElement.style.setProperty('--otk-viewer-quote1-header-border-color', settings.viewerQuote1HeaderBorderColor);
        updateColorInputs('viewer-quote1-border', settings.viewerQuote1HeaderBorderColor);
    }

    // Viewer Quote L2+ Border Color
    if (settings.viewerQuote2plusHeaderBorderColor) {
        document.documentElement.style.setProperty('--otk-viewer-quote2plus-header-border-color', settings.viewerQuote2plusHeaderBorderColor);
        updateColorInputs('viewer-quote2plus-border', settings.viewerQuote2plusHeaderBorderColor);
    }

    // Message Background Colors, Message Body Text Colors, Message Header Text Colors
    ['Bg', 'Text', 'HeaderTextColor'].forEach(type => {
        ['0', '1', '2plus'].forEach(depth => {
            const keyBase = `msgDepth${depth}${type === 'HeaderTextColor' ? 'HeaderTextColor' : type}`; // e.g. msgDepth0BgColor, msgDepth0TextColor, msgDepth0HeaderTextColor
            const cssVarBase = `--otk-msg-depth${depth}-${type === 'Bg' ? 'bg' : (type === 'Text' ? 'text' : 'header-text')}-color`; // e.g. --otk-msg-depth0-bg-color
            const idSuffixBase = `msg-depth${depth}-${type === 'Bg' ? 'bg' : (type === 'Text' ? 'text' : 'header-text')}`; // e.g. msg-depth0-bg

            // Correcting key and idSuffix for "HeaderTextColor" to match createThemeOptionRow structure
            let correctedKey = keyBase;
            let correctedIdSuffix = idSuffixBase;
            if (type === 'HeaderTextColor') {
                 correctedKey = `msgDepth${depth}HeaderTextColor`; // This was already correct
                 correctedIdSuffix = `msg-depth${depth}-header-text`; // This was already correct
            } else {
                correctedKey = `msgDepth${depth}${type}Color`; // e.g. msgDepth0BgColor
                correctedIdSuffix = `msg-depth${depth}-${type.toLowerCase()}`; // e.g. msg-depth0-bg
            }


            if (settings[correctedKey]) {
                document.documentElement.style.setProperty(cssVarBase, settings[correctedKey]);
                updateColorInputs(correctedIdSuffix, settings[correctedKey]);
            }
        });
    });


    // New Depth-Specific Content Font Sizes
    ['Depth 0', 'Depth 1', 'Depth 2+'].forEach((label, index) => {
        const depthKeyPart = index === 2 ? '2plus' : index.toString();
        const storageKey = `msgDepth${depthKeyPart}ContentFontSize`;
        const cssVar = `--otk-msg-depth${depthKeyPart}-content-font-size`;
        const inputId = `otk-msg-depth${depthKeyPart}-content-fontsize`;

        if (settings[storageKey]) {
            document.documentElement.style.setProperty(cssVar, settings[storageKey]);
            const inputElement = document.getElementById(inputId);
            if (inputElement) {
                inputElement.value = settings[storageKey].replace('px', '');
            }
        }
    });

    if (otkViewer) {
        if (settings.otkMsgDepth0DisableHeaderUnderline) {
            otkViewer.classList.add('hide-underline');
        } else {
            otkViewer.classList.remove('hide-underline');
        }
        if (!settings.otkMsgDepth0DisplayMediaFilename) {
            otkViewer.classList.add('hide-filenames');
        } else {
            otkViewer.classList.remove('hide-filenames');
        }
    }

    // Message Layout Dropdown
    if (settings.otkMessageLayoutStyle) {
        const layoutDropdown = document.getElementById('otk-message-layout-dropdown');
        if (layoutDropdown) {
            layoutDropdown.value = settings.otkMessageLayoutStyle;
        }
        if (otkViewer) {
            if (settings.otkMessageLayoutStyle === 'new_design') {
                otkViewer.classList.add('otk-message-layout-newdesign');
                otkViewer.classList.remove('otk-message-layout-default');
            } else {
                otkViewer.classList.add('otk-message-layout-default');
                otkViewer.classList.remove('otk-message-layout-newdesign');
            }
        }
    }

    if (settings.guiBottomBorderColor) {
        document.documentElement.style.setProperty('--otk-gui-bottom-border-color', settings.guiBottomBorderColor);
        updateColorInputs('gui-bottom-border', settings.guiBottomBorderColor);
    }

    // Cog Icon Color
    if (settings.cogIconColor) {
        document.documentElement.style.setProperty('--otk-cog-icon-color', settings.cogIconColor);
        updateColorInputs('cog-icon', settings.cogIconColor);
    }

    // Disable Background Font Color
    if (settings.disableBgFontColor) {
        document.documentElement.style.setProperty('--otk-disable-bg-font-color', settings.disableBgFontColor);
        updateColorInputs('disable-bg-font', settings.disableBgFontColor);
    }

    // New Messages Divider Color
    if (settings.newMessagesDividerColor) {
        document.documentElement.style.setProperty('--otk-new-messages-divider-color', settings.newMessagesDividerColor);
        updateColorInputs('new-msg-divider', settings.newMessagesDividerColor);
    }

    // New Messages Font Color
    if (settings.newMessagesFontColor) {
        document.documentElement.style.setProperty('--otk-new-messages-font-color', settings.newMessagesFontColor);
        updateColorInputs('new-msg-font', settings.newMessagesFontColor);
    }

    // Anchor Highlight Colors
    if (settings.anchorHighlightBgColor) {
        document.documentElement.style.setProperty('--otk-anchor-highlight-bg-color', settings.anchorHighlightBgColor);
        updateColorInputs('anchor-bg', settings.anchorHighlightBgColor);
    }
    if (settings.anchorHighlightBorderColor) {
        document.documentElement.style.setProperty('--otk-anchor-highlight-border-color', settings.anchorHighlightBorderColor);
        updateColorInputs('anchor-border', settings.anchorHighlightBorderColor);
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
            updateColorInputs(config.idSuffix, settings[config.key]);
        }
    });

    // Loading Screen Colors
    if (settings.loadingOverlayBaseHexColor) {
        document.documentElement.style.setProperty('--otk-loading-overlay-base-hex-color', settings.loadingOverlayBaseHexColor);
        updateColorInputs('loading-overlay-base-hex', settings.loadingOverlayBaseHexColor);
    }
    if (settings.loadingOverlayOpacity) {
        document.documentElement.style.setProperty('--otk-loading-overlay-opacity', settings.loadingOverlayOpacity);
        const inputEl = document.getElementById('otk-loading-overlay-opacity');
        if (inputEl) inputEl.value = settings.loadingOverlayOpacity;
    }
    if (settings.loadingTextColor) {
        document.documentElement.style.setProperty('--otk-loading-text-color', settings.loadingTextColor);
        updateColorInputs('loading-text', settings.loadingTextColor);
    }
    if (settings.loadingProgressBarBgColor) {
        document.documentElement.style.setProperty('--otk-loading-progress-bar-bg-color', settings.loadingProgressBarBgColor);
        updateColorInputs('loading-progress-bg', settings.loadingProgressBarBgColor);
    }
    if (settings.loadingProgressBarFillColor) {
        document.documentElement.style.setProperty('--otk-loading-progress-bar-fill-color', settings.loadingProgressBarFillColor);
        updateColorInputs('loading-progress-fill', settings.loadingProgressBarFillColor);
    }
    if (settings.loadingProgressBarTextColor) {
        document.documentElement.style.setProperty('--otk-loading-progress-bar-text-color', settings.loadingProgressBarTextColor);
        updateColorInputs('loading-progress-text', settings.loadingProgressBarTextColor);
    }

    // Update checkboxes for new boolean settings
    const newBooleanSettings = [
        { key: 'otkMsgDepth0DisableHeaderUnderline', defaultValue: false, idSuffix: 'msg-depth0-disable-header-underline' },
        { key: 'otkMsgDepth0DisplayMediaFilename', defaultValue: true, idSuffix: 'msg-depth0-display-media-filename' },
        { key: 'otkMsgDepth1DisableHeaderUnderline', defaultValue: false, idSuffix: 'msg-depth1-disable-header-underline' },
        { key: 'otkMsgDepth1DisplayMediaFilename', defaultValue: true, idSuffix: 'msg-depth1-display-media-filename' },
        { key: 'otkMsgDepth2plusDisableHeaderUnderline', defaultValue: false, idSuffix: 'msg-depth2plus-disable-header-underline' },
        { key: 'otkMsgDepth2plusDisplayMediaFilename', defaultValue: true, idSuffix: 'msg-depth2plus-display-media-filename' }
    ];

    newBooleanSettings.forEach(opt => {
        const checkbox = document.getElementById(`otk-${opt.idSuffix}-checkbox`);
        if (checkbox) {
            if (settings.hasOwnProperty(opt.key)) {
                checkbox.checked = settings[opt.key];
            } else {
                checkbox.checked = opt.defaultValue;
            }
        }
    });

    // Directly update loading screen styles
    const loadingOverlayElement = document.getElementById('otk-loading-overlay');
    if (loadingOverlayElement) {
        const baseHex = settings.loadingOverlayBaseHexColor || getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-overlay-base-hex-color').trim() || '#000000';
        const rgbParts = hexToRgbParts(baseHex);
        const opacity = settings.loadingOverlayOpacity || getComputedStyle(document.documentElement).getPropertyValue('--otk-loading-overlay-opacity').trim() || '0.8';
        loadingOverlayElement.style.backgroundColor = `rgba(${rgbParts}, ${opacity})`;
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

    forceViewerRerenderAfterThemeChange();
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
        width: 545px; /* Further Increased width for scrollbar clearance (540px + 5px) */
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
        padding: 15px 10px 15px 20px; /* Top, Right (10px), Bottom, Left (20px) */
        flex-grow: 1; /* Allows content to fill space */
        overflow-y: auto; /* If content gets too long */
        box-sizing: border-box; /* Ensure padding is included in width/height */
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
        padding-right: 5px; /* Added right padding */
        box-sizing: border-box; /* Ensure padding is included if not already part of a width calc */
    `;
    contentArea.appendChild(generalSettingsSection); // Add general settings section first

    // Add a heading for the General Settings section using the helper
    generalSettingsSection.appendChild(createSectionHeading('General Settings'));

    // --- Tracked Keyword(s) Option ---
    const trackedKeywordsGroup = document.createElement('div');
    // Apply Flexbox styling similar to createThemeOptionRow
    trackedKeywordsGroup.style.cssText = "display: flex; align-items: center; gap: 8px; width: 100%; margin-bottom: 5px;";

    const trackedKeywordsLabel = document.createElement('label');
    trackedKeywordsLabel.textContent = "Tracked Keyword(s):";
    trackedKeywordsLabel.htmlFor = 'otk-tracked-keywords-input';
    // Apply Flexbox label styling
    trackedKeywordsLabel.style.cssText = "font-size: 12px; text-align: left; flex-basis: 230px; flex-shrink: 0;";

    const trackedKeywordsControlsWrapper = document.createElement('div');
    trackedKeywordsControlsWrapper.style.cssText = "display: flex; flex-grow: 1; align-items: center; gap: 8px; min-width: 0;";

    const trackedKeywordsInput = document.createElement('input');
    trackedKeywordsInput.type = 'text';
    trackedKeywordsInput.id = 'otk-tracked-keywords-input';
    trackedKeywordsInput.placeholder = "e.g., otk, item2, phrase three";
    // Explicitly set width to 100% of its parent wrapper and right-align text.
    trackedKeywordsInput.style.cssText = "width: 100%; height: 25px; box-sizing: border-box; font-size: 12px; text-align: right;";
    trackedKeywordsInput.value = localStorage.getItem(OTK_TRACKED_KEYWORDS_KEY) || "otk"; // Load saved value or default

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
    });

    trackedKeywordsControlsWrapper.appendChild(trackedKeywordsInput);
    trackedKeywordsGroup.appendChild(trackedKeywordsLabel);
    trackedKeywordsGroup.appendChild(trackedKeywordsControlsWrapper);
    generalSettingsSection.appendChild(trackedKeywordsGroup);

    // --- Background Update Frequency Option ---
    const minUpdateGroup = createThemeOptionRow({
        labelText: "Minimum time between updates (minutes):",
        storageKey: 'otkMinUpdateMinutes',
        cssVariable: '--otk-min-update-seconds',
        defaultValue: '2',
        inputType: 'number',
        unit: null,
        min: 2,
        max: 60,
        idSuffix: 'min-update-seconds'
    });
    generalSettingsSection.appendChild(minUpdateGroup);

    const maxUpdateGroup = createThemeOptionRow({
        labelText: "Maximum time between updates (minutes):",
        storageKey: 'otkMaxUpdateMinutes',
        cssVariable: '--otk-max-update-seconds',
        defaultValue: '5',
        inputType: 'number',
        unit: null,
        min: 4,
        max: 60,
        idSuffix: 'max-update-seconds'
    });
    generalSettingsSection.appendChild(maxUpdateGroup);

    const suspendAfterGroup = createThemeOptionRow({
        labelText: "Suspend updates after (minutes):",
        storageKey: 'otkSuspendAfterInactiveMinutes',
        cssVariable: '--otk-suspend-after-inactive-minutes',
        defaultValue: '1',
        inputType: 'number',
        unit: null,
        min: 1,
        max: 60,
        idSuffix: 'suspend-after-inactive-minutes'
    });
    generalSettingsSection.appendChild(suspendAfterGroup);

    // --- Debugging Toggle Option ---
    const debugToggleGroup = document.createElement('div');
    // Apply Flexbox styling
    debugToggleGroup.style.cssText = "display: flex; align-items: center; gap: 8px; width: 100%; margin-bottom: 5px;";

    const debugToggleLabel = document.createElement('label');
    debugToggleLabel.textContent = "Enable Console Debugging:";
    debugToggleLabel.htmlFor = 'otk-debug-mode-checkbox';
    // Apply Flexbox label styling
    debugToggleLabel.style.cssText = "font-size: 12px; text-align: left; flex-basis: 230px; flex-shrink: 0;";

    const debugToggleControlsWrapper = document.createElement('div');
    debugToggleControlsWrapper.style.cssText = "display: flex; flex-grow: 1; align-items: center; gap: 8px; min-width: 0; justify-content: flex-end;";

    const debugToggleCheckbox = document.createElement('input');
    debugToggleCheckbox.type = 'checkbox';
    debugToggleCheckbox.id = 'otk-debug-mode-checkbox';
    // Specific styling for checkbox
    debugToggleCheckbox.style.cssText = "height: 16px; width: 16px;";
    debugToggleCheckbox.checked = DEBUG_MODE;

    debugToggleCheckbox.addEventListener('change', () => {
        DEBUG_MODE = debugToggleCheckbox.checked;
        localStorage.setItem(DEBUG_MODE_KEY, DEBUG_MODE.toString());
        consoleLog(`Debug mode ${DEBUG_MODE ? 'enabled' : 'disabled'}.`);
        if (DEBUG_MODE) {
             console.log('[OTK Tracker]', `Debug mode explicitly enabled via UI.`);
        }
    });

    debugToggleControlsWrapper.appendChild(debugToggleCheckbox);
    debugToggleGroup.appendChild(debugToggleLabel);
    debugToggleGroup.appendChild(debugToggleControlsWrapper);
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
        /* max-height: 330px; */ /* Max height for the theme options area - Let content dictate or use min-height */
        /* overflow-y: auto; */ /* Enable vertical scrollbar - Let themeOptionsContainer handle scroll */
        /* padding-right: 10px; */ /* Space for scrollbar - Removed */
        /* padding-left: 5px; */ /* Minor padding for content - Removed */
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
        padding-right: 20px; /* Further Increased right padding for scrollbar clearance (15px + 5px) */
        box-sizing: border-box; /* Ensure padding is included */
        /* padding-left: 5px; */ /* Minor padding for content - Remains Removed, covered by contentArea */
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

    // Helper function to create a checkbox option row
    function createCheckboxOptionRow(options) {
        // options = { labelText, storageKey, defaultValue, idSuffix }
        const group = document.createElement('div');
        group.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            margin-bottom: 5px;
        `;

        const label = document.createElement('label');
        label.textContent = options.labelText;
        label.htmlFor = `otk-${options.idSuffix}-checkbox`;
        label.style.cssText = `
            font-size: 12px;
            text-align: left;
            flex-basis: 230px;
            flex-shrink: 0;
        `;

        const controlsWrapperDiv = document.createElement('div');
        controlsWrapperDiv.style.cssText = `
            display: flex;
            flex-grow: 1;
            align-items: center;
            justify-content: flex-end; /* Align checkbox to the right */
            min-width: 0;
        `;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `otk-${options.idSuffix}-checkbox`; // Ensure ID is unique and clear
        checkbox.style.cssText = `
            height: 16px; /* Standard checkbox size */
            width: 16px;  /* Standard checkbox size */
            flex-shrink: 0; /* Prevent checkbox from shrinking */
        `;

        // Initialize checkbox state
        const savedValue = localStorage.getItem(options.storageKey);
        checkbox.checked = (savedValue !== null) ? (savedValue === 'true') : options.defaultValue;

        checkbox.addEventListener('change', () => {
            saveThemeSetting(options.storageKey, checkbox.checked);
        });

        controlsWrapperDiv.appendChild(checkbox);
        group.appendChild(label);
        group.appendChild(controlsWrapperDiv);
        return group;
    }

    // Helper function to create a theme option row
    function createThemeOptionRow(options) {
        // options = { labelText, storageKey, cssVariable, defaultValue, inputType ('color'|'number'), unit ('px'|null), min, max, idSuffix }
        const group = document.createElement('div');
        // Using Flexbox for more dynamic sizing
        group.style.cssText = `
            display: flex;
            align-items: center; /* Vertically align label and controls-wrapper */
            gap: 8px; /* Space between label and controls-wrapper */
            width: 100%;
            margin-bottom: 5px;
        `;

        const label = document.createElement('label');
        label.textContent = options.labelText;
        label.htmlFor = `otk-${options.idSuffix}`; // Points to the main input (picker or number input)
        label.style.cssText = `
            font-size: 12px;
            text-align: left;
            flex-basis: 230px; /* Accommodate longest label */
            flex-shrink: 0; /* Prevent shrinking */
        `;

        // Create a wrapper for all controls (hex, main input, button)
        const controlsWrapperDiv = document.createElement('div');
        controlsWrapperDiv.style.cssText = `
            display: flex;
            flex-grow: 1; /* Take remaining space */
            align-items: center; /* Vertically align controls */
            gap: 8px; /* Space between controls */
            min-width: 0; /* Allow shrinking if needed */
        `;

        let hexInput = null;
        if (options.inputType === 'color') {
            hexInput = document.createElement('input');
            hexInput.type = 'text';
            hexInput.id = `otk-${options.idSuffix}-hex`;
            hexInput.style.cssText = `
                flex: 1 1 70px; /* flex-grow, flex-shrink, flex-basis */
                min-width: 50px;
                height: 25px;
                box-sizing: border-box;
                font-size: 12px;
                text-align: right;
            `;
        }

        const mainInput = document.createElement('input');
        mainInput.type = options.inputType;
        mainInput.id = `otk-${options.idSuffix}`;
        if (options.inputType === 'color') {
            mainInput.style.cssText = `
                flex-grow: 0;
                flex-shrink: 0;
                width: 30px; /* Adjusted width */
                height: 25px;
                padding: 1px; /* Adjusted padding */
                box-sizing: border-box;
            `;
        } else if (options.inputType === 'number') {
            mainInput.style.cssText = `
                flex: 1 1 60px; /* flex-grow, flex-shrink, flex-basis */
                min-width: 40px;
                height: 25px;
                box-sizing: border-box;
                font-size: 12px;
            `;
            // Add text-align: right for number inputs created by createThemeOptionRow
            if (options.inputType === 'number') {
                mainInput.style.textAlign = 'right';
            }
            if (options.min !== undefined) mainInput.min = options.min;
            if (options.max !== undefined) mainInput.max = options.max;
        }

        const defaultBtn = document.createElement('button');
        defaultBtn.textContent = 'Default';
        defaultBtn.style.cssText = `
            flex-grow: 0;
            flex-shrink: 0;
            padding: 2px 6px; /* Adjusted padding */
            height: 25px;
            font-size: 11px;
            box-sizing: border-box;
            width: auto;
        `;

        group.appendChild(label);

        // Append controls to their wrapper
        if (hexInput) {
            controlsWrapperDiv.appendChild(hexInput);
        }
        controlsWrapperDiv.appendChild(mainInput);
        controlsWrapperDiv.appendChild(defaultBtn);

        group.appendChild(controlsWrapperDiv); // Append the wrapper to the main group

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
            hexInput.addEventListener('input', (e) => { // Real-time update from hex input to color picker
                const hexValue = e.target.value.trim();
                // Basic validation for a complete hex code (3, 4, 6, or 8 digits after #)
                if (/^#([0-9A-F]{3}|[0-9A-F]{4}|[0-9A-F]{6}|[0-9A-F]{8})$/i.test(hexValue)) {
                    mainInput.value = hexValue;
                }
                // The 'change' listener below will handle full validation and saving.
            });
            hexInput.addEventListener('change', (e) => updateSetting(e.target.value, false)); // Fire on change (blur/enter) for saving

            mainInput.addEventListener('input', (e) => { // Color picker updates continuously
                const pickerValue = e.target.value;
                // Update hex field immediately as picker changes, assuming pickerValue is standard hex
                if (pickerValue.startsWith('#')) { // Basic check that it's likely a hex color string
                    hexInput.value = pickerValue;
                } else {
                    // This case should ideally not happen with standard browser behavior.
                    // If pickerValue is not hex (e.g., 'rgb(r,g,b)'), we might need to convert it or log an error.
                    // For now, we'll only update hexInput if it looks like hex.
                    // The robust validation and saving happens on 'change'.
                    consoleWarn(`Color picker returned non-hex value during input: ${pickerValue}. Hex field not updated in real-time.`);
                }

                // Call updateSetting to apply the change to CSS variables etc.
                // updateSetting itself will validate the hex code before applying it.
                updateSetting(pickerValue, true); // Pass flag true
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
        hr.style.cssText = "width: 100%; border: none; border-top: 1px solid #555; margin: 12px 0 8px 0;";
        return hr;
    }

    function createSectionHeading(text) {
        const h = document.createElement('h5');
        h.textContent = text;
        // Adjusted margins for more space, removed border-bottom
        h.style.cssText = "margin-top: 10px; margin-bottom: 6px; color: #cccccc; font-size: 13px; padding-bottom: 4px; font-weight: bold; text-align: left;";
        return h;
    }

    // Clear existing content from themeOptionsContainer before repopulating
    themeOptionsContainer.innerHTML = '';

    // --- GUI Section ---
    const guiSectionHeading = createSectionHeading('GUI');
    guiSectionHeading.style.marginTop = "0px"; // First heading doesn't need extra top margin
    guiSectionHeading.style.marginBottom = "18px"; // Increased bottom margin for specific space after GUI heading
    themeOptionsContainer.appendChild(guiSectionHeading);
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Background:", storageKey: 'guiBgColor', cssVariable: '--otk-gui-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'gui-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Title Text:", storageKey: 'titleTextColor', cssVariable: '--otk-title-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'title-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Thread Titles Text:", storageKey: 'guiThreadListTitleColor', cssVariable: '--otk-gui-threadlist-title-color', defaultValue: '#e0e0e0', inputType: 'color', idSuffix: 'threadlist-title' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Thread Times Text:", storageKey: 'guiThreadListTimeColor', cssVariable: '--otk-gui-threadlist-time-color', defaultValue: '#aaa', inputType: 'color', idSuffix: 'threadlist-time' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Stats Text:", storageKey: 'actualStatsTextColor', cssVariable: '--otk-stats-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'actual-stats-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Background Updates Stats Text:", storageKey: 'backgroundUpdatesStatsTextColor', cssVariable: '--otk-background-updates-stats-text-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'background-updates-stats-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Cog Icon:", storageKey: 'cogIconColor', cssVariable: '--otk-cog-icon-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'cog-icon' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Disable Background Update Text:", storageKey: 'disableBgFontColor', cssVariable: '--otk-disable-bg-font-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'disable-bg-font' }));

    // Sub-section for GUI Buttons
    const guiButtonsSubHeading = document.createElement('h6');
    guiButtonsSubHeading.textContent = "GUI Buttons";
    guiButtonsSubHeading.style.cssText = "margin-top: 20px; margin-bottom: 15px; color: #cccccc; font-size: 12px; font-weight: bold; text-align: left;"; // Increased margin-top and margin-bottom
    themeOptionsContainer.appendChild(guiButtonsSubHeading);
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Background:", storageKey: 'guiButtonBgColor', cssVariable: '--otk-button-bg-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'gui-button-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Text:", storageKey: 'guiButtonTextColor', cssVariable: '--otk-button-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'gui-button-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Border:", storageKey: 'guiButtonBorderColor', cssVariable: '--otk-button-border-color', defaultValue: '#777777', inputType: 'color', idSuffix: 'gui-button-border' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Hover Background:", storageKey: 'guiButtonHoverBgColor', cssVariable: '--otk-button-hover-bg-color', defaultValue: '#666666', inputType: 'color', idSuffix: 'gui-button-hover-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Active Background:", storageKey: 'guiButtonActiveBgColor', cssVariable: '--otk-button-active-bg-color', defaultValue: '#444444', inputType: 'color', idSuffix: 'gui-button-active-bg' }));

    // themeOptionsContainer.appendChild(createDivider()); // Removed divider

    // --- Viewer Section ---
    const viewerSectionHeading = createSectionHeading('Viewer');
    viewerSectionHeading.style.marginTop = "22px"; // Increased top margin for space before Viewer heading
    viewerSectionHeading.style.marginBottom = "18px"; // Increased bottom margin for space after Viewer heading
    themeOptionsContainer.appendChild(viewerSectionHeading);

    // Add Message Layout Dropdown to Viewer section (moved to top)
    // Add Message Layout Dropdown to Viewer section (moved to top)
    const layoutSettingKey = 'otkMessageLayoutStyle';
    const currentLayout = localStorage.getItem(layoutSettingKey) || 'default';
    const layoutDropdownGroup = document.createElement('div');
    // Using Flexbox to align with createThemeOptionRow
    layoutDropdownGroup.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        margin-bottom: 5px;
    `;

    const layoutDropdownLabel = document.createElement('label');
    layoutDropdownLabel.textContent = "Message Layout:";
    layoutDropdownLabel.htmlFor = 'otk-message-layout-dropdown';
    layoutDropdownLabel.style.cssText = `
        font-size: 12px;
        text-align: left;
        flex-basis: 230px; /* Consistent with createThemeOptionRow */
        flex-shrink: 0;   /* Consistent with createThemeOptionRow */
    `;

    const controlsWrapperForDropdown = document.createElement('div');
    controlsWrapperForDropdown.style.cssText = `
        display: flex;
        flex-grow: 1;
        align-items: center;
    `;

    const messageLayoutDropdown = document.createElement('select');
    messageLayoutDropdown.id = 'otk-message-layout-dropdown';
    messageLayoutDropdown.style.cssText = `
        flex-grow: 1; /* Allow dropdown to take available space in its wrapper */
        height: 25px;
        box-sizing: border-box;
        font-size: 12px;
        text-align: center; /* Attempt to center-align selected text */
        text-align-last: center; /* For some browsers */
        /* direction: ltr; */ /* Ensure default or ltr if issues with arrow */
    `;

    const layoutOptions = [
        { label: 'Default', value: 'default' },
        { label: 'New Design', value: 'new_design' }
    ];

    layoutOptions.forEach(opt => {
        const optionElement = document.createElement('option');
        optionElement.value = opt.value;
        optionElement.textContent = opt.label;
        if (currentLayout === opt.value) {
            optionElement.selected = true;
        }
        messageLayoutDropdown.appendChild(optionElement);
    });

    messageLayoutDropdown.addEventListener('change', () => {
        const selectedLayout = messageLayoutDropdown.value;
        saveThemeSetting(layoutSettingKey, selectedLayout);
        consoleLog(`Message layout changed to: ${selectedLayout}`);
    });

    layoutDropdownGroup.appendChild(layoutDropdownLabel);
    controlsWrapperForDropdown.appendChild(messageLayoutDropdown); // Add dropdown to its wrapper
    layoutDropdownGroup.appendChild(controlsWrapperForDropdown); // Add wrapper to the group
    themeOptionsContainer.appendChild(layoutDropdownGroup); // Appended first in Viewer section

    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Background:", storageKey: 'viewerBgColor', cssVariable: '--otk-viewer-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'viewer-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "GUI Bottom Border:", storageKey: 'guiBottomBorderColor', cssVariable: '--otk-gui-bottom-border-color', defaultValue: '#555', inputType: 'color', idSuffix: 'gui-bottom-border' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "New Messages Divider:", storageKey: 'newMessagesDividerColor', cssVariable: '--otk-new-messages-divider-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'new-msg-divider' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "New Messages Text:", storageKey: 'newMessagesFontColor', cssVariable: '--otk-new-messages-font-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'new-msg-font' }));

    // Anchor Highlight Colors
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Anchor Highlight Background:", storageKey: 'anchorHighlightBgColor', cssVariable: '--otk-anchor-highlight-bg-color', defaultValue: '#4a4a3a', inputType: 'color', idSuffix: 'anchor-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Anchor Highlight Border:", storageKey: 'anchorHighlightBorderColor', cssVariable: '--otk-anchor-highlight-border-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'anchor-border' }));

    const tweetEmbedModeGroup = document.createElement('div');
    tweetEmbedModeGroup.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        margin-bottom: 5px;
    `;
    const tweetEmbedModeLabel = document.createElement('label');
    tweetEmbedModeLabel.textContent = "Tweet Embeds:";
    tweetEmbedModeLabel.htmlFor = 'otk-tweet-embed-mode-dropdown';
    tweetEmbedModeLabel.style.cssText = `
        font-size: 12px;
        text-align: left;
        flex-basis: 230px;
        flex-shrink: 0;
    `;
    const tweetEmbedModeControlsWrapper = document.createElement('div');
    tweetEmbedModeControlsWrapper.style.cssText = `
        display: flex;
        flex-grow: 1;
        align-items: center;
    `;
    const tweetEmbedModeDropdown = document.createElement('select');
    tweetEmbedModeDropdown.id = 'otk-tweet-embed-mode-dropdown';
    tweetEmbedModeDropdown.style.cssText = `
        flex-grow: 1;
        height: 25px;
        box-sizing: border-box;
        font-size: 12px;
        text-align: center;
        text-align-last: center;
    `;
    const tweetEmbedOptions = [
        { label: 'Disabled', value: 'disabled' },
        { label: 'Default', value: 'default' },
        { label: 'Dark Mode', value: 'dark' }
    ];
    tweetEmbedOptions.forEach(opt => {
        const optionElement = document.createElement('option');
        optionElement.value = opt.value;
        optionElement.textContent = opt.label;
        tweetEmbedModeDropdown.appendChild(optionElement);
    });
    tweetEmbedModeDropdown.value = localStorage.getItem(TWEET_EMBED_MODE_KEY) || 'default';
    tweetEmbedModeDropdown.addEventListener('change', () => {
        saveThemeSetting(TWEET_EMBED_MODE_KEY, tweetEmbedModeDropdown.value);
    });
    tweetEmbedModeGroup.appendChild(tweetEmbedModeLabel);
    tweetEmbedModeControlsWrapper.appendChild(tweetEmbedModeDropdown);
    tweetEmbedModeGroup.appendChild(tweetEmbedModeControlsWrapper);
    themeOptionsContainer.appendChild(tweetEmbedModeGroup);

    // themeOptionsContainer.appendChild(createDivider()); // Removed divider

    // --- Messages Section Restructuring ---
    // Remove old global "Messages" heading and global font size option (done by not adding them back here)

    // --- Depth 0 Messages Section ---
    const depth0MessagesHeading = createSectionHeading('Depth 0 Messages');
    depth0MessagesHeading.style.marginTop = "22px";
    depth0MessagesHeading.style.marginBottom = "18px";
    themeOptionsContainer.appendChild(depth0MessagesHeading);
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Font Size (px):", storageKey: 'msgDepth0ContentFontSize', cssVariable: '--otk-msg-depth0-content-font-size', defaultValue: '13px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'msg-depth0-content-fontsize' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Background:", storageKey: 'msgDepth0BgColor', cssVariable: '--otk-msg-depth0-bg-color', defaultValue: '#343434', inputType: 'color', idSuffix: 'msg-depth0-bg' })); // Default for original theme, new theme uses #fff
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Content Font:", storageKey: 'msgDepth0TextColor', cssVariable: '--otk-msg-depth0-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth0-text' })); // Default for original theme, new theme uses #333
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Header Font:", storageKey: 'msgDepth0HeaderTextColor', cssVariable: '--otk-msg-depth0-header-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth0-header-text' })); // Default for original theme, new theme uses #555
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Header Underline:", storageKey: 'viewerHeaderBorderColor', cssVariable: '--otk-viewer-header-border-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'viewer-header-border' }));
    themeOptionsContainer.appendChild(createCheckboxOptionRow({ labelText: "Hide Message Underline:", storageKey: 'otkMsgDepth0DisableHeaderUnderline', defaultValue: false, idSuffix: 'msg-depth0-disable-header-underline' }));
    themeOptionsContainer.appendChild(createCheckboxOptionRow({ labelText: "Show Media Filenames:", storageKey: 'otkMsgDepth0DisplayMediaFilename', defaultValue: true, idSuffix: 'msg-depth0-display-media-filename' }));

    // --- Depth 1 Messages Section ---
    const depth1MessagesHeading = createSectionHeading('Depth 1 Messages');
    depth1MessagesHeading.style.marginTop = "22px";
    depth1MessagesHeading.style.marginBottom = "18px";
    themeOptionsContainer.appendChild(depth1MessagesHeading);
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Font Size (px):", storageKey: 'msgDepth1ContentFontSize', cssVariable: '--otk-msg-depth1-content-font-size', defaultValue: '13px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'msg-depth1-content-fontsize' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Background:", storageKey: 'msgDepth1BgColor', cssVariable: '--otk-msg-depth1-bg-color', defaultValue: '#525252', inputType: 'color', idSuffix: 'msg-depth1-bg' })); // Default for original theme
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Content Font:", storageKey: 'msgDepth1TextColor', cssVariable: '--otk-msg-depth1-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth1-text' })); // Default for original theme
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Header Font:", storageKey: 'msgDepth1HeaderTextColor', cssVariable: '--otk-msg-depth1-header-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth1-header-text' })); // Default for original theme
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Header Underline:", storageKey: 'viewerQuote1HeaderBorderColor', cssVariable: '--otk-viewer-quote1-header-border-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'viewer-quote1-border' }));
    themeOptionsContainer.appendChild(createCheckboxOptionRow({ labelText: "Hide Message Underline:", storageKey: 'otkMsgDepth1DisableHeaderUnderline', defaultValue: false, idSuffix: 'msg-depth1-disable-header-underline' }));
    themeOptionsContainer.appendChild(createCheckboxOptionRow({ labelText: "Show Media Filenames:", storageKey: 'otkMsgDepth1DisplayMediaFilename', defaultValue: true, idSuffix: 'msg-depth1-display-media-filename' }));

    // --- Depth 2+ Messages Section ---
    const depth2plusMessagesHeading = createSectionHeading('Depth 2+ Messages');
    depth2plusMessagesHeading.style.marginTop = "22px";
    depth2plusMessagesHeading.style.marginBottom = "18px";
    themeOptionsContainer.appendChild(depth2plusMessagesHeading);
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Font Size (px):", storageKey: 'msgDepth2plusContentFontSize', cssVariable: '--otk-msg-depth2plus-content-font-size', defaultValue: '13px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'msg-depth2plus-content-fontsize' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Background:", storageKey: 'msgDepth2plusBgColor', cssVariable: '--otk-msg-depth2plus-bg-color', defaultValue: '#484848', inputType: 'color', idSuffix: 'msg-depth2plus-bg' })); // Default for original theme
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Content Font:", storageKey: 'msgDepth2plusTextColor', cssVariable: '--otk-msg-depth2plus-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth2plus-text' })); // Default for original theme
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Header Font:", storageKey: 'msgDepth2plusHeaderTextColor', cssVariable: '--otk-msg-depth2plus-header-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'msg-depth2plus-header-text' })); // Default for original theme
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Header Underline:", storageKey: 'viewerQuote2plusHeaderBorderColor', cssVariable: '--otk-viewer-quote2plus-header-border-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'viewer-quote2plus-border' }));
    themeOptionsContainer.appendChild(createCheckboxOptionRow({ labelText: "Hide Message Underline:", storageKey: 'otkMsgDepth2plusDisableHeaderUnderline', defaultValue: false, idSuffix: 'msg-depth2plus-disable-header-underline' }));
    themeOptionsContainer.appendChild(createCheckboxOptionRow({ labelText: "Show Media Filenames:", storageKey: 'otkMsgDepth2plusDisplayMediaFilename', defaultValue: true, idSuffix: 'msg-depth2plus-display-media-filename' }));

    // --- Options Panel Section ---
    const optionsPanelSectionHeading = createSectionHeading('Options Panel');
    optionsPanelSectionHeading.style.marginTop = "22px"; // Increased top margin
    optionsPanelSectionHeading.style.marginBottom = "18px"; // Increased bottom margin
    themeOptionsContainer.appendChild(optionsPanelSectionHeading);
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Panel Text:", storageKey: 'optionsTextColor', cssVariable: '--otk-options-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'options-text' }));
    // themeOptionsContainer.appendChild(createDivider()); // Removed divider

    // --- Loading Screen Sub-Section (within Theme) ---
    const loadingScreenSubHeading = document.createElement('h6');
    loadingScreenSubHeading.textContent = "Loading Screen";
    loadingScreenSubHeading.style.cssText = "margin-top: 20px; margin-bottom: 15px; color: #cccccc; font-size: 12px; font-weight: bold; text-align: left;"; // Increased margin-top and margin-bottom
    themeOptionsContainer.appendChild(loadingScreenSubHeading);

    // Add Overlay Opacity first
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Overlay Opacity:", storageKey: 'loadingOverlayOpacity', cssVariable: '--otk-loading-overlay-opacity', defaultValue: '0.8', inputType: 'number', min:0.0, max:1.0, step:0.05, idSuffix: 'loading-overlay-opacity' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Overlay Base:", storageKey: 'loadingOverlayBaseHexColor', cssVariable: '--otk-loading-overlay-base-hex-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'loading-overlay-base-hex' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Text:", storageKey: 'loadingTextColor', cssVariable: '--otk-loading-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-text' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Progress Bar Background:", storageKey: 'loadingProgressBarBgColor', cssVariable: '--otk-loading-progress-bar-bg-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'loading-progress-bg' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Progress Bar Fill:", storageKey: 'loadingProgressBarFillColor', cssVariable: '--otk-loading-progress-bar-fill-color', defaultValue: '#4CAF50', inputType: 'color', idSuffix: 'loading-progress-fill' }));
    themeOptionsContainer.appendChild(createThemeOptionRow({ labelText: "Progress Bar Text:", storageKey: 'loadingProgressBarTextColor', cssVariable: '--otk-loading-progress-bar-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-progress-text' }));

    // --- Custom Themes Section ---
    // themeOptionsContainer.appendChild(createDivider()); // Removed divider
    const customThemesSectionHeading = createSectionHeading('Custom Themes');
    customThemesSectionHeading.style.marginTop = "22px"; // Increased top margin
    customThemesSectionHeading.style.marginBottom = "18px"; // Increased bottom margin
    themeOptionsContainer.appendChild(customThemesSectionHeading);

    const customThemeActionsWrapper = document.createElement('div');
    customThemeActionsWrapper.style.cssText = `
        display: grid;
        /* Adjusted grid: Col1 (Name/Dropdown), Col2 (Save/Load), Col3 (Delete) */
        /* Col1 width aims to leave space for Col2 to align with hex inputs */
        grid-template-columns: calc(238px - 8px) auto auto; /* 238px = 230px label + 8px gap. Subtract internal grid gap. */
        gap: 8px;
        align-items: center;
    `;

    // Name input (Row 1, Col 1)
    const newThemeNameInput = document.createElement('input');
    newThemeNameInput.type = 'text';
    newThemeNameInput.id = 'otk-custom-theme-name-input';
    newThemeNameInput.placeholder = 'Enter Theme Name';
    newThemeNameInput.style.cssText = "width: 100%; height: 25px; box-sizing: border-box; font-size: 12px; text-align: right;";
    // No explicit grid-column needed if it's the first element for the first cell

    // Save button (Row 1, Col 2)
    const saveThemeButton = document.createElement('button');
    saveThemeButton.id = 'otk-save-custom-theme-btn';
    saveThemeButton.textContent = 'Save Theme';
    saveThemeButton.style.cssText = "width: 100%; padding: 4px 8px; font-size: 11px; height: 25px; box-sizing: border-box; grid-column: 2 / 4;"; // Span columns 2 and 3
    // No explicit grid-column needed if it's the second element for the second cell --> This comment is now misleading, removing

    // Dropdown (Row 2, Col 1)
    const customThemesDropdown = document.createElement('select');
    customThemesDropdown.id = 'otk-custom-themes-dropdown';
    customThemesDropdown.style.cssText = "width: 100%; height: 25px; box-sizing: border-box; font-size: 12px; text-align: center; text-align-last: center;"; // Attempt to center-align
    // Needs explicit grid-column to go to the next row in the same column
    customThemesDropdown.style.gridColumn = '1 / 2';


    // Load button (Row 2, Col 2)
    const loadThemeButton = document.createElement('button');
    loadThemeButton.id = 'otk-load-custom-theme-btn';
    loadThemeButton.textContent = 'Load';
    loadThemeButton.style.cssText = "width: 100%; padding: 4px 8px; font-size: 11px; height: 25px; box-sizing: border-box;";
    loadThemeButton.style.gridColumn = '2 / 3';

    // Delete button (Row 2, Col 3 - or could be Row 1, Col 3 if preferred visually)
    // For simplicity, let's keep it with Load on Row 2 for now.
    const deleteThemeButton = document.createElement('button');
    deleteThemeButton.id = 'otk-delete-custom-theme-btn';
    deleteThemeButton.textContent = 'Delete';
    deleteThemeButton.style.cssText = "width: 100%; padding: 4px 8px; font-size: 11px; height: 25px; box-sizing: border-box; background-color: #803333; color: #ffffff;"; // Dark red, white text
    deleteThemeButton.onmouseover = () => deleteThemeButton.style.backgroundColor = '#a04444';
    deleteThemeButton.onmouseout = () => deleteThemeButton.style.backgroundColor = '#803333';
    deleteThemeButton.style.gridColumn = '3 / 4';

    // Append in order for grid flow
    customThemeActionsWrapper.appendChild(newThemeNameInput);    // R1 C1
    customThemeActionsWrapper.appendChild(saveThemeButton);      // R1 C2 (now spans C2-C3)
    // r1c3Placeholder is no longer needed as saveThemeButton spans its cell.
    // const r1c3Placeholder = document.createElement('div');
    // customThemeActionsWrapper.appendChild(r1c3Placeholder);

    customThemeActionsWrapper.appendChild(customThemesDropdown); // R2 C1
    customThemeActionsWrapper.appendChild(loadThemeButton);      // R2 C2
    customThemeActionsWrapper.appendChild(deleteThemeButton);    // R2 C3

    themeOptionsContainer.appendChild(customThemeActionsWrapper);

    const CUSTOM_THEMES_KEY = 'otkCustomThemes';

    saveThemeButton.addEventListener('click', () => {
        const themeName = newThemeNameInput.value.trim();
        if (!themeName) {
            alert("Please enter a name for the theme.");
            return;
        }

        const currentSettings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        let allCustomThemes = JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY)) || {};
        allCustomThemes[themeName] = currentSettings;
        localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(allCustomThemes));

        alert(`Theme "${themeName}" saved!`);
        populateCustomThemesDropdown();
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
        const selectedThemeName = customThemesDropdown.value;

        if (selectedThemeName === "__REVERT__" || !selectedThemeName || (customThemesDropdown.selectedOptions[0] && customThemesDropdown.selectedOptions[0].disabled)) {
            alert("Please select a valid custom theme to load.");
            return;
        }

        const customThemes = JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY)) || [];
        const themeToLoad = customThemes.find(t => t.name === selectedThemeName);

        if (!themeToLoad) {
            alert(`Error: Could not find the theme "${selectedThemeName}" to load.`);
            return;
        }

        consoleLog(`Loading custom theme: "${selectedThemeName}"`);

        // 1. Reset all theme settings to their base defaults first.
        resetAllThemeSettingsToDefault(false); // Pass false to prevent confirmation prompt

        // 2. Set the new theme's settings into the active settings key.
        localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(themeToLoad.settings));

        // 3. Apply the newly loaded settings.
        applyThemeSettings();

        // 4. Clear any preview-related state.
        prePreviewSettings = null;
        currentlyPreviewingThemeName = null;
        customThemesDropdown.value = "__REVERT__"; // Set dropdown to show "Active Settings"

        alert(`Theme "${selectedThemeName}" loaded successfully.`);
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

    const applyButton = document.createElement('button');
    applyButton.textContent = 'Apply Changes';
    applyButton.style.cssText = `
        display: block;
        width: 100%;
        padding: 10px;
        margin-top: 15px;
        background-color: #4CAF50;
        color: white;
        border: none;
        border-radius: 0 0 5px 5px;
        cursor: pointer;
        font-size: 16px;
    `;
    optionsWindow.appendChild(applyButton);

    applyButton.addEventListener('click', () => {
        let settings = JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY)) || {};
        Object.assign(settings, stagedThemeSettings);
        localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(settings));
        stagedThemeSettings = {};
        applyThemeSettings();
        forceViewerRerenderAfterThemeChange();
        alert('Settings applied!');
    });

    // Helper function to get all theme configurations (used by save and reset)
    function getAllOptionConfigs() {
        // Note: labelText is not part of this config object, it's passed directly to createThemeOptionRow.
        // This function is primarily for mapping storageKey, cssVariable, defaultValue, inputType, etc.
        // The spelling change from "Color" to "Colour" happens in the createThemeOptionRow calls.
        return [
            { storageKey: 'guiBgColor', cssVariable: '--otk-gui-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'gui-bg' },
            { storageKey: 'titleTextColor', cssVariable: '--otk-title-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'title-text' },
            { storageKey: 'guiThreadListTitleColor', cssVariable: '--otk-gui-threadlist-title-color', defaultValue: '#e0e0e0', inputType: 'color', idSuffix: 'threadlist-title' },
            { storageKey: 'guiThreadListTimeColor', cssVariable: '--otk-gui-threadlist-time-color', defaultValue: '#aaa', inputType: 'color', idSuffix: 'threadlist-time' },
            { storageKey: 'actualStatsTextColor', cssVariable: '--otk-stats-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'actual-stats-text' },
            { storageKey: 'viewerBgColor', cssVariable: '--otk-viewer-bg-color', defaultValue: '#181818', inputType: 'color', idSuffix: 'viewer-bg' },
            { storageKey: 'guiBottomBorderColor', cssVariable: '--otk-gui-bottom-border-color', defaultValue: '#555', inputType: 'color', idSuffix: 'gui-bottom-border' },
            // { storageKey: 'viewerMessageFontSize', cssVariable: '--otk-viewer-message-font-size', defaultValue: '13px', inputType: 'number', unit: 'px', idSuffix: 'fontsize-message-text' }, // Removed old global
            // New Depth-Specific Content Font Sizes
            { storageKey: 'msgDepth0ContentFontSize', cssVariable: '--otk-msg-depth0-content-font-size', defaultValue: '13px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'msg-depth0-content-fontsize'},
            { storageKey: 'msgDepth1ContentFontSize', cssVariable: '--otk-msg-depth1-content-font-size', defaultValue: '13px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'msg-depth1-content-fontsize'},
            { storageKey: 'msgDepth2plusContentFontSize', cssVariable: '--otk-msg-depth2plus-content-font-size', defaultValue: '13px', inputType: 'number', unit: 'px', min: 8, max: 24, idSuffix: 'msg-depth2plus-content-fontsize'},
            // Existing depth-specific color options (no changes needed to these specific lines, just context for new font sizes)
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
            { storageKey: 'disableBgFontColor', cssVariable: '--otk-disable-bg-font-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'disable-bg-font' },
            { storageKey: 'optionsTextColor', cssVariable: '--otk-options-text-color', defaultValue: '#e6e6e6', inputType: 'color', idSuffix: 'options-text' },
            { storageKey: 'newMessagesDividerColor', cssVariable: '--otk-new-messages-divider-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'new-msg-divider' },
            { storageKey: 'newMessagesFontColor', cssVariable: '--otk-new-messages-font-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'new-msg-font' },

            // Anchor Highlight Colors
            { storageKey: 'anchorHighlightBgColor', cssVariable: '--otk-anchor-highlight-bg-color', defaultValue: '#4a4a3a', inputType: 'color', idSuffix: 'anchor-bg' },
            { storageKey: 'anchorHighlightBorderColor', cssVariable: '--otk-anchor-highlight-border-color', defaultValue: '#FFD700', inputType: 'color', idSuffix: 'anchor-border' },

            // GUI Button Colours
            { storageKey: 'guiButtonBgColor', cssVariable: '--otk-button-bg-color', defaultValue: '#555555', inputType: 'color', idSuffix: 'gui-button-bg' },
            { storageKey: 'guiButtonTextColor', cssVariable: '--otk-button-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'gui-button-text' },
            { storageKey: 'guiButtonBorderColor', cssVariable: '--otk-button-border-color', defaultValue: '#777777', inputType: 'color', idSuffix: 'gui-button-border' },
            { storageKey: 'guiButtonHoverBgColor', cssVariable: '--otk-button-hover-bg-color', defaultValue: '#666666', inputType: 'color', idSuffix: 'gui-button-hover-bg' },
            { storageKey: 'guiButtonActiveBgColor', cssVariable: '--otk-button-active-bg-color', defaultValue: '#444444', inputType: 'color', idSuffix: 'gui-button-active-bg' },

            // Loading Screen Colours
            { storageKey: 'loadingOverlayBaseHexColor', cssVariable: '--otk-loading-overlay-base-hex-color', defaultValue: '#000000', inputType: 'color', idSuffix: 'loading-overlay-base-hex' },
            { storageKey: 'loadingOverlayOpacity', cssVariable: '--otk-loading-overlay-opacity', defaultValue: '0.8', inputType: 'number', unit: null, min:0.0, max:1.0, step:0.05, idSuffix: 'loading-overlay-opacity' },
            { storageKey: 'loadingTextColor', cssVariable: '--otk-loading-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-text' },
            { storageKey: 'loadingProgressBarBgColor', cssVariable: '--otk-loading-progress-bar-bg-color', defaultValue: '#333333', inputType: 'color', idSuffix: 'loading-progress-bg' },
            { storageKey: 'loadingProgressBarFillColor', cssVariable: '--otk-loading-progress-bar-fill-color', defaultValue: '#4CAF50', inputType: 'color', idSuffix: 'loading-progress-fill' },
            { storageKey: 'loadingProgressBarTextColor', cssVariable: '--otk-loading-progress-bar-text-color', defaultValue: '#ffffff', inputType: 'color', idSuffix: 'loading-progress-text' }
        ];
    }


    function resetAllThemeSettingsToDefault(promptUser = true) {
        if (promptUser && !confirm("Are you sure you want to reset all theme settings to their defaults?")) {
            return;
        }

        consoleLog("Resetting all theme settings to default...");
        // Clear the active theme settings from localStorage.
        localStorage.removeItem(THEME_SETTINGS_KEY);

        const allOptionConfigs = getAllOptionConfigs();

        allOptionConfigs.forEach(opt => {
            // Remove the inline style to revert to the stylesheet's default.
            document.documentElement.style.removeProperty(opt.cssVariable);

            // Update the input fields in the options panel to reflect the default values.
            const mainInput = document.getElementById(`otk-${opt.idSuffix}`);
            const hexInput = opt.inputType === 'color' ? document.getElementById(`otk-${opt.idSuffix}-hex`) : null;

            // Get the default value from the stylesheet or the config's fallback.
            let cssDefaultValue = getComputedStyle(document.documentElement).getPropertyValue(opt.cssVariable)?.trim() || opt.defaultValue;
            if (opt.unit && cssDefaultValue.endsWith(opt.unit)) {
                cssDefaultValue = cssDefaultValue.replace(opt.unit, '');
            }

            if (mainInput) mainInput.value = cssDefaultValue;
            if (hexInput) hexInput.value = cssDefaultValue;

            if (opt.storageKey === 'cogIconColor') {
                const cogIcon = document.getElementById('otk-settings-cog');
                if (cogIcon) cogIcon.style.color = ''; // Revert to stylesheet
            }
        });

        // Also reset new boolean settings to their defaults
        const newBooleanSettings = [
            { key: 'otkMsgDepth0DisableHeaderUnderline', defaultValue: false, idSuffix: 'msg-depth0-disable-header-underline' },
            { key: 'otkMsgDepth0DisplayMediaFilename', defaultValue: true, idSuffix: 'msg-depth0-display-media-filename' },
            { key: 'otkMsgDepth1DisableHeaderUnderline', defaultValue: false, idSuffix: 'msg-depth1-disable-header-underline' },
            { key: 'otkMsgDepth1DisplayMediaFilename', defaultValue: true, idSuffix: 'msg-depth1-display-media-filename' },
            { key: 'otkMsgDepth2plusDisableHeaderUnderline', defaultValue: false, idSuffix: 'msg-depth2plus-disable-header-underline' },
            { key: 'otkMsgDepth2plusDisplayMediaFilename', defaultValue: true, idSuffix: 'msg-depth2plus-display-media-filename' }
        ];
        newBooleanSettings.forEach(opt => {
            const checkbox = document.getElementById(`otk-${opt.idSuffix}-checkbox`);
            if (checkbox) {
                checkbox.checked = opt.defaultValue;
            }
        });

        // The applyThemeSettings() call is no longer needed here if called by the initiator.
        // If called from the reset button, it should call it.
        // Let's call it for the standalone reset case.
        if (promptUser) {
            applyThemeSettings();
            alert("All theme settings have been reset to their defaults.");
        }
    }

    resetAllColorsButton.addEventListener('click', () => {
        resetAllThemeSettingsToDefault(true); // true to prompt user
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
        // Reversion logic for theme preview
        if (prePreviewSettings) {
            consoleLog("[OptionsClose] Reverting to pre-preview settings as options window is closing.");
            localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(prePreviewSettings));
            applyThemeSettings(); // Apply the restored settings

            prePreviewSettings = null; // Clear the stored pre-preview settings
            currentlyPreviewingThemeName = null; // Clear the currently previewing theme name

            // Reset dropdown to "Active Settings"
            const dropdown = document.getElementById('otk-custom-themes-dropdown');
            if (dropdown) {
                dropdown.value = "__REVERT__";
            }
        } else {
            consoleLog("[OptionsClose] No active preview to revert. Closing options window.");
        }

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

    function resetInactivityTimer() {
        if (scrollTimeout) {
            clearTimeout(scrollTimeout);
        }
        if (isSuspended) {
            consoleLog("[Activity] Resuming background updates.");
            isSuspended = false;
            hideSuspendedScreen();
            startBackgroundRefresh();
        }
        const suspendAfterInactiveMinutes = parseInt(localStorage.getItem('otkSuspendAfterInactiveMinutes') || '30', 10);
        scrollTimeout = setTimeout(() => {
            consoleLog(`[Inactivity] No activity for ${suspendAfterInactiveMinutes} minutes, suspending background updates.`);
            isSuspended = true;
            stopBackgroundRefresh();
            showSuspendedScreen();
        }, suspendAfterInactiveMinutes * 60 * 1000);
    }

    ['scroll', 'mousemove', 'mousedown', 'keypress'].forEach(activityEvent => {
        window.addEventListener(activityEvent, resetInactivityTimer);
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
            --otk-background-updates-stats-text-color: #FFD700; /* For the 'new' stats text */
            --otk-viewer-bg-color: #181818;
            --otk-gui-threadlist-title-color: #e0e0e0;
            --otk-gui-threadlist-time-color: #aaa;
            --otk-viewer-header-border-color: #000000; /* Default theme's header underline for depth 0 - Now black */
            --otk-viewer-quote1-header-border-color: #000000; /* Default theme's header underline for depth 1 - Now black */
            /* New defaults based on example.html for the new design, now acting as global defaults */
            --otk-msg-depth0-bg-color: #ffffff; /* example.html main bg */
            --otk-msg-depth1-bg-color: rgba(0, 0, 0, 0.05); /* example.html quote1 bg */
            --otk-msg-depth2plus-bg-color: #ffffff; /* example.html quote2 bg (alternating) */

            --otk-msg-depth0-text-color: #333333; /* example.html content text (assumed) */
            --otk-msg-depth1-text-color: #333333; /* example.html content text (assumed) */
            --otk-msg-depth2plus-text-color: #333333; /* example.html content text (assumed) */

            --otk-msg-depth0-header-text-color: #555555; /* example.html header text */
            --otk-msg-depth1-header-text-color: #555555; /* example.html header text */
            --otk-msg-depth2plus-header-text-color: #555555; /* example.html header text */

            --otk-viewer-message-font-size: 13px; /* Default font size for message text - remains common */
            --otk-gui-bottom-border-color: #555; /* Default for GUI bottom border - remains common */
            --otk-cog-icon-color: #e6e6e6; /* Default for settings cog icon */
            --otk-disable-bg-font-color: #e6e6e6; /* Default for "Disable Background Updates" text */
            --otk-viewer-quote2plus-header-border-color: #000000; /* Default for Depth 2+ message header underline - Now black */
            --otk-new-messages-divider-color: #FFD700; /* Default for new message separator line */
            --otk-new-messages-font-color: #FFD700; /* Default for new message separator text */

            /* New Depth-Specific Content Font Sizes */
            --otk-msg-depth0-content-font-size: 13px;
            --otk-msg-depth1-content-font-size: 13px;
            --otk-msg-depth2plus-content-font-size: 13px;

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

            /* Anchor Highlight Colors */
            --otk-anchor-highlight-bg-color: #4a4a3a;    /* Default: dark yellow/greenish */
            --otk-anchor-highlight-border-color: #FFD700; /* Default: gold */

            /* --- New Design Theme Variables --- */
            --otk-newdesign-main-bg: #fff;
            --otk-newdesign-quote1-bg: rgba(0, 0, 0, 0.05);
            --otk-newdesign-quote2-bg: #fff; /* Alternating, same as main */
            --otk-newdesign-colorsquare-bg: #4CAF50;
            --otk-newdesign-header-text-color: #555;
            --otk-newdesign-content-text-color: #333; /* Assuming content text is darker on white BG */
            --otk-newdesign-main-border-bottom-color: #ccc; /* Unique to new design's top-level msg */
            --otk-newdesign-viewer-bg-color: #fff4de; /* Viewer background for the new theme */
            /* The --otk-newdesign-msg-depthX... variables are removed as we will directly use the shared --otk-msg-depthX... vars */
        }

        /* --- New Design Specific Styles --- */
        #otk-viewer.otk-message-layout-newdesign { /* Target otkViewer when new design is active */
            background-color: var(--otk-newdesign-viewer-bg-color);
        }

        /* These rules now use the shared --otk-msg-depthX... variables, which have new defaults from example.html */
        .otk-message-layout-newdesign .otk-message-container-main {
            background-color: var(--otk-msg-depth0-bg-color); /* Uses shared variable */
            border-radius: 4px;
            padding: 6px 8px;
            margin-bottom: 15px;
            border-bottom: 1px solid var(--otk-newdesign-main-border-bottom-color); /* Specific to new design */
        }

        .otk-message-layout-newdesign .otk-message-container-quote-depth-1 {
            background-color: var(--otk-msg-depth1-bg-color); /* Uses shared variable */
            border-radius: 4px;
            padding: 6px 8px;
            margin-bottom: 8px;
        }

        .otk-message-layout-newdesign .otk-message-container-quote-depth-2 {
            background-color: var(--otk-msg-depth2plus-bg-color); /* Uses shared variable */
            border-radius: 4px;
            padding: 6px 8px; /* From example.html */
            margin-bottom: 8px; /* From example.html */
        }

        .otk-message-layout-newdesign .otk-post-div { /* Common for main message block and quoted message blocks */
            display: flex;
            align-items: flex-start; /* Align items (square, text wrapper) to the top */
        }

        .otk-message-layout-newdesign .otk-color-square {
            width: 15px;
            height: 40px; /* Or adjust dynamically if needed */
            background-color: var(--otk-newdesign-colorsquare-bg);
            border-radius: 3px;
            margin-right: 10px;
            flex-shrink: 0;
        }

        .otk-message-layout-newdesign .otk-text-wrapper {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
        }

        .otk-message-layout-newdesign .otk-header-div {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
            /* Default header color from shared variables, which now default to new theme's header color */
            color: var(--otk-msg-depth0-header-text-color);
            white-space: nowrap; /* From example.html */
            border-bottom: 1px solid var(--otk-viewer-header-border-color); /* Added underline */
            padding-bottom: 5px; /* Space for underline */
            margin-bottom: 8px; /* Space after underline */
        }
        /* For quoted messages, the header text color might be the same or different based on depth.
           Using shared variables allows this flexibility via settings. */
        .otk-message-layout-newdesign .otk-message-container-quote-depth-1 .otk-header-div {
             color: var(--otk-msg-depth1-header-text-color);
             border-bottom-color: var(--otk-viewer-quote1-header-border-color); /* Specific underline color for depth 1 */
        }
        .otk-message-layout-newdesign .otk-message-container-quote-depth-2 .otk-header-div {
             color: var(--otk-msg-depth2plus-header-text-color);
             border-bottom-color: var(--otk-viewer-quote2plus-header-border-color); /* Specific underline color for depth 2+ */
        }

        .otk-message-layout-newdesign .otk-content-div {
            white-space: pre-wrap;
            word-wrap: break-word;
            /* Default content text color from shared variables */
            color: var(--otk-msg-depth0-text-color);
            font-size: var(--otk-msg-depth0-content-font-size); /* Use new depth-specific variable */
        }
        .otk-message-layout-newdesign .otk-message-container-quote-depth-1 .otk-content-div {
             color: var(--otk-msg-depth1-text-color);
             font-size: var(--otk-msg-depth1-content-font-size); /* Use new depth-specific variable */
        }
        .otk-message-layout-newdesign .otk-message-container-quote-depth-2 .otk-content-div {
             color: var(--otk-msg-depth2plus-text-color);
             font-size: var(--otk-msg-depth2plus-content-font-size); /* Use new depth-specific variable */
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

        /* Placeholder styling */
        #otk-custom-theme-name-input::placeholder {
            text-align: center;
        }

        /* GUI Button States */
        .otk-button--hover {
            background-color: var(--otk-button-hover-bg-color) !important;
        }
        .otk-button--active {
            background-color: var(--otk-button-active-bg-color) !important;
        }

        .${ANCHORED_MESSAGE_CLASS} {
            background-color: var(--otk-anchor-highlight-bg-color) !important;
            border: 1px solid var(--otk-anchor-highlight-border-color) !important;
            /* Add other styles if needed, e.g., box-shadow */
        }
        .otk-viewer.hide-underline .otk-header-div {
            border-bottom: none !important;
        }
        .otk-viewer.hide-filenames .attachment-filename {
            display: none !important;
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

            // Restore viewer state
            if (localStorage.getItem(VIEWER_OPEN_KEY) === 'true' && otkViewer) {
                const currentLayoutMain = localStorage.getItem('otkMessageLayoutStyle') || 'default';
                if (currentLayoutMain === 'new_design') {
                    otkViewer.classList.add('otk-message-layout-newdesign');
                    otkViewer.classList.remove('otk-message-layout-default');
                } else {
                    otkViewer.classList.add('otk-message-layout-default');
                    otkViewer.classList.remove('otk-message-layout-newdesign');
                }
                consoleLog('Viewer state restored to open. Layout class applied. Rendering all messages.');
                otkViewer.style.display = 'block';
                document.body.style.overflow = 'hidden';
                renderMessagesInViewer(); // Auto-populate with all messages
            }


            // Load initial data and render list (stats are already updated)
            refreshThreadsAndMessages();
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
