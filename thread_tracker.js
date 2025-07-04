// ==UserScript==
// @name         Thread Tracker
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Tracks OTK threads on /b/, stores messages, shows top bar with colors and controls
// @match        https://boards.4chan.org/b/
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Constants for storage keys
    const THREADS_KEY = 'otkActiveThreads';
    const MESSAGES_KEY = 'otkMessagesByThreadId';
    const COLORS_KEY = 'otkThreadColors';

// === GLOBAL VARIABLES ===
    let otkViewer = null;  // ✅ fixes the ReferenceError
    let backgroundRefreshIntervalId = null;
    let isManualRefreshInProgress = false;
    const BACKGROUND_REFRESH_INTERVAL = 3000 * 50000; // 50 minute

    // Color palette for squares
    const COLORS = [
        '#e6194B', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
        '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
        '#008080', '#e6beff', '#9A6324', '#fffac8', '#800000',
        '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080'
    ];

    // REMOVED GUI ELEMENT CREATION AND STYLING FOR:
    // bar, topRow, bottomRow, threadList, trackerText,
    // btnToggleViewer, btnRefresh, btnClearRefresh

    // Create the GUI structure
    let otkGuiWrapper = document.getElementById('otk-tracker-gui-wrapper');
    let otkGui = document.getElementById('otk-tracker-gui'); // Keep this check for the inner bar

    if (!otkGuiWrapper) {
        otkGuiWrapper = document.createElement('div');
        otkGuiWrapper.id = 'otk-tracker-gui-wrapper';
        otkGuiWrapper.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw; /* Explicitly set width to viewport width */
            /* right: 0; */ /* Replaced by width: 100vw */
            z-index: 9999;
            border-bottom: 1px solid grey; /* Grey line is now on the wrapper */
            background: black; /* Background color for the entire bar area including border space */
            box-sizing: border-box; /* Ensure padding/border included in 100vw if any were on wrapper */
        `;

        otkGui = document.createElement('div'); // Create inner otkGui
        otkGui.id = 'otk-tracker-gui';
        otkGui.style.cssText = `
            height: 85px; /* Height of the content area - Increased slightly */
            color: white; /* Default text color for children */
            font-family: Verdana, sans-serif; /* Default font */
            font-size: 14px; /* Default font size */
            padding: 5px 25px; /* Increased right padding, kept top/bottom and left */
            box-sizing: border-box;
            display: flex;
            align-items: stretch;
            /* justify-content: space-between; */ /* Removed to allow center column to grow */
            user-select: none;
            /* background: black;شفاف if wrapper has it, or same color */
        `;
        otkGuiWrapper.appendChild(otkGui);
        document.body.style.paddingTop = '86px'; // 85px for otkGui + 1px for wrapper's border
        document.body.insertBefore(otkGuiWrapper, document.body.firstChild);

        // Create thread display container on the left, inside otkGui
        const threadDisplayContainer = document.createElement('div');
        threadDisplayContainer.id = 'otk-thread-display-container';
        threadDisplayContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            justify-content: flex-start; /* Align thread items to the top */
            padding-top: 3px; /* Reduced space from top of bar */
            padding-bottom: 5px; /* Space at the bottom of the thread list area */
            max-width: 300px; /* Control horizontal spread */
            flex-grow: 0; /* Do not grow, let center column take space */
            flex-shrink: 0; /* Do not shrink past content width */
            justify-content: center; /* Vertically center the items if space allows */
            /* border: 1px dashed yellow; */ /* For debugging layout */
            /* overflow-y: auto; */ /* Re-evaluate if needed after testing */
            /* max-height: calc(100% - 8px); */ /* (padding-top + padding-bottom) */
        `;
        otkGui.appendChild(threadDisplayContainer);

        // Create Center Info Container
        const centerInfoContainer = document.createElement('div');
        centerInfoContainer.id = 'otk-center-info-container';
        centerInfoContainer.style.cssText = `
            flex-grow: 1; /* Takes up space between left and right containers */
            display: flex;
            flex-direction: column;
            align-items: center; /* Centers its children (title, stats) horizontally */
            justify-content: space-between; /* Push title to top, stats to bottom */
            color: white; /* Default text color */
            text-align: center;
            padding: 0 10px; /* Horizontal padding for text content */
            /* border: 1px dashed orange; */ /* For layout debugging */
        `;

        // Create title display
        const otkThreadTitleDisplay = document.createElement('div');
        otkThreadTitleDisplay.id = 'otk-thread-title-display';
        otkThreadTitleDisplay.textContent = 'Thread Tracker 2.0'; // Updated text
        otkThreadTitleDisplay.style.cssText = `
            font-weight: bold;
            font-size: 14px;
            margin-bottom: 4px;
        `;

        // Create stats display container
        const otkStatsDisplay = document.createElement('div');
        otkStatsDisplay.id = 'otk-stats-display';
        otkStatsDisplay.style.cssText = `
            font-size: 11px;
            display: flex;
            flex-direction: column; /* Stats stacked vertically */
            align-items: center;
            /* margin-top: 4px; */ /* Adjusted later for alignment */
        `;

        const threadsTrackedStat = document.createElement('span');
        threadsTrackedStat.id = 'otk-threads-tracked-stat';
        threadsTrackedStat.textContent = 'Live Threads: 0'; // Updated Placeholder

        const totalMessagesStat = document.createElement('span');
        totalMessagesStat.id = 'otk-total-messages-stat';
        totalMessagesStat.textContent = 'Total Messages: 0'; // Placeholder
        // totalMessagesStat.style.marginTop = '2px'; // Small gap if stats are stacked

        otkStatsDisplay.appendChild(threadsTrackedStat);
        otkStatsDisplay.appendChild(totalMessagesStat);

        centerInfoContainer.appendChild(otkThreadTitleDisplay);
        centerInfoContainer.appendChild(otkStatsDisplay);

        otkGui.appendChild(centerInfoContainer); // Add center container to otkGui

        // Create a container for buttons on the right side
        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'otk-button-container';
        buttonContainer.style.cssText = `
            display: flex;
            align-items: flex-end; /* Align items (buttons and wrapper) to their bottom edges */
            gap: 10px; /* Space between buttons */
            /* align-self: flex-end; */ /* REMOVED - Let it stretch vertically within otkGui */
            /* padding-bottom: 5px; */ /* REMOVED - Rely on otkGui's own padding */
            /* border: 1px dashed cyan; */ /* For debugging layout */
        `;
        otkGui.appendChild(buttonContainer);

    } else { // otkGuiWrapper already exists
        // Ensure body padding is correct
        if (document.body.style.paddingTop !== '86px') {
            document.body.style.paddingTop = '86px'; // Adjusted padding
        }

        // Ensure otkGui (the inner bar) exists within the wrapper
        if (!otkGui) { // If inner otkGui is missing from wrapper
            otkGui = document.createElement('div');
            otkGui.id = 'otk-tracker-gui';
            // Apply its standard styles (copy from above or refactor to a function)
            otkGui.style.cssText = `
                height: 85px; color: white; font-family: Verdana, sans-serif; font-size: 14px; /* Increased height */
                padding: 5px 25px; /* Increased right padding */ box-sizing: border-box; display: flex;
                align-items: stretch; /* justify-content: space-between; */ user-select: none; /* Removed for center col */
            `;
            otkGuiWrapper.appendChild(otkGui); // Append to existing wrapper
        }

        // Ensure thread display container is present inside otkGui
        if (!document.getElementById('otk-thread-display-container')) {
            const threadDisplayContainer = document.createElement('div');
            threadDisplayContainer.id = 'otk-thread-display-container';
            threadDisplayContainer.style.cssText = `
                display: flex; flex-direction: column; justify-content: flex-start;
                padding-top: 3px; /* Reduced */ padding-bottom: 5px;
                max-width: 300px; /* Added */
                flex-grow: 0; /* Do not grow */
                flex-shrink: 0; /* Do not shrink */
                justify-content: center; /* Vertically center the items if space allows */
                /* overflow-y: auto; */ /* Re-evaluate if needed after testing */
                /* max-height: calc(100% - 8px); */
            `;
            const existingButtonContainer = otkGui.querySelector('#otk-button-container'); // Query within otkGui
            if (existingButtonContainer) {
                otkGui.insertBefore(threadDisplayContainer, existingButtonContainer);
            } else {
                otkGui.appendChild(threadDisplayContainer);
            }
        }

        // Ensure center info container is present inside otkGui
        if (!document.getElementById('otk-center-info-container')) {
            const centerInfoContainer = document.createElement('div');
            centerInfoContainer.id = 'otk-center-info-container';
            centerInfoContainer.style.cssText = `
                flex-grow: 1; display: flex; flex-direction: column;
                align-items: center; justify-content: space-between; /* Align title top, stats bottom */
                color: white; text-align: center; padding: 0 10px;
            `;

            const otkThreadTitleDisplay = document.createElement('div');
            otkThreadTitleDisplay.id = 'otk-thread-title-display';
            otkThreadTitleDisplay.textContent = 'Thread Tracker'; // Updated text
            otkThreadTitleDisplay.style.cssText = `font-weight: bold; font-size: 14px; margin-bottom: 4px;`;

            const otkStatsDisplay = document.createElement('div');
            otkStatsDisplay.id = 'otk-stats-display';
            otkStatsDisplay.style.cssText = `font-size: 11px; display: flex; flex-direction: column; align-items: center;`;

            const threadsTrackedStat = document.createElement('span');
            threadsTrackedStat.id = 'otk-threads-tracked-stat';
            threadsTrackedStat.textContent = 'Live Threads: 0'; // Updated Placeholder

            const totalMessagesStat = document.createElement('span');
            totalMessagesStat.id = 'otk-total-messages-stat';
            totalMessagesStat.textContent = 'Total Messages: 0'; // Placeholder

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

        // Ensure button container is present inside otkGui
        if (!document.getElementById('otk-button-container')) {
            const buttonContainer = document.createElement('div');
            buttonContainer.id = 'otk-button-container';
            buttonContainer.style.cssText = `
                display: flex; align-items: center; gap: 10px;
                align-self: flex-end; padding-bottom: 5px;
            `;
            otkGui.appendChild(buttonContainer);
        }
    }

    ensureViewerExists(); // Create or get reference to the viewer element

    // Load from localStorage or initialize
    let activeThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
    let messagesByThreadId = JSON.parse(localStorage.getItem(MESSAGES_KEY)) || {};
    let threadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};
    let droppedThreadIds = new Set(JSON.parse(localStorage.getItem('otkDroppedThreadIds')) || []); // Persist dropped IDs

    // Utility to decode HTML entities
    function decodeEntities(encodedString) {
        const txt = document.createElement('textarea');
        txt.innerHTML = encodedString;
        return txt.value;
    }

    // Utility to truncate title at word boundary
    function truncateTitleWithWordBoundary(title, maxLength) {
        if (title.length <= maxLength) {
            return title;
        }
        // Try to find the last space within the maxLength
        let truncated = title.substr(0, maxLength);
        let lastSpace = truncated.lastIndexOf(' ');

        if (lastSpace > 0 && lastSpace > maxLength - 20) { // Ensure the space is reasonably close to maxLength
            return truncated.substr(0, lastSpace) + '...';
        } else {
            // If no space found or space is too early, just hard truncate and add ellipsis
            return title.substr(0, maxLength - 3) + '...';
        }
    }

    // Get unique color for thread, or assign new
    function getThreadColor(threadId) {
        if (!threadColors[threadId]) {
            const usedColors = new Set(Object.values(threadColors));
            const availableColors = COLORS.filter(c => !usedColors.has(c));
            threadColors[threadId] = availableColors.length ? availableColors[0] : '#888';
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
        }
        return threadColors[threadId];
    }

    // Render threads in black bar left side
    function renderThreadList() {
        const threadDisplayContainer = document.getElementById('otk-thread-display-container');
        if (!threadDisplayContainer) {
            console.error('[OTK Tracker] Thread display container not found. Cannot render thread list.');
            return;
        }

        // Clear any existing threads from the display
        threadDisplayContainer.innerHTML = '';
        console.log('[OTK Tracker] renderThreadList: Cleared thread display container.');

        // Step 3 (Data Preparation) and Step 4 (Display Logic) will be implemented progressively.
        // For now, we'll just log the intent.

        // Simulate data that will be prepared (actual logic in next step)
        // const threadsToDisplay = prepareThreadsForDisplay(); // Placeholder for next step

        if (activeThreads.length === 0) {
            // Optionally, display a message like "No active threads."
            // const noThreadsMsg = document.createElement('div');
            // noThreadsMsg.textContent = 'No active OTK threads being tracked.';
            // noThreadsMsg.style.padding = '5px 0';
            // noThreadsMsg.style.fontSize = '12px';
            // noThreadsMsg.style.fontStyle = 'italic';
            // threadDisplayContainer.appendChild(noThreadsMsg);
            console.log('[OTK Tracker] renderThreadList: No active threads to display.');
            return;
        }

        // --- Data Preparation for Display ---
        const threadDisplayObjects = activeThreads.map(threadId => {
            const messages = messagesByThreadId[threadId] || [];
            let title = 'Untitled Thread';
            let firstMessageTime = null;
            let originalThreadUrl = `https://boards.4chan.org/b/thread/${threadId}`; // Default URL

            if (messages.length > 0) {
                // Title from the OP of the thread (all messages in a thread share the same OP title)
                title = messages[0].title ? decodeEntities(messages[0].title) : `Thread ${threadId}`;
                firstMessageTime = messages[0].time; // Unix timestamp (seconds)
            } else {
                 // If no messages, try to get title from scanCatalog results if it was stored more directly
                 // This part depends on how scanCatalog and activeThreads are populated.
                 // For now, if no messages, it remains "Untitled Thread" or we could try to find it.
                 // Let's assume for now that if it's in activeThreads, it should have messages or will soon.
            }

            return {
                id: threadId,
                title: title,
                firstMessageTime: firstMessageTime, // Could be null if no messages
                color: getThreadColor(threadId), // Ensure color is assigned
                url: originalThreadUrl
            };
        }).filter(thread => thread.firstMessageTime !== null); // Ensure we only try to display threads with a known time

        // Sort threads by firstMessageTime, newest first
        threadDisplayObjects.sort((a, b) => b.firstMessageTime - a.firstMessageTime);

        console.log(`[OTK Tracker] renderThreadList: Prepared ${threadDisplayObjects.length} total threads (including potentially dropped) for display logic.`);

        // Filter out dropped threads for the main display list, but keep them for the (+n) indicator and its tooltip
        const displayableActiveThreads = threadDisplayObjects.filter(thread => !droppedThreadIds.has(thread.id));

        console.log(`[OTK Tracker] renderThreadList: ${displayableActiveThreads.length} non-dropped threads available for main list.`);

        // --- Display Logic for Top 3 Non-Dropped Threads ---
        const threadsToDisplayInList = displayableActiveThreads.slice(0, 3);

        threadsToDisplayInList.forEach((thread, index) => {
            const threadItemDiv = document.createElement('div');
            let marginBottom = '3px'; // Default margin-bottom for the last item or if it's the only item.

            // New logic for 3 items: items 0 and 1 (i.e., index < 2) get 0px margin-bottom if the next item exists.
            // Item 2 (index === 2) will get the default '3px' margin.
            if (index < 2 && threadsToDisplayInList.length > (index + 1)) {
                 marginBottom = '0px';
            }


            threadItemDiv.style.cssText = `
                display: flex; /* For colored box and text content side-by-side */
                align-items: flex-start; /* Align items to the top of their flex line */
                padding: 4px; /* Reduced padding */
                /* border: 1px solid #777; */ /* Border removed */
                border-radius: 3px; /* Keep radius for potential future background/border */
                margin-bottom: ${marginBottom}; /* Dynamically set margin */
                /* background-color: #333; */ /* Removed background color */
            `;

            // Colored Box
            const colorBox = document.createElement('div');
            colorBox.style.cssText = `
                width: 12px; /* Reduced size */
                height: 12px; /* Reduced size */
                background-color: ${thread.color};
                border-radius: 2px;
                margin-right: 6px; /* Slightly reduced margin */
                flex-shrink: 0; /* Prevent shrinking */
                margin-top: 1px; /* Adjust for new font/box size alignment */
            `;
            threadItemDiv.appendChild(colorBox);

            // Text Content Container (for title and timestamp)
            const textContentDiv = document.createElement('div');
            textContentDiv.style.display = 'flex';
            textContentDiv.style.flexDirection = 'column';

            // Thread Title (Link)
            const titleLink = document.createElement('a');
            titleLink.href = thread.url;
            titleLink.target = '_blank';
            // Truncate displayed title and set full title as tooltip
            const fullTitle = thread.title;
            titleLink.textContent = truncateTitleWithWordBoundary(fullTitle, 50);
            titleLink.title = fullTitle; // Use title attribute for native tooltip

            let titleLinkStyle = `
                color: #e0e0e0;
                text-decoration: none;
                font-weight: bold;
                font-size: 12px; /* Reduced font size */
                margin-bottom: 2px; /* Reduced space between title and timestamp */
                display: block; /* Needed for text-overflow */
                width: 100%; /* Take full width of parent textContentDiv */
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            `;

            // Timestamp
            const time = new Date(thread.firstMessageTime * 1000);
            // Format to "Time" e.g., [11:35 PM]
            const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            // const dateStr = time.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' }); // Date removed
            const formattedTimestamp = `[${timeStr}]`; // Only time
            const timestampSpan = document.createElement('span');
            timestampSpan.textContent = formattedTimestamp;
            let timestampSpanStyle = `
                font-size: 10px; /* Reduced font size */
                color: #aaa;
                margin-left: 5px; /* Space between title and time */
            `;

            // Title and time will be in a flex container to sit side-by-side
            const titleTimeContainer = document.createElement('div');
            titleTimeContainer.style.display = 'flex';
            titleTimeContainer.style.alignItems = 'baseline'; // Align baseline of title and time

            // Strikethrough for dropped threads is removed from main list rendering.
            // It's still applied in the tooltip for the (+n) indicator.
            // if (droppedThreadIds.has(thread.id)) {
            //     titleLinkStyle += `text-decoration: line-through; color: #999;`;
            //     timestampSpanStyle += `text-decoration: line-through; color: #777;`;
            //     titleLink.style.setProperty('text-decoration-color', '#777', 'important'); // Ensure strikethrough is visible
            // }

            titleLink.style.cssText = titleLinkStyle;
            timestampSpan.style.cssText = timestampSpanStyle;

            titleLink.onmouseover = () => {
                // Underline on hover is always applied for non-dropped (visible) items.
                titleLink.style.textDecoration = 'underline';
            };
            titleLink.onmouseout = () => {
                titleLink.style.textDecoration = 'none';
            };

            titleTimeContainer.appendChild(titleLink);
            titleTimeContainer.appendChild(timestampSpan);

            textContentDiv.appendChild(titleTimeContainer); // Add the container

            threadItemDiv.appendChild(textContentDiv);
            threadDisplayContainer.appendChild(threadItemDiv);
        });

        if (threadDisplayObjects.length > 0 && threadsToDisplayInList.length === 0 && activeThreads.length > 0) {
            // This case should ideally not happen if filter in data prep is correct
             console.log('[OTK Tracker] renderThreadList: No threads to display in list, but activeThreads exist. This might indicate all threads lacked message times.');
        } else if (threadsToDisplayInList.length > 0) {
            console.log(`[OTK Tracker] Rendered ${threadsToDisplayInList.length} thread items.`);
        }

        // --- Handle More Than 3 Threads ((+n) indicator) ---
        if (threadDisplayObjects.length > 3) { // Changed condition to > 3
            const numberOfAdditionalThreads = threadDisplayObjects.length - 3; // Adjusted calculation
            const moreIndicator = document.createElement('div');
            moreIndicator.id = 'otk-more-threads-indicator';
            moreIndicator.textContent = `(+${numberOfAdditionalThreads})`;
            moreIndicator.style.cssText = `
                font-size: 12px;
                color: #ccc;
                font-style: italic;
                cursor: pointer;
                padding: 3px 6px; /* Similar padding to thread items for consistency */
                /* margin-left: 23px; */ /* Removed, will be appended differently */
                margin-left: 8px; /* Space it from the preceding item (timestamp) */
                display: inline; /* To flow after the timestamp */
                /* border: 1px solid #555; */ /* Optional: if it needs its own border */
                /* border-radius: 3px; */
            `;
            moreIndicator.onmouseover = () => moreIndicator.style.textDecoration = 'underline';
            moreIndicator.onmouseout = () => moreIndicator.style.textDecoration = 'none';

            let tooltip = null; // To hold the tooltip element

            moreIndicator.addEventListener('mouseenter', (event) => {
                if (tooltip) tooltip.remove(); // Remove existing tooltip if any

                tooltip = document.createElement('div');
                tooltip.id = 'otk-more-threads-tooltip';
                tooltip.style.cssText = `
                    position: absolute;
                    background-color: #222;
                    border: 1px solid #888;
                    border-radius: 4px;
                    padding: 8px;
                    z-index: 10000; /* Above other GUI elements */
                    color: white;
                    font-size: 12px;
                    max-width: 300px; /* Prevent overly wide tooltips */
                    box-shadow: 0 2px 5px rgba(0,0,0,0.5);
                `;

                const additionalThreads = threadDisplayObjects.slice(3); // Adjusted slice index
                additionalThreads.forEach(thread => {
                    const tooltipLink = document.createElement('a');
                    tooltipLink.href = thread.url;
                    tooltipLink.target = '_blank';
                    tooltipLink.textContent = thread.title;
                    let tooltipLinkStyle = `
                        display: block;
                        color: #d0d0d0;
                        text-decoration: none;
                        padding: 2px 0;
                    `;
                    if (droppedThreadIds.has(thread.id)) {
                        tooltipLinkStyle += `text-decoration: line-through; color: #999;`;
                    }
                    tooltipLink.style.cssText = tooltipLinkStyle;

                    tooltipLink.onmouseover = () => {
                        if (!droppedThreadIds.has(thread.id)) tooltipLink.style.color = '#fff';
                    };
                    tooltipLink.onmouseout = () => {
                        if (!droppedThreadIds.has(thread.id)) tooltipLink.style.color = '#d0d0d0';
                        else tooltipLink.style.color = '#999'; // Keep struck-through color
                    };
                    tooltip.appendChild(tooltipLink);
                });

                document.body.appendChild(tooltip); // Append to body to avoid clipping issues

                // Position tooltip relative to the indicator
                const indicatorRect = moreIndicator.getBoundingClientRect();
                tooltip.style.left = `${indicatorRect.left}px`;
                tooltip.style.top = `${indicatorRect.bottom + 2}px`; // Position below the indicator

                // Adjust if tooltip goes off-screen
                const tooltipRect = tooltip.getBoundingClientRect();
                if (tooltipRect.right > window.innerWidth) {
                    tooltip.style.left = `${window.innerWidth - tooltipRect.width - 5}px`;
                }
                if (tooltipRect.bottom > window.innerHeight) {
                    tooltip.style.top = `${indicatorRect.top - tooltipRect.height - 2}px`; // Position above
                }
            });

            moreIndicator.addEventListener('mouseleave', () => {
                if (tooltip) {
                    // Delayed removal to allow mouse to move into tooltip if needed, though simple removal is often fine
                    setTimeout(() => {
                        if (tooltip && !tooltip.matches(':hover')) { // Check if mouse isn't over tooltip itself
                            tooltip.remove();
                            tooltip = null;
                        }
                    }, 100); // Short delay
                }
            });

            // Tooltip should also hide if mouse leaves it
            if (tooltip) { // This event listener needs to be on the tooltip itself, after it's created
                 // This logic is tricky because tooltip is recreated. Better to handle removal on indicator's mouseleave.
            }

            // Append the moreIndicator
            if (threadsToDisplayInList.length > 0) {
                // Append to the titleTimeContainer of the last displayed thread item
                const lastThreadItemDiv = threadDisplayContainer.lastChild; // This assumes it's the last one
                if (lastThreadItemDiv && lastThreadItemDiv.querySelector) { // Check if lastChild is an element and has querySelector
                    const titleTimeContainerOfLastItem = lastThreadItemDiv.querySelector('div > div'); // Path to titleTimeContainer
                    if (titleTimeContainerOfLastItem) {
                        titleTimeContainerOfLastItem.appendChild(moreIndicator);
                    } else {
                        threadDisplayContainer.appendChild(moreIndicator); // Fallback
                    }
                } else {
                     threadDisplayContainer.appendChild(moreIndicator); // Fallback
                }
            } else {
                // If no threads are displayed in the list (e.g., all are dropped), append to container directly
                // but ensure its style is appropriate (e.g., not a huge margin-left if it's the only thing)
                moreIndicator.style.marginLeft = '0px'; // Reset margin if it's the only item
                moreIndicator.style.paddingLeft = '23px'; // Re-add padding to align with where titles would start
                threadDisplayContainer.appendChild(moreIndicator);
            }
        }
    }

    // Scan catalog for threads with "OTK" (case-insensitive)
    async function scanCatalog() {
        const url = 'https://a.4cdn.org/b/catalog.json';
        const response = await fetch(url);
        const catalog = await response.json();

        let foundThreads = [];
        catalog.forEach(page => {
            page.threads.forEach(thread => {
                // Look for "OTK" in title or comment (case-insensitive)
                let title = thread.sub || '';
                let com = thread.com || '';
                if ((title + com).toLowerCase().includes('otk')) {
                    foundThreads.push({
                        id: thread.no,
                        title: title || 'Untitled'
                    });
                }
            });
        });
        return foundThreads;
    }

    // Fetch messages for a thread by JSON API
    async function fetchThreadMessages(threadId) {
        const url = `https://a.4cdn.org/b/thread/${threadId}.json`;
        const response = await fetch(url);
        if (!response.ok) return [];
        const threadData = await response.json();
        if (!threadData.posts) return [];
        // Map posts to simpler message objects
        return threadData.posts.map(post => {
            const message = {
                id: post.no,
                time: post.time,
                text: post.com ? post.com.replace(/<br>/g, '\n').replace(/<.*?>/g, '') : '',
                title: threadData.posts[0].sub || 'Untitled', // Title from the OP for all messages in thread
                attachment: null
            };
            if (post.filename) { // Check if filename exists, indicating an attachment
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
    }

async function backgroundRefreshThreadsAndMessages() {
    if (isManualRefreshInProgress) {
        console.log('[OTK Tracker BG] Manual refresh in progress, skipping background refresh.');
        return;
    }
    console.log('[OTK Tracker BG] Performing background refresh...'); // LOG A
    try {
        // --- Add logs around major operations ---
        console.log('[OTK Tracker BG] Calling scanCatalog...'); // LOG B1
        const foundThreads = await scanCatalog();
        console.log(`[OTK Tracker BG] scanCatalog found ${foundThreads.length} threads.`); // LOG B2
        const foundIds = new Set(foundThreads.map(t => t.id));

        foundThreads.forEach(t => {
            if (!activeThreads.includes(t.id)) {
                activeThreads.push(t.id);
            }
        });

        activeThreads = activeThreads.filter(threadId => {
            const stillInCatalog = foundIds.has(threadId);
            const hasMessages = messagesByThreadId[threadId] && messagesByThreadId[threadId].length > 0;
            return stillInCatalog || hasMessages;
        });
        console.log(`[OTK Tracker BG] Active threads count after catalog scan: ${activeThreads.length}`); // LOG C

        for (const threadId of activeThreads) {
            console.log(`[OTK Tracker BG] Fetching messages for thread ${threadId}...`); // LOG D1
            let newMessages = await fetchThreadMessages(threadId);
            console.log(`[OTK Tracker BG] Fetched ${newMessages.length} new messages for thread ${threadId}.`); // LOG D2
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
            }
        }

        console.log('[OTK Tracker BG] Saving data to localStorage...'); // LOG E1
        localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
        localStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesByThreadId));
        console.log('[OTK Tracker BG] Data saved. Dispatching otkMessagesUpdated event.'); // LOG E2
        // Colors are NOT updated by background refresh

        window.dispatchEvent(new CustomEvent('otkMessagesUpdated'));
        updateDisplayedStatistics(); // Update stats

        console.log('[OTK Tracker BG] Background refresh complete.'); // LOG F
    } catch (error) {
        console.error('[OTK Tracker BG] Error during background refresh:', error.message, error.stack); // Enhanced error log
    }
}

    // Refresh threads and messages without clearing storage
