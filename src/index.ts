import type { Page } from '@playwright/test';
import { PageSoMHandler, registerPlaywrightExpect, SomReannotationRequiredError } from './som-handler';
import { waitForPageStability } from './page-stability';
import {
  AiActionResult,
  AiActResult,
  CommandRunStatus,
  InteractionAction,
  SemanticCommandResult,
  SomCommand,
  SomElement,
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
const DEFAULT_OBJECTIVE_ITERATION_LIMIT = 5;

const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const DEFAULT_PAGE_TIMEOUT_MS = 30_000;
const NAVIGATION_RETRY_DELAY_MS = 1_000;
const MIN_WAIT_FOR_DURATION_MS = 5_000;
const MAX_WAIT_FOR_DURATION_MS = 30_000;

function clampWaitDuration(seconds: number | undefined | null): number {
  const ms = seconds != null ? seconds * 1000 : MIN_WAIT_FOR_DURATION_MS;
  return Math.min(Math.max(ms, MIN_WAIT_FOR_DURATION_MS), MAX_WAIT_FOR_DURATION_MS);
}

type TimeoutSetterInfo = {
  set: (timeout: number) => void;
  owner: object;
};

type TimeoutState = {
  baselineTimeoutMs: number;
  startTimeMs: number;
  lastAppliedTimeoutMs?: number;
};

const testTimeoutStates = new WeakMap<object, TimeoutState>();
const pageTimeoutStates = new WeakMap<object, TimeoutState>();

function summarizeSomElement(element: SomElement): Record<string, unknown> {
  const {
    somId,
    tag,
    role,
    text,
    ariaLabel,
    labelText,
    placeholder,
    name,
    type,
    id,
    className,
    bbox,
    hasVisiblePseudoElement,
  } = element;

  return {
    somId,
    tag,
    role,
    text,
    ariaLabel,
    labelText,
    placeholder,
    name,
    type,
    id,
    className,
    bbox,
    hasVisiblePseudoElement,
  };
}

function logCommandSomContext(
  stage: 'preCommand' | 'command',
  command: SomCommand,
  handler: PageSoMHandler,
): void {
  const payload: Record<string, unknown> = {
    stage,
    command,
  };

  if (command.elementRef) {
    const somElement = handler.getSomElementById(command.elementRef);
    payload.elementRef = command.elementRef;

    if (somElement) {
      payload.somElement = summarizeSomElement(somElement);
    } else {
      payload.somElement = null;
      payload.somElementMissing = true;
    }
  }

  logDebug('ai.act command context', payload);
}

class NavigationInProgressError extends Error {
  context?: Record<string, unknown>;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'NavigationInProgressError';
    this.context = context;
  }
}

function safeToString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unserializable]';
  }
}

function normalizeAttempt(
  attempt: SemanticCommandResult['failedAttempts'][number],
): {
  command: string;
  status: CommandRunStatus;
  error?: string;
} {
  const command =
    typeof attempt.command === 'string' && attempt.command.length > 0
      ? attempt.command
      : 'unknown';
  const error =
    typeof attempt.error === 'string'
      ? attempt.error
      : attempt.error != null
        ? safeToString(attempt.error)
        : undefined;

  return error ? { command, status: attempt.status, error } : { command, status: attempt.status };
}

function formatFailedAttemptsLine(
  attempts?: SemanticCommandResult['failedAttempts'],
): string | undefined {
  if (!attempts || attempts.length === 0) {
    return undefined;
  }

  const normalized = attempts.map(normalizeAttempt);

  try {
    return `Attempts: ${JSON.stringify(normalized)}`;
  } catch {
    const fallback = normalized
      .map(({ command, status, error }) => [command, status, error].filter(Boolean).join(' | '))
      .join('; ');
    return `Attempts: ${fallback}`;
  }
}

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

function resolveStartTimeMs(candidate: unknown): number | undefined {
  if (!candidate) {
    return undefined;
  }
  if (candidate instanceof Date) {
    return candidate.getTime();
  }
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    return candidate;
  }
  return undefined;
}

