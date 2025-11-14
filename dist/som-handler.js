"use strict";
/**
 * PageSoMHandler - Set-of-Marks Handler for Visual Element Identification
 * Manages SoM markers, canvas overlay, and semantic command execution
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PageSoMHandler = exports.SomReannotationRequiredError = void 0;
exports.registerPlaywrightExpect = registerPlaywrightExpect;
const som_types_1 = require("./som-types");
let registeredExpect;
function registerPlaywrightExpect(expectFn) {
    registeredExpect = expectFn;
}
class SomReannotationRequiredError extends Error {
    constructor(message, context) {
        super(message);
        this.name = 'SomReannotationRequiredError';
        this.context = context;
    }
}
exports.SomReannotationRequiredError = SomReannotationRequiredError;
function getExpect() {
    if (registeredExpect) {
        return registeredExpect;
    }
    const globalExpect = globalThis?.expect;
    if (globalExpect) {
        return globalExpect;
    }
    throw new Error('Playwright expect is not available. Pass it via registerPlaywrightExpect or ensure it exists on globalThis.');
}
function expect(...args) {
    return getExpect()(...args);
}
const ACTION_TIMEOUT_MS = 4000;
function getCommandFromError(error, fallback) {
    if (error && typeof error.playwrightCommand === 'string' && error.playwrightCommand.length > 0) {
        return error.playwrightCommand;
    }
    return fallback;
}
class PageSoMHandler {
    constructor(page, logger) {
        this.canvasInjected = false;
        this.mutationsList = [];
        this.mutationObserver = null; // MutationObserver only exists in browser context
        this.page = page;
        this.somMap = new Map();
        this.logger = logger;
    }
    setPage(page) {
        this.page = page;
        this.somMap.clear();
        this.canvasInjected = false;
        this.disconnectMutationObserver();
    }
    async disconnectMutationObserver() {
        if (this.mutationObserver || this.page) {
            try {
                // Clean up in page context
                await this.page.evaluate(() => {
                    if (window.__tcSomMutationObserver) {
                        window.__tcSomMutationObserver.disconnect();
                        delete window.__tcSomMutationObserver;
                    }
                    if (window.__tcSomMutations) {
                        delete window.__tcSomMutations;
                    }
                });
            }
            catch (error) {
                // Page may be closed or navigated away
                this.logger?.(`[PageSoMHandler] Failed to disconnect mutation observer: ${error}`, 'warn');
            }
            this.mutationObserver = null;
        }
    }
    /**
     * Update SoM markers - extract interactive elements and draw overlay
     * Clears coordinate markers from previous iteration (agent can view via previous_screenshot tool)
     * @param includeOffscreen - If true, marks ALL elements including those below viewport (for full-page screenshots)
     */
    async updateSom(includeOffscreen = false, includeDisabled = false) {
        this.logger?.(`[PageSoMHandler] Updating SoM markers${includeOffscreen ? ' (including offscreen elements)' : ''}${includeDisabled ? ' (including disabled elements)' : ''}...`, 'log');
        // Check if page is valid and not closed
        if (!this.page || this.page.isClosed()) {
            this.logger?.('[PageSoMHandler] Cannot update SoM markers: page is null or closed', 'warn');
            return 0;
        }
        // Clear any coordinate markers from previous iteration
        await this.removeCoordinateMarker();
        // Extract interactive elements and assign SoM IDs
        const elements = await this.page.evaluate((params) => {
            const { includeOffscreen, includeDisabled } = params;
            const doc = document;
            const elements = [];
            let idCounter = 1;
            // Helper: Find all shadow roots in the document (recursive, but only called once)
            function getAllShadowRoots(root = document) {
                const shadowRoots = [];
                // Use TreeWalker for efficient DOM traversal (faster than querySelectorAll('*'))
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
                let node = walker.currentNode;
                while (node) {
                    if (node.shadowRoot) {
                        try {
                            const shadowRoot = node.shadowRoot;
                            shadowRoots.push(shadowRoot);
                            // Recursively find shadow roots inside this shadow root
                            const nestedShadowRoots = getAllShadowRoots(shadowRoot);
                            shadowRoots.push(...nestedShadowRoots);
                        }
                        catch (e) {
                            // Closed shadow root - skip it
                        }
                    }
                    node = walker.nextNode();
                }
                return shadowRoots;
            }
            // Helper: Query selector in document + all shadow roots
            // Much more efficient than recursive approach - finds shadow roots once, then queries each
            function querySelectorAllDeep(selector) {
                const results = [];
                // Query main document
                doc.querySelectorAll(selector).forEach((el) => results.push(el));
                // Query each shadow root
                shadowRoots.forEach(shadowRoot => {
                    try {
                        shadowRoot.querySelectorAll(selector).forEach((el) => results.push(el));
                    }
                    catch (e) {
                        // Selector might not be valid in shadow context - skip
                    }
                });
                return results;
            }
            // Find all shadow roots upfront (only once, not per selector!)
            const shadowRoots = getAllShadowRoots(doc);
            // Query all interactive elements (including shadow DOM)
            const interactiveSelectors = [
                'button', 'input', 'textarea', 'select', 'a[href]',
                '[role="button"]', '[role="link"]', '[role="textbox"]',
                '[role="checkbox"]', '[role="radio"]', '[role="combobox"]',
                '[role="menu"]', '[role="menuitem"]', '[role="option"]',
                '[onclick]', '[type="submit"]',
                '[role="tab"]', '[role="switch"]', '[role="spinbutton"]'
            ];
            const allInteractive = new Set();
            interactiveSelectors.forEach(selector => {
                querySelectorAllDeep(selector).forEach((el) => allInteractive.add(el));
            });
            // Special handling for containers with ARIA attributes that might not be directly clickable
            // Pattern 1: [aria-haspopup] - dropdowns, menus, dialogs, date pickers
            // Pattern 2: [aria-expanded] - accordions, collapses, expandable sections
            // Pattern 3: [role="combobox"] - custom selects without aria-haspopup
            const ariaContainerSelectors = ['[aria-haspopup]', '[aria-expanded]', '[role="combobox"]'];
            ariaContainerSelectors.forEach(selector => {
                querySelectorAllDeep(selector).forEach((container) => {
                    // Skip if already marked by other selectors (e.g., button with aria-expanded)
                    if (allInteractive.has(container))
                        return;
                    const styles = window.getComputedStyle(container);
                    const isContainerClickable = styles.cursor === 'pointer' ||
                        container.onclick ||
                        container.getAttribute('onclick') ||
                        container.tagName === 'BUTTON' ||
                        container.tagName === 'A';
                    if (!isContainerClickable) {
                        // Check for clickable children (buttons, icons, inputs)
                        const clickableChild = Array.from(container.children).find((child) => {
                            const childStyles = window.getComputedStyle(child);
                            return childStyles.cursor === 'pointer' ||
                                child.onclick ||
                                child.getAttribute('onclick') ||
                                child.tagName === 'BUTTON' ||
                                child.tagName === 'A' ||
                                child.tagName === 'INPUT';
                        });
                        if (clickableChild) {
                            // Mark the child, not the container
                            allInteractive.add(clickableChild);
                        }
                        else {
                            // No clickable child found, mark the container as fallback
                            allInteractive.add(container);
                        }
                    }
                    else {
                        // Container is clickable, mark it
                        allInteractive.add(container);
                    }
                });
            });
            // Also detect styled-as-interactive elements
            querySelectorAllDeep('div, span, p, li, td').forEach((el) => {
                const styles = window.getComputedStyle(el);
                const hasClickHandler = el.onclick || el.getAttribute('onclick') ||
                    el.hasAttribute('data-action') || el.hasAttribute('data-click');
                if (styles.cursor === 'pointer' || hasClickHandler || el.tabIndex >= 0) {
                    allInteractive.add(el);
                }
            });
            // Special handling for labels wrapping hidden inputs (custom checkbox/radio patterns)
            // If a label wraps a hidden input and has visible content, mark the label, not the input
            querySelectorAllDeep('label').forEach((label) => {
                const input = label.querySelector('input[type="checkbox"], input[type="radio"]');
                if (input) {
                    const inputStyles = window.getComputedStyle(input);
                    const isInputHidden = inputStyles.display === 'none' ||
                        inputStyles.visibility === 'hidden' ||
                        parseFloat(inputStyles.opacity) === 0 ||
                        (input.getBoundingClientRect().width === 0);
                    if (isInputHidden) {
                        // Hidden input with styled label - mark the label instead
                        allInteractive.add(label);
                    }
                }
            });
            // Remove elements that are descendants of "true" interactive elements
            // (e.g., <span> inside <button> should not get separate marker)
            // But keep elements inside generic containers (div, section, etc.)
            const trueInteractiveTags = new Set([
                'BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL'
            ]);
            const topLevelInteractive = new Set();
            allInteractive.forEach((el) => {
                let hasInteractiveAncestor = false;
                let parent = el.parentElement;
                // Check if any ancestor is a "true" interactive element
                while (parent) {
                    if (allInteractive.has(parent) && trueInteractiveTags.has(parent.tagName)) {
                        hasInteractiveAncestor = true;
                        break;
                    }
                    parent = parent.parentElement;
                }
                if (!hasInteractiveAncestor) {
                    topLevelInteractive.add(el);
                }
            });
            // Filter to visible, non-occluded, enabled elements
            topLevelInteractive.forEach((el) => {
                const rect = el.getBoundingClientRect();
                // Skip invisible elements (zero size)
                if (rect.width === 0 || rect.height === 0)
                    return;
                // Skip hidden elements (display, visibility, opacity checks)
                const styles = window.getComputedStyle(el);
                const isHidden = styles.display === 'none' ||
                    (styles.visibility === 'hidden' && parseFloat(styles.opacity) === 0);
                // Special case: Check for visible pseudo-elements (::before, ::after)
                // Some sites hide the main element but show content via pseudo-elements
                let hasVisiblePseudo = false;
                if (styles.visibility === 'hidden' || parseFloat(styles.opacity) === 0) {
                    const before = window.getComputedStyle(el, '::before');
                    const after = window.getComputedStyle(el, '::after');
                    hasVisiblePseudo = (before.content !== 'none' && before.visibility === 'visible' && before.display !== 'none') ||
                        (after.content !== 'none' && after.visibility === 'visible' && after.display !== 'none');
                }
                if (isHidden && !hasVisiblePseudo)
                    return;
                // Skip disabled elements (they can't be interacted with)
                // BUT: Include them if includeDisabled=true (for bug artifact reference)
                const isDisabled = el.disabled ||
                    el.hasAttribute('disabled') ||
                    el.getAttribute('aria-disabled') === 'true' ||
                    el.getAttribute('data-disabled') === 'true' ||
                    el.classList?.contains('disabled');
                if (isDisabled && !includeDisabled)
                    return;
                // Z-index occlusion detection: Check if element is fully blocked
                // Sample 5 points: center + 4 corners (slightly inset)
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                // Use smaller inset for small elements (min 1px, max 10% of dimension)
                const inset = Math.max(1, Math.min(rect.width, rect.height) * 0.1);
                const testPoints = [
                    { x: centerX, y: centerY }, // center
                    { x: rect.left + inset, y: rect.top + inset }, // top-left
                    { x: rect.right - inset, y: rect.top + inset }, // top-right
                    { x: rect.left + inset, y: rect.bottom - inset }, // bottom-left
                    { x: rect.right - inset, y: rect.bottom - inset } // bottom-right
                ];
                // Occlusion detection - only for elements in viewport
                // For offscreen elements (below fold), skip this check since elementFromPoint doesn't work
                const isInViewport = rect.top < window.innerHeight && rect.bottom > 0 &&
                    rect.left < window.innerWidth && rect.right > 0;
                if (!includeOffscreen && isInViewport) {
                    // Element is in viewport - check if it's occluded
                    let visiblePoints = 0;
                    for (const point of testPoints) {
                        const topEl = document.elementFromPoint(point.x, point.y);
                        if (topEl && (topEl === el || el.contains(topEl) || topEl.contains(el))) {
                            visiblePoints++;
                        }
                    }
                    // Skip fully occluded elements (no visible points)
                    if (visiblePoints < 1) {
                        return;
                    }
                }
                else if (includeOffscreen && !isInViewport) {
                    // Element is offscreen - include it without occlusion check
                    // (elementFromPoint doesn't work for offscreen elements)
                }
                else if (!includeOffscreen && !isInViewport) {
                    // Viewport-only mode and element not in viewport - skip it
                    return;
                }
                // Assign tc-som-id attribute
                const somId = String(idCounter++);
                el.setAttribute('tc-som-id', somId);
                // Capture element details
                const parent = el.parentElement;
                // Extract text - if main element is hidden, try to get text from pseudo-elements
                let displayText = el.textContent?.trim().substring(0, 50) || '';
                if (hasVisiblePseudo && (!displayText || styles.visibility === 'hidden')) {
                    const before = window.getComputedStyle(el, '::before');
                    const after = window.getComputedStyle(el, '::after');
                    if (before.content && before.content !== 'none') {
                        // Remove surrounding quotes from content
                        displayText = before.content.replace(/^["']|["']$/g, '');
                    }
                    else if (after.content && after.content !== 'none') {
                        displayText = after.content.replace(/^["']|["']$/g, '');
                    }
                }
                // For images, the accessible name comes from alt attribute
                // For other elements, use aria-label if present
                let accessibleName = el.getAttribute('aria-label') || '';
                if (el.tagName.toLowerCase() === 'img' && !accessibleName) {
                    accessibleName = el.getAttribute('alt') || '';
                }
                // Detect associated <label> element for inputs/textareas/selects
                // This enables getByLabel() selector generation
                let labelText = '';
                const tagLower = el.tagName.toLowerCase();
                if (['input', 'textarea', 'select'].includes(tagLower)) {
                    // Method 1: Label with for="id"
                    if (el.id) {
                        const label = doc.querySelector(`label[for="${el.id}"]`);
                        if (label) {
                            labelText = label.textContent?.trim() || '';
                        }
                    }
                    // Method 2: Label wrapping the input
                    if (!labelText) {
                        let parent = el.parentElement;
                        while (parent && parent !== doc.body) {
                            if (parent.tagName.toLowerCase() === 'label') {
                                labelText = parent.textContent?.trim() || '';
                                break;
                            }
                            parent = parent.parentElement;
                        }
                    }
                }
                elements.push({
                    somId,
                    tag: el.tagName.toLowerCase(),
                    role: el.getAttribute('role') || el.tagName.toLowerCase(),
                    text: displayText,
                    ariaLabel: accessibleName,
                    labelText: labelText, // Associated <label> text for getByLabel()
                    placeholder: el.placeholder || '',
                    name: el.getAttribute('name') || '',
                    type: el.type || '',
                    id: el.id || '',
                    className: el.className || '',
                    bbox: {
                        x: Math.round(rect.x),
                        y: Math.round(rect.y),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                    },
                    hasVisiblePseudoElement: hasVisiblePseudo,
                    parent: parent ? {
                        tag: parent.tagName.toLowerCase(),
                        role: parent.getAttribute('role') || '',
                        className: parent.className || '',
                        text: parent.textContent?.trim().substring(0, 30) || ''
                    } : undefined
                });
            });
            return elements;
        }, { includeOffscreen, includeDisabled });
        // Store in somMap
        this.somMap.clear();
        elements.forEach(el => this.somMap.set(el.somId, el));
        // Inject/update canvas overlay with bounding boxes
        await this.drawSomOverlay(elements);
        this.logger?.(`[PageSoMHandler] Mapped ${elements.length} interactive elements`, 'log');
        return elements.length;
    }
    /**
     * Draw canvas overlay with bounding boxes and ID labels
     */
    async drawSomOverlay(elements) {
        await this.page.evaluate((els) => {
            const doc = document;
            // Skip if body doesn't exist yet (page still loading)
            if (!doc.body) {
                return;
            }
            // Create or get canvas
            let canvas = doc.getElementById('tc-som-canvas');
            if (!canvas) {
                canvas = doc.createElement('canvas');
                canvas.id = 'tc-som-canvas';
                canvas.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          z-index: 2147483647;
          pointer-events: none;
          display: none;
        `;
                // Re-check and wrap in try-catch to handle race condition
                // (page might navigate between the check above and appendChild)
                try {
                    if (doc.body) {
                        doc.body.appendChild(canvas);
                    }
                    else {
                        return; // Body disappeared, abort
                    }
                }
                catch (e) {
                    // Page navigated during appendChild - ignore error
                    return;
                }
            }
            // Set canvas dimensions to viewport size
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            // Make canvas visible for debugging (markers shown on live page)
            canvas.style.display = 'block';
            // 20 distinct colors with high contrast for readability
            // Each color chosen to ensure the ID label is clearly visible
            const COLOR_PALETTE = [
                { stroke: '#CC0000', fill: '#FF4444', text: 'white' }, // Bright Red
                { stroke: '#00AA00', fill: '#66FF66', text: 'black' }, // Bright Green
                { stroke: '#0066CC', fill: '#3399FF', text: 'white' }, // Bright Blue
                { stroke: '#FFAA00', fill: '#FFDD66', text: 'black' }, // Bright Orange
                { stroke: '#CC00CC', fill: '#FF66FF', text: 'black' }, // Bright Magenta
                { stroke: '#00AAAA', fill: '#66FFFF', text: 'black' }, // Bright Cyan
                { stroke: '#FF6600', fill: '#FFAA66', text: 'black' }, // Orange-Red
                { stroke: '#6600CC', fill: '#9966FF', text: 'white' }, // Purple
                { stroke: '#00CC66', fill: '#66FFAA', text: 'black' }, // Sea Green
                { stroke: '#FF0066', fill: '#FF66AA', text: 'white' }, // Hot Pink
                { stroke: '#66CC00', fill: '#AAFF66', text: 'black' }, // Lime Green
                { stroke: '#CC6600', fill: '#FFAA44', text: 'black' }, // Dark Orange
                { stroke: '#0099FF', fill: '#66CCFF', text: 'black' }, // Sky Blue
                { stroke: '#FF9999', fill: '#FFDDDD', text: 'black' }, // Light Coral
                { stroke: '#AA5500', fill: '#FF8833', text: 'white' }, // Dark Orange/Brown
                { stroke: '#5555AA', fill: '#8888FF', text: 'white' }, // Slate Blue
                { stroke: '#AA0044', fill: '#FF4488', text: 'white' }, // Raspberry
                { stroke: '#00AA88', fill: '#44FFCC', text: 'black' }, // Turquoise
                { stroke: '#AA44AA', fill: '#DD88DD', text: 'black' }, // Orchid
                { stroke: '#AAAA00', fill: '#FFFF66', text: 'black' } // Yellow-Green
            ];
            // Draw bounding boxes and labels
            els.forEach((el, index) => {
                const { bbox, somId } = el;
                // Assign color based on element index (cycles through 20 colors)
                const colors = COLOR_PALETTE[index % COLOR_PALETTE.length];
                // Draw bounding box
                ctx.strokeStyle = colors.stroke;
                ctx.lineWidth = 3;
                ctx.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
                // Draw ID label at TOP-RIGHT corner, OUTSIDE above the bounding box
                // This prevents obscuring element content (text, icons, etc.)
                const labelText = somId;
                ctx.font = 'bold 14px Arial';
                const textMetrics = ctx.measureText(labelText);
                const textWidth = textMetrics.width;
                const textHeight = 14;
                const padding = 3;
                const labelBoxWidth = textWidth + padding * 2;
                const labelBoxHeight = textHeight + padding;
                // Position label at top-right corner, ABOVE the bounding box
                // Label is right-aligned with bbox, bottom of label touches top of bbox
                const labelX = bbox.x + bbox.width - labelBoxWidth;
                let labelY = bbox.y - labelBoxHeight;
                // If no room above, place below the bounding box instead
                if (labelY < 0) {
                    labelY = bbox.y + bbox.height;
                }
                // Draw label background
                ctx.fillStyle = colors.fill;
                ctx.fillRect(labelX, labelY, labelBoxWidth, labelBoxHeight);
                // Draw label text
                ctx.fillStyle = colors.text;
                ctx.textBaseline = 'top';
                ctx.fillText(labelText, labelX + padding, labelY + padding / 2);
                ctx.textBaseline = 'alphabetic'; // Reset
            });
        }, elements);
        this.canvasInjected = true;
    }
    /**
     * Get formatted SoM element map for agent context
     * Returns concise, truncated element details to help disambiguate similar elements
     */
    getSomElementMap() {
        if (this.somMap.size === 0) {
            return 'No SoM elements mapped yet.';
        }
        const lines = [];
        // Sort by somId (numeric)
        const sortedEntries = Array.from(this.somMap.entries()).sort((a, b) => {
            return parseInt(a[0]) - parseInt(b[0]);
        });
        for (const [somId, element] of sortedEntries) {
            const parts = [];
            // Tag (always present)
            parts.push(element.tag);
            // Text (truncate to 40 chars)
            if (element.text && element.text.trim()) {
                const truncated = element.text.trim().substring(0, 40);
                parts.push(`"${truncated}${element.text.length > 40 ? '...' : ''}"`);
            }
            // Build attributes string
            const attrs = [];
            if (element.ariaLabel) {
                attrs.push(`aria: "${element.ariaLabel.substring(0, 30)}"`);
            }
            if (element.placeholder) {
                attrs.push(`placeholder: "${element.placeholder.substring(0, 30)}"`);
            }
            if (element.type && element.type !== 'text') {
                attrs.push(`type: "${element.type}"`);
            }
            if (element.role && element.role !== 'generic') {
                attrs.push(`role: "${element.role}"`);
            }
            if (element.name) {
                attrs.push(`name: "${element.name.substring(0, 20)}"`);
            }
            // Combine: [1]: button "Submit" (aria: "submit-form", type: "submit")
            const attrStr = attrs.length > 0 ? ` (${attrs.join(', ')})` : '';
            lines.push(`[${somId}]: ${parts.join(' ')}${attrStr}`);
        }
        return lines.join('\n');
    }
    /**
     * Retrieve a SoM element by id for debugging/telemetry purposes
     */
    getSomElementById(somId) {
        if (!somId) {
            return undefined;
        }
        return this.somMap.get(somId);
    }
    async resolveSomTarget(elementRef, expected) {
        const duplicates = await this.page.evaluate((ref) => {
            const nodes = Array.from(document.querySelectorAll(`[tc-som-id="${ref}"]`));
            return nodes.map((node, idx) => {
                const rect = node.getBoundingClientRect();
                return {
                    index: idx,
                    tag: node.tagName.toLowerCase(),
                    className: node.className || '',
                    text: (node.textContent || '').trim(),
                    ariaLabel: node.getAttribute('aria-label') || '',
                    bbox: {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                    },
                };
            });
        }, elementRef);
        const duplicateCount = duplicates.length;
        if (duplicateCount <= 1) {
            return {
                index: 0,
                duplicateCount,
                candidates: duplicates,
            };
        }
        const expectedTag = (expected.tag || '').toLowerCase();
        const expectedText = (expected.text || '').trim();
        const expectedAria = (expected.ariaLabel || '').trim();
        const expectedClassTokens = new Set((expected.className || '')
            .split(/\s+/)
            .map((token) => token.trim())
            .filter(Boolean));
        const expectedBBox = expected.bbox || { x: 0, y: 0, width: 0, height: 0 };
        const scored = duplicates.map((candidate) => {
            const candidateClassTokens = new Set(candidate.className
                .split(/\s+/)
                .map((token) => token.trim())
                .filter(Boolean));
            let score = 0;
            if (candidate.tag === expectedTag && expectedTag) {
                score += 5;
            }
            if (expectedClassTokens.size > 0) {
                const hasAllClasses = Array.from(expectedClassTokens).every((cls) => candidateClassTokens.has(cls));
                const overlap = Array.from(expectedClassTokens).some((cls) => candidateClassTokens.has(cls));
                if (hasAllClasses) {
                    score += 5;
                }
                else if (overlap) {
                    score += 3;
                }
            }
            const candidateText = candidate.text.trim();
            if (expectedText) {
                if (candidateText === expectedText) {
                    score += 4;
                }
                else if (candidateText.includes(expectedText)) {
                    score += 2;
                }
            }
            const candidateAria = candidate.ariaLabel.trim();
            if (expectedAria && candidateAria === expectedAria) {
                score += 2;
            }
            const bbox = candidate.bbox;
            if (expectedBBox.width && expectedBBox.height) {
                const widthDiff = Math.abs(bbox.width - expectedBBox.width);
                const heightDiff = Math.abs(bbox.height - expectedBBox.height);
                if (widthDiff < 2 && heightDiff < 2) {
                    score += 2;
                }
                else if (widthDiff < 6 && heightDiff < 6) {
                    score += 1;
                }
            }
            return { ...candidate, score };
        });
        let best = scored[0];
        for (const candidate of scored) {
            if (candidate.score > best.score ||
                (candidate.score === best.score && candidate.index < best.index)) {
                best = candidate;
            }
        }
        if (!best || best.score <= 0) {
            throw new SomReannotationRequiredError(`Duplicate SoM id "${elementRef}" no longer matches original element`, {
                elementRef,
                expected,
                candidates: scored,
            });
        }
        if (duplicateCount > 1) {
            this.logger?.(`[PageSoMHandler] Resolved duplicate tc-som-id="${elementRef}" with ${duplicateCount} candidates (chosen index=${best.index}, score=${best.score})`, 'log');
        }
        return {
            index: best.index,
            duplicateCount,
            candidates: scored,
        };
    }
    /**
     * Get screenshot with optional SoM markers
     */
    async getScreenshot(includeSomMarkers, fullPage = false, quality = 60) {
        if (!this.page || this.page.isClosed()) {
            throw new Error('Cannot get screenshot: page is null or closed');
        }
        // Show/hide canvas overlay
        await this.page.evaluate((show) => {
            const canvas = document.getElementById('tc-som-canvas');
            if (canvas)
                canvas.style.display = show ? 'block' : 'none';
        }, includeSomMarkers);
        // Capture screenshot
        const buffer = await this.page.screenshot({
            fullPage,
            type: 'jpeg',
            quality
        });
        // Keep markers visible for debugging - don't hide them
        // Only hide if specifically requested (includeSomMarkers = false)
        if (!includeSomMarkers) {
            await this.page.evaluate(() => {
                const canvas = document.getElementById('tc-som-canvas');
                if (canvas)
                    canvas.style.display = 'none';
            });
        }
        return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    }
    /**
     * Run command with semantic selector generation and coordinate fallback
     */
    async runCommand(command, useSomIdBasedCommands = false) {
        if (!this.page || this.page.isClosed()) {
            throw new Error('Cannot run command: page is null or closed');
        }
        const failedAttempts = [];
        const maxAttempts = 7; // Error budget per command
        // Handle navigation actions (no element/coord required)
        if (command.action === som_types_1.InteractionAction.NAVIGATE ||
            command.action === som_types_1.InteractionAction.GO_BACK ||
            command.action === som_types_1.InteractionAction.GO_FORWARD ||
            command.action === som_types_1.InteractionAction.RELOAD) {
            this.logger?.(`[PageSoMHandler] Executing navigation action: ${command.action}`, 'log');
            try {
                let playwrightCommand = '';
                switch (command.action) {
                    case som_types_1.InteractionAction.NAVIGATE:
                        if (!command.value) {
                            throw new Error('NAVIGATE action requires URL in value field');
                        }
                        await this.page.goto(command.value, { waitUntil: 'networkidle', timeout: 30000 });
                        playwrightCommand = `await page.goto('${command.value}')`;
                        break;
                    case som_types_1.InteractionAction.GO_BACK:
                        await this.page.goBack({ waitUntil: 'networkidle', timeout: 30000 });
                        playwrightCommand = 'await page.goBack()';
                        break;
                    case som_types_1.InteractionAction.GO_FORWARD:
                        await this.page.goForward({ waitUntil: 'networkidle', timeout: 30000 });
                        playwrightCommand = 'await page.goForward()';
                        break;
                    case som_types_1.InteractionAction.RELOAD:
                        await this.page.reload({ waitUntil: 'networkidle', timeout: 30000 });
                        playwrightCommand = 'await page.reload()';
                        break;
                }
                return {
                    failedAttempts: [],
                    successAttempt: {
                        command: playwrightCommand,
                        status: som_types_1.CommandRunStatus.SUCCESS
                    },
                    status: som_types_1.CommandRunStatus.SUCCESS
                };
            }
            catch (error) {
                return {
                    failedAttempts: [{
                            command: `Navigation action: ${command.action}`,
                            status: som_types_1.CommandRunStatus.FAILURE,
                            error: error.message
                        }],
                    error: error.message,
                    status: som_types_1.CommandRunStatus.FAILURE
                };
            }
        }
        // Handle direct percentage-based coordinate commands
        if (command.coord && !command.elementRef) {
            this.logger?.(`[PageSoMHandler] Executing ${command.action} at percentage coords (${command.coord.x}%, ${command.coord.y}%)`, 'log');
            try {
                const result = await this.executePercentageCoordinateAction(command);
                return {
                    failedAttempts: [],
                    successAttempt: {
                        command: `Coordinate action: ${command.action} at (${command.coord.x}%, ${command.coord.y}%)`,
                        status: som_types_1.CommandRunStatus.SUCCESS
                    },
                    status: som_types_1.CommandRunStatus.SUCCESS
                };
            }
            catch (error) {
                return {
                    failedAttempts: [{
                            command: `Coordinate action: ${command.action} at (${command.coord.x}%, ${command.coord.y}%)`,
                            status: som_types_1.CommandRunStatus.FAILURE,
                            error: error.message
                        }],
                    error: error.message,
                    status: som_types_1.CommandRunStatus.FAILURE
                };
            }
        }
        // Lookup element in SoM map
        if (!command.elementRef) {
            return {
                failedAttempts: [],
                error: 'Command must have either elementRef or coord specified',
                status: som_types_1.CommandRunStatus.FAILURE
            };
        }
        const element = this.somMap.get(command.elementRef);
        if (!element) {
            return {
                failedAttempts: [],
                error: `Element with SoM ID "${command.elementRef}" not found in map`,
                status: som_types_1.CommandRunStatus.FAILURE
            };
        }
        const duplicateResolution = await this.resolveSomTarget(command.elementRef, element);
        this.logger?.(`[PageSoMHandler] Executing ${command.action} on element ${command.elementRef}`, 'log');
        // Clear mutations list before command execution
        this.mutationsList = [];
        // Setup mutation observer for hover/focus actions
        if (command.action === som_types_1.InteractionAction.HOVER || command.action === som_types_1.InteractionAction.FOCUS) {
            await this.setupMutationObserver();
        }
        // Always attempt direct tc-som-id selector first (fastest, most precise)
        {
            const somIdSelector = {
                type: 'locator',
                value: `[tc-som-id="${command.elementRef}"]`,
                nth: duplicateResolution.index > 0 ? duplicateResolution.index : undefined,
            };
            this.logger?.(`[PageSoMHandler] Trying tc-som-id selector first: ${this.formatSelector(somIdSelector)}`, 'log');
            const modifiedCommand = element?.hasVisiblePseudoElement &&
                (command.action === som_types_1.InteractionAction.CLICK ||
                    command.action === som_types_1.InteractionAction.DOUBLE_CLICK ||
                    command.action === som_types_1.InteractionAction.RIGHT_CLICK ||
                    command.action === som_types_1.InteractionAction.HOVER)
                ? { ...command, force: true }
                : command;
            const somResult = await this.tryExecuteAction(somIdSelector, modifiedCommand, element);
            if (somResult.status === som_types_1.CommandRunStatus.SUCCESS) {
                await this.disconnectMutationObserver();
                return somResult;
            }
            if (somResult.failedAttempts.length > 0) {
                failedAttempts.push(...somResult.failedAttempts);
            }
        }
        // Try semantic selectors next (unless useSomIdBasedCommands=true)
        // For pseudo-element buttons, generateSemanticSelectors will use CSS selectors instead of getByRole/getByText
        if (!useSomIdBasedCommands) {
            const selectors = this.generateSemanticSelectors(element);
            for (let i = 0; i < Math.min(selectors.length, maxAttempts); i++) {
                const selector = selectors[i];
                // Force click/hover for pseudo-element buttons (they have visibility:hidden)
                const modifiedCommand = element?.hasVisiblePseudoElement &&
                    (command.action === som_types_1.InteractionAction.CLICK ||
                        command.action === som_types_1.InteractionAction.DOUBLE_CLICK ||
                        command.action === som_types_1.InteractionAction.RIGHT_CLICK ||
                        command.action === som_types_1.InteractionAction.HOVER)
                    ? { ...command, force: true }
                    : command;
                const result = await this.tryExecuteAction(selector, modifiedCommand, element);
                if (result.status === som_types_1.CommandRunStatus.SUCCESS) {
                    // Wait for mutations if hover/focus
                    if (command.action === som_types_1.InteractionAction.HOVER || command.action === som_types_1.InteractionAction.FOCUS) {
                        await this.page.waitForTimeout(500); // Wait for mutations to settle
                        result.mutations = await this.filterRelevantMutations();
                    }
                    await this.disconnectMutationObserver();
                    return result;
                }
                if (result.failedAttempts.length > 0) {
                    failedAttempts.push(...result.failedAttempts);
                }
            }
        }
        // Fallback to coordinates (more replayable)
        this.logger?.(`[PageSoMHandler] SoM/semantic selectors exhausted (${failedAttempts.length} attempts), falling back to coordinates`, 'warn');
        const coordResult = await this.executeCoordinateAction(command, element);
        await this.disconnectMutationObserver();
        // Add failed attempts to coordinate result
        if (coordResult.status === som_types_1.CommandRunStatus.SUCCESS) {
            coordResult.failedAttempts = failedAttempts;
        }
        else if (failedAttempts.length > 0) {
            coordResult.failedAttempts = [...failedAttempts, ...(coordResult.failedAttempts || [])];
        }
        return coordResult;
    }
    /**
     * Execute verification command and generate Playwright expect assertion
     * Uses semantic selectors (reuses generateSemanticSelectors) for script portability
     */
    async executeVerification(verification) {
        try {
            let locatorStr = '';
            let locator;
            let element;
            // Build locator using semantic selectors (like runCommand does)
            if (verification.elementRef) {
                element = this.somMap.get(verification.elementRef);
                if (!element) {
                    return {
                        success: false,
                        playwrightCommand: '',
                        error: `Element with SoM ID ${verification.elementRef} not found`
                    };
                }
                // Generate semantic selectors (reuse existing logic)
                const semanticSelectors = this.generateSemanticSelectors(element);
                if (semanticSelectors.length === 0) {
                    return {
                        success: false,
                        playwrightCommand: '',
                        error: `No semantic selectors available for element ${verification.elementRef}`
                    };
                }
                // Try selectors in priority order to find working one
                let workingSelector = null;
                for (const typedSelector of semanticSelectors) {
                    try {
                        const testLocator = this.buildLocatorFromTypedSelector(typedSelector);
                        await testLocator.first().waitFor({ state: 'attached', timeout: 1000 });
                        workingSelector = typedSelector;
                        break;
                    }
                    catch {
                        continue;
                    }
                }
                if (!workingSelector) {
                    // Fall back to first selector even if not confirmed working
                    workingSelector = semanticSelectors[0];
                    this.logger?.(`[PageSoMHandler] No confirmed working selector, using first: ${this.formatSelector(workingSelector)}`, 'warn');
                }
                locator = this.buildLocatorFromTypedSelector(workingSelector);
                locatorStr = this.formatSelector(workingSelector);
            }
            else if (verification.selector) {
                // Direct CSS selector (for count verifications on non-SoM elements)
                locatorStr = `page.locator('${verification.selector}')`;
                locator = this.page.locator(verification.selector);
            }
            else {
                return {
                    success: false,
                    playwrightCommand: '',
                    error: 'Either elementRef or selector required for verification'
                };
            }
            let expectCommand = '';
            let verificationPassed = true;
            // Generate Playwright command string FIRST (before executing, so we have it even if assertion fails)
            switch (verification.verificationType) {
                case som_types_1.VerificationType.TEXT_CONTAINS:
                    expectCommand = `await expect(${locatorStr}).toContainText('${verification.expected}')`;
                    break;
                case som_types_1.VerificationType.TEXT_EQUALS:
                    expectCommand = `await expect(${locatorStr}).toHaveText('${verification.expected}')`;
                    break;
                case som_types_1.VerificationType.VALUE_EQUALS:
                    expectCommand = `await expect(${locatorStr}).toHaveValue('${verification.expected}')`;
                    break;
                case som_types_1.VerificationType.VALUE_EMPTY:
                    expectCommand = `await expect(${locatorStr}).toHaveValue('')`;
                    break;
                case som_types_1.VerificationType.IS_VISIBLE:
                    expectCommand = `await expect(${locatorStr}).toBeVisible()`;
                    break;
                case som_types_1.VerificationType.IS_HIDDEN:
                    expectCommand = `await expect(${locatorStr}).toBeHidden()`;
                    break;
                case som_types_1.VerificationType.IS_ENABLED:
                    expectCommand = `await expect(${locatorStr}).toBeEnabled()`;
                    break;
                case som_types_1.VerificationType.IS_DISABLED:
                    expectCommand = `await expect(${locatorStr}).toBeDisabled()`;
                    break;
                case som_types_1.VerificationType.IS_CHECKED:
                    expectCommand = `await expect(${locatorStr}).toBeChecked()`;
                    break;
                case som_types_1.VerificationType.IS_UNCHECKED:
                    expectCommand = `await expect(${locatorStr}).not.toBeChecked()`;
                    break;
                case som_types_1.VerificationType.COUNT_EQUALS:
                    expectCommand = `await expect(${locatorStr}).toHaveCount(${verification.expected})`;
                    break;
                case som_types_1.VerificationType.COUNT_GREATER_THAN:
                    expectCommand = `expect(await ${locatorStr}.count()).toBeGreaterThan(${verification.expected})`;
                    break;
                case som_types_1.VerificationType.COUNT_LESS_THAN:
                    expectCommand = `expect(await ${locatorStr}.count()).toBeLessThan(${verification.expected})`;
                    break;
                case som_types_1.VerificationType.HAS_CLASS:
                    expectCommand = `await expect(${locatorStr}).toHaveClass(/${verification.expected}/)`;
                    break;
                case som_types_1.VerificationType.HAS_ATTRIBUTE:
                    // Format: "attr:value" or just "attr" (use colon to avoid = in values)
                    const parts = verification.expected.split(':', 2);
                    const attr = parts[0];
                    const value = parts[1];
                    if (value) {
                        expectCommand = `await expect(${locatorStr}).toHaveAttribute('${attr}', '${value}')`;
                    }
                    else {
                        expectCommand = `await expect(${locatorStr}).toHaveAttribute('${attr}')`;
                    }
                    break;
                default:
                    return {
                        success: false,
                        playwrightCommand: '',
                        error: `Unknown verification type: ${verification.verificationType}`
                    };
            }
            // Now execute the assertion (may fail, but we already have the command string)
            try {
                // For non-count verifications, use .first() to avoid strict mode violations
                // when semantic selector matches multiple elements (e.g., class-based selectors)
                const targetLocator = (verification.verificationType === som_types_1.VerificationType.COUNT_EQUALS ||
                    verification.verificationType === som_types_1.VerificationType.COUNT_GREATER_THAN ||
                    verification.verificationType === som_types_1.VerificationType.COUNT_LESS_THAN)
                    ? locator // Count verifications work on the full locator
                    : locator.first(); // All other verifications target the first element
                switch (verification.verificationType) {
                    case som_types_1.VerificationType.TEXT_CONTAINS:
                        await expect(targetLocator).toContainText(verification.expected, { timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.TEXT_EQUALS:
                        await expect(targetLocator).toHaveText(verification.expected, { timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.VALUE_EQUALS:
                        await expect(targetLocator).toHaveValue(verification.expected, { timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.VALUE_EMPTY:
                        await expect(targetLocator).toHaveValue('', { timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.IS_VISIBLE:
                        await expect(targetLocator).toBeVisible({ timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.IS_HIDDEN:
                        await expect(targetLocator).toBeHidden({ timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.IS_ENABLED:
                        await expect(targetLocator).toBeEnabled({ timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.IS_DISABLED:
                        await expect(targetLocator).toBeDisabled({ timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.IS_CHECKED:
                        await expect(targetLocator).toBeChecked({ timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.IS_UNCHECKED:
                        await expect(targetLocator).not.toBeChecked({ timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.COUNT_EQUALS:
                        await expect(locator).toHaveCount(verification.expected, { timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.COUNT_GREATER_THAN:
                        const countGT = await locator.count();
                        expect(countGT).toBeGreaterThan(verification.expected);
                        break;
                    case som_types_1.VerificationType.COUNT_LESS_THAN:
                        const countLT = await locator.count();
                        expect(countLT).toBeLessThan(verification.expected);
                        break;
                    case som_types_1.VerificationType.HAS_CLASS:
                        await expect(targetLocator).toHaveClass(new RegExp(verification.expected), { timeout: 5000 });
                        break;
                    case som_types_1.VerificationType.HAS_ATTRIBUTE:
                        const parts = verification.expected.split(':', 2);
                        const attr = parts[0];
                        const value = parts[1];
                        if (value) {
                            await expect(targetLocator).toHaveAttribute(attr, value, { timeout: 5000 });
                        }
                        else {
                            await expect(targetLocator).toHaveAttribute(attr, { timeout: 5000 });
                        }
                        break;
                }
            }
            catch (assertionError) {
                // Assertion failed but we still want the command in the script
                verificationPassed = false;
                this.logger?.(`[PageSoMHandler] Verification assertion failed (non-fatal): ${assertionError.message}`, 'warn');
            }
            // Always return the command (even if assertion failed) - scripts need the expect
            return {
                success: verificationPassed,
                playwrightCommand: expectCommand,
                error: verificationPassed ? undefined : 'Assertion failed during generation'
            };
        }
        catch (error) {
            // Could not build command at all (selector not found, etc.)
            return {
                success: false,
                playwrightCommand: '',
                error: error.message
            };
        }
    }
    /**
     * Generate typed semantic selectors from element details (no string parsing needed)
     */
    generateSemanticSelectors(element) {
        const selectors = [];
        // Priority 1: getByTestId (would need to capture in updateSom)
        // Skipped for now - can add data-testid capture later
        // Priority 2: Stable ID
        // Filter unstable IDs:
        // - Contains colons (React/MUI: :r123:, :r1r: - need CSS escaping which is fragile)
        // - Auto-generated prefixes (rc_, __)
        // - Dynamic markers (contains «)
        if (element.id && !element.id.includes(':') && !element.id.match(/^(rc_|__)/) && !element.id.includes('«')) {
            selectors.push({ type: 'id', value: element.id });
        }
        // Priority 3: getByLabel (ONLY when there's an actual <label> element)
        // getByLabel doesn't work with aria-label/alt - it needs <label for="id">
        // Now properly detected: we check for associated <label> during updateSom()
        if (element.labelText) {
            selectors.push({ type: 'label', value: element.labelText });
        }
        // Priority 4: input[name] (backend contract - very stable)
        if (element.name && ['input', 'textarea', 'select'].includes(element.tag)) {
            selectors.push({ type: 'name', value: element.name });
        }
        // Priority 5: getByPlaceholder (UI hint - less stable than name)
        if (element.placeholder) {
            selectors.push({ type: 'placeholder', value: element.placeholder });
        }
        // Priority 6: CSS selector for pseudo-element buttons (BEFORE role/text)
        // For buttons with visibility:hidden + ::before/::after, getByRole/getByText won't work
        if (element.hasVisiblePseudoElement && element.tag === 'button') {
            // Try button[type="submit"] first (most common for forms)
            if (element.type === 'submit') {
                selectors.push({ type: 'locator', value: 'button[type="submit"]' });
            }
            // Try class-based selector if available
            if (element.className) {
                const firstClass = element.className.split(' ')[0];
                if (firstClass && !firstClass.match(/^(css-|MuiButton-|ant-|btn-)/)) {
                    selectors.push({ type: 'locator', value: `button.${firstClass}` });
                }
            }
        }
        // Priority 7: getByRole (broader, can match multiple elements)
        // Skip for pseudo-element buttons (they have visibility:hidden → not in a11y tree)
        // For images/buttons with accessible names, prefer ariaLabel over text
        if (!element.hasVisiblePseudoElement && element.role) {
            const accessibleName = element.ariaLabel || element.text;
            if (accessibleName) {
                selectors.push({ type: 'role', value: element.role, roleOptions: { name: accessibleName } });
            }
        }
        // Priority 8: getByText (last semantic option)
        // Skip for pseudo-element buttons (getByText will match the heading instead!)
        if (!element.hasVisiblePseudoElement && element.text) {
            selectors.push({ type: 'text', value: element.text });
        }
        // Priority 9: Parent-scoped locator (generic fallback)
        if (element.parent?.className) {
            const parentClass = element.parent.className.split(' ')[0];
            if (parentClass) {
                selectors.push({ type: 'locator', value: `.${parentClass} ${element.tag}` });
            }
        }
        return selectors;
    }
    /**
     * Try executing action with a typed selector (no string parsing)
     */
    async tryExecuteAction(typedSelector, command, element) {
        // Format selector description for both success and error paths
        const selectorDesc = this.formatSelector(typedSelector);
        try {
            // Build locator with optional parent chaining
            const locator = this.buildLocatorFromTypedSelector(typedSelector);
            // Execute action based on type
            const playwrightCommand = await this.executeActionOnLocator(locator, command, selectorDesc);
            return {
                failedAttempts: [],
                successAttempt: {
                    command: playwrightCommand,
                    status: som_types_1.CommandRunStatus.SUCCESS
                },
                status: som_types_1.CommandRunStatus.SUCCESS
            };
        }
        catch (error) {
            this.logger?.(`[PageSoMHandler] Selector "${selectorDesc}" failed: ${error.message}`, 'warn');
            // Apply error-specific heuristics
            return await this.applyHeuristicsAndRetry(typedSelector, command, element, error);
        }
    }
    /**
     * Apply intelligent heuristics based on error type and retry
     */
    async applyHeuristicsAndRetry(typedSelector, command, element, error) {
        const errorMsg = error.message || String(error);
        const selectorDesc = this.formatSelector(typedSelector);
        // Heuristic 1: Strict mode violation → Try parent scoping
        if (errorMsg.includes('strict mode violation')) {
            if (typedSelector.type === 'locator' && element.parent?.className) {
                this.logger?.(`[PageSoMHandler] Heuristic: Strict mode → trying parent scoping`, 'log');
                return await this.tryRefinedSelector(typedSelector, command, element, error);
            }
            // Could add nth() selector here based on bbox position
        }
        // Heuristic 2: Timeout → Quick retry with scroll (once only, don't get stuck)
        if (errorMsg.includes('Timeout') && !errorMsg.includes('not enabled')) {
            this.logger?.(`[PageSoMHandler] Heuristic: Timeout → quick scroll + retry (once)`, 'log');
            try {
                const locator = this.buildLocatorFromTypedSelector(typedSelector);
                // Try scroll (if element exists but not in viewport)
                await locator.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => { });
                await this.page.waitForTimeout(500); // Reduced wait
                const playwrightCommand = await this.executeActionOnLocator(locator, command, selectorDesc);
                return {
                    failedAttempts: [{
                            command: getCommandFromError(error, selectorDesc),
                            status: som_types_1.CommandRunStatus.FAILURE,
                            error: 'Timeout (first attempt)'
                        }],
                    successAttempt: {
                        command: `${playwrightCommand} (after scroll)`,
                        status: som_types_1.CommandRunStatus.SUCCESS
                    },
                    status: som_types_1.CommandRunStatus.SUCCESS
                };
            }
            catch (retryError) {
                // Element likely doesn't exist or selector is wrong - move on to next selector
                this.logger?.(`[PageSoMHandler] Scroll retry failed, moving to next selector`, 'log');
            }
        }
        // Heuristic 3: Not enabled/not actionable → Try force flag
        if (errorMsg.includes('not enabled') || errorMsg.includes('not editable') || errorMsg.includes('not actionable')) {
            this.logger?.(`[PageSoMHandler] Heuristic: Not actionable → trying force flag`, 'log');
            try {
                const locator = this.buildLocatorFromTypedSelector(typedSelector);
                const modifiedCommand = { ...command, force: true };
                const playwrightCommand = await this.executeActionOnLocator(locator, modifiedCommand, selectorDesc);
                return {
                    failedAttempts: [{
                            command: getCommandFromError(error, selectorDesc),
                            status: som_types_1.CommandRunStatus.FAILURE,
                            error: errorMsg
                        }],
                    successAttempt: {
                        command: `${playwrightCommand} (with force)`,
                        status: som_types_1.CommandRunStatus.SUCCESS
                    },
                    status: som_types_1.CommandRunStatus.SUCCESS
                };
            }
            catch (forceError) {
                // Force didn't work
            }
        }
        // Heuristic 4: Element moving/detached → Wait for stability
        if (errorMsg.includes('detached') || errorMsg.includes('moving')) {
            this.logger?.(`[PageSoMHandler] Heuristic: Element unstable → waiting for stability`, 'log');
            try {
                await this.page.waitForLoadState('domcontentloaded');
                await this.page.waitForTimeout(1000);
                const locator = this.buildLocatorFromTypedSelector(typedSelector);
                const playwrightCommand = await this.executeActionOnLocator(locator, command, selectorDesc);
                return {
                    failedAttempts: [{
                            command: getCommandFromError(error, selectorDesc),
                            status: som_types_1.CommandRunStatus.FAILURE,
                            error: errorMsg
                        }],
                    successAttempt: {
                        command: `${playwrightCommand} (after stability wait)`,
                        status: som_types_1.CommandRunStatus.SUCCESS
                    },
                    status: som_types_1.CommandRunStatus.SUCCESS
                };
            }
            catch (stabilityError) {
                // Stability wait didn't help
            }
        }
        // No heuristics worked - return failure
        return {
            failedAttempts: [{
                    command: getCommandFromError(error, selectorDesc),
                    status: som_types_1.CommandRunStatus.FAILURE,
                    error: errorMsg
                }],
            status: som_types_1.CommandRunStatus.FAILURE
        };
    }
    /**
     * Build Playwright locator from typed selector (supports chaining)
     */
    buildLocatorFromTypedSelector(typedSelector) {
        // Get base locator (page or parent)
        const base = typedSelector.parent
            ? this.buildLocatorFromTypedSelector(typedSelector.parent)
            : this.page;
        let locator;
        // Build locator from base
        switch (typedSelector.type) {
            case 'id':
                locator = base.locator(`#${typedSelector.value}`);
                break;
            case 'testId':
                locator = base.getByTestId(typedSelector.value);
                break;
            case 'label':
                locator = base.getByLabel(typedSelector.value);
                break;
            case 'role':
                locator = base.getByRole(typedSelector.value, typedSelector.roleOptions);
                break;
            case 'placeholder':
                locator = base.getByPlaceholder(typedSelector.value);
                break;
            case 'text':
                locator = base.getByText(typedSelector.value);
                break;
            case 'title':
                locator = base.getByTitle(typedSelector.value);
                break;
            case 'altText':
                locator = base.getByAltText(typedSelector.value);
                break;
            case 'name':
                locator = base.locator(`[name="${typedSelector.value}"]`);
                break;
            case 'locator':
                // Generic locator - supports CSS, text=, has-text=, chaining, etc.
                locator = base.locator(typedSelector.value);
                break;
            default:
                throw new Error(`Unknown selector type: ${typedSelector.type}`);
        }
        // Apply nth disambiguation when provided
        if (typeof typedSelector.nth === 'number' && typedSelector.nth >= 0) {
            return locator.nth(typedSelector.nth);
        }
        return locator;
    }
    /**
     * Format typed selector for logging (supports chaining)
     */
    formatSelector(sel) {
        let formatted;
        switch (sel.type) {
            case 'id':
                formatted = `page.locator('#${sel.value}')`;
                break;
            case 'testId':
                formatted = `page.getByTestId('${sel.value}')`;
                break;
            case 'label':
                formatted = `page.getByLabel('${sel.value}')`;
                break;
            case 'role':
                formatted = `page.getByRole('${sel.value}', {name: '${sel.roleOptions?.name}'})`;
                break;
            case 'placeholder':
                formatted = `page.getByPlaceholder('${sel.value}')`;
                break;
            case 'text':
                formatted = `page.getByText('${sel.value}')`;
                break;
            case 'title':
                formatted = `page.getByTitle('${sel.value}')`;
                break;
            case 'altText':
                formatted = `page.getByAltText('${sel.value}')`;
                break;
            case 'name':
                formatted = `page.locator('[name="${sel.value}"]')`;
                break;
            case 'locator':
                formatted = `page.locator('${sel.value}')`;
                break;
            default:
                formatted = `page.locator('${sel.value}')`;
        }
        // Add parent chain if exists (use .locator() for chaining)
        if (sel.parent) {
            const parentFormatted = this.formatSelector(sel.parent);
            let combined;
            // Extract just the selector part for chaining
            switch (sel.type) {
                case 'testId':
                    combined = `${parentFormatted}.getByTestId('${sel.value}')`;
                    break;
                case 'label':
                    combined = `${parentFormatted}.getByLabel('${sel.value}')`;
                    break;
                case 'role':
                    combined = `${parentFormatted}.getByRole('${sel.value}', {name: '${sel.roleOptions?.name}'})`;
                    break;
                case 'placeholder':
                    combined = `${parentFormatted}.getByPlaceholder('${sel.value}')`;
                    break;
                case 'text':
                    combined = `${parentFormatted}.getByText('${sel.value}')`;
                    break;
                case 'title':
                    combined = `${parentFormatted}.getByTitle('${sel.value}')`;
                    break;
                case 'altText':
                    combined = `${parentFormatted}.getByAltText('${sel.value}')`;
                    break;
                case 'id':
                    combined = `${parentFormatted}.locator('#${sel.value}')`;
                    break;
                case 'name':
                    combined = `${parentFormatted}.locator('[name="${sel.value}"]')`;
                    break;
                case 'locator':
                default:
                    combined = `${parentFormatted}.locator('${sel.value}')`;
                    break;
            }
            if (typeof sel.nth === 'number' && sel.nth >= 0) {
                combined = `${combined}.nth(${sel.nth})`;
            }
            return combined;
        }
        if (typeof sel.nth === 'number' && sel.nth >= 0) {
            formatted = `${formatted}.nth(${sel.nth})`;
        }
        return formatted;
    }
    /**
     * Execute action on locator based on command type
     */
    async executeActionOnLocator(locator, command, selectorDesc) {
        const { action, value, force, scrollAmount } = command;
        const selector = selectorDesc || 'locator';
        const timeout = command.timeout ?? ACTION_TIMEOUT_MS;
        let commandString = '';
        try {
            switch (action) {
                case som_types_1.InteractionAction.CLICK:
                    commandString = force
                        ? `await ${selector}.click({ force: true, timeout: ${timeout} })`
                        : `await ${selector}.click({ timeout: ${timeout} })`;
                    await locator.click({ force, timeout });
                    break;
                case som_types_1.InteractionAction.DOUBLE_CLICK:
                    commandString = force
                        ? `await ${selector}.dblclick({ force: true, timeout: ${timeout} })`
                        : `await ${selector}.dblclick({ timeout: ${timeout} })`;
                    await locator.dblclick({ force, timeout });
                    break;
                case som_types_1.InteractionAction.RIGHT_CLICK:
                    commandString = force
                        ? `await ${selector}.click({ button: 'right', force: true, timeout: ${timeout} })`
                        : `await ${selector}.click({ button: 'right', timeout: ${timeout} })`;
                    await locator.click({ button: 'right', force, timeout });
                    break;
                case som_types_1.InteractionAction.FILL: {
                    const fillValue = value || '';
                    commandString = force
                        ? `await ${selector}.fill('${fillValue}', { force: true, timeout: ${timeout} })`
                        : `await ${selector}.fill('${fillValue}', { timeout: ${timeout} })`;
                    await locator.fill(fillValue, { force, timeout });
                    break;
                }
                case som_types_1.InteractionAction.TYPE: {
                    const typeValue = value || '';
                    const delay = command.delay || 50;
                    commandString = `await ${selector}.pressSequentially('${typeValue}', { delay: ${delay} })`;
                    await locator.pressSequentially(typeValue, { delay });
                    break;
                }
                case som_types_1.InteractionAction.CLEAR:
                    commandString = force
                        ? `await ${selector}.clear({ force: true, timeout: ${timeout} })`
                        : `await ${selector}.clear({ timeout: ${timeout} })`;
                    await locator.clear({ force, timeout });
                    break;
                case som_types_1.InteractionAction.PRESS: {
                    const pressKey = value || 'Enter';
                    commandString = `await ${selector}.press('${pressKey}', { timeout: ${timeout} })`;
                    await locator.press(pressKey, { timeout });
                    break;
                }
                case som_types_1.InteractionAction.SELECT: {
                    const selectValue = value || '';
                    commandString = `await ${selector}.selectOption('${selectValue}', { timeout: ${timeout} })`;
                    await locator.selectOption(selectValue, { timeout });
                    break;
                }
                case som_types_1.InteractionAction.CHECK:
                    commandString = force
                        ? `await ${selector}.check({ force: true, timeout: ${timeout} })`
                        : `await ${selector}.check({ timeout: ${timeout} })`;
                    await locator.check({ force, timeout });
                    break;
                case som_types_1.InteractionAction.UNCHECK:
                    commandString = force
                        ? `await ${selector}.uncheck({ force: true, timeout: ${timeout} })`
                        : `await ${selector}.uncheck({ timeout: ${timeout} })`;
                    await locator.uncheck({ force, timeout });
                    break;
                case som_types_1.InteractionAction.HOVER:
                    commandString = force
                        ? `await ${selector}.hover({ force: true, timeout: ${timeout} })`
                        : `await ${selector}.hover({ timeout: ${timeout} })`;
                    await locator.hover({ force, timeout });
                    break;
                case som_types_1.InteractionAction.FOCUS:
                    commandString = `await ${selector}.focus()`;
                    await locator.focus();
                    break;
                case som_types_1.InteractionAction.BLUR:
                    commandString = `await ${selector}.blur()`;
                    await locator.blur();
                    break;
                case som_types_1.InteractionAction.SCROLL_INTO_VIEW:
                    commandString = `await ${selector}.scrollIntoViewIfNeeded()`;
                    await locator.scrollIntoViewIfNeeded();
                    break;
                case som_types_1.InteractionAction.SCROLL:
                    if (scrollAmount) {
                        commandString = `await ${selector}.evaluate(el => el.scrollBy(0, ${scrollAmount}))`;
                        await locator.evaluate((el, amount) => {
                            el.scrollBy(0, amount);
                        }, scrollAmount);
                        break;
                    }
                    break;
                case som_types_1.InteractionAction.DRAG:
                    if (command.toCoord) {
                        commandString = `await ${selector}.dragTo(body, { targetPosition: { x: ${command.toCoord.x}, y: ${command.toCoord.y} } })`;
                        await locator.dragTo(this.page.locator('body'), {
                            targetPosition: { x: command.toCoord.x, y: command.toCoord.y }
                        });
                        break;
                    }
                    break;
                default:
                    commandString = `await ${selector}.${action}()`;
                    throw new Error(`Unsupported action: ${action}`);
            }
            return commandString || `await ${selector}.${action}()`;
        }
        catch (error) {
            error.playwrightCommand = commandString || `await ${selector}.${action}()`;
            throw error;
        }
    }
    /**
     * Execute coordinate-based action as fallback
     */
    /**
     * Draw a visual marker at coordinate position (for debugging in headed mode)
     * Marker persists through screenshots so agent can see where coords landed
     */
    async drawCoordinateMarker(pixelX, pixelY) {
        // Coordinate markers are suppressed to avoid adding noise to screenshots.
        await this.removeCoordinateMarker();
    }
    /**
     * Remove coordinate marker from page (used when cleaning up or replacing)
     */
    async removeCoordinateMarker() {
        if (!this.page || this.page.isClosed()) {
            return; // Silently skip if page is invalid
        }
        await this.page.evaluate(() => {
            // Remove marker circle
            const marker = document.getElementById('tc-coord-marker');
            if (marker)
                marker.remove();
            // Remove all "clicked" labels (in case there are multiple)
            const labels = Array.from(document.querySelectorAll('div')).filter(el => el.textContent === 'clicked' && el.style.position === 'fixed' && el.style.background?.includes('255, 0, 255'));
            labels.forEach(label => label.remove());
        });
    }
    /**
     * Execute action using percentage-based coordinates
     */
    async executePercentageCoordinateAction(command) {
        if (!command.coord) {
            throw new Error('Coordinate is required for percentage-based commands');
        }
        // Get viewport dimensions
        const viewport = this.page.viewportSize();
        if (!viewport) {
            throw new Error('Could not determine viewport size');
        }
        // Convert percentage to pixels
        const pixelX = Math.round((command.coord.x / 100) * viewport.width);
        const pixelY = Math.round((command.coord.y / 100) * viewport.height);
        this.logger?.(`[PageSoMHandler] Using percentage coords: (${command.coord.x}%, ${command.coord.y}%) -> pixels (${pixelX}, ${pixelY})`, 'log');
        // Draw visual marker at target position (for headed mode debugging)
        await this.drawCoordinateMarker(pixelX, pixelY);
        const { action, value } = command;
        let playwrightCommand = '';
        try {
            switch (action) {
                case som_types_1.InteractionAction.CLICK:
                case som_types_1.InteractionAction.DOUBLE_CLICK:
                case som_types_1.InteractionAction.RIGHT_CLICK:
                    const clickCount = action === som_types_1.InteractionAction.DOUBLE_CLICK ? 2 : 1;
                    const button = action === som_types_1.InteractionAction.RIGHT_CLICK ? 'right' :
                        command.button || 'left';
                    await this.page.mouse.click(pixelX, pixelY, {
                        button,
                        clickCount,
                        delay: command.delay
                    });
                    playwrightCommand = `await page.mouse.click(${pixelX}, ${pixelY}${button !== 'left' ? `, { button: '${button}' }` : ''})`;
                    break;
                case som_types_1.InteractionAction.FILL:
                case som_types_1.InteractionAction.TYPE:
                    // Click to focus, then type
                    await this.page.mouse.click(pixelX, pixelY);
                    await this.page.waitForTimeout(100); // Brief wait for focus
                    if (action === som_types_1.InteractionAction.FILL) {
                        await this.page.keyboard.type(value || '');
                    }
                    else {
                        await this.page.keyboard.type(value || '', { delay: command.delay || 50 });
                    }
                    playwrightCommand = `await page.mouse.click(${pixelX}, ${pixelY}); await page.keyboard.type('${value}')`;
                    break;
                case som_types_1.InteractionAction.HOVER:
                    await this.page.mouse.move(pixelX, pixelY);
                    playwrightCommand = `await page.mouse.move(${pixelX}, ${pixelY})`;
                    break;
                case som_types_1.InteractionAction.DRAG:
                    if (!command.toCoord) {
                        throw new Error('toCoord is required for drag action');
                    }
                    const toPixelX = Math.round((command.toCoord.x / 100) * viewport.width);
                    const toPixelY = Math.round((command.toCoord.y / 100) * viewport.height);
                    await this.page.mouse.move(pixelX, pixelY);
                    await this.page.mouse.down();
                    await this.page.mouse.move(toPixelX, toPixelY);
                    await this.page.mouse.up();
                    playwrightCommand = `await page.mouse.move(${pixelX}, ${pixelY}); await page.mouse.down(); await page.mouse.move(${toPixelX}, ${toPixelY}); await page.mouse.up()`;
                    break;
                case som_types_1.InteractionAction.PRESS:
                case som_types_1.InteractionAction.PRESS_SEQUENTIALLY:
                    // Keyboard press is page-level - coordinates don't make sense
                    throw new Error(`PRESS action cannot use coordinates. To scroll: use SCROLL action with scrollDirection/scrollAmount. To press keys: use PRESS without coord.`);
                default:
                    throw new Error(`Coordinate-based execution not supported for action: ${action}`);
            }
            return {
                failedAttempts: [],
                successAttempt: {
                    command: playwrightCommand,
                    status: som_types_1.CommandRunStatus.SUCCESS
                },
                status: som_types_1.CommandRunStatus.SUCCESS
            };
        }
        catch (error) {
            throw new Error(`Failed to execute percentage coordinate action: ${error.message}`);
        }
    }
    async executeCoordinateAction(command, element) {
        try {
            // Calculate center of bounding box
            const centerX = element.bbox.x + element.bbox.width / 2;
            const centerY = element.bbox.y + element.bbox.height / 2;
            this.logger?.(`[PageSoMHandler] Using coordinates (${centerX}, ${centerY})`, 'log');
            const { action, value } = command;
            let playwrightCommand = '';
            switch (action) {
                case som_types_1.InteractionAction.CLICK:
                case som_types_1.InteractionAction.DOUBLE_CLICK:
                case som_types_1.InteractionAction.RIGHT_CLICK:
                    const clickCount = action === som_types_1.InteractionAction.DOUBLE_CLICK ? 2 : 1;
                    const button = action === som_types_1.InteractionAction.RIGHT_CLICK ? 'right' : 'left';
                    await this.page.mouse.click(centerX, centerY, { button, clickCount });
                    playwrightCommand = `await page.mouse.click(${centerX}, ${centerY}${button !== 'left' ? `, { button: '${button}' }` : ''})`;
                    break;
                case som_types_1.InteractionAction.FILL:
                case som_types_1.InteractionAction.TYPE:
                    // Click first, then type
                    await this.page.mouse.click(centerX, centerY);
                    if (action === som_types_1.InteractionAction.FILL) {
                        await this.page.keyboard.type(value || '');
                    }
                    else {
                        await this.page.keyboard.type(value || '', { delay: command.delay || 50 });
                    }
                    playwrightCommand = `await page.mouse.click(${centerX}, ${centerY}); await page.keyboard.type('${value}')`;
                    break;
                case som_types_1.InteractionAction.HOVER:
                    await this.page.mouse.move(centerX, centerY);
                    playwrightCommand = `await page.mouse.move(${centerX}, ${centerY})`;
                    break;
                default:
                    throw new Error(`Coordinate fallback not supported for action: ${action}`);
            }
            return {
                failedAttempts: [],
                successAttempt: {
                    command: playwrightCommand,
                    status: som_types_1.CommandRunStatus.SUCCESS
                },
                status: som_types_1.CommandRunStatus.SUCCESS
            };
        }
        catch (error) {
            return {
                failedAttempts: [{
                        command: `coordinate-based ${command.action}`,
                        status: som_types_1.CommandRunStatus.FAILURE,
                        error: error.message
                    }],
                error: `Coordinate fallback failed: ${error.message}`,
                status: som_types_1.CommandRunStatus.FAILURE
            };
        }
    }
    /**
     * Setup mutation observer to track DOM changes
     */
    async setupMutationObserver() {
        await this.page.evaluate(() => {
            const mutations = [];
            const observer = new MutationObserver((mutationsList) => {
                for (const mutation of mutationsList) {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === 1) { // Element node
                                const el = node;
                                const styles = window.getComputedStyle(el);
                                // Only track visible additions
                                if (styles.display !== 'none' && styles.visibility !== 'hidden') {
                                    mutations.push({
                                        type: 'added',
                                        elementDescription: `${el.tagName.toLowerCase()}${el.className ? '.' + el.className.split(' ')[0] : ''}`,
                                        timestamp: Date.now()
                                    });
                                }
                            }
                        });
                    }
                }
            });
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true
            });
            window.__tcSomMutationObserver = observer;
            window.__tcSomMutations = mutations;
        });
    }
    /**
     * Filter relevant mutations (exclude mass updates)
     */
    async filterRelevantMutations() {
        // Get mutations from page
        const mutations = await this.page.evaluate(() => {
            return window.__tcSomMutations || [];
        });
        // Filter: If too many mutations (>10), likely page rebuild - don't report
        if (mutations.length > 10) {
            this.logger?.(`[PageSoMHandler] ${mutations.length} mutations detected - too many, filtering out`, 'warn');
            return [];
        }
        // Return relevant mutations (tooltips, notices, message boxes)
        return mutations;
    }
    /**
     * Escape selector text
     */
    escapeSelector(text) {
        return text.replace(/'/g, "\\'").trim().substring(0, 50);
    }
    /**
     * Try refined selector with parent scoping
     */
    async tryRefinedSelector(typedSelector, command, element, originalError) {
        // Try parent scoping for generic locators (but avoid if already scoped)
        if (typedSelector.type === 'locator' && element.parent?.className) {
            const parentClass = element.parent.className.split(' ')[0];
            // Guard: Don't add parent if selector already includes it (prevent infinite recursion)
            if (parentClass && !typedSelector.value.includes(parentClass)) {
                const refinedSelector = {
                    type: 'locator',
                    value: `.${parentClass} ${typedSelector.value}`
                };
                const selectorDesc = this.formatSelector(refinedSelector);
                this.logger?.(`[PageSoMHandler] Trying refined selector with parent: ${selectorDesc}`, 'log');
                // Important: Don't call tryExecuteAction (would recurse), execute directly
                try {
                    const locator = this.buildLocatorFromTypedSelector(refinedSelector);
                    const refinedDesc = this.formatSelector(refinedSelector);
                    const playwrightCommand = await this.executeActionOnLocator(locator, command, refinedDesc);
                    return {
                        failedAttempts: [{
                                command: this.formatSelector(typedSelector),
                                status: som_types_1.CommandRunStatus.FAILURE,
                                error: originalError.message
                            }],
                        successAttempt: {
                            command: playwrightCommand,
                            status: som_types_1.CommandRunStatus.SUCCESS
                        },
                        status: som_types_1.CommandRunStatus.SUCCESS
                    };
                }
                catch (refinedError) {
                    // Parent scoping didn't help, fall through to failure
                    this.logger?.(`[PageSoMHandler] Refined selector also failed: ${refinedError.message}`, 'warn');
                }
            }
        }
        // Could implement nth() based on bbox position here
        const selectorDesc = this.formatSelector(typedSelector);
        return {
            failedAttempts: [{
                    command: selectorDesc,
                    status: som_types_1.CommandRunStatus.FAILURE,
                    error: originalError.message
                }],
            status: som_types_1.CommandRunStatus.FAILURE
        };
    }
}
exports.PageSoMHandler = PageSoMHandler;