async function refreshThreadsAndMessages() {
    console.log('[OTK Tracker Manual] Refreshing threads and messages (core logic)...');
    try {
        const foundThreads = await scanCatalog();
        let foundIds = foundThreads.map(t => t.id);

        foundThreads.forEach(t => {
            if (!activeThreads.includes(t.id)) {
                activeThreads.push(t.id);
                getThreadColor(t.id); // Assign color if new thread
            }
        });

        const previousActiveThreads = new Set(activeThreads);
        activeThreads = activeThreads.filter(tid => {
            const isStillInCatalog = foundIds.includes(tid);
            const hasMessages = messagesByThreadId[tid] && messagesByThreadId[tid].length > 0;
            if (previousActiveThreads.has(tid) && !isStillInCatalog && hasMessages) {
                droppedThreadIds.add(tid); // Thread was active, had messages, but is no longer in catalog
            } else if (isStillInCatalog && droppedThreadIds.has(tid)) {
                droppedThreadIds.delete(tid); // Thread re-appeared
            }
            return isStillInCatalog || hasMessages;
        });

        for (const threadId of activeThreads) {
            // If a thread becomes active again and was previously dropped, remove from dropped set
            if (foundIds.includes(threadId) && droppedThreadIds.has(threadId)) {
                droppedThreadIds.delete(threadId);
            }
            let newMessages = await fetchThreadMessages(threadId);
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
            }
        }

        localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
        localStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesByThreadId));
        localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
        localStorage.setItem('otkDroppedThreadIds', JSON.stringify(Array.from(droppedThreadIds))); // Save dropped IDs

        renderThreadList();
        window.dispatchEvent(new CustomEvent('otkMessagesUpdated'));
        updateDisplayedStatistics(); // Update stats
        console.log('[OTK Tracker Manual] Core refresh actions complete.');
    } catch (error) {
        console.error('[OTK Tracker Manual] Error during core refresh:', error);
    }
}

    // Clear all data and refresh fully
