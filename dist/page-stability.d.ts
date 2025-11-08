import type { Page } from '@playwright/test';
type Logger = (message: string) => void;
type StabilizeOptions = {
    logger?: Logger;
    description?: string;
    networkIdleTimeoutMs?: number;
    domContentTimeoutMs?: number;
    ariaChecks?: number;
    ariaCheckIntervalMs?: number;
};
export declare function waitForPageStability(page: Page, options?: StabilizeOptions): Promise<void>;
export {};
