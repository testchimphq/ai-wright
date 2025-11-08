import {
  CommandRunStatus,
  InteractionAction,
  SomCommand,
  SemanticCommandResult,
} from './som-types';

export {
  InteractionAction,
  CommandRunStatus,
} from './som-types';

export type {
  Coordinate,
  CommandAttempt,
  DomMutation,
  SemanticCommandResult,
  SomElement,
  SomCommand,
  SomCommandOrVerification,
  SomVerification,
  TypedSelector,
  VerificationType,
} from './som-types';

export interface AiActionResult {
  preCommands?: SomCommand[];
  extractedContentList?: string[];
  extractedContent?: string;
  confidence?: number;
  verificationSuccess?: boolean;
  commandsToRun?: SomCommand[];
  shouldWait?: boolean;
  waitReason?: string;
  needsRetryAfterPreActions?: boolean;
}

export interface AiActResult {
  command_results: SemanticCommandResult[];
  status: CommandRunStatus;
  error?: string;
}