async function clearAndRefresh() {
    console.log('[OTK Tracker Clear] Clear and Refresh initiated...');
    isManualRefreshInProgress = true;
    try {
        activeThreads = [];
        messagesByThreadId = {};
        threadColors = {};
        droppedThreadIds.clear(); // Clear the set
        localStorage.removeItem(THREADS_KEY);
        localStorage.removeItem(MESSAGES_KEY);
        localStorage.removeItem(COLORS_KEY);
        localStorage.removeItem('otkDroppedThreadIds'); // Clear stored dropped IDs

        console.log('[OTK Tracker Clear] LocalStorage cleared, including droppedThreadIds. Calling refreshThreadsAndMessages...');
        await refreshThreadsAndMessages();

        // Dispatch an event for the viewer to clear its display
        console.log('[OTK Tracker Clear] Dispatching otkClearViewerDisplay event.');
        window.dispatchEvent(new CustomEvent('otkClearViewerDisplay'));

        // renderThreadList is called by refreshThreadsAndMessages. If an extra one is needed, it can be added.
        // The current refreshThreadsAndMessages calls renderThreadList() and also getThreadColor for new threads.
        console.log('[OTK Tracker Clear] Clear and Refresh complete.');
    } catch (error) {
        console.error('[OTK Tracker Clear] Error during clear and refresh:', error);
    } finally {
        isManualRefreshInProgress = false;
        console.log('[OTK Tracker Clear] Manual refresh flag reset by clearAndRefresh.');
    }
}

    // Button event handlers
    // REMOVED: Event listeners for btnToggleViewer, btnRefresh, btnClearRefresh
    // These will be re-added with the new GUI structure.

