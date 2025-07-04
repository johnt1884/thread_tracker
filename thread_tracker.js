// ==UserScript==
// @name         Thread Tracker
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Tracks OTK threads on /b/, stores messages, shows top bar with colors and controls, removes inactive threads entirely
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

    // Global variables
    let otkViewer = null;
    let backgroundRefreshIntervalId = null;
    let isManualRefreshInProgress = false;
    const BACKGROUND_REFRESH_INTERVAL = 30000; // 30 seconds for testing

    // Color palette for thread indicators
    const COLORS = [
        '#e6194B', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
        '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
        '#008080', '#e6beff', '#9A6324', '#fffac8', '#800000',
        '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080'
    ];

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
            border-bottom: 1px solid grey;
            background: black;
            box-sizing: border-box;
        `;

        otkGui = document.createElement('div');
        otkGui.id = 'otk-tracker-gui';
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
            flex-grow: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: space-between;
            color: white;
            text-align: center;
            padding: 0 10px;
        `;

        const otkThreadTitleDisplay = document.createElement('div');
        otkThreadTitleDisplay.id = 'otk-thread-title-display';
        otkThreadTitleDisplay.textContent = 'Thread Tracker 2.6';
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
            align-items: center;
        `;

        const threadsTrackedStat = document.createElement('span');
        threadsTrackedStat.id = 'otk-threads-tracked-stat';
        threadsTrackedStat.textContent = 'Live Threads: 0';

        const totalMessagesStat = document.createElement('span');
        totalMessagesStat.id = 'otk-total-messages-stat';
        totalMessagesStat.textContent = 'Total Messages: 0';

        otkStatsDisplay.appendChild(threadsTrackedStat);
        otkStatsDisplay.appendChild(totalMessagesStat);
        centerInfoContainer.appendChild(otkThreadTitleDisplay);
        centerInfoContainer.appendChild(otkStatsDisplay);
        otkGui.appendChild(centerInfoContainer);

        // Button container (right)
        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'otk-button-container';
        buttonContainer.style.cssText = `
            display: flex;
            align-items: flex-end;
            gap: 10px;
        `;
        otkGui.appendChild(buttonContainer);
    } else {
        if (document.body.style.paddingTop !== '86px') {
            document.body.style.paddingTop = '86px';
        }

        if (!otkGui) {
            otkGui = document.createElement('div');
            otkGui.id = 'otk-tracker-gui';
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

        if (!document.getElementById('otk-thread-display-container')) {
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
            centerInfoContainer.style.cssText = `
                flex-grow: 1;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: space-between;
                color: white;
                text-align: center;
                padding: 0 10px;
            `;

            const otkThreadTitleDisplay = document.createElement('div');
            otkThreadTitleDisplay.id = 'otk-thread-title-display';
            otkThreadTitleDisplay.textContent = 'Thread Tracker 2.6';
            otkThreadTitleDisplay.style.cssText = `font-weight: bold; font-size: 14px; margin-bottom: 4px;`;

            const otkStatsDisplay = document.createElement('div');
            otkStatsDisplay.id = 'otk-stats-display';
            otkStatsDisplay.style.cssText = `font-size: 11px; display: flex; flex-direction: column; align-items: center;`;

            const threadsTrackedStat = document.createElement('span');
            threadsTrackedStat.id = 'otk-threads-tracked-stat';
            threadsTrackedStat.textContent = 'Live Threads: 0';

            const totalMessagesStat = document.createElement('span');
            totalMessagesStat.id = 'otk-total-messages-stat';
            totalMessagesStat.textContent = 'Total Messages: 0';

            otkStatsDisplay.appendChild(threadsTrackedStat);
            otkStatsDisplay.appendChild(totalMessagesStat);
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
            buttonContainer.style.cssText = `
                display: flex;
                align-items: center;
                gap: 10px;
            `;
            otkGui.appendChild(buttonContainer);
        }
    }

    ensureViewerExists();

    // Load from localStorage or initialize
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
            console.log(`[OTK Tracker] Removing thread ${threadId} from messagesByThreadId during initialization (not in activeThreads or in droppedThreadIds).`);
            delete messagesByThreadId[threadId];
            delete threadColors[threadId];
        }
    }
    // Clean up droppedThreadIds after processing
    localStorage.removeItem(DROPPED_THREADS_KEY);
    localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesByThreadId));
    localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
    console.log('[OTK Tracker] Initialized activeThreads:', activeThreads);

    // Utility functions
    function decodeEntities(encodedString) {
        const txt = document.createElement('textarea');
        txt.innerHTML = encodedString;
        return txt.value;
    }

    function truncateTitleWithWordBoundary(title, maxLength) {
        if (title.length <= maxLength) return title;
        let truncated = title.substr(0, maxLength);
        let lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > 0 && lastSpace > maxLength - 20) {
            return truncated.substr(0, lastSpace) + '...';
        }
        return title.substr(0, maxLength - 3) + '...';
    }

    function getThreadColor(threadId) {
        if (!threadColors[threadId]) {
            const usedColors = new Set(Object.values(threadColors));
            const availableColors = COLORS.filter(c => !usedColors.has(c));
            threadColors[threadId] = availableColors.length ? availableColors[0] : '#888';
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
        }
        return threadColors[threadId];
    }

    // Render thread list
    function renderThreadList() {
        const threadDisplayContainer = document.getElementById('otk-thread-display-container');
        if (!threadDisplayContainer) {
            console.error('[OTK Tracker] Thread display container not found.');
            return;
        }

        threadDisplayContainer.innerHTML = '';
        console.log('[OTK Tracker] renderThreadList: Cleared thread display container.');

        if (activeThreads.length === 0) {
            console.log('[OTK Tracker] renderThreadList: No active threads to display.');
            return;
        }

        const threadDisplayObjects = activeThreads.map(threadId => {
            const messages = messagesByThreadId[threadId] || [];
            let title = 'Untitled Thread';
            let firstMessageTime = null;
            let originalThreadUrl = `https://boards.4chan.org/b/thread/${threadId}`;

            if (messages.length > 0) {
                title = messages[0].title ? decodeEntities(messages[0].title) : `Thread ${threadId}`;
                firstMessageTime = messages[0].time;
            }

            return {
                id: threadId,
                title: title,
                firstMessageTime: firstMessageTime,
                color: getThreadColor(threadId),
                url: originalThreadUrl
            };
        }).filter(thread => thread.firstMessageTime !== null);

        threadDisplayObjects.sort((a, b) => b.firstMessageTime - a.firstMessageTime);
        console.log(`[OTK Tracker] renderThreadList: Prepared ${threadDisplayObjects.length} threads for display:`, threadDisplayObjects.map(t => t.id));

        const threadsToDisplayInList = threadDisplayObjects.slice(0, 3);

        threadsToDisplayInList.forEach((thread, index) => {
            const threadItemDiv = document.createElement('div');
            let marginBottom = index < 2 && threadsToDisplayInList.length > index + 1 ? '0px' : '3px';
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

            const titleLink = document.createElement('a');
            titleLink.href = thread.url;
            titleLink.target = '_blank';
            const fullTitle = thread.title;
            titleLink.textContent = truncateTitleWithWordBoundary(fullTitle, 50);
            titleLink.title = fullTitle;
            let titleLinkStyle = `
                color: #e0e0e0;
                text-decoration: none;
                font-weight: bold;
                font-size: 12px;
                margin-bottom: 2px;
                display: block;
                width: 100%;
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
                    console.warn('[OTK Tracker] Timestamp span not found, appended (+n) to title-time container.');
                } else if (textContentDiv) {
                    textContentDiv.appendChild(hoverContainer);
                    console.warn('[OTK Tracker] Title-time container not found, appended (+n) to text content div.');
                } else {
                    threadDisplayContainer.appendChild(hoverContainer);
                    console.warn('[OTK Tracker] Last thread item structure not found, appended (+n) to thread display container.');
                }
            } else {
                moreIndicator.style.marginLeft = '0px';
                moreIndicator.style.paddingLeft = '22px';
                threadDisplayContainer.appendChild(hoverContainer);
            }

            let tooltip = null;
            let tooltipTimeout;

            hoverContainer.addEventListener('mouseenter', () => {
                console.log('[OTK Tracker] hoverContainer mouseenter triggered');
                moreIndicator.style.textDecoration = 'underline';
                if (tooltip) {
                    console.log('[OTK Tracker] Removing existing tooltip');
                    tooltip.remove();
                }

                console.log('[OTK Tracker] Creating new tooltip');
                tooltip = document.createElement('div');
                tooltip.id = 'otk-more-threads-tooltip';
                tooltip.style.cssText = `
                    position: absolute;
                    background-color: #222;
                    border: 1px solid #888;
                    border-radius: 4px;
                    padding: 8px;
                    z-index: 100000;
                    color: white;
                    font-size: 12px;
                    max-width: 300px;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.5);
                    pointer-events: auto;
                    display: block;
                    opacity: 1;
                    border: 2px solid red;
                    transform: translate(0, 0);
                `;

                const additionalThreads = threadDisplayObjects.slice(3);
                additionalThreads.forEach(thread => {
                    const tooltipLink = document.createElement('a');
                    tooltipLink.href = thread.url;
                    tooltipLink.target = '_blank';
                    tooltipLink.textContent = thread.title;
                    tooltipLink.style.cssText = `
                        display: block;
                        color: #d0d0d0;
                        text-decoration: none;
                        padding: 2px 0;
                    `;
                    tooltipLink.onmouseover = () => { tooltipLink.style.color = '#fff'; };
                    tooltipLink.onmouseout = () => { tooltipLink.style.color = '#d0d0d0'; };
                    tooltip.appendChild(tooltipLink);
                });

                document.body.appendChild(tooltip);
                console.log('[OTK Tracker] Tooltip appended to body', tooltip);

                const indicatorRect = moreIndicator.getBoundingClientRect();
                const tooltipRect = tooltip.getBoundingClientRect();
                console.log('[OTK Tracker] Indicator position:', indicatorRect);
                console.log('[OTK Tracker] Tooltip position (initial):', tooltipRect);

                let leftPos = indicatorRect.left;
                let topPos = indicatorRect.bottom + window.scrollY + 2;
                if (leftPos + tooltipRect.width > window.innerWidth) {
                    leftPos = window.innerWidth - tooltipRect.width - 5;
                }
                if (topPos + tooltipRect.height > window.innerHeight + window.scrollY) {
                    console.log('[OTK Tracker] Adjusting tooltip position to above indicator');
                    topPos = indicatorRect.top + window.scrollY - tooltipRect.height - 2;
                }

                tooltip.style.left = `${leftPos}px`;
                tooltip.style.top = `${topPos}px`;
                console.log('[OTK Tracker] Tooltip final position:', { left: leftPos, top: topPos });

                tooltip.addEventListener('mouseenter', () => {
                    console.log('[OTK Tracker] Tooltip mouseenter triggered');
                    if (tooltipTimeout) {
                        clearTimeout(tooltipTimeout);
                        console.log('[OTK Tracker] Cleared tooltip timeout');
                    }
                });

                tooltip.addEventListener('mouseleave', () => {
                    console.log('[OTK Tracker] Tooltip mouseleave triggered');
                    tooltipTimeout = setTimeout(() => {
                        if (
                            tooltip &&
                            !tooltip.matches(':hover') &&
                            !moreIndicator.matches(':hover')
                        ) {
                            console.log('[OTK Tracker] Removing tooltip');
                            tooltip.remove();
                            tooltip = null;
                        }
                    }, 1000);
                });
            });

            hoverContainer.addEventListener('mouseleave', () => {
                console.log('[OTK Tracker] hoverContainer mouseleave triggered');
                moreIndicator.style.textDecoration = 'none';
                tooltipTimeout = setTimeout(() => {
                    if (
                        tooltip &&
                        !tooltip.matches(':hover') &&
                        !moreIndicator.matches(':hover')
                    ) {
                        console.log('[OTK Tracker] Removing tooltip');
                        tooltip.remove();
                        tooltip = null;
                    }
                }, 1000);
            });
        }
    }

    // Scan catalog for OTK threads
    async function scanCatalog() {
        const url = 'https://a.4cdn.org/b/catalog.json';
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Catalog fetch failed: ${response.status}`);
            const catalog = await response.json();

            let foundThreads = [];
            catalog.forEach(page => {
                page.threads.forEach(thread => {
                    let title = thread.sub || '';
                    let com = thread.com || '';
                    if ((title + com).toLowerCase().includes('otk')) {
                        foundThreads.push({
                            id: Number(thread.no),
                            title: title || 'Untitled'
                        });
                    }
                });
            });
            console.log('[OTK Tracker] scanCatalog: Found threads:', foundThreads.map(t => t.id));
            return foundThreads;
        } catch (error) {
            console.error('[OTK Tracker] scanCatalog error:', error);
            return [];
        }
    }

    // Fetch thread messages
    async function fetchThreadMessages(threadId) {
        const url = `https://a.4cdn.org/b/thread/${threadId}.json`;
        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.log(`[OTK Tracker] fetchThreadMessages: Thread ${threadId} not found (likely deleted).`);
                return [];
            }
            const threadData = await response.json();
            if (!threadData.posts) return [];
            return threadData.posts.map(post => {
                const message = {
                    id: post.no,
                    time: post.time,
                    text: post.com ? post.com.replace(/<br>/g, '\n').replace(/<.*?>/g, '') : '',
                    title: threadData.posts[0].sub || 'Untitled',
                    attachment: null
                };
                if (post.filename) {
                    message.attachment = {
                        filename: post.filename,
                        ext: post.ext,
                        tn_w: post.tn_w,
                        tn_h: post.tn_h,
                        tim: post.tim,
                        w: post.w,
                        h: post.h
                    };
                }
                return message;
            });
        } catch (error) {
            console.error(`[OTK Tracker] fetchThreadMessages error for thread ${threadId}:`, error);
            return [];
        }
    }

    // Background refresh
    async function backgroundRefreshThreadsAndMessages() {
        if (isManualRefreshInProgress) {
            console.log('[OTK Tracker BG] Manual refresh in progress, skipping background refresh.');
            return;
        }
        console.log('[OTK Tracker BG] Performing background refresh...');
        try {
            console.log('[OTK Tracker BG] Calling scanCatalog...');
            const foundThreads = await scanCatalog();
            const foundIds = new Set(foundThreads.map(t => Number(t.id)));
            console.log(`[OTK Tracker BG] scanCatalog found ${foundThreads.length} threads:`, foundIds);

            // Store previous active threads for logging
            const previousActiveThreads = [...activeThreads];
            console.log('[OTK Tracker BG] Previous active threads:', previousActiveThreads);

            // Update activeThreads: only keep threads in the catalog
            activeThreads = activeThreads.filter(threadId => {
                const isLive = foundIds.has(Number(threadId));
                if (!isLive) {
                    console.log(`[OTK Tracker BG] Removing thread ${threadId} as it is not in catalog.`);
                    delete messagesByThreadId[threadId];
                    delete threadColors[threadId];
                }
                return isLive;
            });

            // Add new threads
            foundThreads.forEach(t => {
                if (!activeThreads.includes(Number(t.id))) {
                    console.log(`[OTK Tracker BG] Adding new thread ${t.id}`);
                    activeThreads.push(Number(t.id));
                }
            });

            console.log(`[OTK Tracker BG] Active threads after catalog filter: ${activeThreads.length}`, activeThreads);

            // Fetch messages for active threads
            for (const threadId of [...activeThreads]) { // Use a copy to avoid modification issues
                console.log(`[OTK Tracker BG] Fetching messages for thread ${threadId}...`);
                let newMessages = await fetchThreadMessages(threadId);
                console.log(`[OTK Tracker BG] Fetched ${newMessages.length} new messages for thread ${threadId}.`);
                if (newMessages.length > 0) {
                    let existing = messagesByThreadId[threadId] || [];
                    let existingIds = new Set(existing.map(m => m.id));
                    let merged = existing.slice();
                    newMessages.forEach(m => {
                        if (!existingIds.has(m.id)) {
                            merged.push(m);
                            existingIds.add(m.id);
                        }
                    });
                    merged.sort((a, b) => a.time - b.time);
                    messagesByThreadId[threadId] = merged;
                } else {
                    console.log(`[OTK Tracker BG] No messages for thread ${threadId}, removing from active threads.`);
                    activeThreads = activeThreads.filter(id => id !== Number(threadId));
                    delete messagesByThreadId[threadId];
                    delete threadColors[threadId];
                }
            }

            console.log(`[OTK Tracker BG] Final active threads: ${activeThreads.length}`, activeThreads);
            console.log('[OTK Tracker BG] Saving data to localStorage...');
            localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
            localStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesByThreadId));
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
            localStorage.removeItem(DROPPED_THREADS_KEY);
            console.log('[OTK Tracker BG] Data saved. Dispatching otkMessagesUpdated event.');
            window.dispatchEvent(new CustomEvent('otkMessagesUpdated'));
            renderThreadList();
            updateDisplayedStatistics();
            console.log('[OTK Tracker BG] Background refresh complete.');
        } catch (error) {
            console.error('[OTK Tracker BG] Error during background refresh:', error.message, error.stack);
        }
    }

    // Manual refresh
    async function refreshThreadsAndMessages() {
        console.log('[OTK Tracker Manual] Refreshing threads and messages...');
        try {
            const foundThreads = await scanCatalog();
            const foundIds = new Set(foundThreads.map(t => Number(t.id)));
            console.log(`[OTK Tracker Manual] scanCatalog found ${foundThreads.length} threads:`, foundIds);

            // Store previous active threads for logging
            const previousActiveThreads = [...activeThreads];
            console.log('[OTK Tracker Manual] Previous active threads:', previousActiveThreads);

            // Update activeThreads: only keep threads in the catalog
            activeThreads = activeThreads.filter(threadId => {
                const isLive = foundIds.has(Number(threadId));
                if (!isLive) {
                    console.log(`[OTK Tracker Manual] Removing thread ${threadId} as it is not in catalog.`);
                    delete messagesByThreadId[threadId];
                    delete threadColors[threadId];
                }
                return isLive;
            });

            // Add new threads
            foundThreads.forEach(t => {
                if (!activeThreads.includes(Number(t.id))) {
                    console.log(`[OTK Tracker Manual] Adding new thread ${t.id}`);
                    activeThreads.push(Number(t.id));
                    getThreadColor(t.id);
                }
            });

            console.log(`[OTK Tracker Manual] Active threads after catalog filter: ${activeThreads.length}`, activeThreads);

            // Fetch messages for active threads
            for (const threadId of [...activeThreads]) { // Use a copy to avoid modification issues
                console.log(`[OTK Tracker Manual] Fetching messages for thread ${threadId}...`);
                let newMessages = await fetchThreadMessages(threadId);
                console.log(`[OTK Tracker Manual] Fetched ${newMessages.length} new messages for thread ${threadId}.`);
                if (newMessages.length > 0) {
                    let existing = messagesByThreadId[threadId] || [];
                    let existingIds = new Set(existing.map(m => m.id));
                    let merged = existing.slice();
                    newMessages.forEach(m => {
                        if (!existingIds.has(m.id)) {
                            merged.push(m);
                        }
                    });
                    merged.sort((a, b) => a.time - b.time);
                    messagesByThreadId[threadId] = merged;
                } else {
                    console.log(`[OTK Tracker Manual] No messages for thread ${threadId}, removing from active threads.`);
                    activeThreads = activeThreads.filter(id => id !== Number(threadId));
                    delete messagesByThreadId[threadId];
                    delete threadColors[threadId];
                }
            }

            console.log(`[OTK Tracker Manual] Final active threads: ${activeThreads.length}`, activeThreads);
            localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
            localStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesByThreadId));
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
            localStorage.removeItem(DROPPED_THREADS_KEY);
            console.log('[OTK Tracker Manual] Core refresh actions complete.');
            renderThreadList();
            window.dispatchEvent(new CustomEvent('otkMessagesUpdated'));
            updateDisplayedStatistics();
        } catch (error) {
            console.error('[OTK Tracker Manual] Error during core refresh:', error);
        }
    }

    // Clear and refresh
    async function clearAndRefresh() {
        console.log('[OTK Tracker Clear] Clear and Refresh initiated...');
        isManualRefreshInProgress = true;
        try {
            activeThreads = [];
            messagesByThreadId = {};
            threadColors = {};
            localStorage.removeItem(THREADS_KEY);
            localStorage.removeItem(MESSAGES_KEY);
            localStorage.removeItem(COLORS_KEY);
            localStorage.removeItem(DROPPED_THREADS_KEY);

            console.log('[OTK Tracker Clear] LocalStorage cleared. Calling refreshThreadsAndMessages...');
            await refreshThreadsAndMessages();
            console.log('[OTK Tracker Clear] Dispatching otkClearViewerDisplay event.');
            window.dispatchEvent(new CustomEvent('otkClearViewerDisplay'));
            console.log('[OTK Tracker Clear] Clear and Refresh complete.');
        } catch (error) {
            console.error('[OTK Tracker Clear] Error during clear and refresh:', error);
        } finally {
            isManualRefreshInProgress = false;
            console.log('[OTK Tracker Clear] Manual refresh flag reset.');
        }
    }

    // Ensure viewer exists
    function ensureViewerExists() {
        if (!document.getElementById('otk-viewer')) {
            otkViewer = document.createElement('div');
            otkViewer.id = 'otk-viewer';
            document.body.appendChild(otkViewer);
            console.log('[OTK Tracker] Viewer element created.');
        } else {
            otkViewer = document.getElementById('otk-viewer');
            console.log('[OTK Tracker] Viewer element already exists.');
        }

        otkViewer.style.cssText = `
            position: fixed;
            top: 86px;
            left: 0;
            width: 100vw;
            bottom: 0;
            background-color: rgba(30, 30, 30, 0.95);
            z-index: 9998;
            overflow-y: auto;
            box-sizing: border-box;
            color: white;
            padding: 10px;
            border-top: 1px solid #DBDBDC;
            display: none;
        `;
    }

    // Toggle viewer
    function toggleViewer() {
        if (!otkViewer) {
            console.warn('[OTK Tracker] Viewer element not found. Attempting to create.');
            ensureViewerExists();
            if (!otkViewer) {
                console.error('[OTK Tracker] Viewer element could not be initialized.');
                return;
            }
        }

        const isViewerVisible = otkViewer.style.display !== 'none';
        if (isViewerVisible) {
            otkViewer.style.display = 'none';
            document.body.style.overflow = 'auto';
            console.log('[OTK Tracker] Viewer hidden.');
        } else {
            otkViewer.style.display = 'block';
            document.body.style.overflow = 'hidden';
            console.log('[OTK Tracker] Viewer shown.');
        }
    }

    // Update statistics
    function updateDisplayedStatistics() {
        const threadsTrackedElem = document.getElementById('otk-threads-tracked-stat');
        const totalMessagesElem = document.getElementById('otk-total-messages-stat');

        if (threadsTrackedElem && totalMessagesElem) {
            const liveThreadsCount = activeThreads.length;
            let totalMessagesCount = 0;
            for (const threadId in messagesByThreadId) {
                if (messagesByThreadId.hasOwnProperty(threadId) && activeThreads.includes(Number(threadId))) {
                    totalMessagesCount += messagesByThreadId[threadId].length;
                }
            }
            threadsTrackedElem.textContent = `Live Threads: ${liveThreadsCount}`;
            totalMessagesElem.textContent = `Total Messages: ${totalMessagesCount}`;
            console.log(`[OTK Tracker] Statistics updated: Live Threads: ${liveThreadsCount}, Total Messages: ${totalMessagesCount}`);
        } else {
            console.warn('[OTK Tracker] Statistics elements not found.');
        }
    }

    // Button implementations
    const buttonContainer = document.getElementById('otk-button-container');
    if (buttonContainer) {
        function createTrackerButton(text) {
            const button = document.createElement('button');
            button.textContent = text;
            button.style.cssText = `
                padding: 5px 10px;
                cursor: pointer;
                background-color: #555;
                color: white;
                border: 1px solid #777;
                border-radius: 3px;
                font-size: 13px;
            `;
            button.onmouseover = () => button.style.backgroundColor = '#666';
            button.onmouseout = () => button.style.backgroundColor = '#555';
            button.onmousedown = () => button.style.backgroundColor = '#444';
            button.onmouseup = () => button.style.backgroundColor = '#666';
            return button;
        }

        const btnToggleViewer = createTrackerButton('Toggle Viewer');
        btnToggleViewer.addEventListener('click', toggleViewer);
        buttonContainer.appendChild(btnToggleViewer);

        const btnRefresh = createTrackerButton('Refresh Data');
        btnRefresh.addEventListener('click', async () => {
            console.log('[OTK Tracker GUI] "Refresh Data" button clicked.');
            sessionStorage.setItem('otkManualRefreshClicked', 'true');
            btnRefresh.disabled = true;
            isManualRefreshInProgress = true;
            try {
                await refreshThreadsAndMessages();
                console.log('[OTK Tracker GUI] Data refresh complete.');
            } catch (error) {
                console.error('[OTK Tracker GUI] Error during data refresh:', error);
            } finally {
                isManualRefreshInProgress = false;
                btnRefresh.disabled = false;
                console.log('[OTK Tracker GUI] Refresh operation finished.');
            }
        });
        buttonContainer.appendChild(btnRefresh);

        const thirdButtonWrapper = document.createElement('div');
        thirdButtonWrapper.style.cssText = `
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            align-items: stretch;
            height: 100%;
        `;

        const bgUpdateCheckboxContainer = document.createElement('div');
        bgUpdateCheckboxContainer.style.cssText = `
            display: flex;
            align-items: center;
            margin-bottom: 4px;
        `;

        const bgUpdateCheckbox = document.createElement('input');
        bgUpdateCheckbox.type = 'checkbox';
        bgUpdateCheckbox.id = 'otk-disable-bg-update-checkbox';
        bgUpdateCheckbox.style.marginRight = '5px';

        const bgUpdateLabel = document.createElement('label');
        bgUpdateLabel.htmlFor = 'otk-disable-bg-update-checkbox';
        bgUpdateLabel.textContent = 'Disable Background Updates';
        bgUpdateLabel.style.cssText = `
            font-size: 12px;
            color: white;
            white-space: normal;
            overflow-wrap: break-word;
            flex-shrink: 1;
        `;

        bgUpdateCheckboxContainer.appendChild(bgUpdateCheckbox);
        bgUpdateCheckboxContainer.appendChild(bgUpdateLabel);
        thirdButtonWrapper.appendChild(bgUpdateCheckboxContainer);

        const btnClearRefresh = createTrackerButton('Restart Thread Tracker');
        btnClearRefresh.addEventListener('click', async () => {
            console.log('[OTK Tracker GUI] "Restart Thread Tracker" button clicked.');
            btnClearRefresh.disabled = true;
            try {
                await clearAndRefresh();
                console.log('[OTK Tracker GUI] Clear and refresh complete.');
            } catch (error) {
                console.error('[OTK Tracker GUI] Error during clear and refresh:', error);
            } finally {
                btnClearRefresh.disabled = false;
                console.log('[OTK Tracker GUI] Restart operation finished.');
            }
        });
        thirdButtonWrapper.appendChild(btnClearRefresh);
        buttonContainer.appendChild(thirdButtonWrapper);

        // Checkbox functionality
        const isDisabled = localStorage.getItem(BACKGROUND_UPDATES_DISABLED_KEY) === 'true';
        bgUpdateCheckbox.checked = isDisabled;

        if (isDisabled) {
            console.log('[OTK Tracker] Background updates disabled by user preference.');
        } else {
            startBackgroundRefresh();
        }

        bgUpdateCheckbox.addEventListener('change', () => {
            if (bgUpdateCheckbox.checked) {
                stopBackgroundRefresh();
                localStorage.setItem(BACKGROUND_UPDATES_DISABLED_KEY, 'true');
                console.log('[OTK Tracker] Background updates disabled by checkbox.');
            } else {
                startBackgroundRefresh();
                localStorage.setItem(BACKGROUND_UPDATES_DISABLED_KEY, 'false');
                console.log('[OTK Tracker] Background updates enabled by checkbox.');
            }
        });
    } else {
        console.error('[OTK Tracker] Button container not found.');
    }

    // Background refresh control
    function startBackgroundRefresh() {
        if (backgroundRefreshIntervalId) {
            clearInterval(backgroundRefreshIntervalId);
        }
        backgroundRefreshIntervalId = setInterval(backgroundRefreshThreadsAndMessages, BACKGROUND_REFRESH_INTERVAL);
        console.log(`[OTK Tracker] Background refresh scheduled every ${BACKGROUND_REFRESH_INTERVAL / 1000} seconds.`);
    }

    function stopBackgroundRefresh() {
        if (backgroundRefreshIntervalId) {
            clearInterval(backgroundRefreshIntervalId);
            backgroundRefreshIntervalId = null;
            console.log('[OTK Tracker] Background refresh stopped.');
        }
    }

    // Initial actions
    renderThreadList();
    updateDisplayedStatistics();
})();
