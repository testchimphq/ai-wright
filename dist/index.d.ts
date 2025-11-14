import type { Page } from '@playwright/test';
import { AiActResult } from './types';
type PlaywrightExpect = typeof import('@playwright/test').expect;
type PlaywrightTestApi = typeof import('@playwright/test').test;
type Logger = (message: string) => void;
type TestLike = PlaywrightTestApi | {
    expect?: PlaywrightExpect;
    setTimeout?: (timeout: number) => void;
    timeout?: number;
    info?: {
        startTime?: Date | number;
    };
};
type ActContext = {
    page: Page;
    logger?: Logger;
    expect?: PlaywrightExpect;
    test?: TestLike;
    testInfo?: {
        setTimeout?: (timeout: number) => void;
        expect?: PlaywrightExpect;
        timeout?: number;
        startTime?: Date | number;
    };
};
type VerifyContext = {
    page: Page;
    expect?: PlaywrightExpect;
    test?: TestLike;
    testInfo?: {
        setTimeout?: (timeout: number) => void;
        expect?: PlaywrightExpect;
        timeout?: number;
        startTime?: Date | number;
    };
};
type ExtractReturnType = 'string_array' | 'string' | 'int_array' | 'int';
type ExtractOptions = {
    return_type?: ExtractReturnType;
};
type VerifyOptions = {
    confidence_threshold?: number;
    expect?: PlaywrightExpect;
};
declare function act(objective: string, context: ActContext): Promise<AiActResult>;
declare function verify(requirement: string, context: VerifyContext, options?: VerifyOptions): Promise<{
    verificationSuccess: boolean;
    confidence: number;
    verificationReason: string | undefined;
}>;
declare function extract(requirement: string, context: VerifyContext, options?: ExtractOptions): Promise<string | string[] | number | number[]>;
export declare const ai: {
    act: typeof act;
    verify: typeof verify;
    extract: typeof extract;
};
export * from './types';
export { PageSoMHandler } from './som-handler';
