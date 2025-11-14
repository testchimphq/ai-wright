/**
 * PageSoMHandler - Set-of-Marks Handler for Visual Element Identification
 * Manages SoM markers, canvas overlay, and semantic command execution
 */
import { SomCommand, SomElement, SemanticCommandResult, SomVerification } from './som-types';
type PlaywrightExpect = typeof import('@playwright/test').expect;
export declare function registerPlaywrightExpect(expectFn: PlaywrightExpect): void;
export declare class SomReannotationRequiredError extends Error {
    context?: Record<string, unknown>;
    constructor(message: string, context?: Record<string, unknown>);
}
export declare class PageSoMHandler {
    private page;
    private somMap;
    private canvasInjected;
    private mutationsList;
    private mutationObserver;
    private logger?;
    constructor(page: any, logger?: (message: string, level?: 'log' | 'error' | 'warn') => void);
    setPage(page: any): void;
    private disconnectMutationObserver;
    /**
     * Update SoM markers - extract interactive elements and draw overlay
     * Clears coordinate markers from previous iteration (agent can view via previous_screenshot tool)
     * @param includeOffscreen - If true, marks ALL elements including those below viewport (for full-page screenshots)
     */
    updateSom(includeOffscreen?: boolean, includeDisabled?: boolean): Promise<number>;
    /**
     * Draw canvas overlay with bounding boxes and ID labels
     */
    private drawSomOverlay;
    /**
     * Get formatted SoM element map for agent context
     * Returns concise, truncated element details to help disambiguate similar elements
     */
    getSomElementMap(): string;
    /**
     * Retrieve a SoM element by id for debugging/telemetry purposes
     */
    getSomElementById(somId: string | undefined | null): SomElement | undefined;
    private resolveSomTarget;
    /**
     * Get screenshot with optional SoM markers
     */
    getScreenshot(includeSomMarkers: boolean, fullPage?: boolean, quality?: number): Promise<string>;
    /**
     * Run command with semantic selector generation and coordinate fallback
     */
    runCommand(command: SomCommand, useSomIdBasedCommands?: boolean): Promise<SemanticCommandResult>;
    /**
     * Execute verification command and generate Playwright expect assertion
     * Uses semantic selectors (reuses generateSemanticSelectors) for script portability
     */
    executeVerification(verification: SomVerification): Promise<{
        success: boolean;
        playwrightCommand: string;
        error?: string;
    }>;
    /**
     * Generate typed semantic selectors from element details (no string parsing needed)
     */
    private generateSemanticSelectors;
    /**
     * Try executing action with a typed selector (no string parsing)
     */
    private tryExecuteAction;
    /**
     * Apply intelligent heuristics based on error type and retry
     */
    private applyHeuristicsAndRetry;
    /**
     * Build Playwright locator from typed selector (supports chaining)
     */
    private buildLocatorFromTypedSelector;
    /**
     * Format typed selector for logging (supports chaining)
     */
    private formatSelector;
    /**
     * Execute action on locator based on command type
     */
    private executeActionOnLocator;
    /**
     * Execute coordinate-based action as fallback
     */
    /**
     * Draw a visual marker at coordinate position (for debugging in headed mode)
     * Marker persists through screenshots so agent can see where coords landed
     */
    private drawCoordinateMarker;
    /**
     * Remove coordinate marker from page (used when cleaning up or replacing)
     */
    private removeCoordinateMarker;
    /**
     * Execute action using percentage-based coordinates
     */
    private executePercentageCoordinateAction;
    private executeCoordinateAction;
    /**
     * Setup mutation observer to track DOM changes
     */
    private setupMutationObserver;
    /**
     * Filter relevant mutations (exclude mass updates)
     */
    private filterRelevantMutations;
    /**
     * Escape selector text
     */
    private escapeSelector;
    /**
     * Try refined selector with parent scoping
     */
    private tryRefinedSelector;
}
export {};