function getOrCreateTestTimeoutState(
  owner: object,
  context: { test?: TestLike; testInfo?: { timeout?: number; startTime?: Date | number } },
): TimeoutState {
  let existing = testTimeoutStates.get(owner);
  if (existing) {
    return existing;
  }

  const startTimeFromInfo = resolveStartTimeMs((context.testInfo as any)?.startTime);
  const startTimeFromTest = resolveStartTimeMs((context.test as any)?.info?.startTime);
  const fallbackStart = Date.now();

  const timeoutFromInfo = (context.testInfo as any)?.timeout;
  const timeoutFromTest =
    typeof (context.test as any)?.timeout === 'function'
      ? undefined
      : (context.test as any)?.timeout;

  const baseline =
    typeof timeoutFromInfo === 'number' && timeoutFromInfo > 0
      ? timeoutFromInfo
      : typeof timeoutFromTest === 'number' && timeoutFromTest > 0
        ? timeoutFromTest
        : DEFAULT_TEST_TIMEOUT_MS;

  existing = {
    baselineTimeoutMs: baseline,
    startTimeMs: startTimeFromInfo ?? startTimeFromTest ?? fallbackStart,
    lastAppliedTimeoutMs: baseline,
  };
  testTimeoutStates.set(owner, existing);
  return existing;
}

function getOrCreatePageTimeoutState(page: any): TimeoutState {
  let existing = pageTimeoutStates.get(page);
  if (existing) {
    return existing;
  }

  let baseline = DEFAULT_PAGE_TIMEOUT_MS;
  try {
    const timeoutSettings = (page as any)?._timeoutSettings;
    const defaultTimeout =
      timeoutSettings?.timeout?.() ??
      timeoutSettings?._timeout ??
      (typeof page?.timeout === 'number' ? page.timeout : undefined);
    if (typeof defaultTimeout === 'number' && defaultTimeout > 0) {
      baseline = defaultTimeout;
    }
  } catch {
    // ignore – accessing Playwright internals is best-effort only
  }

  existing = {
    baselineTimeoutMs: baseline,
    startTimeMs: Date.now(),
    lastAppliedTimeoutMs: baseline,
  };
  pageTimeoutStates.set(page, existing);
  return existing;
}

function extendTestTimeout(
  context: { test?: TestLike; testInfo?: { setTimeout?: (timeout: number) => void; timeout?: number; startTime?: Date | number }; page?: any },
  reason: string,
): void {
  const desired = getDesiredTestTimeout();
  if (desired <= 0) {
    return;
  }

  // Try test.setTimeout() first (works in normal Playwright tests)
  const setterInfo = resolveTimeoutSetter(context);
  if (setterInfo) {
    try {
      const state = getOrCreateTestTimeoutState(setterInfo.owner, context);
      const elapsedMs = Math.max(0, Date.now() - state.startTimeMs);
      const nextTotal = Math.max(state.baselineTimeoutMs, elapsedMs + desired);
      setterInfo.set(nextTotal);
      state.lastAppliedTimeoutMs = nextTotal;
      debugLog('Extended test timeout via Playwright test context', {
        reason,
        desiredExtensionMs: desired,
        elapsedMs,
        newTimeoutBudgetMs: nextTotal,
      });
      return;
    } catch (error) {
      // Expected: "test.setTimeout() can only be called from a test"
      // Fall through to page timeout fallback
      debugLog('test.setTimeout failed, using page timeout fallback', { 
        error: error instanceof Error ? error.message : String(error),
        reason 
      });
    }
  }
  
  // Fallback: Set page timeout (works in runner-core VM context)
  if (context.page?.setDefaultTimeout) {
    try {
      const state = getOrCreatePageTimeoutState(context.page);
      const elapsedMs = Math.max(0, Date.now() - state.startTimeMs);
      const nextTotal = Math.max(state.baselineTimeoutMs, elapsedMs + desired);
      context.page.setDefaultTimeout(nextTotal);
      context.page.setDefaultNavigationTimeout?.(nextTotal);
      state.lastAppliedTimeoutMs = nextTotal;
      debugLog('Extended page timeouts for AI action', {
        reason,
        desiredExtensionMs: desired,
        elapsedMs,
        newTimeoutBudgetMs: nextTotal,
      });
    } catch (error) {
      debugLog('page.setDefaultTimeout failed', { 
        error: error instanceof Error ? error.message : String(error),
        reason 
      });
    }
  }
}