// Ensures the viewer element exists and is styled correctly
function ensureViewerExists() {
    if (!document.getElementById('otk-viewer')) {
        otkViewer = document.createElement('div');
        otkViewer.id = 'otk-viewer';
        document.body.appendChild(otkViewer);
        console.log('[OTK Tracker] Viewer element created.');
    } else {
        otkViewer = document.getElementById('otk-viewer');
        console.log('[OTK Tracker] Viewer element already exists, using reference.');
    }

    // Apply styles
    otkViewer.style.position = 'fixed';
    otkViewer.style.top = '86px';
    otkViewer.style.left = '0';
    otkViewer.style.width = '100vw';
    otkViewer.style.bottom = '0';
    otkViewer.style.backgroundColor = 'rgba(30, 30, 30, 0.95)';
    otkViewer.style.zIndex = '9998';
    otkViewer.style.overflowY = 'auto';
    otkViewer.style.boxSizing = 'border-box';
    otkViewer.style.color = 'white';
    otkViewer.style.padding = '10px';
    otkViewer.style.borderTop = '1px solid #DBDBDC';
    otkViewer.style.display = 'none';
} // End ensureViewerExists


// Toggles the visibility of the viewer
function toggleViewer() {
    if (!otkViewer) {
        console.warn('[OTK Tracker] Viewer element not found for toggle. Attempting to create.');
        ensureViewerExists();
        if (!otkViewer) {
            console.error('[OTK Tracker] Viewer element could not be initialized. Toggle failed.');
            return;
        }
    }

    const isViewerVisible = otkViewer.style.display !== 'none';

    if (isViewerVisible) {
        otkViewer.style.display = 'none';
        document.body.style.overflow = 'auto'; // Restore scroll
        console.log('[OTK Tracker] Viewer hidden.');
    } else {
        otkViewer.style.display = 'block';
        document.body.style.overflow = 'hidden'; // Prevent background scroll
        console.log('[OTK Tracker] Viewer shown.');
        // TODO: Add logic here to populate/refresh viewer content when shown
    }
}

