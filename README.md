# ai-playwright

AI steps (ai.act, ai.verify) in your Playwright tests — open source, vision-enabled, no vendor lock-in.

## Introduction

`ai-playwright` lets you include AI-powered actions, verifications, and data extraction in any Playwright test. It supports:
- BYOL (bring-your-own-license) to use your own OpenAI Api key, 
- or use your [TestChimp](https://testchimp.io) license key to avoid paying separately for token usage. 

Unlike other solutions, `ai-playwright` relies on *vision intelligence*: screenshots are annotated with Set-of-Marks (SoM) overlays and combined with DOM element maps for disambiguation, so the LLM can navigate complex UIs with far greater accuracy and resilience.

**Why teams adopt `ai-playwright`:**
- **Vendor flexibility & BYOL** – use your own OpenAI key or TestChimp license; you are never tied to a closed license.
- **Vision-first semantics** – SoM overlays + DOM metadata give the model precise context.
- **Resilient prompting** – pre-action planning, retry guidance, and stability waits are built in.
- **Open source** – complete transparency and community support.

## Usage Guide

### Installation

```bash
npm install ai-playwright
# or
yarn add ai-playwright
```

Then import the library inside your Playwright tests:

```ts
import { ai } from 'ai-playwright';
```

### AI Commands

#### `ai.act(objective, {page,test})`
Executes one or more UI actions to satisfy the given objective. The library:
1. Waits for page stability.
2. Generates a SoM map + screenshot.
3. Queries the LLM for pre-actions necessary (e.g., close modals) and main commands.
4. Runs each command sequentially with detailed retries, to achieve the given objective.

```ts
await ai.act('Log in as alice@example.com with password TestPass123', {
  page,
  test,
});
```

#### `ai.verify(requirement, {page,test}, options?)`
Vision-driven assertion that works like `expect`. It fails the Playwright step if the LLM reports `verificationSuccess = false` or if the reported `confidence` falls below `options.confidence_threshold` (default 70%).

```ts
await ai.verify('The toast should say "Message sent"', {
  page,
  test,
}, {
  confidence_threshold: 85,
});
```

#### `ai.extract(requirement, context, options?)`
Pulls structured data from the page. Set `options.return_type` to shape the output (`'string' | 'string_array' | 'int' | 'int_array'`).

```ts
const orderIds = await ai.extract('List the order IDs from the table', {
  page,
  test,
}, {
  return_type: 'string_array',
});
```

### Authentication

`ai-playwright` chooses credentials in priority order:

1. **OpenAI API key**
   - Set `OPENAI_API_KEY` env var. (and optionally `OPENAI_MODEL`, defaults to `gpt-5-mini`).
2. **TestChimp API keys**
   - Set `TESTCHIMP_API_KEY` + `TESTCHIMP_PROJECT_ID`, _or_ `TESTCHIMP_USER_AUTH_KEY` + `TESTCHIMP_USER_MAIL`.
   - Benefit: reuse your existing TestChimp account, letting their backend proxy the LLM and cover token costs.

### Example Playwright Test

```ts
import { test } from '@playwright/test';
import { ai } from 'ai-playwright';

test('send message', async ({ page }) => {
  await ai.act('Log in with alice@example.com / TestPass123', { page, test });

  await ai.act('Open the Messages tab and send "Hello"', { page, test });

  await ai.verify('The message input field should be empty afterwards', { page, test });
});
```

### Advanced Configuration

Environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `AI_PLAYWRIGHT_DEBUG` | Enable verbose logging (`1`, `true`, `on`, `yes`). | off |
| `AI_PLAYWRIGHT_TEST_TIMEOUT_MS` | Extend Playwright test timeouts automatically; `0` disables extension. | `180000` |
| `AI_PLAYWRIGHT_MAX_WAIT_RETRIES` | How many times the LLM may request additional waits. | `2` |
| `LLM_CALL_TIMEOUT` | Max duration (ms) for each LLM request. | `120000` |
| `COMMAND_EXEC_TIMEOUT` | Timeout (ms) for individual DOM actions. | `5000` |
| `NAVIGATION_COMMAND_TIMEOUT` | Timeout (ms) for navigation actions. | `15000` |
| `OPENAI_MODEL` | Override the OpenAI model (ignored when using TestChimp). | `gpt-5-mini` |

Optional context/options:
- `context.logger`: `(message: string) => void` to receive internal log output.
- `options.confidence_threshold`: override verification threshold per call.
- `options.return_type`: control extraction result shape.

## Comparison with Other Solutions

### ZeroStep
- Requires a proprietary license key causing vendor-lock.
- Unmaintained and limited to GPT-3.5.
- Tied to CDP (Chrome DevTools Protocol), so works only with Chrome.
- Offers fewer resilience mechanisms than SoM plus multi-strategy retries.

### auto-playwright
- The agent relies on DOM context, significantly limiting its ability to navigate complex UIs.
- Reliance on DOM means the prompt sizes are unbounded.
- Verifications require you to parse the AI response manually and call `expect` yourself; `ai.verify` does this automatically.
- Project activity is minimal, raising maintenance concerns.

### Fully-Agentic Test Suites
- Vendor lock in. Fully agentic tests require proprietary runners and custom formats, which result in vendor lock-in.
- All steps are agentic, resulting in slow, costly, non-deterministic tests.
- `ai-playwright` enables a hybrid approach: keep 90% of your test deterministic Playwright code, and inject AI only for the messy, nondeterministic UI flows / verifications.
- This balances speed and reliability while still unlocking AI flexibility where you _actually_ need it.

---
Start by installing the package, set either TestChimp or OpenAI credentials, and layer `ai.act`, `ai.verify`, or `ai.extract` onto the toughest parts of your Playwright suite. 

AI where it helps, plain Playwright everywhere else.

## Author

`ai-playwright` is an Open source project contributed by [TestChimp](https://testchimp.io) — an AI QA platform that learns your web app through explorations, to provide context-aware AI assistance to QA workflows.

## License

Distributed under the GNU Affero General Public License v3.0. See the [LICENSE](./LICENSE) file for full terms.
