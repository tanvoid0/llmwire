<p align="center">
  <a href="https://tanvoid0.github.io/llmwire/"><img src="site/logo.svg" alt="llmwire" width="340" height="80"></a>
</p>

<p align="center">
  <a href="https://tanvoid0.github.io/llmwire/">Docs</a> ·
  <a href="https://tanvoid0.github.io/llmwire/documents/Examples.html">Examples</a> ·
  <a href="https://tanvoid0.github.io/llmwire/modules.html">API</a> ·
  <a href="https://www.npmjs.com/package/llmwire">npm</a>
</p>

[![CI/CD Pipeline](https://github.com/tanvoid0/llmwire/workflows/CI/CD%20Pipeline/badge.svg)](https://github.com/tanvoid0/llmwire/actions)
[![npm version](https://img.shields.io/npm/v/llmwire.svg)](https://www.npmjs.com/package/llmwire)
[![npm downloads](https://img.shields.io/npm/dm/llmwire.svg)](https://www.npmjs.com/package/llmwire)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![bundle size](https://img.shields.io/badge/core%20%2B%20one%20provider-12.4%20kB%20gz-blue)
![runtimes](https://img.shields.io/badge/runs%20on-Node%20%C2%B7%20Bun%20%C2%B7%20Deno%20%C2%B7%20Workers%20%C2%B7%20browsers-blue)

Zero-dependency TypeScript LLM client for OpenAI, Anthropic, Gemini, **Ollama**, LM Studio, Groq, OpenRouter, DeepSeek, Mistral, xAI, Together and any OpenAI-compatible API, with real streaming, tool calling, structured output, images and typed provider errors on every one of them; plus agents, an MCP client, sessions, embeddings and routines as separate entries.

## Why llmwire

- **Zero runtime dependencies.** Native `fetch`, no Node built-ins in the main entry: Node 18+, Bun, Deno, Workers, browsers. `/core` plus one provider bundles to 12.4 kB gzipped.
- **Local first, cloud with one env var.** Ollama and LM Studio work with no config; `OPENAI_API_KEY` (and friends) switches on cloud. Routing is static: `modelId: 'claude-sonnet-4-5'` reaches Anthropic with no discovery call, and an explicit `openai/gpt-4o` prefix always wins.
- **One request shape, every capability.** `messages` with images, `tools` with an automatic `maxSteps` loop, `schema` through any Standard Schema (Zod, Valibot, ArkType) or plain JSON Schema, typed stream chunks, `finishReason` and `usage` on every answer.
- **Honest errors.** Every failure is an `AIError` with a `code`, the provider's own message never rewritten, and a `hint` saying what to do next. Retries with backoff only on what is retryable; fallback across providers; a stream idle timeout.
- **Agent layer, no runtime.** `Agent` with `asTool` and `handoff`, `Session` with a token budget, `McpClient` over Streamable HTTP or stdio, `embed` and `estimateCost`: each its own subpath, none imported by the core.
- **Batteries for local models.** Ollama pull/list/rm/show/ps/run from the library or `npx llmwire`, plus a `doctor` that pings every provider.

Upgrading from 1.x? Read [MIGRATION.md](MIGRATION.md): every removed input fails with an error naming its replacement.

---

## Install

```bash
npm install llmwire
```

The main entry exports everything and is edge/browser safe. `/core` plus one provider subpath bundles to 12.4 kB gzipped (`npm run bench:size`); `ollama-cli` and `mcp-stdio` are the only ones that need Node:

```typescript
import { AIFactory } from 'llmwire/core';               // factory, errors, types; no built-in providers (pass `providers`)
import { OpenAIProvider } from 'llmwire/openai';        // also /anthropic /gemini /ollama /lmstudio /openai-compatible
import { runOllamaCLI } from 'llmwire/ollama-cli';      // spawns the `ollama` binary (Node only)
import { Agent, handoff } from 'llmwire/agent';         // also /session /mcp /embed /cost /routine; /mcp-stdio is Node only
```

## Quick start

```typescript
import { aiFactory } from 'llmwire';

const text = await aiFactory.generate('Say hello in one sentence.', { maxTokens: 100 });
console.log(text);
```

With **Ollama** running locally, this works without API keys. For cloud providers, set env vars (see [Environment](#environment)).

---

## Streaming

`processStream` yields the answer as it is written, over real SSE (OpenAI, LM Studio, Anthropic, Gemini) or NDJSON (Ollama). Chunks are a union discriminated by `type`: `text` (the delta since the previous chunk; append, do not replace), `reasoning` (a thinking model's thoughts, never mixed into the answer), `tool-call` (one completed call) and a final `done` carrying `finishReason`, `usage` (when the provider reports it), `toolCalls`, `durationMs` (wall time for the whole stream) and `timeToFirstTokenMs`.

```typescript
import { aiFactory } from 'llmwire';

for await (const chunk of aiFactory.processStream({ prompt: 'Count to twenty.' })) {
  if (chunk.type === 'text') process.stdout.write(chunk.text);
  if (chunk.type === 'done') console.log('\n', chunk.finishReason, chunk.usage, `${chunk.durationMs}ms`);
}
```

A stalled upstream fails the stream with `STREAM_IDLE` after `streamIdleTimeout` ms of silence, default 60 s. Set it per request (`{ streamIdleTimeout: 20_000 }`), per factory (`new AIFactory({ streamIdleTimeout })`) or per provider (`new OpenAIProvider({ streamIdleTimeout })`); the clock resets on every byte, so a slow-but-alive stream never trips it.

Cancel early with an `AbortSignal`:

```typescript
const abort = new AbortController();
setTimeout(() => abort.abort(), 10_000);

try {
  for await (const chunk of aiFactory.processStream({ prompt, signal: abort.signal })) {
    if (chunk.type === 'text') process.stdout.write(chunk.text);
  }
} catch (err) {
  if (abort.signal.aborted) console.log('cancelled');
  else throw err;
}
```

Breaking out of the `for await` also closes the upstream connection. A provider error mid-stream throws `AIError` from the loop rather than ending the stream as a success; retry and fallback only apply before the first chunk arrives (see [Retries and fallback](#retries-and-fallback)).

---

## JSON mode

`jsonMode: true` asks the provider for JSON output. OpenAI, LM Studio and any `OpenAICompatibleProvider` use the native `response_format: { type: 'json_object' }`; Gemini uses `responseMimeType`; Ollama uses `format: 'json'`. Anthropic has no native JSON mode, so `jsonMode` adds one line to the system prompt asking for a bare JSON value instead; it is a request, not an API-enforced constraint. Parse the result yourself; the client returns the raw string.

```typescript
const res = await aiFactory.process({
  prompt: 'List three fruits as {"fruits": string[]}.',
  jsonMode: true,
});
const { fruits } = JSON.parse(res.data!);
```

For a shape the provider is asked to follow and a parsed, validated result, use `schema` ([Structured output](#structured-output)).

---

## Messages and images

`prompt` is shorthand for a final user turn. `messages` is the whole conversation; a user message may carry image parts as a remote URL, a `data:` URL, raw bytes or base64 (the mime type is sniffed when omitted).

```typescript
const res = await aiFactory.process({
  modelId: 'gpt-4o',
  systemPrompt: 'Answer in one line.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is in this picture?' }, { type: 'image', data: await readFile('cat.png') }] },
    { role: 'assistant', content: 'A cat on a keyboard.' },
  ],
  prompt: 'What colour is it?',
});
```

Images go out as OpenAI `image_url`, Anthropic `source`, Gemini `inlineData` / `fileData` and Ollama `images[]`. Ollama takes bytes only: a remote URL there fails `UNSUPPORTED` with a hint.

---

## Tool calling

Define tools with a JSON Schema for the arguments. Without `maxSteps`, the model's calls come back on `toolCalls` and you run them; with `maxSteps > 1` and an `execute` on each tool, the factory runs the calls (in parallel), feeds the results back and asks again, up to `maxSteps` rounds, recording each in `steps`.

```typescript
const weather = {
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async ({ city }) => fetchWeather(city),
};

const res = await aiFactory.process({ prompt: 'Is it raining in Oslo?', tools: [weather], maxSteps: 3 });
console.log(res.data);            // "No, it is 21C and clear."
console.log(res.steps?.[0].toolResults);
```

`toolChoice` is `'auto'`, `'none'`, `'required'` or `{ name }`; it applies to the first round only, so a forced call cannot loop forever. A tool that throws is reported to the model as `{ error }` rather than failing the request. Streams emit a `{ type: 'tool-call' }` chunk per completed call and one `done` at the end of the last round. Weak local models that print `<function=name>{...}</function>` as text get the call recovered and the markup stripped.

---

## Structured output

`schema` takes a JSON Schema object or any [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, ...). It implies JSON mode, goes out on the wire where the host takes a schema (OpenAI `json_schema`, Gemini `responseSchema`, Ollama `format`; Anthropic gets it in the system prompt), and the answer is parsed and validated onto `object`.

```typescript
import { z } from 'zod';

const Weather = z.object({ city: z.string(), tempC: z.number() });
const res = await aiFactory.process({ prompt: 'Weather in Oslo as JSON.', schema: Weather });
if (res.success) console.log(res.object); // { city: 'Oslo', tempC: 21 }, validated
```

A non-JSON answer fails `INVALID_JSON`, a validation failure `SCHEMA_MISMATCH` (every issue in `errorInfo.details`), and an answer cut off by `maxTokens` `TRUNCATED`; the raw text stays on `data`. A plain JSON Schema is sent but not validated locally (no validator ships). Streams ignore `schema`.

---

## Agents

An `Agent` is a name, a model, a system prompt, tools and a step budget, run through the factory's tool loop. It is a config holder with `run` and `stream`, not a runtime: no planner, no graph, no hidden memory.

```typescript
import { Agent, handoff } from 'llmwire/agent';

const researcher = new Agent({
  name: 'researcher',
  model: 'claude-sonnet-4-5',
  system: 'You research. Cite sources.',
  tools: [search, fetchPage],
  maxSteps: 8,                          // default 8
  onStep: (step) => console.log(step.toolCalls.map((c) => c.name)),
});

const out = await researcher.run('Compare X and Y');           // AIResponse, plus steps[]
for await (const chunk of researcher.stream('Summarize Z')) { /* typed chunks, as processStream */ }
```

Multi-agent is two tools:

- **Agent as tool.** `researcher.asTool()` is a `Tool` taking `{ input }` and returning the agent's text. A supervisor lists sub-agents in `tools` and the model decides who to call.
- **Handoff.** `handoff(billing)` is a tool that ends the current agent's turn and continues the same conversation as `billing`, with its system prompt and tools. `run` returns `billing`'s answer with `handedOffTo: 'billing'` and the merged `steps`.

```typescript
const billing = new Agent({ name: 'billing', system: 'You handle refunds.', tools: [refund] });
const triage = new Agent({ name: 'triage', tools: [handoff(billing), researcher.asTool()] });
const res = await triage.run('I want my money back');
res.handedOffTo; // 'billing'
```

Parallel fan-out is `Promise.all(agents.map((a) => a.run(task)))`. Agents use the shared `aiFactory` unless given `{ factory }`; `onStep` is also available on any `AIRequest`.

## Sessions

A `Session` keeps a conversation across `send` calls in a `Store` (`MemoryStore` ships; Redis or SQLite is the same three methods) and holds it under a token budget.

```typescript
import { Session, MemoryStore } from 'llmwire/session';

const session = new Session({ id: 'user-42', store: new MemoryStore(), maxTokens: 32_000, summarize: true });
await session.send(agent, 'Hello');       // appends the user turn, every tool round, the answer
await session.send(agent, 'And then?');   // the model sees the whole history
```

Over budget, tool results are shortened first (`toolResultChars`, default 400), then whole oldest turns are dropped, never the last one and never a tool call without its result; with `summarize: true` the dropped turns become one model-written system message. No tokenizer ships: the estimate is `chars / 4`, corrected by the provider's last reported `usage.promptTokens`.

## MCP

`McpClient` speaks JSON-RPC over Streamable HTTP with `fetch` (any runtime) or stdio (`llmwire/mcp-stdio`, Node only); no SDK is imported. A server's tools come back as `Tool[]` ready for an agent or any request.

```typescript
import { McpClient } from 'llmwire/mcp';
import { McpStdioTransport } from 'llmwire/mcp-stdio';

const remote = await McpClient.connect({ url: 'https://mcp.example.com/mcp', headers: { authorization: `Bearer ${token}` } });
const local = await McpClient.connect({ transport: new McpStdioTransport({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }) });

const agent = new Agent({ name: 'ops', tools: [...(await remote.tools()), ...(await local.tools())] });
await remote.resources(); await remote.readResource('file:///a.txt'); await remote.prompts(); await remote.ping();
```

Tool schemas are the server's own JSON Schema, passed through. Results are flattened to text (images and resources noted); a result marked `isError` throws so the model sees `{ error }`. A JSON-RPC error is an `AIError` with code `MCP_ERROR`, `providerCode` the RPC code and the server's message verbatim. Not implemented: sampling, roots, the server-initiated notification stream.

## Embeddings

```typescript
import { embed, cosine } from 'llmwire/embed';

const { embeddings } = await embed(['a cat', 'a dog', 'a car'], { model: 'text-embedding-3-small' });
cosine(embeddings[0], embeddings[1]); // 0.8…
```

OpenAI-format `/embeddings` (OpenAI and any compatible host via `baseURL`), Gemini `batchEmbedContents`, Ollama `/api/embed`; the provider is picked from the model id unless given. Keys come from `OPENAI_API_KEY` / `GEMINI_API_KEY` or `{ apiKey }`.

## Routines

A `Routine` runs a job on an interval or a 5-field cron, in this process, with `setTimeout`.

```typescript
import { Routine } from 'llmwire/routine';
import { MemoryStore } from 'llmwire/session';

const digest = new Routine({
  name: 'daily-digest',
  every: '0 8 * * *',                          // 5-field cron (local time), or '15m' / '2h' / ms
  run: ({ signal }) => agent.run('Summarize yesterday', { signal }),
  store: new MemoryStore(),                    // keeps lastRunAt / lastResult across restarts
  catchUp: true,                               // on start, run at once if the last run is older than a period
  timeout: 120_000,                            // aborts the run's signal, reports TIMEOUT
  onResult: (r) => console.log(r.data),
  onError: (e) => console.error(e.code, e.message),
});
await digest.start();   // digest.stop() cancels the next tick and aborts a run in progress
await digest.runNow();  // once, outside the schedule
```

A run that overruns its slot skips the next tick rather than queueing it. Cron is minute, hour, day-of-month, month, day-of-week with `*`, lists, ranges and steps; not a distributed scheduler, several instances need a lock in their own `Store`. For system cron or a systemd timer, `npx llmwire routine run ./routines.js` imports the file and runs each exported routine once.

## Cost

```typescript
import { estimateCost, PRICES, PRICES_DATE } from 'llmwire/cost';

const res = await aiFactory.process({ prompt, modelId: 'gpt-4o' });
estimateCost(res.usage, res.modelUsed!); // USD, or undefined for a model not in the table
```

List prices for Anthropic, OpenAI, Google, DeepSeek, xAI and Mistral models, USD per million tokens, cached prompt tokens at the cache price; `PRICES_DATE` says when the table was last checked. Pass your own table as the third argument for other hosts or negotiated rates. Never a guess: unknown model, `undefined`.

---

## Prompt caching

`cache: true` marks the stable prompt prefix cacheable, so a prefix you send on
every call is billed at the provider's cache rate instead of in full.

```typescript
const res = await aiFactory.process({
  modelId: 'claude-sonnet-4-5',
  systemPrompt: longSystemPrompt,   // the part that repeats across calls
  tools,
  prompt: 'And the second question?',
  cache: true,
});
res.usage?.cachedTokens; // prompt tokens served from cache, when the provider reports it
```

- **Anthropic** needs explicit cache breakpoints, so `cache: true` stamps `cache_control: { type: 'ephemeral' }` on the system prompt and the last tool definition — the spans that repeat. A block below the provider's minimum (1024 tokens, 2048 for Haiku) simply isn't cached; nothing errors.
- **OpenAI** and other OpenAI-format hosts cache automatically server-side; `cache: true` is a no-op there, and a hit still comes back on `usage.cachedTokens`.

For finer control (more breakpoints, caching a specific message), set `cache_control` yourself through `providerOptions`.

---

## Reasoning models

`reasoning: true` lets a thinking model think. The thinking comes back as `reasoning` on the response and as `{ type: 'reasoning' }` chunks on a stream. It is never mixed into the answer.

```typescript
for await (const chunk of aiFactory.processStream({ prompt: 'Is 91 prime?', modelId: 'gemma4', reasoning: true })) {
  if (chunk.type === 'reasoning') process.stderr.write(chunk.text); // the model's thinking
  if (chunk.type === 'text') process.stdout.write(chunk.text);       // the answer
}
```

| Provider | `reasoning: true` sends | Thinking read from |
|---|---|---|
| Ollama | `think: true` (`think: false` otherwise) | `message.thinking`, or inline `<think>` tags |
| Anthropic | `thinking: { type: 'enabled', budget_tokens }`, temperature 1 | `thinking` content blocks / `thinking_delta` events |
| Gemini | `thinkingConfig.includeThoughts` | parts marked `thought: true` |
| OpenAI-compatible (DeepSeek, vLLM, llama.cpp, OpenRouter, LM Studio) | nothing extra | `reasoning_content` or `reasoning` on the message or delta, or inline `<think>` tags |

Ollama defaults to `think: false`. Left on, a thinking model can spend its whole `maxTokens` on thinking and hand back an empty answer with `finishReason: 'length'`. An inline `<think>` tag split across two stream chunks is held back until it is known to be a tag, so no tag text leaks into `text`.

---

## Errors

Every provider failure becomes an `AIError`: a classified `code`, the provider's own `message` verbatim, and a one-line `hint` saying what to do next.

```typescript
class AIError extends Error {
  code: AIErrorCode;
  provider: string;
  message: string;        // the provider's own text, never rewritten
  hint?: string;          // one sentence: what to do next
  statusCode?: number;    // HTTP status, when the failure was an HTTP reply
  providerCode?: string;  // the provider's own error type/code, verbatim
  retryable: boolean;
  retryAfterMs?: number;  // from Retry-After or the provider body
  requestId?: string;     // provider request id header, when sent
  model?: string;
}
```

<details>
<summary><strong>AIErrorCode</strong></summary>

```typescript
type AIErrorCode =
  // not retryable: fix credentials or the account
  | 'NO_API_KEY' | 'AUTH' | 'PERMISSION' | 'QUOTA'
  // retryable: transient on the provider or network side
  | 'RATE_LIMIT' | 'OVERLOADED' | 'SERVER' | 'NETWORK' | 'TIMEOUT' | 'STREAM_IDLE'
  // caller cancelled
  | 'ABORTED'
  // fix the request
  | 'MODEL_NOT_FOUND' | 'CONTEXT_LENGTH' | 'INVALID_REQUEST' | 'UNSUPPORTED'
  // output problems
  | 'CONTENT_FILTER' | 'TRUNCATED' | 'INVALID_JSON' | 'SCHEMA_MISMATCH'
  // setup problems
  | 'PROVIDER_UNREACHABLE' | 'NO_PROVIDERS' | 'NO_MODEL'
  | 'TOOL_ERROR' | 'MCP_ERROR'
  | 'INVALID_RESPONSE' | 'UNKNOWN';
```
</details>

`process()` never throws for a provider failure; it returns `{ success: false, error, errorInfo }`:

```typescript
const res = await aiFactory.process({ prompt: 'Hello', modelId: 'gpt-4o' });
if (!res.success) {
  switch (res.errorInfo?.code) {
    case 'NO_API_KEY':
    case 'MODEL_NOT_FOUND':
    case 'PROVIDER_UNREACHABLE':
      console.error(res.errorInfo.hint);
      break;
    case 'RATE_LIMIT':
    case 'OVERLOADED':
      // already retried automatically; this is the final failure
      break;
    default:
      console.error(String(res.errorInfo));
  }
}
```

`String(error)` renders the code and message with the hint appended:

```
[openai/RATE_LIMIT] Rate limit reached — Retry after 20s, or lower the request rate; retried automatically when retry is enabled.
```

`generate()` throws the `AIError` instead of returning a failure response. `processStream()` throws it from the iterator once a stream has failed.

---

## Retries and fallback

Retryable codes (`RATE_LIMIT`, `OVERLOADED`, `SERVER`, `NETWORK`, `TIMEOUT`, `STREAM_IDLE`) are retried automatically with exponential backoff and jitter, honouring a provider's `Retry-After` when it sends one. Everything else (`NO_API_KEY`, `AUTH`, `MODEL_NOT_FOUND`, `INVALID_REQUEST`, ...) fails immediately, since retrying a bad request or a missing key only wastes a call.

```typescript
const factory = new AIFactory({
  retry: { retries: 2, baseDelayMs: 500, maxDelayMs: 8000 }, // defaults
  fallbackProviders: ['anthropic', 'ollama'],
});
```

Defaults: 2 retries, 500 ms base delay, doubling each attempt up to 8 s, plus or minus 20% jitter. `retries: 0` opts out. `fallbackProvider` (single id) and `fallbackProviders` (array, tried in order after it) both work; a fallback is tried once retries on the current provider are exhausted, or immediately for `NO_API_KEY`, `MODEL_NOT_FOUND` and `PROVIDER_UNREACHABLE`.

Every response carries `retryCount` (attempts spent before this answer) and `fallbackUsed` (true when a fallback provider answered), so a success that took retries is still visible to the caller.

Streaming rule: retry and fallback only run before the first chunk arrives. Once text has reached the caller, a mid-stream failure throws instead of restarting on another provider, which would splice two different answers together.

---

## Performance

| Metric | Value |
|---|---|
| Per-call overhead above raw `fetch` (p50 / p99) | below noise: within 0.2 ms / 1 ms of a bare `fetch` + `res.json()` |
| Streaming overhead per chunk | 8.4 µs per yielded chunk |
| Memory for a 1 MB streamed answer | flat (about 0.3 MB heap delta; chunks are yielded, never accumulated) |
| Cold import of the core entry | 10.8 ms median, zero network calls (all of it Node's module loader) |
| First-request network calls with `discover: 'lazy'` and a routable `modelId` | 1 (the completion itself) |
| SSE frame parse | 0.6–1.2 µs per event, 64 B to 16 kB socket chunks |
| Model routing (`guessProvider`) | 0.05 µs |
| Published size (minified, gz) | `.` entry 18.0 kB; `./core` + one provider 12.4 kB; one provider subpath 7.2–7.9 kB; `./mcp` 4.3 kB, `./session` 1.2 kB, `./cost` 0.7 kB |

Measured with `npm run bench` on Node 24.14, 2026-09-14, against a local mock server; see [bench/RESULTS.md](bench/RESULTS.md) for method, per-entry sizes and caveats. Cold import is Node's module loader end to end; the library's own top-level code is under 0.5 ms.

## Comparison

How llmwire compares to **Vercel AI SDK**, **LangChain.js**, token.js, multi-llm-ts and llm.js. Snapshot taken 2026-10-07 from each project's public docs; corrections welcome as issues.

| | Vercel AI SDK 6 | LangChain.js | token.js | multi-llm-ts 5 | llm.js | **llmwire 2.2** |
|---|---|---|---|---|---|---|
| Providers | ~30 via packages | 100+ via integration packages | 200+ (OpenAI format) | ~20 | ~10 | 5 built in, 6 presets, any OpenAI-compatible host |
| Runtime deps | many (zod, ai-core, per-provider pkgs) | many (`langchain`, `@langchain/core`, per-integration) | some | some | some | **0** |
| Streaming everywhere | yes | yes | yes | yes | yes | **yes** (SSE and NDJSON, typed chunks) |
| Tool calling | yes, agent loop | yes (LangGraph / AgentExecutor) | yes | yes | yes | **yes**, `maxSteps` loop, leaked `<function=>` recovery |
| Structured output | Zod `generateObject` | Zod `withStructuredOutput` | JSON mode | Zod | JSON mode | **any Standard Schema** (Zod, Valibot, ArkType) or JSON Schema |
| Images in | yes | yes | yes | yes | yes | **yes** (URL, bytes, base64) |
| Typed error taxonomy | yes (`APICallError`, retryable) | partial | partial | partial | partial | **yes** (`code`, `retryable`, `hint`, provider message untouched) |
| Retry with backoff | yes | yes | no | no | no | **yes**, retryable codes only, `Retry-After` honoured |
| Edge / browser / Workers | yes | partial (core runs; full bundle is heavy) | yes | yes | yes | **yes** (`/ollama-cli` is the only Node-only entry) |
| Agent class / multi-agent | `Agent`, agents as tools | yes (LangGraph) | no | no | no | **yes**: `Agent`, `asTool`, `handoff`, `Session` |
| MCP client | via `@modelcontextprotocol/sdk` | via `@langchain/mcp-adapters` | no | no | no | **yes**, no SDK: Streamable HTTP and stdio |
| Prompt caching | manual per message | manual per message | no | no | no | **`cache: true`** (Anthropic breakpoints; OpenAI automatic) |
| Embeddings | yes | yes | no | yes | yes | **yes** (OpenAI-format, Gemini, Ollama) + `cosine` |
| Scheduled routines | no (host feature) | no | no | no | no | **yes**: interval or cron, in-process, `Store`-backed |
| Local-first (Ollama, LM Studio) zero config | no | partial | no | partial | yes | **yes** |
| Ollama management (pull/list/rm/ps) | no | no | no | no | no | **yes** |
| npx CLI | no | yes (`langgraph`) | no | no | no | **yes** (`doctor`, models, keys) |

---

## npx CLI

Manage Ollama models and API keys from the terminal, and check every provider at once:

```bash
npx llmwire help
npx llmwire doctor
npx llmwire ollama list
npx llmwire ollama pull llama3.1:8b
npx llmwire keys list
npx llmwire keys set BOT_CLIENT_OPENAI_KEY sk-...
```

<details>
<summary><strong>doctor</strong></summary>

Lists each provider's models, sends it a one-line prompt (`maxTokens: 16`), and prints the model that answered or the classified error with its hint. Name a preset to include it (`doctor groq openrouter`). Exit code 0 when at least one provider answered.

```
$ npx llmwire doctor
openai       FAIL  NO_API_KEY                   OpenAI API key required — Pass { apiKey } to the OpenAI provider or set its environment variable. (24 ms)
anthropic    FAIL  NO_API_KEY                   Anthropic API key required — Pass { apiKey } to the Anthropic provider or set its environment variable. (24 ms)
gemini       FAIL  NO_API_KEY                   Gemini API key required — Pass { apiKey } to the Google Gemini provider or set its environment variable. (24 ms)
ollama       ok    llama3.1:8b                  6 models (353 ms)
lmstudio     FAIL  NO_MODEL                     No chat models available (only embedding models may be loaded) — Load a chat model in LM Studio, or pass modelId. (6 ms)
```
</details>

<details>
<summary><strong>Ollama commands</strong></summary>

| Command | Description |
|--------|-------------|
| `ollama list` / `ollama ls` | List models |
| `ollama pull <model>` | Pull a model |
| `ollama rm <model>` | Remove a model |
| `ollama show <model>` | Show model info |
| `ollama ps` | List running models |
| `ollama run <model> [prompt]` | Run model (optional prompt) |

Uses the local Ollama API when the server is up; falls back to the `ollama` CLI.
</details>

<details>
<summary><strong>Keys commands</strong></summary>

Read/write `.env` in the current directory.

| Command | Description |
|--------|-------------|
| `keys list` / `keys ls` | List known API keys (masked) |
| `keys get <key> [--show]` | Get value (masked unless `--show`) |
| `keys set <key> <value>` | Set key in `.env` |

Known keys: `BOT_CLIENT_PROVIDER`, `BOT_CLIENT_OPENAI_KEY`, `BOT_CLIENT_ANTHROPIC_KEY`, `BOT_CLIENT_GEMINI_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.
</details>

---

## Environment

<details>
<summary><strong>API keys and provider</strong></summary>

```bash
# Provider (optional): ollama | openai | anthropic | gemini | lmstudio
export BOT_CLIENT_PROVIDER=ollama

# Keys (recommended names)
export BOT_CLIENT_OPENAI_KEY="sk-..."
export BOT_CLIENT_ANTHROPIC_KEY="sk-ant-..."
export BOT_CLIENT_GEMINI_KEY="..."

# Legacy names (still supported)
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GEMINI_API_KEY="..."
```

Local providers (Ollama, LM Studio) need no keys; ensure the app is running on its default port.
</details>

---

## API (library)

<details>
<summary><strong>aiFactory (singleton)</strong></summary>

- `generate(prompt, options?)` → `Promise<string>`
- `process(request)` → `Promise<AIResponse>`
- `processStream(request)` → `AsyncGenerator<AIStreamChunk>` (see [Streaming](#streaming))
- `getAvailableProviders()` → `string[]`
- `getProvider(id)` → `AIProvider | null`
- `getAllProviders()` → `AIProvider[]`
- `getAllSupportedModels()` → `string[]` (all models across providers)
- `getProviderForModel(modelId)` → `AIProvider | null`
- `testProviders()` → `Promise<Record<string, boolean>>` (connection status per provider)
- `ready()` → `Promise<void>` (resolves when init is complete)
</details>

<details>
<summary><strong>AIFactory (custom config)</strong></summary>

Create a factory with default provider, fallback, order, logger, or custom providers:

```typescript
import { AIFactory } from 'llmwire';

const factory = new AIFactory({
  defaultProvider: 'ollama',
  fallbackProviders: ['openai'],
  providerOrder: ['ollama', 'lmstudio', 'openai'],
  logger: { info: console.log, warn: console.warn, error: console.error },
  retry: { retries: 1 },
});
await factory.ready();
const text = await factory.generate('Hello');
```

Use only specific providers (e.g. custom or pre-configured):

```typescript
import { AIFactory, OllamaProvider, OpenAIProvider } from 'llmwire';

const factory = new AIFactory({
  providers: [
    new OllamaProvider({ baseURL: 'http://localhost:11434' }),
    new OpenAIProvider({ apiKey: process.env.MY_KEY })
  ],
  defaultProvider: 'ollama'
});
```
</details>

<details>
<summary><strong>Discovery</strong></summary>

`discover` controls when a provider's model list is fetched, and never sends a paid generation to do it:

- `'lazy'` (default): every candidate provider is registered up front; a provider is probed only the first time a request resolves to it. Nothing is called until the first request.
- `'eager'`: every candidate provider is probed in parallel on first use; only those that answer are kept. Probing lists models (`GET /models` or equivalent), so init costs one cheap call per provider, not a completion.
- `'none'`: never probes; routing relies on `modelId` (explicit prefix or the static catalog) and any `models` seeded in the provider's config.

```typescript
const factory = new AIFactory({ discover: 'lazy' });
```

`testConnection()` (used during eager discovery and by `testProviders()`) lists models instead of sending a real completion.
</details>

<details>
<summary><strong>Any OpenAI-compatible API</strong></summary>

Point `OpenAICompatibleProvider` at any server that speaks the OpenAI chat-completions dialect. Six hosts ship as presets that fill in the origin and the key variable:

```typescript
import { AIFactory, OpenAICompatibleProvider } from 'llmwire';

const groq = new OpenAICompatibleProvider({ preset: 'groq' });               // reads GROQ_API_KEY
const vllm = new OpenAICompatibleProvider({ id: 'vllm', baseURL: 'http://gpu-box:8000' });

const factory = new AIFactory({ providers: [groq, vllm] });
```

| Preset | Origin | Key variable |
|---|---|---|
| `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `mistral` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| `xai` | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |

Any field given alongside `preset` overrides it (`{ preset: 'groq', apiKey, baseURL }`). Model ids the hosts use (`grok-4`, `deepseek-chat`, `mistral-large-latest`, `llama-3.3-70b-versatile`) route to the matching preset with no discovery call; `vendor/model` ids (OpenRouter, Together) go to `defaultProvider`, or prefix them explicitly: `openrouter/meta-llama/llama-4-scout`.
</details>

<details>
<summary><strong>Ollama provider (programmatic)</strong></summary>

Use the Ollama provider for API-first operations. Pass `cli: runOllamaCLI` to fall back to the `ollama` binary when the server is down (and for `serve`, `stop`, `create`, which are CLI-only); it comes from the Node-only `ollama-cli` subpath so the main entry stays free of `child_process`:

```typescript
import { AIFactory, OllamaProvider } from 'llmwire';
import { runOllamaCLI } from 'llmwire/ollama-cli';

const factory = new AIFactory({ providers: [new OllamaProvider({ cli: runOllamaCLI })] });
const ollama = factory.getProvider('ollama') as OllamaProvider | null;
if (ollama) {
  const list = await ollama.list();   // list models
  await ollama.pull('llama3.1:8b');   // pull model
  const info = await ollama.show('llama3.1:8b');
  const out = await ollama.run('llama3.1:8b', 'Hello');
}
```

Or instantiate with custom base URL / CLI path:

```typescript
const provider = new OllamaProvider({
  baseURL: 'http://localhost:11434',
  cli: runOllamaCLI,
  ollamaExecutablePath: 'ollama',
  preferCLI: false  // true = always use CLI
});
await provider.pull('gemma3');
```
</details>

<details>
<summary><strong>Standalone Ollama CLI helper</strong></summary>

```typescript
import { runOllamaCLI, isOllamaCLIAvailable } from 'llmwire/ollama-cli';

const ok = await isOllamaCLIAvailable();
const result = await runOllamaCLI('pull', ['llama3.1:8b'], { onStderr: (c) => process.stderr.write(c) });
// result: { ok, code, stdout, stderr }
```
</details>

<details>
<summary><strong>Customisation</strong></summary>

Every built-in provider takes `BaseProviderConfig`; the factory adds hooks and defaults on top.

```typescript
import { AIFactory, AnthropicProvider, OllamaProvider } from 'llmwire';

const anthropic = new AnthropicProvider({
  baseURL: 'https://my-gateway.example.com',      // any origin that speaks the Messages API
  headers: { 'x-team': 'search' },                // sent on every request, after the provider's own
  fetch: myTracedFetch,                           // proxies, undici Agent, tests
  timeout: 15_000,                                // JSON calls; streams use streamIdleTimeout
  models: ['claude-sonnet-4-5'],                  // seeds the list: no discovery call, stays first after one
  modelCacheTtlMs: 60_000,                        // reuse a model listing this long (default 5 min; 0 = always fetch)
});

const factory = new AIFactory({
  providers: [anthropic, new OllamaProvider()],
  discover: 'lazy',                                // probe a provider the first time a request lands on it
  hooks: {
    onRequest: ({ provider, model, request }) => log.debug('→', provider, model),
    onResponse: ({ provider, response, durationMs }) => metrics.timing(provider, durationMs),
    onError: ({ provider, error, willRetry }) => log.warn(provider, error.code, willRetry ? 'retrying' : 'giving up'),
  },
});

// Provider-specific fields go in providerOptions; they are merged last into the wire body, one level deep.
await factory.process({ prompt: 'hi', modelId: 'llama3.1', providerOptions: { keep_alive: '10m', options: { num_ctx: 8192 } } });
await factory.process({ prompt: 'hi', modelId: 'gpt-4o', providerOptions: { top_p: 0.9, seed: 7 } });
```

Hooks are awaited; `onResponse` gets the `AIResponse`, or the `done` chunk for a stream. To see the exact bytes on the wire, wrap `fetch`.
</details>

<details>
<summary><strong>Types</strong></summary>

- **AIRequest**: `prompt?` (one of `prompt` / `messages` required), `messages?` (`Message[]`), `modelId?`, `temperature?`, `maxTokens?`, `systemPrompt?`, `jsonMode?`, `schema?` (JSON Schema or Standard Schema), `tools?`, `toolChoice?`, `maxSteps?`, `signal?` (`AbortSignal`), `timeout?` (whole request, ms, default 30000), `streamIdleTimeout?` (ms of upstream silence before a stream fails, default 60000), `metadata?`, `reasoning?` (let a thinking model think; see [Reasoning models](#reasoning-models)), `cache?` (mark the stable prefix cacheable; see [Prompt caching](#prompt-caching)), `providerOptions?` (merged last into the wire body), `onStep?(step)` (after each tool round)
- **Message**: `{ role: 'system', content }` | `{ role: 'user', content: string | (TextPart | ImagePart)[] }` | `{ role: 'assistant', content, toolCalls? }` | `{ role: 'tool', toolCallId, name, content }`
- **Tool**: `name`, `description?`, `parameters` (JSON Schema), `execute?(args, { signal })`; **ToolCall**: `id`, `name`, `arguments`; **ToolResult**: `toolCallId`, `name`, `result?`, `error?`; **Step**: `text`, `toolCalls`, `toolResults`, `usage?`
- **AIResponse**: `success`, `data?`, `reasoning?`, `object?` (when `schema` given), `toolCalls?`, `steps?`, `error?`, `errorInfo?` (`AIError`, set when `success` is false), `finishReason` (`'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown'`), `usage?` (`TokenUsage`), `modelUsed?`, `providerId?`, `requestId?`, `durationMs`, `retryCount`, `fallbackUsed`
- **AIStreamChunk**: `{ type: 'text', text }` | `{ type: 'reasoning', text }` | `{ type: 'tool-call', toolCall }` | `{ type: 'done', finishReason, usage?, toolCalls?, requestId?, durationMs?, timeToFirstTokenMs? }`; every member has `modelUsed?`
- **TokenUsage**: `promptTokens?`, `completionTokens?`, `totalTokens?`, `cachedTokens?`
- **AIFactoryConfig**: `defaultProvider?`, `fallbackProvider?`, `fallbackProviders?`, `providerOrder?`, `logger?`, `providers?`, `retries?` (shorthand for `retry.retries`), `retry?` (`{ retries?, baseDelayMs?, maxDelayMs? }`), `discover?` (`'lazy' | 'eager' | 'none'`, default `'lazy'`), `timeout?`, `streamIdleTimeout?`, `hooks?` (`{ onRequest?, onResponse?, onError? }`), `concurrency?` (max provider calls in flight; a stream holds its slot until it ends)
- **BaseProviderConfig**: accepted by every built-in provider constructor: `baseURL?`, `headers?`, `timeout?`, `streamIdleTimeout?`, `models?` (seeds the supported list, skips discovery), `modelCacheTtlMs?` (default 300000), `fetch?` (custom `fetch`, for proxies or tests)
- **OpenAICompatibleProvider config**: `BaseProviderConfig` plus `preset?` (`'groq' | 'openrouter' | 'deepseek' | 'mistral' | 'xai' | 'together' | 'agent-platform'`), `id?`, `name?`, `apiKey?`, `modelFilter?`, `defaultModel?`, `defaultMaxTokens?`, `requireApiKey?`, `streamUsage?`, `apiKeyEnv?`
- **OllamaProvider config**: `BaseProviderConfig` plus `cli?` (`runOllamaCLI` from `/ollama-cli`), `ollamaExecutablePath?`, `preferCLI?`
- **Agent** (`/agent`): `new Agent({ name, model?, system?, tools?, maxSteps?, temperature?, maxTokens?, factory?, onStep? })`; `run(input, overrides?)` → `AgentResult` (`AIResponse` + `handedOffTo?`), `stream(input, overrides?)`, `asTool({ name?, description? })`, `request(input)`; `handoff(agent, description?)` → `Tool`
- **Session** (`/session`): `new Session({ id, store?, maxTokens?, summarize?, toolResultChars? })`; `send(agent, input, overrides?)`, `messages()`, `clear()`, `estimateTokens()`; `Store` is `{ get(id), set(id, messages), delete?(id) }`; `MemoryStore`; `transcript(response)` → `Message[]`
- **McpClient** (`/mcp`): `McpClient.connect({ url, headers?, fetch?, signal? } | { transport })`; `tools()` → `Tool[]`, `listTools()`, `callTool(name, args)`, `resources()`, `readResource(uri)`, `prompts()`, `getPrompt(name, args?)`, `ping()`, `call(method, params)`, `close()`; `McpStdioTransport({ command, args?, env?, cwd?, timeout? })` from `/mcp-stdio`
- **embed** (`/embed`): `embed(texts, { model, provider?, baseURL?, apiKey?, headers?, fetch?, signal?, timeout?, dimensions? })` → `{ embeddings: number[][], usage? }`; `cosine(a, b)`
- **Routine** (`/routine`): `new Routine({ name, every, run({ signal, lastRunAt }), store?, onResult?, onError?, timeout?, catchUp? })`; `start()`, `stop()`, `runNow()`, `next(from?)`, `state()`; `nextRun(every, from)`, `parseCron`, `parseDuration`
- **cost** (`/cost`): `estimateCost(usage, model, table?)` → USD | `undefined`; `priceOf(model, table?)`; `PRICES`, `PRICES_DATE`
- **Logger**: optional `debug`, `info`, `warn`, `error` (all `(message, ...args) => void`)
- **AIError**: see [Errors](#errors)
- **AIProvider**: interface for custom providers; implement `providerId`, `providerName`, `supportedModels`, `process`, `isModelSupported`, `testConnection`, `discoverModels`; `processStream` is optional (the factory falls back to one chunk from `process`)
- Removed in 2.0 (see [MIGRATION.md](MIGRATION.md)): `history`, `responseSchema`, `usageContext`; `tokensUsed` / `promptTokens` / `completionTokens` (use `usage`), `processingTime`, `confidence`, `cost`, `modelCapabilities`, `suggestedImprovements`, `timestamp`; the 1.x `{ text, done }` chunk shape
</details>

---

## See it run

`node examples/demo.mjs` runs the scenarios below against a local Ollama. The output here is copied from a real run (Ollama, `gemma4:latest`, no API keys set), not typed by hand.

<details>
<summary><strong>1. Zero config</strong></summary>

```typescript
const text = await aiFactory.generate('In one short sentence, what is a mutex?', { modelId: 'gemma4:latest', maxTokens: 60 });
```

```
A mutex is a synchronization primitive used to ensure that only one thread can access a shared resource at any given time.
```
</details>

<details>
<summary><strong>2. Streaming with timings</strong></summary>

```typescript
for await (const chunk of aiFactory.processStream({ prompt: 'Count from 1 to 5, comma separated.', modelId: 'gemma4:latest' })) {
  if (chunk.type === 'text') process.stdout.write(chunk.text);
  if (chunk.type === 'done') console.log(chunk);
}
```

```
1, 2, 3, 4, 5
{ finishReason: 'stop', usage: { promptTokens: 20, completionTokens: 14, totalTokens: 34 }, timeToFirstTokenMs: 39, durationMs: 120 }
```
</details>

<details>
<summary><strong>3. JSON mode</strong></summary>

```typescript
const res = await aiFactory.process({ prompt: 'Give three primary colours as {"colours": string[]}.', modelId: 'gemma4:latest', jsonMode: true });
console.log(res.data, JSON.parse(res.data));
```

```
{"colours": ["red", "yellow", "blue"]}
{ colours: [ 'red', 'yellow', 'blue' ] }
```
</details>

<details>
<summary><strong>4. Reasoning</strong></summary>

```typescript
for await (const chunk of aiFactory.processStream({ prompt: 'Is 91 prime? Answer yes or no with one reason.', modelId: 'gemma4:latest', reasoning: true })) {
  if (chunk.type === 'reasoning') thought += chunk.text; else if (chunk.type === 'text') answer += chunk.text;
}
```

```
reasoning: Thinking Process:

1.  **Analyze the request:** The user asks "Is 91 prime?" and requires the answer to be "yes or no" with "one reason."
2.  **Define "prime nu…
text:      No, because 91 is divisible by 7 (91 = 7 * 13).
usage:     { promptTokens: 30, completionTokens: 342, totalTokens: 372 }
```
</details>

<details>
<summary><strong>5. Model not found</strong></summary>

```typescript
const res = await aiFactory.process({ prompt: 'hi', modelId: 'llama9:70b' });
console.log(String(res.errorInfo));
console.log(res.errorInfo);
```

```
[ollama/MODEL_NOT_FOUND] model 'llama9:70b' not found — Run `ollama pull llama9:70b` and try again.
{
  code: 'MODEL_NOT_FOUND',
  provider: 'ollama',
  message: "model 'llama9:70b' not found",
  hint: 'Run `ollama pull llama9:70b` and try again.',
  statusCode: 404,
  retryable: false,
  model: 'llama9:70b'
}
```
</details>

<details>
<summary><strong>6. Provider not running</strong></summary>

```typescript
const res = await new LMStudioProvider().process({ prompt: 'hi', modelId: 'any' });
```

```
[lmstudio/PROVIDER_UNREACHABLE] fetch failed (ECONNREFUSED) — Nothing answered at http://localhost:1234/v1; check that it is running and the baseURL.
```
</details>

<details>
<summary><strong>7. Cloud model, no key</strong></summary>

```typescript
const res = await aiFactory.process({ prompt: 'hi', modelId: 'gpt-4o' });
```

```
[openai/NO_PROVIDERS] Provider "openai" (for model "gpt-4o") is not available: connection test failed (missing or rejected API key, or server not running) — Fix the openai setup, or pick a model from an available provider (ollama).
```
</details>

<details>
<summary><strong>8. Fallback</strong></summary>

A bad OpenAI key fails with `AUTH`, which is not retried; the request moves to Ollama. `gpt-4o` belongs to OpenAI, so the fallback uses its own default model instead of 404ing.

```typescript
const factory = new AIFactory({
  providers: [new OpenAIProvider({ apiKey: 'sk-not-a-real-key' }), new OllamaProvider({ models: ['gemma4:latest'] })],
  discover: 'lazy',
  fallbackProvider: 'ollama',
  logger: { warn: console.warn },
});
const res = await factory.process({ prompt: 'Say "fallback works" and nothing else.', modelId: 'gpt-4o' });
```

```
[warn] OpenAI failed (AUTH: Incorrect API key provided: sk-not-a*****-key. ...); trying the next provider
[warn] Ollama: model "gpt-4o" belongs to openai; using the default model instead
{ success: true, providerId: 'ollama', modelUsed: 'gemma4:latest', fallbackUsed: true, retryCount: 0, data: 'fallback works' }
```
</details>

<details>
<summary><strong>9. Abort and timeout</strong></summary>

```typescript
const abort = new AbortController();
for await (const chunk of aiFactory.processStream({ prompt: 'Write a long paragraph.', modelId: 'gemma4:latest', signal: abort.signal })) {
  if (chunk.type === 'text') partial += chunk.text;
  if (partial.length > 40) abort.abort();
}
// throws: { code: 'ABORTED', message: 'This operation was aborted' }   partial has 42 chars

const slow = await aiFactory.process({ prompt: 'Write a long essay.', modelId: 'gemma4:latest', timeout: 50 });
```

```
[ollama/TIMEOUT] Request timed out after 50ms — Raise the timeout, or use processStream for long answers.
retryCount: 2
```
</details>

---

## Providers

| Provider | Type | Streams | Tools | Schema | Images | `baseURL` | Notes |
|---------|------|:-:|:-:|:-:|:-:|:-:|--------|
| **Ollama** | Local | ✅ | ✅ | ✅ `format` | ✅ bytes only | ✅ | API + CLI; list/pull/rm/show/ps/run; tested |
| **LM Studio** | Local | ✅ | ✅ | ✅ | ✅ | ✅ | localhost:1234; OpenAI-compatible; tested |
| **OpenAI** | Cloud | ✅ | ✅ | ✅ `json_schema` | ✅ | ✅ | API key required |
| **Anthropic** | Cloud | ✅ | ✅ | system-prompt instruction, not native | ✅ | ✅ | API key required |
| **Gemini** | Cloud | ✅ | ✅ | ✅ `responseSchema` | ✅ | ✅ | API key required; tested |
| **Groq**, **OpenRouter**, **DeepSeek**, **Mistral**, **xAI**, **Together** | Cloud | ✅ | ✅ | host-dependent | host-dependent | ✅ | `OpenAICompatibleProvider` presets; API key required |
| Any OpenAI-compatible server (vLLM, llama.cpp, ...) | Either | ✅ | ✅ | host-dependent | host-dependent | ✅ | `new OpenAICompatibleProvider({ id, baseURL })` |

Every provider streams for real: SSE for the OpenAI dialect, Anthropic and Gemini; NDJSON for Ollama.

The factory probes providers per `discover` (default `'lazy'`, see [Discovery](#discovery)) and keeps those that pass the connection check. Use `getProvider('ollama')` (etc.) to use a specific one.

---

## Troubleshooting

Read `errorInfo.hint` first; it is generated for the specific failure and usually says exactly what to do next.

| Code | Hint |
|---|---|
| `NO_API_KEY` | Pass `{ apiKey }` to the provider, or set its environment variable. |
| `PROVIDER_UNREACHABLE` | Nothing answered at the configured `baseURL`; check that it is running. |
| `MODEL_NOT_FOUND` | The model id is unknown to the provider; check it, or call `discoverModels()` for the list. |

<details>
<summary><strong>Use a specific provider</strong></summary>

```typescript
const provider = aiFactory.getProvider('ollama');
if (provider) {
  const res = await provider.process({ prompt: 'Hello', modelId: 'llama3.1:8b' });
}
```
</details>

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the gates to run and a template for adding a provider. [examples/](examples) has runnable scripts; the generated [API reference](https://tanvoid0.github.io/llmwire/) lists every exported symbol; [llms.txt](llms.txt) is the index for coding agents.

---

## License

MIT
