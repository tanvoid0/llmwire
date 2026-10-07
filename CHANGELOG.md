# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.3.0] - 2026-10-07

### Added

- `AIRequest.cache`: `cache: true` marks the stable prompt prefix cacheable. On Anthropic it stamps `cache_control: { type: 'ephemeral' }` on the system prompt and the last tool definition, so a repeated prefix is billed at the cache rate; a hit comes back on `usage.cachedTokens`. OpenAI and other OpenAI-format hosts cache automatically and ignore the flag. For finer control, set `cache_control` through `providerOptions`.

### Changed

- `llmwire/cost`: DeepSeek, xAI and Mistral list prices added to `PRICES` (checked 2026-09-14).

## [2.2.0] - 2026-09-14

### Added

- `llmwire/routine`: `Routine({ name, every, run, store?, onResult?, onError?, timeout?, catchUp? })` runs a job on an interval (`'15m'`, ms) or a 5-field cron (local time) with `setTimeout`; `start`, `stop` (aborts the run's `signal`), `runNow`, `next`, `state`. A run that overruns its slot skips the next tick. A `Store` keeps `lastRunAt` / `lastResult` / `lastError`; `catchUp` runs once on start when the last run is stale. `nextRun`, `parseCron`, `parseDuration` exported.
- `npx llmwire routine run <file> [name...]`: imports the file and runs each exported routine once, for system cron and systemd timers.
- `Store` and `MemoryStore` from `llmwire/session` are generic (`Store<T = Message[]>`).

## [2.1.0] - 2026-09-14

Additive. Six new entries, none imported by the core; `.` and `./core` sizes are unchanged.

### Added

- `llmwire/agent`: `Agent({ name, model?, system?, tools?, maxSteps?, factory?, onStep? })` with `run` and `stream` through the factory's tool loop; `agent.asTool()` for supervisor patterns; `handoff(agent)` ends the current turn and continues the same conversation as another agent (`handedOffTo` on the result, `steps` merged). Uses the shared `aiFactory` unless given one.
- `llmwire/session`: `Session({ id, store?, maxTokens?, summarize?, toolResultChars? })` keeps a conversation across `send(agent, input)` calls in a `Store` (`MemoryStore` ships) and holds it under a budget: tool results shortened first, then whole oldest turns dropped (never the last, never a call without its result), optionally replaced by one model-written summary. `transcript(response)` turns an answer with steps into messages.
- `llmwire/mcp`: `McpClient.connect({ url | transport })`, JSON-RPC 2.0 over Streamable HTTP with `fetch`, no SDK. `tools()` returns `Tool[]` whose `execute` calls `tools/call`; `resources()`, `readResource`, `prompts()`, `getPrompt`, `ping`, `call`. JSON-RPC errors are `AIError` `MCP_ERROR` with `providerCode` the RPC code. `llmwire/mcp-stdio`: `McpStdioTransport` (Node only).
- `llmwire/embed`: `embed(texts, { model, provider?, baseURL?, apiKey? })` for OpenAI-format `/embeddings`, Gemini `batchEmbedContents` and Ollama `/api/embed`; `cosine`.
- `llmwire/cost`: `estimateCost(usage, model, table?)` from a dated list-price table (`PRICES`, `PRICES_DATE`) for Anthropic, OpenAI and Google models; `undefined` for anything else.
- `AIRequest.onStep(step)`: called after each round of the factory's tool loop, on `process` and `processStream`.
- `AIFactoryConfig.concurrency`: max provider calls in flight across the factory; a stream holds its slot until it ends.

## [2.0.0] - 2026-09-13

Breaking. See [MIGRATION.md](MIGRATION.md); every removed input fails with an `AIError` naming its replacement.

### Added

- `AIRequest.messages`: the conversation as `Message[]` (`system` / `user` / `assistant`); a `user` message may carry parts, `{ type: 'text' }` and `{ type: 'image', url | data, mimeType? }`. Images go out as OpenAI `image_url` (remote URL or `data:` URL), Anthropic `source: base64 | url`, Gemini `inlineData` / `fileData`, Ollama `images[]`. Bytes and base64 are inlined with the mime type sniffed (png, jpeg, gif, webp) when not given; Ollama answers a remote URL with `UNSUPPORTED` and a hint. `prompt` is now optional and appended after `messages` as the final user turn. `Message`, `MessagePart`, `TextPart`, `ImagePart` exported; `partsOf`, `textOf`, `inlineImage` exported for custom providers.
- The factory answers a request with neither `prompt` nor `messages` with `INVALID_REQUEST` before touching a provider.
- **Tool calling** on OpenAI-format hosts, Anthropic, Gemini and Ollama: `AIRequest.tools` (`{ name, description?, parameters, execute? }`), `toolChoice` (`'auto' | 'none' | 'required' | { name }`). Calls come back as `AIResponse.toolCalls` with `finishReason: 'tool_calls'`, and on the stream's `done` chunk (argument deltas are assembled per provider). `Message` gains `{ role: 'assistant', toolCalls }` and `{ role: 'tool', toolCallId, name, content }`; Anthropic and Gemini group consecutive results into one user turn as their APIs require.
- `maxSteps` on the request: when above 1 and every called tool has `execute`, the factory runs the calls (in parallel; a throwing tool is sent back as `{ error }`), appends the assistant turn and results, and asks again, up to `maxSteps` rounds. `AIResponse.steps` lists each round. `processStream` does the same, emitting the intermediate calls on a plain chunk (`{ text: '', toolCalls }`) and a single `done` at the end. `toolChoice` is dropped after the first round so `'required'` cannot loop forever.
- Leaked tool calls: text of the form `<function=name>{json}</function>` from a weak local model is recovered as a real call (first occurrence per tool) and stripped from `data`, on OpenAI-format hosts and Ollama, whenever `tools` were offered. `recoverLeakedToolCalls` exported.
- Ollama's "model does not support tools" 400 classifies as `UNSUPPORTED` with a hint.
- `core/tools.ts` helpers exported for custom providers: `openaiTools`, `parseArgs`, `runTools`, `nextStepRequest`.
- **Structured output**: `AIRequest.schema` takes a JSON Schema object or any Standard Schema (Zod, Valibot, ArkType, ...). It implies JSON mode; a JSON form of the schema (a plain object, or a library's `~standard.jsonSchema`) goes out as OpenAI `response_format: json_schema`, Gemini `responseSchema`, Ollama `format`, and into Anthropic's system nudge. The factory parses the answer (a stray ```json fence is tolerated) and validates it through the Standard Schema; the result is `AIResponse.object`, the raw text stays on `data`. Failures: `INVALID_JSON` (text in `errorInfo.details`), `SCHEMA_MISMATCH` (issues with paths in `details`, first one in the message), and `TRUNCATED` on `finishReason: 'length'`, which now covers `schema` as well as `jsonMode`. Streams ignore `schema`. A plain JSON Schema is not validated locally (no validator ships); `object` is the parsed value. `StandardSchemaV1` type and `jsonSchemaOf` / `parseJson` / `isStandardSchema` exported.
- **Typed stream chunks**: `AIStreamChunk` is `TextChunk | ReasoningChunk | ToolCallChunk | DoneChunk`, discriminated by `type`. `text` and `reasoning` chunks carry `text`; a `tool-call` chunk is emitted per completed call before `done`; `done` carries `finishReason`, `usage`, `toolCalls`, `requestId`, `durationMs`, `timeToFirstTokenMs`. A non-streaming provider's answer arrives as `text` then `done`. `chunksOf(response)` exported.
- `@tanvoid0/bot-client/core`: the factory, errors, types and helpers without the built-in providers. `AIFactory` from `./core` has no default providers (pass `providers`); `./core` plus one provider subpath bundles to 11.5 kB gz, against 17 kB for `.`. The `.` entry is unchanged: its `AIFactory` still defaults to all five providers, and `aiFactory` still works with no config.

### Changed

- **Renamed to `llmwire`.** `@tanvoid0/bot-client` continues as a re-export shim (every subpath and the `bot-client` CLI) for one major; see [MIGRATION.md](MIGRATION.md). The CLI is `npx llmwire`.
- `discover` defaults to `'lazy'`: providers are registered without a network call and probed the first time a request lands on them. Pass `discover: 'eager'` for the 1.x behaviour of probing every provider up front and dropping the ones that fail.
- `AIRequest.prompt` is optional (`string | undefined`); a custom provider reading it as a string needs a `?? ''`. `buildChatMessages` returns `Message[]`, whose `content` may be a parts array.

### Removed

- `AIRequest.history` (use `messages`), `responseSchema` (use `schema`), `usageContext`. Passing any of them fails with `INVALID_REQUEST` and a hint.
- `AIResponse.tokensUsed` / `promptTokens` / `completionTokens` (use `usage`), `processingTime` (use `durationMs`), `confidence`, `cost`, `modelCapabilities`, `suggestedImprovements`, `timestamp`.
- The 1.x stream chunk shape. A custom provider yielding `{ text, done }` makes the factory throw `INVALID_RESPONSE` on the first chunk.
- `BaseProvider.createResponse` and `handleError`; `ChatMessage`; the unused types `ConversationHistory`, `AIProviderConfig`, `ProviderType`, `ProviderConfig`, `ContentGenerationRequest`, `AnalysisRequest`, `CodeGenerationRequest`, `ConversationRequest`, `PostProcessingOptions`, `ModelCapabilities`, `ProcessingMetrics`.

### Fixed

- A 200 reply whose only content is a refusal (`finish_reason: content_filter` on OpenAI-format hosts, `stop_reason: refusal` on Anthropic) is now a `CONTENT_FILTER` failure, as it already was for Gemini, instead of a success with empty `data`.
- Gemini `RESOURCE_EXHAUSTED` naming a per-day quota (`quotaId: ...PerDay...`) classifies as `QUOTA` (not retryable); per-minute limits stay `RATE_LIMIT`.
- `tests/errors.test.ts` now covers every cell of the ARCHITECTURE §5.2 classification table.

## [1.8.0] - 2026-09-13

### Added

- **Presets** on `OpenAICompatibleProvider`: `{ preset: 'groq' | 'openrouter' | 'deepseek' | 'mistral' | 'xai' | 'together' | 'agent-platform' }` fills in the origin, display name and key variable (`GROQ_API_KEY`, ...); any field given alongside overrides it. `PRESETS` is exported. Model ids those hosts use (`grok-4`, `deepseek-chat`, `mistral-large-latest`, `llama-3.3-70b-versatile`) route to the matching provider with no discovery call. Together's bare-array `/models` reply is read.
- `AIRequest.providerOptions`: provider-specific fields merged last into the wire body, one level deep (`{ options: { num_ctx: 8192 } }` extends Ollama's `options` instead of replacing it). `mergeBody` exported for custom providers.
- Factory `hooks`: `onRequest`, `onResponse` (the `AIResponse`, or the `done` chunk for a stream, with `durationMs`) and `onError` (with `willRetry`). Awaited; called once per attempt.
- Subpath exports: `@tanvoid0/bot-client/openai`, `/anthropic`, `/gemini`, `/ollama`, `/lmstudio`, `/openai-compatible`, `/ollama-cli`, with `typesVersions` for `moduleResolution: node`. The CJS build now ships its own `.d.ts`, so a CommonJS TypeScript project under `moduleResolution: nodenext` (NestJS) no longer hits TS1479 on any entry. The main entry and every provider subpath bundle for the browser with no Node built-ins; a test enforces it.
- `npx @tanvoid0/bot-client doctor [preset...]`: lists each provider's models, sends it a one-line prompt and prints the model that answered or the classified error with its hint.
- `modelCacheTtlMs` on every provider (default 5 min; 0 disables): a successful model listing is reused by `discoverModels()` and `testConnection()`, so eager discovery costs one call per provider instead of two. A failed listing is never cached.
- `OllamaProviderConfig.cli`: pass `runOllamaCLI` to keep the `ollama` binary as a fallback for management calls.

### Changed

- `runOllamaCLI` and `isOllamaCLIAvailable` moved from the main entry to `@tanvoid0/bot-client/ollama-cli` (they spawn a process; the main entry now runs wherever `fetch` does). `OllamaProvider` calls the binary only when given `cli: runOllamaCLI`; without it, `serve`, `stop`, `create` and the server-down fallback return `{ ok: false }` with a message saying so. The `npx` CLI is unaffected.
- Anthropic and Gemini read their key through the same guarded helper as the OpenAI dialect, so constructing them where `process` is undefined no longer throws.
- `test-package.js` awaits `aiFactory.ready()` and drops calls to methods removed in 1.7.

## [1.7.0] - 2026-09-13

### Added

- **Reasoning models**: `AIRequest.reasoning` (Ollama `think`, Anthropic extended thinking, Gemini `includeThoughts`); the thinking comes back as `AIResponse.reasoning` and as `reasoning` deltas on `AIStreamChunk`, never mixed into `text`. OpenAI-format `reasoning_content` / `reasoning` fields and inline `<think>` tags are surfaced the same way; a tag split across stream chunks is held back until known (`ThinkFilter`, `splitThinkTags` exported).
- Fallback drops a `modelId` the fallback provider cannot serve (`gpt-4o` when OpenAI is down) so it answers with its own default model instead of 404ing.
- `PROVIDER_UNREACHABLE` is retried exactly once (a live server with a full accept backlog refuses like a dead port); a 4xx body naming a rate limit ("too many concurrent requests") classifies as `RATE_LIMIT`; a body whose `error.code` is already an `AIErrorCode` name maps 1:1.
- Seeded `models` stay first after discovery, so the caller's chosen default remains the default.
- `examples/demo.mjs`: ten real scenarios against a local Ollama, whose output is what the README "See it run" section shows.

- `AIError` fields: `code`, `hint`, `statusCode`, `providerCode`, `retryable`, `retryAfterMs`, `requestId`; a full `AIErrorCode` taxonomy with per-provider classifiers (`core/errors.ts`).
- Static model-id routing (`core/catalog.ts`): an explicit `openai/gpt-4o` prefix, then a prefix table (`gpt-`, `claude-`, `gemini-`, Ollama family names) resolves the provider with no network call.
- `discover: 'eager' | 'lazy' | 'none'` on `AIFactoryConfig`: `'eager'` (default) probes every provider in parallel, `'lazy'` probes on first use, `'none'` never probes.
- Retry with backoff (`core/retry.ts`): exponential delay with jitter, honours `Retry-After`; `retry: { retries, baseDelayMs, maxDelayMs }` on the factory. `AIResponse.retryCount` and `fallbackUsed` report what happened; `fallbackProviders[]` tried in order after `fallbackProvider`.
- Real SSE streaming for OpenAI, LM Studio and Anthropic, alongside Gemini and Ollama; one `parseSSE` / `parseNDJSON` in `core/http.ts` shared by every provider.
- `streamIdleTimeout` (default 60 s): a stream that goes silent fails with `STREAM_IDLE` instead of hanging forever; settable per request, factory or provider.
- `finishReason`, `durationMs`, `timeToFirstTokenMs`, `requestId`, `usage.cachedTokens` on responses and the stream's `done` chunk.
- `OpenAICompatibleProvider`: point at any OpenAI-format host (Groq, OpenRouter, DeepSeek, ...) with `{ id, baseURL, apiKey }`; `OpenAIProvider` and `LMStudioProvider` are now thin subclasses of it.
- `BaseProviderConfig` (`baseURL`, `headers`, `timeout`, `streamIdleTimeout`, `models`, `fetch`) accepted by every built-in provider.

### Changed

- `process()` on every built-in provider now returns a failure response (`{ success: false, error, errorInfo }`) instead of throwing; the factory catches the rest so retry and fallback work on real HTTP failures, not just a missing key.
- `testConnection()`'s default is now "list models", not a real completion; no more paid call on every process start.
- `AIError.message` is the provider's own text verbatim; no longer prefixed with "X processing failed:".
- SSE parsing is spec-correct: a frame is dispatched on the blank line that terminates it, not per `data:` line.
- Retry defaults to 2 attempts with backoff (was 0, a tight loop with no delay).

### Fixed

- Ollama thinking models returned an empty answer with `finishReason: 'length'` at the default temperature, because the thinking silently consumed the output budget; `think: false` is now sent unless `reasoning: true`.
- The retry backoff timer was unref'd, so a process with nothing else pending could exit mid-retry.

- Provider discovery ran sequentially and probed every provider on the first call, so a single request could wait through five timeouts; discovery is now parallel and probe-only.
- Every process start sent a real, billed generation to Anthropic just to check the connection.
- `modelId: 'claude-…'` never routed to Anthropic (`discoverModels` returned nothing), so it silently fell through to the wrong provider; static routing fixes this without a network call.
- Real provider failures (rate limit, 5xx, network) skipped `retries` and `fallbackProvider` entirely because the factory never caught the throw; both now work.
- The retry loop retried non-retryable failures (missing key, 400, 401) with no delay between attempts.
- `AIError.code` and `statusCode` were never populated, and `Retry-After`, the request id and the provider's own error type were dropped; callers could not branch on error kind.
- OpenAI, Anthropic and LM Studio "streamed" as a single chunk holding the whole answer.
- Streams had no idle timeout; a stalled upstream hung forever unless the caller aborted.
- `processingTime` and `confidence` were hard-coded fake metrics on every response.
- Gemini streaming silently skipped frames it could not parse, and a `SAFETY` / `MAX_TOKENS` finish reported as a normal success even with a truncated or blocked answer.
- Ollama `process()` with no models loaded sent `model: undefined`, producing an opaque upstream error instead of `NO_MODEL`.

### Deprecated

- `AIResponse.processingTime` (use `durationMs`), `.confidence`, `.cost`, `.modelCapabilities`, `.suggestedImprovements`, `.timestamp`.
- `AIRequest.usageContext`.
- `AIProviderConfig`, `ProviderConfig`, `ContentGenerationRequest`, `AnalysisRequest`, `CodeGenerationRequest`, `ConversationRequest`, `PostProcessingOptions`, `ModelCapabilities`, `ProcessingMetrics`: unused, removed in 2.0.

---

## [1.6.0] - 2026-09-13

### Changed

- **Zero runtime dependencies**: `axios` is gone; every provider talks to its API over the global `fetch`. `npm install` pulls in nothing but this package.
- Streaming reads the `fetch` body directly (`streamLines` now takes any `AsyncIterable<Uint8Array | string>`); the abort signal and the no-timeout streaming call behave as before.
- Non-2xx replies throw `HttpError` (`status`, `body`, parsed `json`); `handleError` still lifts the API's own `error.message` into the `AIError`.
- Node **18+** required (was 16+), for native `fetch`.

### Removed

- `readStreamToString` from `base-provider` — no longer needed, error bodies are read before a stream is handed out.

---

## [1.5.0] - 2026-09-07

### Added

- **Streaming**: `AIFactory.processStream(request)` and `AIProvider.processStream`, yielding `AIStreamChunk`s (`text` written since the last chunk, then a final chunk carrying `done` and the token usage).
  - `GeminiProvider` reads `streamGenerateContent` as SSE; `OllamaProvider` reads `/api/chat` NDJSON. Same request body as `process`, so a streamed answer is the same answer in pieces.
  - `BaseProvider.processStream` falls back to one chunk from `process()`, so every provider — OpenAI, Anthropic, LM Studio — can be consumed as a stream today and gain real streaming later without callers changing.
  - No retry and no fallback provider on the streaming path: half an answer is usually already on screen when a stream fails, and restarting elsewhere would splice two answers together.
- `streamLines` helper, exported from `base-provider`, which reassembles lines split across network reads.
- `AIRequest.signal` (`AbortSignal`) to abort an in-flight request/stream; wired through `GeminiProvider` and `OllamaProvider`'s `processStream`, which also drop the client's 30s socket-idle timeout on the streaming call so a cold model load or a mid-stream stall isn't cut off.

---

## [1.3.1] - 2026-02-04

### Fixed

- Publish workflow: fail with clear message when `NPM_TOKEN` secret is missing (instead of generic npm auth error).

---

## [1.3.0] - 2026-02-04

### Added

- **AIFactory config**: `defaultProvider`, `fallbackProvider`, `providerOrder`, `logger`, `providers`, `retries` in constructor.
- **Logger interface**: Optional `logger` in factory config; no console logging when not provided.
- **New methods**: `getAllSupportedModels()`, `getProviderForModel(modelId)`, `testProviders()`, `ready()`.
- **Programmatic provider config**: `OpenAIProviderConfig`, `AnthropicProviderConfig`, `GeminiProviderConfig`, `LMStudioProviderConfig`; pass API keys/baseURL in code.
- **Custom providers**: `AIFactory({ providers: [AIProvider[]] })` to use only specified providers.
- **Conversation history**: All providers use `systemPrompt` and `history` from `AIRequest` (via `buildChatMessages`).
- **AIError code**: Optional `code` (e.g. `NO_API_KEY`, `RATE_LIMIT`) for programmatic handling; `AIErrorCode` type exported.
- **Unit tests**: buildChatMessages, Logger spy tests, AIFactory with mock provider (defaultProvider, providerOrder, fallback, retries), ensureFactoryReady.
- **Integration tests**: `tests/integration-local.ts` for Ollama and LM Studio (no API keys); tests skip when provider unreachable.
- **Exports**: `AIProvider`, provider config types, `buildChatMessages` (via base-provider), `AIErrorCode`.

### Changed

- **Cloud auth**: OpenAI and Anthropic send API keys (Bearer / x-api-key) on every request; single reused HTTP client per provider.
- **Ollama**: `process()` and `discoverModels()` use `getApiClient()` (respects `baseURL` from config).
- **Connection tests**: OpenAI, Gemini, Ollama, LM Studio use lightweight checks (e.g. GET models/tags) instead of full completion.
- **HTTP clients**: All providers reuse one client per provider for discover and process.
- **TypeScript**: `strict: true` in tsconfig.
- **Scripts**: `clean` is cross-platform (Node one-liner); test script uses `--forceExit`.
- **.env.example**: UTF-8, no BOM.
- **README and examples**: Updated for current API; examples use real config and `ready()`.

### Fixed

- Cloud providers no longer return 401 due to missing API key headers.
- Ollama custom `baseURL` was ignored in `process()`; now used.
- Factory constructor accepted no config; now accepts `AIFactoryConfig`.
- Provider selection was arbitrary (first in map); now respects `modelId`, `defaultProvider`, `providerOrder`, then fallback.

### Removed

- **Dead test**: `tests/ai-model-manager.test.ts` (referenced non-existent `AIModelManager`).

---

## [1.2.2] and earlier

See git history for changes before this changelog was added.

[1.3.1]: https://github.com/tanvoid0/bot-client/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/tanvoid0/bot-client/compare/v1.1.1...v1.3.0
