import { CommandRunStatus, SomCommand, SemanticCommandResult } from './som-types';
export { InteractionAction, CommandRunStatus, } from './som-types';
export type { Coordinate, CommandAttempt, DomMutation, SemanticCommandResult, SomElement, SomCommand, SomCommandOrVerification, SomVerification, TypedSelector, VerificationType, } from './som-types';
export interface AiActionResult {
    preCommands?: SomCommand[];
    extractedContentList?: string[];
    extractedContent?: string;
    confidence?: number;
    verificationSuccess?: boolean;
    verificationReason?: string;
    commandsToRun?: SomCommand[];
    shouldWait?: boolean;
    waitReason?: string;
    needsRetryAfterPreActions?: boolean;
    requestSomRefresh?: boolean;
    somRefreshReason?: string;
    stepCompleted?: boolean;
}
export interface AiActResult {
    command_results: SemanticCommandResult[];
    status: CommandRunStatus;
    error?: string;
}
