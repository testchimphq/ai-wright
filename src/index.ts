import type { Page } from '@playwright/test';
import { PageSoMHandler, registerPlaywrightExpect } from './som-handler';
import { waitForPageStability } from './page-stability';
import {
  AiActionResult,
  AiActResult,
  CommandRunStatus,
  InteractionAction,
  SemanticCommandResult,
  SomCommand,
} from './types';
import {
  callAiAction,
  getCommandTimeout,
  getNavigationTimeout,
  isDebugEnabled,
  debugLog,
} from './ai-client';

type PlaywrightExpect = typeof import('@playwright/test').expect;
type PlaywrightTestApi = typeof import('@playwright/test').test;

const SOM_ELEMENT_MAP_MAX_CHARS = 4000;
const DEFAULT_SCREENSHOT_QUALITY = 60;
const DEFAULT_CONFIDENCE_THRESHOLD = 70;
const DEFAULT_WAIT_RETRY_LIMIT = 2;

const DEFAULT_TEST_TIMEOUT_MS = 180_000;

function getDesiredTestTimeout(): number {
  const raw = process.env.AI_PLAYWRIGHT_TEST_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_TEST_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TEST_TIMEOUT_MS;
  }
  return parsed >= 0 ? parsed : DEFAULT_TEST_TIMEOUT_MS;
}

function extendTestTimeout(context: { test?: TestLike; testInfo?: { setTimeout?: (timeout: number) => void } }, reason: string): void {
  const desired = getDesiredTestTimeout();
  if (desired <= 0) {
    debugLog('Skipping test timeout extension (desired <= 0)', { reason });
    return;
  }

  const setter = resolveTimeoutSetter(context);
  if (setter) {
    debugLog('Extending test timeout', { desired, reason });
    try {
      setter(desired);
    } catch (error) {
      debugLog('Failed to extend test timeout', { error: (error as Error).message, desired, reason });
    }
  } else {
    debugLog('No test timeout setter available', { reason });
  }
}

function resolveTimeoutSetter(context: { test?: TestLike; testInfo?: { setTimeout?: (timeout: number) => void } }): ((timeout: number) => void) | undefined {
  const candidates: Array<((timeout: number) => void) | undefined> = [];
  if (context.test) {
    const testObj: any = context.test;
    if (typeof testObj.setTimeout === 'function') {
      candidates.push(testObj.setTimeout.bind(testObj));
    } else if (typeof testObj.timeout === 'function') {
      candidates.push(testObj.timeout.bind(testObj));
    }
  }
  if (context.testInfo?.setTimeout) {
    candidates.push(context.testInfo.setTimeout.bind(context.testInfo));
  }
  return candidates.find((fn) => typeof fn === 'function');
}

function resolveExpect(context: { expect?: PlaywrightExpect; test?: TestLike; testInfo?: { expect?: PlaywrightExpect } }): PlaywrightExpect | undefined {
  if (context.expect) {
    return context.expect;
  }
  const testObj: any = context.test;
  if (testObj && typeof testObj.expect === 'function') {
    return testObj.expect;
  }
  const testInfoObj: any = context.testInfo;
  if (testInfoObj && typeof testInfoObj.expect === 'function') {
    return testInfoObj.expect;
  }
  return undefined;
}

