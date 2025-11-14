import { AxiosError } from 'axios';
import { AiActionResult, InteractionAction, SomCommand } from './types';
import { LLMRequest } from './llm-providers/llm-provider';
import { resolveActiveLLMProvider } from './llm-providers/provider-registry';

const DEBUG_FLAG = 'AI_PLAYWRIGHT_DEBUG';

function isDebugEnvEnabled(): boolean {
  const value = process.env[DEBUG_FLAG];
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function debugLog(...messages: unknown[]): void {
  if (isDebugEnvEnabled()) {
    console.log('[ai-wright]', ...messages);
  }
}

const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;

type AiClientRequest = LLMRequest;

function parseTimeout(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getLLMCallTimeout(): number {
  return parseTimeout(process.env.LLM_CALL_TIMEOUT, DEFAULT_LLM_TIMEOUT_MS);
}

async function withRetry<T>(
  action: () => Promise<T>,
  retries: number = 3,
  delayMs: number = 250,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (retries <= 0 || !isRetryableError(error)) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return withRetry(action, retries - 1, delayMs * 2);
  }
}

function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  if ((error as AxiosError)?.response) {
    const status = (error as AxiosError).response!.status;
    return status >= 500;
  }
  return true;
}

function validateCoordinate(label: string, coord?: SomCommand['coord']): void {
  if (!coord) return;
  const { x, y } = coord;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${label} must contain numeric x and y values.`);
  }
}

function validateSomCommand(command: SomCommand): void {
  if (!Object.values(InteractionAction).includes(command.action)) {
    throw new Error(`Invalid InteractionAction: ${command.action}`);
  }
  validateCoordinate('SomCommand.coord', command.coord);
  validateCoordinate('SomCommand.fromCoord', command.fromCoord);
  validateCoordinate('SomCommand.toCoord', command.toCoord);
}

function validateAiActionResult(payload: unknown): AiActionResult {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('LLM response is not a JSON object.');
  }
  const result: AiActionResult = {};
  const data = payload as Record<string, unknown>;

  if (data.preCommands !== undefined) {
    if (!Array.isArray(data.preCommands)) {
      throw new Error('preCommands must be an array of SomCommand.');
    }
    result.preCommands = data.preCommands as SomCommand[];
    result.preCommands.forEach((command) => validateSomCommand(command));
  }

  if (data.commandsToRun !== undefined) {
    if (!Array.isArray(data.commandsToRun)) {
      throw new Error('commandsToRun must be an array of SomCommand.');
    }
    result.commandsToRun = data.commandsToRun as SomCommand[];
    result.commandsToRun.forEach((command) => validateSomCommand(command));
  }

  if (data.verificationSuccess !== undefined) {
    if (typeof data.verificationSuccess !== 'boolean') {
      throw new Error('verificationSuccess must be a boolean.');
    }
    result.verificationSuccess = data.verificationSuccess;
  }

  if (data.extractedContent !== undefined) {
    if (typeof data.extractedContent !== 'string') {
      throw new Error('extractedContent must be a string.');
    }
    result.extractedContent = data.extractedContent;
  }

  if (data.extractedContentList !== undefined) {
    if (!Array.isArray(data.extractedContentList)) {
      throw new Error('extractedContentList must be an array.');
    }
    result.extractedContentList = (data.extractedContentList as unknown[]).map((item) => {
      if (typeof item !== 'string') {
        throw new Error('extractedContentList must contain strings only.');
      }
      return item;
    });
  }

  if (data.shouldWait !== undefined) {
    if (typeof data.shouldWait !== 'boolean') {
      throw new Error('shouldWait must be a boolean.');
    }
    result.shouldWait = data.shouldWait;
  }

  if (data.waitReason !== undefined) {
    if (typeof data.waitReason !== 'string') {
      throw new Error('waitReason must be a string.');
    }
    result.waitReason = data.waitReason;
  }

  if (data.needsRetryAfterPreActions !== undefined) {
    if (typeof data.needsRetryAfterPreActions !== 'boolean') {
      throw new Error('needsRetryAfterPreActions must be a boolean.');
    }
    result.needsRetryAfterPreActions = data.needsRetryAfterPreActions;
  }

  if (data.stepCompleted !== undefined) {
    if (typeof data.stepCompleted !== 'boolean') {
      throw new Error('stepCompleted must be a boolean.');
    }
    result.stepCompleted = data.stepCompleted;
  }

  if (data.confidence !== undefined) {
    if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 100) {
      throw new Error('confidence must be a number between 0 and 100.');
    }
    result.confidence = data.confidence;
  }

  if (data.verificationReason !== undefined) {
    if (typeof data.verificationReason !== 'string') {
      throw new Error('verificationReason must be a string.');
    }
    result.verificationReason = data.verificationReason;
  }

  return result;
}

export async function callAiAction(request: AiClientRequest): Promise<AiActionResult> {
  const provider = resolveActiveLLMProvider();
  const timeoutMs = getLLMCallTimeout();

  debugLog('Calling AI action', {
    provider: provider.name,
    systemPromptLength: request.systemPrompt.length,
    userPromptLength: request.userPrompt.length,
    hasImage: Boolean(request.image),
  });

  const raw = await withRetry(async () => {
    const content = await provider.callLLM(request, { timeoutMs });
    if (!content) {
      throw new Error('LLM provider returned an empty response.');
    }
    debugLog('Received LLM response', { provider: provider.name, length: content.length });
    debugLog('LLM raw response content', content);
    return content;
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse LLM response as JSON: ${(error as Error).message}`);
  }

  return validateAiActionResult(parsed);
}

export { isDebugEnvEnabled as isDebugEnabled, debugLog };

export function getNavigationTimeout(): number {
  return Math.max(parseTimeout(process.env.NAVIGATION_COMMAND_TIMEOUT, NAVIGATION_TIMEOUT_MS), 0);
}

export function getCommandTimeout(): number {
  return Math.max(parseTimeout(process.env.COMMAND_EXEC_TIMEOUT, COMMAND_TIMEOUT_MS), 0);
}