/* Duplicated style block removed by agent. Original content was:
    otkViewer.style.top = '86px';
    otkViewer.style.left = '0';
    otkViewer.style.width = '100vw';
    otkViewer.style.bottom = '0';
    otkViewer.style.backgroundColor = 'rgba(30, 30, 30, 0.95)';
    otkViewer.style.zIndex = '9998';
    otkViewer.style.overflowY = 'auto';
    otkViewer.style.boxSizing = 'border-box';
    otkViewer.style.color = 'white';
    otkViewer.style.padding = '10px';
    otkViewer.style.borderTop = '1px solid #DBDBDC';
    otkViewer.style.display = 'none';
*/  // ✅ comment ends here

function toggleViewer() {
    if (!otkViewer) {
        console.warn('[OTK Tracker] Viewer element not found for toggle. Attempting to create.');
        ensureViewerExists(); // Attempt to create/initialize if not present
        if (!otkViewer) { // If still not available after attempt
            console.error('[OTK Tracker] Viewer element could not be initialized. Toggle failed.');
            return;
        }
    }

    const isViewerVisible = otkViewer.style.display !== 'none';

    if (isViewerVisible) {
        otkViewer.style.display = 'none';
        document.body.style.overflow = 'auto'; // Restore body scroll
        console.log('[OTK Tracker] Viewer hidden.');
    } else {
        otkViewer.style.display = 'block'; // Show viewer (use 'block' or 'flex' as appropriate for content)
        document.body.style.overflow = 'hidden'; // Hide body scroll
        console.log('[OTK Tracker] Viewer shown.');
        // TODO: Add logic here to populate/refresh viewer content when shown
    }
}

