"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.callAiAction = callAiAction;
exports.isDebugEnabled = isDebugEnvEnabled;
exports.debugLog = debugLog;
exports.getNavigationTimeout = getNavigationTimeout;
exports.getCommandTimeout = getCommandTimeout;
const axios_1 = __importDefault(require("axios"));
const openai_1 = __importDefault(require("openai"));
const types_1 = require("./types");
const DEBUG_FLAG = 'AI_PLAYWRIGHT_DEBUG';
function isDebugEnvEnabled() {
    const value = process.env[DEBUG_FLAG];
    if (!value) {
        return false;
    }
    const normalized = value.toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}
function debugLog(...messages) {
    if (isDebugEnvEnabled()) {
        console.log('[ai-playwright]', ...messages);
    }
}
const DEFAULT_LLM_TIMEOUT_MS = 120000;
const NAVIGATION_TIMEOUT_MS = 15000;
function parseTimeout(value, fallback) {
    if (!value) {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function getAuthConfig() {
    debugLog('Selecting auth strategy...');
    const openAiKey = process.env.OPENAI_API_KEY?.trim();
    const timeout = parseTimeout(process.env.LLM_CALL_TIMEOUT, DEFAULT_LLM_TIMEOUT_MS);
    if (openAiKey) {
        debugLog(`Using OpenAI direct auth (model: ${process.env.OPENAI_MODEL?.trim() || 'gpt-5-mini'})`);
        const openai = new openai_1.default({ apiKey: openAiKey });
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
            endpoint: (process.env.TESTCHIMP_BACKEND_URL?.trim() ||
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
            endpoint: (process.env.TESTCHIMP_BACKEND_URL?.trim() ||
                'https://featureservice.testchimp.io') + '/localagent/call_llm',
            timeout,
        };
    }
    debugLog('Authentication failed: no usable credentials found');
    throw new Error('Missing authentication. Provide OPENAI_API_KEY or TestChimp credentials (TESTCHIMP_API_KEY/TESTCHIMP_PROJECT_ID or TESTCHIMP_USER_AUTH_KEY/TESTCHIMP_USER_MAIL).');
}
async function withRetry(action, retries = 3, delayMs = 250) {
    try {
        return await action();
    }
    catch (error) {
        if (retries <= 0 || !isRetryableError(error)) {
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return withRetry(action, retries - 1, delayMs * 2);
    }
}
function isRetryableError(error) {
    if (!error)
        return false;
    if (error?.response) {
        const status = error.response.status;
        return status >= 500;
    }
    return true;
}
function validateCoordinate(label, coord) {
    if (!coord)
        return;
    const { x, y } = coord;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`${label} must contain numeric x and y values.`);
    }
}
function validateSomCommand(command) {
    if (!Object.values(types_1.InteractionAction).includes(command.action)) {
        throw new Error(`Invalid InteractionAction: ${command.action}`);
    }
    validateCoordinate('SomCommand.coord', command.coord);
    validateCoordinate('SomCommand.fromCoord', command.fromCoord);
    validateCoordinate('SomCommand.toCoord', command.toCoord);
}
function validateAiActionResult(payload) {
    if (typeof payload !== 'object' || payload === null) {
        throw new Error('LLM response is not a JSON object.');
    }
    const result = {};
    const data = payload;
    if (data.preCommands !== undefined) {
        if (!Array.isArray(data.preCommands)) {
            throw new Error('preCommands must be an array of SomCommand.');
        }
        result.preCommands = data.preCommands;
        result.preCommands.forEach((command) => validateSomCommand(command));
    }
    if (data.commandsToRun !== undefined) {
        if (!Array.isArray(data.commandsToRun)) {
            throw new Error('commandsToRun must be an array of SomCommand.');
        }
        result.commandsToRun = data.commandsToRun;
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
        result.extractedContentList = data.extractedContentList.map((item) => {
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
function buildUserContent(userPrompt, image, secondaryImage) {
    const content = [{ type: 'text', text: userPrompt }];
    if (secondaryImage) {
        content.push({ type: 'image_url', image_url: { url: secondaryImage } });
    }
    if (image) {
        content.push({ type: 'image_url', image_url: { url: image } });
    }
    return content;
}
async function callAiAction(request) {
    const auth = getAuthConfig();
    debugLog('Calling AI action', { systemPromptLength: request.systemPrompt.length, userPromptLength: request.userPrompt.length, hasImage: Boolean(request.image), hasSecondaryImage: Boolean(request.secondaryImage) });
    const raw = await withRetry(async () => {
        if (auth.kind === 'openai') {
            const response = await auth.client.chat.completions.create({
                model: auth.model,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: request.systemPrompt },
                    {
                        role: 'user',
                        content: buildUserContent(request.userPrompt, request.image, request.secondaryImage),
                    },
                ],
            }, { timeout: auth.timeout });
            const content = response.choices[0]?.message?.content;
            if (!content) {
                throw new Error('Received empty response from OpenAI.');
            }
            debugLog('Received OpenAI response', { length: content.length });
            return content;
        }
        const { endpoint, headers, timeout } = auth;
        const payload = {
            system_prompt: request.systemPrompt,
            user_prompt: request.userPrompt,
            image_url: request.image,
        };
        if (request.secondaryImage) {
            payload['secondary_image_url'] = request.secondaryImage;
        }
        const response = await axios_1.default.post(endpoint, payload, { headers, timeout });
        const content = response.data?.answer;
        if (typeof content !== 'string') {
            throw new Error('TestChimp backend returned an unexpected response format.');
        }
        debugLog('Received TestChimp response', { length: content.length });
        return content;
    });
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`Failed to parse LLM response as JSON: ${error.message}`);
    }
    return validateAiActionResult(parsed);
}
function getNavigationTimeout() {
    return Math.max(parseTimeout(process.env.NAVIGATION_COMMAND_TIMEOUT, NAVIGATION_TIMEOUT_MS), 0);
}
function getCommandTimeout() {
    return Math.max(parseTimeout(process.env.COMMAND_EXEC_TIMEOUT, 5000), 0);
}
