"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitForPageStability = waitForPageStability;
const ai_client_1 = require("./ai-client");
const DEFAULT_NETWORK_IDLE_TIMEOUT = 8000;
const DEFAULT_DOM_CONTENT_TIMEOUT = 8000;
const DEFAULT_ARIA_CHECKS = 5;
const DEFAULT_ARIA_CHECK_INTERVAL_MS = 2000;
const LOADING_PATTERN = /loading|spinner|please wait|processing|fetching|fetch data|retrieving|workbench/i;
async function waitForPageStability(page, options = {}) {
    const { logger, description = 'page', networkIdleTimeoutMs = DEFAULT_NETWORK_IDLE_TIMEOUT, domContentTimeoutMs = DEFAULT_DOM_CONTENT_TIMEOUT, ariaChecks = DEFAULT_ARIA_CHECKS, ariaCheckIntervalMs = DEFAULT_ARIA_CHECK_INTERVAL_MS, } = options;
    (0, ai_client_1.debugLog)('Stabilizing page before AI action', {
        description,
        networkIdleTimeoutMs,
        domContentTimeoutMs,
        ariaChecks,
        ariaCheckIntervalMs,
    });
    try {
        await page.waitForLoadState('domcontentloaded', { timeout: domContentTimeoutMs });
    }
    catch (error) {
        (0, ai_client_1.debugLog)('waitForLoadState(domcontentloaded) timed out', { error: error.message });
        logger?.(`[ai] ⚠️ domcontentloaded wait timed out for ${description}`);
    }
    try {
        await page.waitForLoadState('networkidle', { timeout: networkIdleTimeoutMs });
    }
    catch (error) {
        (0, ai_client_1.debugLog)('waitForLoadState(networkidle) timed out', { error: error.message });
        logger?.(`[ai] ⚠️ networkidle wait timed out for ${description}`);
    }
    await waitForLoadingToComplete(page, ariaChecks, ariaCheckIntervalMs, logger);
    // small buffer to let microtasks settle
    await page.waitForTimeout(200);
    (0, ai_client_1.debugLog)('Page stabilization complete', { description });
}
async function waitForLoadingToComplete(page, maxChecks, intervalMs, logger) {
    for (let attempt = 1; attempt <= maxChecks; attempt++) {
        try {
            const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
            const hasLoading = checkSnapshotForLoading(snapshot);
            if (!hasLoading) {
                if (attempt > 1) {
                    logger?.(`[ai] ✓ Loading indicators cleared after ${attempt - 1} check(s)`);
                }
                return;
            }
            if (attempt === 1) {
                logger?.('[ai] ⏳ Loading indicators detected, waiting...');
            }
            if (attempt < maxChecks) {
                await page.waitForTimeout(intervalMs);
            }
        }
        catch (error) {
            (0, ai_client_1.debugLog)('Accessibility snapshot failed during loading check', { error: error.message });
            logger?.(`[ai] ⚠️ Failed to inspect accessibility tree: ${error.message}`);
            return;
        }
    }
    logger?.('[ai] ⚠️ Loading indicators still present after maximum checks, proceeding');
}
function checkSnapshotForLoading(node) {
    if (!node) {
        return false;
    }
    const textFields = [node.name, node.description, node.value];
    if (textFields.some((text) => typeof text === 'string' && LOADING_PATTERN.test(text))) {
        return true;
    }
    if (node.role === 'progressbar' || node.role === 'status') {
        const indicatorText = node.name || node.description;
        if (typeof indicatorText === 'string' && LOADING_PATTERN.test(indicatorText)) {
            return true;
        }
    }
    if (node.busy === true || node['aria-busy'] === 'true') {
        return true;
    }
    if (Array.isArray(node.children)) {
        return node.children.some((child) => checkSnapshotForLoading(child));
    }
    return false;
}