function updateDisplayedStatistics() {
    const threadsTrackedElem = document.getElementById('otk-threads-tracked-stat');
    const totalMessagesElem = document.getElementById('otk-total-messages-stat');

    if (threadsTrackedElem && totalMessagesElem) {
        // Calculate actual values
        // const numActiveThreads = activeThreads.length; // Old calculation
        const liveThreadsCount = activeThreads.filter(threadId => !droppedThreadIds.has(threadId)).length;


        let totalMessagesCount = 0;
        for (const threadId in messagesByThreadId) {
            if (messagesByThreadId.hasOwnProperty(threadId) && messagesByThreadId[threadId]) {
                totalMessagesCount += messagesByThreadId[threadId].length;
            }
        }

        threadsTrackedElem.textContent = `Live Threads: ${liveThreadsCount}`; // Label Updated, Value Updated
        totalMessagesElem.textContent = `Total Messages: ${totalMessagesCount}`;
    } else {
        console.warn('[OTK Tracker] Statistics elements not found for updating.');
    }
}

    // --- Button Implementations ---
    const buttonContainer = document.getElementById('otk-button-container');

    if (buttonContainer) {
        // Function to create styled buttons
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
            // Hover effect
            button.onmouseover = () => button.style.backgroundColor = '#666';
            button.onmouseout = () => button.style.backgroundColor = '#555';
            // Active effect
            button.onmousedown = () => button.style.backgroundColor = '#444';
            button.onmouseup = () => button.style.backgroundColor = '#666';
            return button;
        }

        // 1. Toggle Viewer Button
        const btnToggleViewer = createTrackerButton('Toggle Viewer');
        btnToggleViewer.addEventListener('click', toggleViewer); // Call toggleViewer directly
        buttonContainer.appendChild(btnToggleViewer);

        // 2. Refresh Data Button
        const btnRefresh = createTrackerButton('Refresh Data');
        btnRefresh.addEventListener('click', async () => {
            console.log('[OTK Tracker GUI] "Refresh Data" button clicked.');
            sessionStorage.setItem('otkManualRefreshClicked', 'true'); // For viewer, if it uses this
            btnRefresh.disabled = true;
            isManualRefreshInProgress = true;
            try {
                await refreshThreadsAndMessages();
                console.log('[OTK Tracker GUI] Data refresh complete.');
            } catch (error) {
                console.error("[OTK Tracker GUI] Error during data refresh:", error);
            } finally {
                isManualRefreshInProgress = false;
                btnRefresh.disabled = false;
                console.log('[OTK Tracker GUI] Refresh operation finished, button re-enabled.');
            }
        });
        buttonContainer.appendChild(btnRefresh);

        // Wrapper for the third button and the checkbox
        const thirdButtonWrapper = document.createElement('div');
        thirdButtonWrapper.style.cssText = `
            display: flex;
            flex-direction: column;
            justify-content: space-between; /* Push checkbox to top, button to bottom */
            align-items: stretch;           /* Children stretch to wrapper width */
            height: 100%;                   /* Take full height of buttonContainer's flex item cell */
        `;

        // Create and append the checkbox for disabling background updates
        const bgUpdateCheckboxContainer = document.createElement('div');
        bgUpdateCheckboxContainer.style.cssText = `
            display: flex;
            align-items: center;
            margin-bottom: 4px; /* Space between checkbox and button below it */
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
            white-space: normal;      /* Allow wrapping */
            overflow-wrap: break-word; /* Break words if necessary */
            flex-shrink: 1;           /* Allow label to shrink if space is tight in its flex container */
        `;

        bgUpdateCheckboxContainer.appendChild(bgUpdateCheckbox);
        bgUpdateCheckboxContainer.appendChild(bgUpdateLabel);
        thirdButtonWrapper.appendChild(bgUpdateCheckboxContainer); // Add checkbox to the wrapper first

        // 3. Restart Thread Tracker Button
        const btnClearRefresh = createTrackerButton('Restart Thread Tracker');
        btnClearRefresh.addEventListener('click', async () => {
            console.log('[OTK Tracker GUI] "Restart Thread Tracker" button clicked.');
            btnClearRefresh.disabled = true;
            try {
                await clearAndRefresh();
                console.log('[OTK Tracker GUI] Clear and refresh complete.');
            } catch (error) {
                console.error("[OTK Tracker GUI] Error during clear and refresh:", error);
            } finally {
                btnClearRefresh.disabled = false;
                console.log('[OTK Tracker GUI] Restart operation finished, button re-enabled.');
            }
        });
        thirdButtonWrapper.appendChild(btnClearRefresh); // Add 3rd button to the wrapper

        buttonContainer.appendChild(thirdButtonWrapper); // Add the wrapper to the main button container

    } else {
        console.error('[OTK Tracker] Button container not found. Cannot add buttons.');
    }


    // Initial render
    renderThreadList(); // This will now just log to console as its body is cleared.