function resolveTimeoutSetter(
  context: { test?: TestLike; testInfo?: { setTimeout?: (timeout: number) => void } },
): TimeoutSetterInfo | undefined {
  const candidates: TimeoutSetterInfo[] = [];
  if (context.test) {
    const testObj: any = context.test;
    if (typeof testObj.setTimeout === 'function') {
      candidates.push({ set: testObj.setTimeout.bind(testObj), owner: testObj });
    } else if (typeof testObj.timeout === 'function') {
      candidates.push({ set: testObj.timeout.bind(testObj), owner: testObj });
    }
  }
  if (context.testInfo?.setTimeout) {
    candidates.push({ set: context.testInfo.setTimeout.bind(context.testInfo), owner: context.testInfo });
  }
  return candidates.find((info) => typeof info.set === 'function');
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

function getMaxObjectiveIterations(): number {
  const raw = process.env.AI_PLAYWRIGHT_MAX_OBJECTIVE_ITERATIONS?.trim();
  if (!raw) {
    return DEFAULT_OBJECTIVE_ITERATION_LIMIT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_OBJECTIVE_ITERATION_LIMIT;
  }
  const value = Math.floor(parsed);
  return value > 0 ? value : DEFAULT_OBJECTIVE_ITERATION_LIMIT;
}

const ACT_PROMPT_HEADER = [
  '[SET-OF-MARKS MODE]',
  'Screenshot shows the entire page with colored bounding boxes and numeric labels.',
  'RULES FOR USING SoM:',
  '- Match the label color to the bounding box to identify elementRef.',
  '- Labels regenerate each run. Never rely on previous IDs.',
  '- When labels overlap: identify nearby IDs visually, then consult the element map to disambiguate.',
  '- Element map entries describe tag/text/aria attributes. Use them to pick the correct elementRef.',
  '- Canvas elements (tag="canvas") represent entire canvas surfaces. To interact with elements drawn inside a canvas, use elementRef pointing to the canvas and elementRelativeAbsoluteCoords for pixel coordinates within the canvas.',
  '- Always prefer elementRef interactions. Use coord/fromCoord/toCoord only if elementRef cannot perform the action.',
];

const ACT_PROTO_DEFINITION = [
  'Respond with JSON ONLY that matches this proto-style schema:',
  'message AiActionResult {',
  '  repeated SomCommand preCommands = 1;  // optional pre-actions to clear blockers',
  '  repeated SomCommand commandsToRun = 2; // main objective actions (only when ready)',
  '  optional bool needsRetryAfterPreActions = 3; // true when you expect to be re-invoked after preCommands',
  '  optional bool shouldWait = 4;',
  '  optional string waitReason = 5;',
  '  optional bool requiresFurtherAction = 6; // true when only partial progress was possible',
  '  optional string completedObjectiveSummary = 7; // summary of what the returned commands achieve',
  '  optional string nextObjective = 8; // remaining objective when requiresFurtherAction=true',
  '  optional bool requestSomRefresh = 9; // set true to ask orchestrator for SoM refresh (commandsToRun must be empty)',
  '  optional string somRefreshReason = 10;',
  '  optional bool stepCompleted = 11; // set true when the objective is already satisfied (commandsToRun must be empty)',
  '}',
  'message SomCommand {',
  '  string elementRef = 1;  // e.g. "1"',
  '  string action = 2;      // InteractionAction enum value',
  '  optional string value = 3;  // fill/type/select values',
  '  optional Coordinate coord = 4;      // coordinate click/press',
  '  optional Coordinate fromCoord = 5;  // drag start',
  '  optional Coordinate toCoord = 6;    // drag end',
  '  optional double durationSeconds = 7; // for waitFor commands',
  '  optional Coordinate elementRelativeAbsoluteCoords = 8; // pixel coordinates relative to elementRef (for canvas interactions)',
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
    '- For canvas elements (tag="canvas" in element map): when interacting with elements drawn inside the canvas, use elementRef pointing to the canvas element AND elementRelativeAbsoluteCoords with pixel coordinates (x, y) from the canvas top-left corner.',
    '- elementRelativeAbsoluteCoords contains absolute pixel values, not percentages. Use this ONLY when elementRef points to a canvas element.',
    '- Confirm the referenced elementRef exists in the SoM element map and appears ready before returning commands.',
    '- Drag-and-drop: supply both fromCoord and toCoord as percentages (0-100).',
    '- Buttons must use "click". Use "press" only for keyboard keys on focused inputs.',
    '- If text needs to be entered, include the fill action BEFORE submitting.',
    '- When blockers (modals, dialogs, consent banners) must be cleared, list those SomCommands in preCommands in the correct order.',
    '- Only populate commandsToRun when the main objective can be executed immediately.',
    '- If you expect another LLM call after preCommands, set needsRetryAfterPreActions = true and leave commandsToRun empty.',
    '- If only part of the objective can be achieved now, return the commands for the completed portion, set requiresFurtherAction = true, provide completedObjectiveSummary, and specify nextObjective for the remaining work.',
    '- Use requestSomRefresh = true when the SoM overlay needs to be regenerated (commandsToRun must be empty in that case).',
    '- Use WAIT_FOR commands when additional time is required; provide durationSeconds or value in seconds.',
    '- WAIT_FOR ignores elementRef; leave elementRef empty for pure waits.',
    '- Never hallucinate commands for screens you cannot currently see or interact with.',
    '- When the objective is already satisfied, set stepCompleted = true, optionally describe the outcome in completedObjectiveSummary, and leave commandsToRun empty.',
    '- commandsToRun may be empty ONLY when stepCompleted = true, shouldWait = true, or requestSomRefresh = true.',
    '- Do not include commandsToRun when needsRetryAfterPreActions = true or when shouldWait = true.',
    '- Do not include analysis, commentary, or verification commands outside the JSON structure.',
  ];
}

