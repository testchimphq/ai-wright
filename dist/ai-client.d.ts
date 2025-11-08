import { AiActionResult } from './types';
declare function isDebugEnvEnabled(): boolean;
declare function debugLog(...messages: unknown[]): void;
interface AiClientRequest {
    systemPrompt: string;
    userPrompt: string;
    image?: string;
    secondaryImage?: string;
}
export declare function callAiAction(request: AiClientRequest): Promise<AiActionResult>;
export { isDebugEnvEnabled as isDebugEnabled, debugLog };
export declare function getNavigationTimeout(): number;
export declare function getCommandTimeout(): number;