function startBackgroundRefresh() {
    if (backgroundRefreshIntervalId) {
        clearInterval(backgroundRefreshIntervalId);
    }
    backgroundRefreshIntervalId = setInterval(backgroundRefreshThreadsAndMessages, BACKGROUND_REFRESH_INTERVAL);
    console.log(`[OTK Tracker] Background refresh scheduled every ${BACKGROUND_REFRESH_INTERVAL / 1000} seconds.`);
}

// At the end of the script, after the initial renderThreadList();
// startBackgroundRefresh(); // This will be called conditionally based on checkbox state

// Watchdog mechanism removed.

// --- Checkbox Functionality ---
const disableBgUpdateCheckbox = document.getElementById('otk-disable-bg-update-checkbox');
const BACKGROUND_UPDATES_DISABLED_KEY = 'otkBackgroundUpdatesDisabled';

// Ensure startBackgroundRefresh is defined before being called here
// It's defined further down, which is fine for event listeners, but direct calls need care.
// However, the structure here calls it within the if/else block after DOM elements are processed.

function stopBackgroundRefresh() {
    if (backgroundRefreshIntervalId) {
        clearInterval(backgroundRefreshIntervalId);
        backgroundRefreshIntervalId = null;
        console.log('[OTK Tracker] Background refresh stopped.');
    }
}

if (disableBgUpdateCheckbox) {
    // Load saved preference
    const isDisabled = localStorage.getItem(BACKGROUND_UPDATES_DISABLED_KEY) === 'true';
    disableBgUpdateCheckbox.checked = isDisabled;

    if (isDisabled) {
        console.log('[OTK Tracker] Background updates are disabled by user preference.');
        // Call stopBackgroundRefresh only if it wasn't already stopped or if starting by default was an option
        // At this point, backgroundRefreshIntervalId would be null unless startBackgroundRefresh was called unconditionally
        stopBackgroundRefresh(); // Ensure it's stopped if it was somehow started by other logic (unlikely here)
    } else {
        startBackgroundRefresh(); // Start if not disabled
    }

    disableBgUpdateCheckbox.addEventListener('change', () => {
        if (disableBgUpdateCheckbox.checked) {
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
    // Fallback if checkbox not found - start refresh by default
    console.warn('[OTK Tracker] Disable background updates checkbox not found. Starting background refresh by default.');
    startBackgroundRefresh();
}
updateDisplayedStatistics(); // Initial update of statistics

})();