function getMaxWaitRetries(): number {
  const raw = process.env.AI_PLAYWRIGHT_MAX_WAIT_RETRIES?.trim();
  if (!raw) {
    return DEFAULT_WAIT_RETRY_LIMIT;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_WAIT_RETRY_LIMIT;
}

const ACT_PROMPT_HEADER = [
  '[SET-OF-MARKS MODE]',
  'Screenshot shows the entire page with colored bounding boxes and numeric labels.',
  'RULES FOR USING SoM:',
  '- Match the label color to the bounding box to identify elementRef.',
  '- Labels regenerate each run. Never rely on previous IDs.',
  '- When labels overlap: identify nearby IDs visually, then consult the element map to disambiguate.',
  '- Element map entries describe tag/text/aria attributes. Use them to pick the correct elementRef.',
  '- Always prefer elementRef interactions. Use coord/fromCoord/toCoord only if elementRef cannot perform the action.',
];

const ACT_PROTO_DEFINITION = [
  'Respond with JSON ONLY that matches this proto-style schema:',
  'message AiActionResult {',
  '  repeated SomCommand preCommands = 1;  // optional pre-actions to clear blockers',
  '  repeated SomCommand commandsToRun = 2; // main objective actions (only when ready)',
  '  optional bool needsRetryAfterPreActions = 3; // true when you expect to be re-invoked after preCommands',
  '  optional bool shouldWait = 4; // request additional stabilization wait (no commands in the same response)',
  '  optional string waitReason = 5;',
  '}',
  'message SomCommand {',
  '  string elementRef = 1;  // e.g. "1"',
  '  string action = 2;      // InteractionAction enum value',
  '  optional string value = 3;  // fill/type/select values',
  '  optional Coordinate coord = 4;      // coordinate click/press',
  '  optional Coordinate fromCoord = 5;  // drag start',
  '  optional Coordinate toCoord = 6;    // drag end',
  '}',
  'message Coordinate {',
  '  double x = 1;',
  '  double y = 2;',
  '}',
  'Your JSON output must use camelCase field names exactly as listed above.',
];

function buildActRules(actions: string): string[] {
  return [
    'Rules:',
    `- Allowed actions (InteractionAction enum values): ${actions}`,
    '- Output SomCommand objects ONLY. No plain-language narration, no Playwright code snippets.',
    '- Always target the SoM id that matches the marker in the screenshot (elementRef).',
    '- Prefer semantic actions (fill/select/click) on elementRef. Use coord/fromCoord/toCoord ONLY when elementRef cannot perform the action.',
    '- Drag-and-drop: supply both fromCoord and toCoord as percentages (0-100).',
    '- Buttons must use "click". Use "press" only for keyboard keys on focused inputs.',
    '- If text needs to be entered, include the fill action BEFORE submitting.',
    '- When blockers (modals, dialogs, consent banners) must be cleared, list those SomCommands in preCommands in the correct order.',
    '- Only populate commandsToRun when the main objective can be executed immediately.',
    '- If you expect another LLM call after preCommands, set needsRetryAfterPreActions = true and leave commandsToRun empty.',
    '- Do not include commandsToRun when needsRetryAfterPreActions = true or when shouldWait = true.',
    '- Do not include analysis, commentary, or verification commands outside the JSON structure.',
  ];
}

const VERIFY_PROMPT_STATIC = [
  'Respond with JSON ONLY that matches this schema exactly:',
  '{',
  '  "verificationSuccess": true,',
  '  "confidence": 95',
  '}',
  '',
  'Use camelCase field names (verificationSuccess, confidence).',
  'confidence must be between 0 and 100.',
  '',
];

function logDebug(message: string, details?: Record<string, unknown>): void {
  if (isDebugEnabled()) {
    if (details) {
      debugLog(message, details);
    } else {
      debugLog(message);
    }
  }
}

const EXTRACT_PROMPT_STATIC = [
  'Respond with JSON ONLY that matches this proto definition:',
  'message AiActionResult {',
  '  optional string extracted_content = 2;',
  '  repeated string extracted_content_list = 1;',
  '}',
  '',
  'Use camelCase field names in JSON: extractedContentList, extractedContent.',
  '- Populate extracted_content_list when returning a list of values.',
  '- Populate extracted_content when returning a single value.',
  '',
];

type Logger = (message: string) => void;

type TestLike = PlaywrightTestApi | { expect?: PlaywrightExpect; setTimeout?: (timeout: number) => void };

type ActContext = {
  page: Page;
  logger?: Logger;
  expect?: PlaywrightExpect;
  test?: TestLike;
  testInfo?: { setTimeout?: (timeout: number) => void; expect?: PlaywrightExpect };
};

type VerifyContext = {
  page: Page;
  expect?: PlaywrightExpect;
  test?: TestLike;
  testInfo?: { setTimeout?: (timeout: number) => void; expect?: PlaywrightExpect };
};

type ExtractReturnType = 'string_array' | 'string' | 'int_array' | 'int';

type ExtractOptions = {
  return_type?: ExtractReturnType;
};

type VerifyOptions = {
  confidence_threshold?: number;
  expect?: PlaywrightExpect;
};

function truncate(text: string, limit: number = SOM_ELEMENT_MAP_MAX_CHARS): string {
  if (!text) {
    return text;
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}\n... (truncated)`;
}

function buildActSystemPrompt(): string {
  return 'You are an expert UI automation agent that outputs Playwright SomCommands in JSON only.';
}

function buildActUserPrompt(objective: string, somElementMap: string, waitCount: number, maxWaits: number): string {
  const actions = Object.values(InteractionAction).join(', ');
  return [
    ...ACT_PROMPT_HEADER,
    ...ACT_PROTO_DEFINITION,
    ...buildActRules(actions),
    '',
    'Pre-action and wait instructions:',
    '- Place unexpected blockers (modals, banners, dialogs) in preCommands so they run before the main objective.',
    '- When the main objective still cannot run after those steps, set needsRetryAfterPreActions = true and leave commandsToRun empty so the agent re-queries.',
    '- Use shouldWait = true only when the page is still loading and no actions should run yet; when shouldWait is true, both preCommands and commandsToRun must be empty.',
    '- Provide waitReason to explain what you are waiting for when shouldWait = true.',
    '- When you supply commandsToRun, shouldWait must be false and needsRetryAfterPreActions must be false.',
    `Wait context: wait_attempts_used = ${waitCount}, max_wait_attempts = ${maxWaits}.`,
    '',
    'Objective: ' + objective,
    '',
    'SoM ELEMENT MAP (for disambiguation):',
    truncate(somElementMap),
    '',
  ].join('\n');
}

function buildVerifySystemPrompt(): string {
  return 'You evaluate UI screenshots to verify requirements. Respond with JSON only.';
}

function buildVerifyUserPrompt(requirement: string): string {
  return [
    ...VERIFY_PROMPT_STATIC,
    'Requirement: ' + requirement,
    '',
  ].join('\n');
}

function buildExtractSystemPrompt(): string {
  return 'You extract structured information from UI screenshots. Respond with JSON only.';
}

function buildExtractUserPrompt(requirement: string, returnType: ExtractReturnType): string {
  return [
    ...EXTRACT_PROMPT_STATIC,
    'Return type requested: ' + returnType,
    '',
    'Requirement: ' + requirement,
    '',
  ].join('\n');
}

function isNavigationAction(action: InteractionAction): boolean {
  return (
    action === InteractionAction.NAVIGATE ||
    action === InteractionAction.GO_BACK ||
    action === InteractionAction.GO_FORWARD ||
    action === InteractionAction.RELOAD
  );
}

function createTimeoutFailure(command: SomCommand, message: string): SemanticCommandResult {
  return {
    failedAttempts: [
      {
        command: command.action,
        status: CommandRunStatus.FAILURE,
        error: message,
      },
    ],
    status: CommandRunStatus.FAILURE,
    error: message,
  };
}

async function executeSomCommand(
  handler: PageSoMHandler,
  command: SomCommand,
  timeoutMs: number,
): Promise<SemanticCommandResult> {
  let resolved = false;
  let timeout: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<SemanticCommandResult>((resolve) => {
    timeout = setTimeout(() => {
      resolved = true;
      resolve(createTimeoutFailure(command, `Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const runPromise = handler
    .runCommand(command)
    .then((result) => {
      if (!resolved && timeout) {
        clearTimeout(timeout);
      }
      return result;
    })
    .catch((error: Error) => {
      if (!resolved && timeout) {
        clearTimeout(timeout);
      }
      return {
        failedAttempts: [
          {
            command: command.action,
            status: CommandRunStatus.FAILURE,
            error: error.message,
          },
        ],
        status: CommandRunStatus.FAILURE,
        error: error.message,
      };
    });

  const result = await Promise.race([runPromise, timeoutPromise]);
  if (!resolved && timeout) {
    clearTimeout(timeout);
  }
  return result;
}

async function capturePageScreenshot(page: Page, fullPage: boolean): Promise<string> {
  const buffer = await page.screenshot({
    fullPage,
    type: 'jpeg',
    quality: DEFAULT_SCREENSHOT_QUALITY,
  });
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

async function captureSomScreenshot(handler: PageSoMHandler): Promise<string> {
  return handler.getScreenshot(true, false, DEFAULT_SCREENSHOT_QUALITY);
}

function ensureCommands(result: AiActionResult): SomCommand[] {
  if (!result.commandsToRun || result.commandsToRun.length === 0) {
    logDebug('LLM returned no commands to run', { result });
    throw new Error('LLM did not return any commands to run.');
  }
  logDebug('LLM returned commands', { count: result.commandsToRun.length, commands: result.commandsToRun });
  return result.commandsToRun;
}

function extractVerification(result: AiActionResult): { verificationSuccess: boolean; confidence: number } {
  if (result.verificationSuccess === undefined) {
    throw new Error('LLM response missing verificationSuccess field.');
  }
  if (result.confidence === undefined) {
    throw new Error('LLM response missing confidence field.');
  }
  return {
    verificationSuccess: result.verificationSuccess,
    confidence: result.confidence,
  };
}

function castToNumber(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric value for ${fieldName}, received: ${value}`);
  }
  return parsed;
}

function castStringArrayToNumbers(values: string[], fieldName: string): number[] {
  return values.map((value) => castToNumber(value, fieldName));
}

function computeExtractResult(result: AiActionResult, options?: ExtractOptions): string | string[] | number | number[] {
  const returnType: ExtractReturnType = options?.return_type || 'string';
  const list = result.extractedContentList ?? [];
  const content = result.extractedContent;

  if (!content && list.length === 0) {
    throw new Error('LLM response did not include extracted content.');
  }

  switch (returnType) {
    case 'string_array':
      return list.length > 0 ? list : content ? [content] : [];
    case 'int_array':
      return castStringArrayToNumbers(list.length > 0 ? list : content ? [content] : [], 'extractedContentList');
    case 'int':
      if (content) {
        return castToNumber(content, 'extractedContent');
      }
      if (list.length === 1) {
        return castToNumber(list[0], 'extractedContentList');
      }
      throw new Error('Expected a single numeric value in extractedContent.');
    case 'string':
    default: {
      if (list.length > 1) {
        return list;
      }
      if (list.length === 1) {
        return list[0];
      }
      if (content) {
        return content;
      }
      throw new Error('Expected extractedContent to be a string.');
    }
  }
}

async function act(objective: string, context: ActContext): Promise<AiActResult> {
  if (!context?.page) {
    throw new Error('act() requires a Playwright page instance.');
  }

  logDebug('ai.act invoked', { objective });
  extendTestTimeout(context, 'ai.act');

  const expectFn = resolveExpect(context);
  if (expectFn) {
    logDebug('Registering Playwright expect for ai.act');
    registerPlaywrightExpect(expectFn);
  }

  const handler = new PageSoMHandler(context.page, context.logger);
  const waitRetryLimit = getMaxWaitRetries();
  let waitCount = 0;
  let preActionRetryCount = 0;
  const aggregateResults: SemanticCommandResult[] = [];

  while (true) {
    logDebug('Waiting for page stability before SoM capture', { waitCount, waitRetryLimit, preActionRetryCount });
    await waitForPageStability(context.page, {
      logger: context.logger,
      description: `ai.act objective: ${objective}`,
    });

    await handler.updateSom(false);
    const somMap = handler.getSomElementMap();
    logDebug('SoM element map generated', { length: somMap.length });
    const somScreenshot = await captureSomScreenshot(handler);
    logDebug('Captured SoM screenshot', { bytes: somScreenshot.length });

    const aiResult = await callAiAction({
      systemPrompt: buildActSystemPrompt(),
      userPrompt: buildActUserPrompt(objective, somMap, waitCount, waitRetryLimit),
      image: somScreenshot,
    });

    logDebug('AI action result received', { aiResult });

    if (aiResult.shouldWait) {
      logDebug('LLM requested additional stabilization wait', {
        waitCount,
        waitRetryLimit,
        waitReason: aiResult.waitReason,
        commands: aiResult.commandsToRun?.length,
        preCommands: aiResult.preCommands?.length,
      });
      if (aiResult.preCommands && aiResult.preCommands.length > 0) {
        logDebug('Ignoring preCommands because shouldWait=true', { preCommands: aiResult.preCommands });
      }
      if (aiResult.commandsToRun && aiResult.commandsToRun.length > 0) {
        logDebug('Ignoring commands because shouldWait=true', { commands: aiResult.commandsToRun });
      }
      if (waitCount >= waitRetryLimit) {
        throw new Error(`LLM requested wait beyond max attempts (${waitRetryLimit}).`);
      }
      waitCount += 1;
      continue;
    }

    const preCommands = aiResult.preCommands ?? [];
    if (preCommands.length > 0) {
      logDebug('Executing pre-commands', { count: preCommands.length });
      for (const command of preCommands) {
        const timeout = isNavigationAction(command.action)
          ? getNavigationTimeout()
          : getCommandTimeout();
        const result = await executeSomCommand(handler, command, timeout);
        logDebug('Executed pre-command', {
          command,
          status: result.status,
          successAttempt: result.successAttempt,
          failedAttempts: (result.failedAttempts || []).map((attempt) => ({
            command: attempt.command,
            status: attempt.status,
            error: attempt.error,
          })),
          error: result.error,
        });
        aggregateResults.push(result);
        if (result.status === CommandRunStatus.FAILURE) {
          const failureMessage = [
            `AI action failed during pre-commands for objective: ${objective}`,
            result.error ? `Last error: ${result.error}` : undefined,
            result.failedAttempts ? `Attempts: ${JSON.stringify(result.failedAttempts)}` : undefined,
          ]
            .filter(Boolean)
            .join('\n');
          logDebug('ai.act failed during pre-commands', { command, result });
          throw new Error(failureMessage || 'Pre-action command failed.');
        }
      }

      logDebug('Pre-commands completed successfully', { count: preCommands.length });
      logDebug('Waiting for page stability after pre-commands', { objective });
      await waitForPageStability(context.page, {
        logger: context.logger,
        description: `post-preCommands for ai.act objective: ${objective}`,
      });
    }

    if (aiResult.needsRetryAfterPreActions) {
      logDebug('LLM requested retry after pre-actions', {
        waitCount,
        waitRetryLimit,
        preActionRetryCount,
        commands: aiResult.commandsToRun?.length,
      });
      if (aiResult.commandsToRun && aiResult.commandsToRun.length > 0) {
        logDebug('Ignoring commands because needsRetryAfterPreActions=true', { commands: aiResult.commandsToRun });
      }
      if (preActionRetryCount >= waitRetryLimit) {
        throw new Error(`LLM requested retry after pre-actions beyond max attempts (${waitRetryLimit}).`);
      }
      preActionRetryCount += 1;
      waitCount = 0;
      continue;
    }

    const commands = ensureCommands(aiResult);
    let status: CommandRunStatus = CommandRunStatus.SUCCESS;
    let lastError: string | undefined;
    let failedCommand: SomCommand | undefined;

    for (const command of commands) {
      const timeout = isNavigationAction(command.action)
        ? getNavigationTimeout()
        : getCommandTimeout();
      const result = await executeSomCommand(handler, command, timeout);
      logDebug('Executed command', {
        command,
        status: result.status,
        successAttempt: result.successAttempt,
        failedAttempts: (result.failedAttempts || []).map((attempt) => ({
          command: attempt.command,
          status: attempt.status,
          error: attempt.error,
        })),
        error: result.error,
      });
      aggregateResults.push(result);
      if (result.status === CommandRunStatus.FAILURE) {
        status = CommandRunStatus.FAILURE;
        lastError = result.error;
        failedCommand = command;
        break;
      }
    }

    const response = {
      command_results: aggregateResults,
      status,
      error: lastError,
    };

    if (status === CommandRunStatus.FAILURE) {
      const failedResult = aggregateResults[aggregateResults.length - 1];
      logDebug('ai.act failed', { response, failedCommand });
      const failureMessage = [
        `AI action failed for objective: ${objective}`,
        lastError ? `Last error: ${lastError}` : undefined,
        failedResult?.failedAttempts ? `Attempts: ${JSON.stringify(failedResult.failedAttempts)}` : undefined,
      ]
        .filter(Boolean)
        .join('\n');
      throw new Error(failureMessage || 'AI action failed with unknown error.');
    }

    logDebug('ai.act completed', response);
    return response;
  }
}
async function verify(
  requirement: string,
  context: VerifyContext,
  options?: VerifyOptions,
) {
  if (!context?.page) {
    throw new Error('verify() requires a Playwright page instance.');
  }

  logDebug('ai.verify invoked', { requirement });
  extendTestTimeout(context, 'ai.verify');

  const screenshot = await capturePageScreenshot(context.page, true);
  const aiResult = await callAiAction({
    systemPrompt: buildVerifySystemPrompt(),
    userPrompt: buildVerifyUserPrompt(requirement),
    image: screenshot,
  });

  const { verificationSuccess, confidence } = extractVerification(aiResult);
  logDebug('ai.verify result from LLM', { verificationSuccess, confidence });
  const threshold = Math.max(0, options?.confidence_threshold ?? DEFAULT_CONFIDENCE_THRESHOLD);
  const expectFn = options?.expect ?? resolveExpect(context);
  if (!expectFn) {
    throw new Error('verify() requires Playwright expect. Pass the Playwright test object or provide expect explicitly.');
  }

  logDebug('ai.verify asserting', { threshold });

  expectFn(
    confidence,
    `AI verification confidence ${confidence} is below threshold ${threshold}`,
  ).toBeGreaterThanOrEqual(threshold);
  expectFn(verificationSuccess, `AI verification failed for requirement: ${requirement}`).toBe(true);

  const response = { verificationSuccess, confidence };
  logDebug('ai.verify completed', response);
  return response;
}

async function extract(
  requirement: string,
  context: VerifyContext,
  options?: ExtractOptions,
): Promise<string | string[] | number | number[]> {
  if (!context?.page) {
    throw new Error('extract() requires a Playwright page instance.');
  }

  logDebug('ai.extract invoked', { requirement, returnType: options?.return_type || 'string' });
  extendTestTimeout(context, 'ai.extract');

  const screenshot = await capturePageScreenshot(context.page, true);
  const aiResult = await callAiAction({
    systemPrompt: buildExtractSystemPrompt(),
    userPrompt: buildExtractUserPrompt(requirement, options?.return_type || 'string'),
    image: screenshot,
  });

  logDebug('ai.extract result from LLM', { aiResult });
  const extracted = computeExtractResult(aiResult, options);
  logDebug('ai.extract completed', { extracted });
  return extracted;
}

export const ai = {
  act,
  verify,
  extract,
};

export * from './types';
export { PageSoMHandler } from './som-handler';
