import axios, { AxiosError } from 'axios';
import OpenAI from 'openai';
import { AiActionResult, InteractionAction, SomCommand } from './types';

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
    console.log('[ai-playwright]', ...messages);
  }
}

const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const NAVIGATION_TIMEOUT_MS = 15_000;

interface AiClientRequest {
  systemPrompt: string;
  userPrompt: string;
  image?: string; // Primary screenshot to attach (data URL)
  secondaryImage?: string; // Optional second screenshot (e.g., SOM markers)
}

type AuthConfig =
  | {
      kind: 'openai';
      client: OpenAI;
      model: string;
      timeout: number;
    }
  | {
      kind: 'testchimp';
      headers: Record<string, string>;
      endpoint: string;
      timeout: number;
    };

function parseTimeout(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getAuthConfig(): AuthConfig {
  debugLog('Selecting auth strategy...');
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  const timeout = parseTimeout(process.env.LLM_CALL_TIMEOUT, DEFAULT_LLM_TIMEOUT_MS);

  if (openAiKey) {
    debugLog(`Using OpenAI direct auth (model: ${process.env.OPENAI_MODEL?.trim() || 'gpt-5-mini'})`);
    const openai = new OpenAI({ apiKey: openAiKey });
    const model = process.env.OPENAI_MODEL?.trim() || 'gpt-5-mini';
    return {
      kind: 'openai',
      client: openai,
      model,
      timeout,
    };
  }

  const apiKey = process.env.TESTCHIMP_API_KEY?.trim();
  const projectId = process.env.TESTCHIMP_PROJECT_ID?.trim();
  const userAuthKey = process.env.TESTCHIMP_USER_AUTH_KEY?.trim();
  const userMail = process.env.TESTCHIMP_USER_MAIL?.trim();

  if (apiKey && projectId) {
    debugLog('Using TestChimp API key + project id auth');
    return {
      kind: 'testchimp',
      headers: {
        'TestChimp-Api-Key': apiKey,
        'project-id': projectId,
      },
      endpoint:
        (process.env.TESTCHIMP_BACKEND_URL?.trim() ||
          'https://featureservice.testchimp.io') + '/localagent/call_llm',
      timeout,
    };
  }

  if (userAuthKey && userMail) {
    debugLog('Using TestChimp user auth key + mail');
    return {
      kind: 'testchimp',
      headers: {
        user_auth_key: userAuthKey,
        user_mail: userMail,
      },
      endpoint:
        (process.env.TESTCHIMP_BACKEND_URL?.trim() ||
          'https://featureservice.testchimp.io') + '/localagent/call_llm',
      timeout,
    };
  }

  debugLog('Authentication failed: no usable credentials found');
  throw new Error(
    'Missing authentication. Provide OPENAI_API_KEY or TestChimp credentials (TESTCHIMP_API_KEY/TESTCHIMP_PROJECT_ID or TESTCHIMP_USER_AUTH_KEY/TESTCHIMP_USER_MAIL).',
  );
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

  if (data.confidence !== undefined) {
    if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 100) {
      throw new Error('confidence must be a number between 0 and 100.');
    }
    result.confidence = data.confidence;
  }

  return result;
}

type UserMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

function buildUserContent(
  userPrompt: string,
  image?: string,
  secondaryImage?: string,
): UserMessageContentPart[] {
  const content: UserMessageContentPart[] = [{ type: 'text', text: userPrompt }];

  if (secondaryImage) {
    content.push({ type: 'image_url', image_url: { url: secondaryImage } });
  }

  if (image) {
    content.push({ type: 'image_url', image_url: { url: image } });
  }

  return content;
}

export async function callAiAction(request: AiClientRequest): Promise<AiActionResult> {
  const auth = getAuthConfig();

  debugLog('Calling AI action', { systemPromptLength: request.systemPrompt.length, userPromptLength: request.userPrompt.length, hasImage: Boolean(request.image), hasSecondaryImage: Boolean(request.secondaryImage) });

  const raw = await withRetry(async () => {
    if (auth.kind === 'openai') {
      const response = await auth.client.chat.completions.create(
        {
          model: auth.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: request.systemPrompt },
            {
              role: 'user',
              content: buildUserContent(request.userPrompt, request.image, request.secondaryImage),
            },
          ],
        },
        { timeout: auth.timeout },
      );
      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Received empty response from OpenAI.');
      }
      debugLog('Received OpenAI response', { length: content.length });
      return content;
    }

    const { endpoint, headers, timeout } = auth;
    const payload: Record<string, unknown> = {
      system_prompt: request.systemPrompt,
      user_prompt: request.userPrompt,
      image_url: request.image,
    };
    if (request.secondaryImage) {
      payload['secondary_image_url'] = request.secondaryImage;
    }

    const response = await axios.post(endpoint, payload, { headers, timeout });
    const content = response.data?.answer;
    if (typeof content !== 'string') {
      throw new Error('TestChimp backend returned an unexpected response format.');
    }
    debugLog('Received TestChimp response', { length: content.length });
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
  return Math.max(parseTimeout(process.env.COMMAND_EXEC_TIMEOUT, 5_000), 0);
}
