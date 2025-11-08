import type { Page } from '@playwright/test';
import { debugLog } from './ai-client';

type Logger = (message: string) => void;

type StabilizeOptions = {
  logger?: Logger;
  description?: string;
  networkIdleTimeoutMs?: number;
  domContentTimeoutMs?: number;
  ariaChecks?: number;
  ariaCheckIntervalMs?: number;
};

const DEFAULT_NETWORK_IDLE_TIMEOUT = 8000;
const DEFAULT_DOM_CONTENT_TIMEOUT = 8000;
const DEFAULT_ARIA_CHECKS = 5;
const DEFAULT_ARIA_CHECK_INTERVAL_MS = 2000;
const LOADING_PATTERN = /loading|spinner|please wait|processing|fetching|fetch data|retrieving|workbench/i;

export async function waitForPageStability(page: Page, options: StabilizeOptions = {}): Promise<void> {
  const {
    logger,
    description = 'page',
    networkIdleTimeoutMs = DEFAULT_NETWORK_IDLE_TIMEOUT,
    domContentTimeoutMs = DEFAULT_DOM_CONTENT_TIMEOUT,
    ariaChecks = DEFAULT_ARIA_CHECKS,
    ariaCheckIntervalMs = DEFAULT_ARIA_CHECK_INTERVAL_MS,
  } = options;

  debugLog('Stabilizing page before AI action', {
    description,
    networkIdleTimeoutMs,
    domContentTimeoutMs,
    ariaChecks,
    ariaCheckIntervalMs,
  });

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: domContentTimeoutMs });
  } catch (error) {
    debugLog('waitForLoadState(domcontentloaded) timed out', { error: (error as Error).message });
    logger?.(`[ai] ⚠️ domcontentloaded wait timed out for ${description}`);
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: networkIdleTimeoutMs });
  } catch (error) {
    debugLog('waitForLoadState(networkidle) timed out', { error: (error as Error).message });
    logger?.(`[ai] ⚠️ networkidle wait timed out for ${description}`);
  }

  await waitForLoadingToComplete(page, ariaChecks, ariaCheckIntervalMs, logger);

  // small buffer to let microtasks settle
  await page.waitForTimeout(200);

  debugLog('Page stabilization complete', { description });
}

async function waitForLoadingToComplete(
  page: Page,
  maxChecks: number,
  intervalMs: number,
  logger?: Logger,
): Promise<void> {
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
    } catch (error) {
      debugLog('Accessibility snapshot failed during loading check', { error: (error as Error).message });
      logger?.(`[ai] ⚠️ Failed to inspect accessibility tree: ${(error as Error).message}`);
      return;
    }
  }
  logger?.('[ai] ⚠️ Loading indicators still present after maximum checks, proceeding');
}

function checkSnapshotForLoading(node: any): boolean {
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
    return node.children.some((child: unknown) => checkSnapshotForLoading(child));
  }

  return false;
}