const VERIFY_PROMPT_STATIC = [
  'Respond with JSON ONLY that matches this schema exactly:',
  '{',
  '  "verificationSuccess": true,',
  '  "confidence": 95,',
  '  "verificationReason": "why verificationSuccess is false (empty string when true)"',
  '}',
  '',
  'Use camelCase field names (verificationSuccess, confidence, verificationReason).',
  'confidence must be between 0 and 100.',
  'When verificationSuccess is false, provide verificationReason explaining the failure.',
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

type TestLike = PlaywrightTestApi | {
  expect?: PlaywrightExpect;
  setTimeout?: (timeout: number) => void;
  timeout?: number;
  info?: { startTime?: Date | number };
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

function isNavigationError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const message =
    typeof (error as any).message === 'string'
      ? (error as any).message
      : typeof error === 'string'
        ? error
        : '';
  if (!message) {
    return false;
  }
  const patterns = [
    'Execution context was destroyed',
    'Target closed',
    'Navigation failed because page crashed',
    'Navigation failed because browser has disconnected',
    'Most likely the page has been closed',
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

async function stabilizeForLlm<T>({
  context,
  description,
  waitCount,
  waitRetryLimit,
  backoffMs,
  prepare,
}: {
  context: ActContext | VerifyContext;
  description: string;
  waitCount: number;
  waitRetryLimit: number;
  backoffMs: number;
  prepare: () => Promise<T>;
}): Promise<{ data: T; waitCount: number }> {
  const page = context.page;
  if (!page) {
    throw new Error('Missing page instance for stabilization.');
  }

  let attemptsUsed = waitCount;

  while (true) {
    if (attemptsUsed > waitCount && backoffMs > 0) {
      logDebug('Navigation detected, backing off before stabilization', {
        description,
        delayMs: backoffMs,
        attemptsUsed,
        waitRetryLimit,
      });
      await page.waitForTimeout(backoffMs);
    }

    logDebug('Waiting for page stability before LLM call', {
      description,
      attemptsUsed,
      waitRetryLimit,
    });

    await waitForPageStability(page, {
      logger: (context as ActContext).logger,
      description,
    });

    try {
      const data = await prepare();
      return { data, waitCount: attemptsUsed };
    } catch (error) {
      if (isNavigationError(error)) {
        attemptsUsed += 1;
        if (attemptsUsed > waitRetryLimit) {
          throw new Error(
            `Navigation continued interrupting ${description} beyond retry limit (${waitRetryLimit}).`,
          );
        }
        logDebug('Navigation interrupted preparation, retrying', {
          description,
          attemptsUsed,
          waitRetryLimit,
        });
        continue;
      }
      throw error;
    }
  }
}

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
    '- If the requested UI is not yet visible/interactable (page still loading, authentication pending, or SoM id absent), respond with shouldWait = true and do not return commandsToRun.',
    '- Provide waitReason to explain what you are waiting for when shouldWait = true.',
    '- When you supply commandsToRun, shouldWait must be false and needsRetryAfterPreActions must be false.',
    '- When SoM markers appear stale or missing (duplicates, newly rendered panels, etc.), set requestSomRefresh = true (commandsToRun must remain empty) so the orchestrator can refresh the SoM map and re-prompt you.',
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
      if (error instanceof SomReannotationRequiredError) {
        throw error;
      }
      if (isNavigationError(error)) {
        throw new NavigationInProgressError(error.message, { command });
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

function ensureCommands(
  result: AiActionResult,
  onImplicitWait: () => void,
): SomCommand[] {
  if (result.requestSomRefresh || result.stepCompleted) {
    return [];
  }
  const commands = result.commandsToRun || [];
  if (commands.length === 0) {
    logDebug('LLM returned empty commands without required flags; treating as implicit wait', {
      shouldWait: result.shouldWait,
      requestSomRefresh: result.requestSomRefresh,
      stepCompleted: result.stepCompleted,
    });
    onImplicitWait();
    return [];
  }
  logDebug('LLM returned commands', { count: commands.length, commands });
  return commands;
}

function extractVerification(result: AiActionResult): { verificationSuccess: boolean; confidence: number; verificationReason?: string } {
  if (result.verificationSuccess === undefined) {
    throw new Error('LLM response missing verificationSuccess field.');
  }
  if (result.confidence === undefined) {
    throw new Error('LLM response missing confidence field.');
  }
  if (result.verificationReason !== undefined && typeof result.verificationReason !== 'string') {
    throw new Error('verificationReason must be a string when provided.');
  }
  return {
    verificationSuccess: result.verificationSuccess,
    confidence: result.confidence,
    verificationReason: result.verificationReason,
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
    const stabilization = await stabilizeForLlm<{
      somMap: string;
      somScreenshot: string;
    }>({
      context,
      description: `ai.act objective: ${objective}`,
      waitCount,
      waitRetryLimit,
      backoffMs: NAVIGATION_RETRY_DELAY_MS,
      prepare: async () => {
        await handler.updateSom(false);
        const somMap = handler.getSomElementMap();
        logDebug('SoM element map generated', { length: somMap.length });
        const somScreenshot = await captureSomScreenshot(handler);
        logDebug('Captured SoM screenshot', { bytes: somScreenshot.length });
        return { somMap, somScreenshot };
      },
    });
    waitCount = stabilization.waitCount;
    const { somMap, somScreenshot } = stabilization.data;

    // Log before LLM call
    logDebug('Calling LLM for AI action', { objective, waitCount, waitRetryLimit });
    const llmCallStart = Date.now();

    const aiResult = await callAiAction({
      systemPrompt: buildActSystemPrompt(),
      userPrompt: buildActUserPrompt(objective, somMap, waitCount, waitRetryLimit),
      image: somScreenshot,
    });

    // Log after LLM call
    const llmCallDuration = Date.now() - llmCallStart;
    logDebug('LLM call completed', { durationMs: llmCallDuration, objective });

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

    if (aiResult.stepCompleted) {
      logDebug('LLM indicated step already satisfied', { objective });
      const response = {
        command_results: aggregateResults,
        status: CommandRunStatus.SUCCESS,
        error: undefined,
      };
      logDebug('ai.act completed', response);
      return response;
    }

    if (aiResult.requestSomRefresh) {
      if (aiResult.commandsToRun && aiResult.commandsToRun.length > 0) {
        logDebug('LLM requested SoM refresh but also supplied commands; commands will be ignored', {
          commands: aiResult.commandsToRun,
        });
      }
      logDebug('LLM requested SoM refresh before executing commands', {
        reason: aiResult.somRefreshReason,
        waitCount,
        waitRetryLimit,
      });
      try {
        await waitForPageStability(context.page, {
          logger: context.logger,
          description: `SoM refresh for ai.act objective: ${objective}`,
        });
        const count = await handler.updateSom(false);
        logDebug('SoM refreshed per LLM request', { elementCount: count });
      } catch (error) {
        if (isNavigationError(error)) {
          logDebug('Navigation interrupted SoM refresh requested by LLM; retrying', {
            reason: error instanceof Error ? error.message : String(error),
          });
          waitCount = Math.min(waitCount + 1, waitRetryLimit);
          preActionRetryCount = 0;
          continue;
        }
        throw error;
      }
      waitCount = Math.min(waitCount + 1, waitRetryLimit);
      preActionRetryCount = 0;
      continue;
    }

    const preCommands = aiResult.preCommands ?? [];
    if (preCommands.length > 0) {
      logDebug('Executing pre-commands', { count: preCommands.length });
      for (const command of preCommands) {
        if (command.action === InteractionAction.WAIT_FOR) {
          const durationMs = clampWaitDuration(
            command.durationSeconds ?? (command.value ? Number(command.value) : undefined),
          );
          logDebug('Executing WAIT_FOR pre-command as timed wait', {
            durationMs,
            command,
          });
          await context.page.waitForTimeout(durationMs);
          aggregateResults.push({
            failedAttempts: [],
            successAttempt: {
              command: `await page.waitForTimeout(${durationMs})`,
              status: CommandRunStatus.SUCCESS,
            },
            status: CommandRunStatus.SUCCESS,
          });
          continue;
        }
        logCommandSomContext('preCommand', command, handler);
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
            formatFailedAttemptsLine(result.failedAttempts),
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
      try {
        const count = await handler.updateSom(false);
        logDebug('SoM refreshed after pre-commands', { elementCount: count });
      } catch (error) {
        if (isNavigationError(error)) {
          logDebug('Navigation interrupted SoM refresh after pre-commands; retrying', {
            reason: error instanceof Error ? error.message : String(error),
          });
          waitCount = Math.min(waitCount + 1, waitRetryLimit);
          preActionRetryCount = 0;
          continue;
        }
        throw error;
      }
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

    let implicitWaitTriggered = false;
    const commands = ensureCommands(aiResult, () => {
      implicitWaitTriggered = true;
    });
    if (implicitWaitTriggered) {
      if (waitCount >= waitRetryLimit) {
        throw new Error(
          `LLM returned empty commands without allowed flags beyond max wait attempts (${waitRetryLimit}).`,
        );
      }
      logDebug('Implicit wait triggered due to empty command list; re-running stabilization', {
        waitCount,
        waitRetryLimit,
      });
      waitCount += 1;
      await waitForPageStability(context.page, {
        logger: context.logger,
        description: `implicit-wait for ai.act objective: ${objective}`,
      });
      continue;
    }
    let navigationRetryRequested = false;
    const waitCommands = commands.filter((command) => command.action === InteractionAction.WAIT_FOR);
    const actionCommands = commands.filter((command) => command.action !== InteractionAction.WAIT_FOR);

  if (waitCommands.length > 0 && actionCommands.length > 0) {
      logDebug('WAIT_FOR command mixed with other actions; will execute waits first', {
        waitCommands,
        actionCommands,
      });
    }

    for (const waitCommand of waitCommands) {
      const durationMs = clampWaitDuration(waitCommand.durationSeconds ?? (waitCommand.value ? Number(waitCommand.value) : undefined));
      logDebug('Executing WAIT_FOR command', { durationMs, command: waitCommand });
      await context.page.waitForTimeout(durationMs);
      await waitForPageStability(context.page, {
        logger: context.logger,
        description: `post-waitFor for ai.act objective: ${objective}`,
      });
      try {
        const count = await handler.updateSom(false);
        logDebug('SoM refreshed after WAIT_FOR command', { elementCount: count });
      } catch (error) {
        if (isNavigationError(error)) {
          logDebug('Navigation interrupted SoM refresh after WAIT_FOR; retrying', {
            reason: error instanceof Error ? error.message : String(error),
          });
          navigationRetryRequested = true;
          break;
        }
        throw error;
      }
    }

    if (navigationRetryRequested) {
      aggregateResults.length = 0;
      waitCount = Math.min(waitCount + 1, waitRetryLimit);
      preActionRetryCount = 0;
      continue;
    }

    const commandsToExecute = actionCommands;
    let status: CommandRunStatus = CommandRunStatus.SUCCESS;
    let lastError: string | undefined;
    let failedCommand: SomCommand | undefined;

    let reannotationRequested = false;

    for (const command of commandsToExecute) {
      logCommandSomContext('command', command, handler);
      const timeout = isNavigationAction(command.action)
        ? getNavigationTimeout()
        : getCommandTimeout();
      let result: SemanticCommandResult;
      try {
        result = await executeSomCommand(handler, command, timeout);
      } catch (error) {
        if (error instanceof SomReannotationRequiredError) {
          logDebug('SoM target changed; refreshing map and re-prompting LLM', {
            command,
            reason: error.message,
            context: error.context,
          });
          reannotationRequested = true;
          break;
        }
        if (error instanceof NavigationInProgressError || isNavigationError(error)) {
          logDebug('Navigation interrupted command execution; refreshing map and retrying', {
            command,
            reason: error instanceof Error ? error.message : String(error),
          });
          navigationRetryRequested = true;
          break;
        }
        throw error;
      }
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
      try {
        logDebug('Post-command stabilization before refreshing SoM', {
          objective,
          command,
        });
        await waitForPageStability(context.page, {
          logger: context.logger,
          description: `post-command for ai.act objective: ${objective}`,
        });
        const count = await handler.updateSom(false);
        logDebug('SoM refreshed after command', { elementCount: count });
      } catch (error) {
        if (isNavigationError(error)) {
          logDebug('Navigation interrupted post-command SoM refresh; retrying', {
            command,
            reason: error instanceof Error ? error.message : String(error),
          });
          navigationRetryRequested = true;
          break;
        }
        throw error;
      }
      if (result.status === CommandRunStatus.FAILURE) {
        status = CommandRunStatus.FAILURE;
        lastError = result.error;
        failedCommand = command;
        break;
      }
    }

    if (reannotationRequested || navigationRetryRequested) {
      aggregateResults.length = 0;
      waitCount = Math.min(waitCount + 1, waitRetryLimit);
      preActionRetryCount = 0;
      continue;
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
        formatFailedAttemptsLine(failedResult?.failedAttempts),
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

  const waitRetryLimit = getMaxWaitRetries();
  let waitCount = 0;

  while (true) {
    const stabilization = await stabilizeForLlm<string>({
      context,
      description: `ai.verify requirement: ${requirement}`,
      waitCount,
      waitRetryLimit,
      backoffMs: NAVIGATION_RETRY_DELAY_MS,
      prepare: async () => capturePageScreenshot(context.page, true),
    });
    waitCount = stabilization.waitCount;
    const screenshot = stabilization.data;
    
    logDebug('Calling LLM for AI verification', { requirement });
    const llmCallStart = Date.now();
    let aiResult: AiActionResult;
    try {
      aiResult = await callAiAction({
        systemPrompt: buildVerifySystemPrompt(),
        userPrompt: buildVerifyUserPrompt(requirement),
        image: screenshot,
      });
    } catch (error) {
      if (isNavigationError(error)) {
        logDebug('Navigation interrupted verification LLM call; retrying after stabilization', {
          requirement,
        });
        waitCount = Math.min(waitCount + 1, waitRetryLimit);
        if (waitCount > waitRetryLimit) {
          throw new Error(
            `Navigation continued interrupting verification for "${requirement}" beyond retry limit (${waitRetryLimit}).`,
          );
        }
        continue;
      }
      throw error;
    }
  
    const llmCallDuration = Date.now() - llmCallStart;
    logDebug('LLM call completed', { durationMs: llmCallDuration, requirement });
  
    if (aiResult.requestSomRefresh) {
      logDebug('LLM requested SoM refresh during verification; retrying', {
        requirement,
        reason: aiResult.somRefreshReason,
        waitCount,
        waitRetryLimit,
      });
      waitCount = Math.min(waitCount + 1, waitRetryLimit);
      continue;
    }
  
    const { verificationSuccess, confidence, verificationReason } = extractVerification(aiResult);
    logDebug('ai.verify result from LLM', { verificationSuccess, confidence, verificationReason });
    if (aiResult.stepCompleted || verificationSuccess) {
      logDebug('LLM indicated verification already satisfied', { requirement, verificationSuccess });
      const response = { verificationSuccess, confidence, verificationReason };
      logDebug('ai.verify completed', response);
      return response;
    }

    const threshold = Math.max(0, options?.confidence_threshold ?? DEFAULT_CONFIDENCE_THRESHOLD);
    const expectFn = options?.expect ?? resolveExpect(context);
    if (!expectFn) {
      throw new Error('verify() requires Playwright expect. Pass the Playwright test object or provide expect explicitly.');
    }
  
    if (!verificationSuccess && verificationReason) {
      logDebug('ai.verify reported failure reason', { verificationReason });
    }
  
    logDebug('ai.verify asserting', { threshold });

    expectFn(
      confidence,
      `AI verification confidence ${confidence} is below threshold ${threshold}`,
    ).toBeGreaterThanOrEqual(threshold);
    expectFn(
      verificationSuccess,
      `AI verification failed for requirement: ${requirement}${verificationReason ? ` - ${verificationReason}` : ''}`,
    ).toBe(true);

    const response = { verificationSuccess, confidence, verificationReason };
    logDebug('ai.verify completed', response);
    return response;
  }
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
