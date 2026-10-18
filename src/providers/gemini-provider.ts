/** @module llmwire/gemini */
import type { AIRequest, AIResponse, AIStreamChunk, BaseProviderConfig, FinishReason, TokenUsage } from '../types/index.js';
import type { Refinement } from '../core/errors.js';
import { BaseProvider, buildChatMessages, firstEnv, inlineImage, mergeBody, partsOf, textOf as messageText } from './base-provider.js';
import { parseArgs } from '../core/tools.js';
import { jsonSchemaOf, wantsJson } from '../core/schema.js';
import type { ToolCall } from '../types/index.js';
import { parseSSE } from '../core/http.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-3.8-flash';

/**
 * Generous by default: structured replies (plans, tool calls) truncate
 * mid-JSON at the old 1000-token cap, which reads as a parse failure.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface GeminiProviderConfig extends BaseProviderConfig {
  apiKey?: string;
  /** Origin; defaults to generativelanguage.googleapis.com. */
  baseURL?: string;
}

const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

function finishReason(raw: unknown): FinishReason {
  if (raw === 'STOP') return 'stop';
  if (raw === 'MAX_TOKENS') return 'length';
  if (typeof raw === 'string' && BLOCKED.has(raw)) return 'content_filter';
  if (raw === 'MALFORMED_FUNCTION_CALL') return 'error';
  return 'unknown';
}

function usageOf(meta: any): TokenUsage | undefined {
  if (!meta) return undefined;
  return {
    promptTokens: meta.promptTokenCount,
    completionTokens: meta.candidatesTokenCount,
    totalTokens: meta.totalTokenCount,
    ...(meta.cachedContentTokenCount !== undefined && { cachedTokens: meta.cachedContentTokenCount }),
  };
}

/** Answer text and, when `includeThoughts` was on, the thought parts (`thought: true`) separately. */
/** `functionCall` parts of a candidate. Gemini sends no call ids; positional ones are made up. */
function toolCallsOf(candidate: any, offset = 0): ToolCall[] {
  const parts: any[] = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  return parts
    .filter((p) => p?.functionCall)
    .map((p, i) => ({ id: p.functionCall.id ?? `call_${offset + i}`, name: p.functionCall.name ?? '', arguments: p.functionCall.args ?? {} }));
}

/** `functionResponse.response` must be an object: a JSON object result as is, anything else wrapped. */
function responseOf(content: string): Record<string, unknown> {
  try {
    const v = JSON.parse(content);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { result: v };
  } catch {
    return { result: content };
  }
}

function toolConfigOf(choice: NonNullable<AIRequest['toolChoice']>): Record<string, unknown> {
  if (typeof choice === 'object') return { mode: 'ANY', allowedFunctionNames: [choice.name] };
  return { mode: choice === 'required' ? 'ANY' : choice.toUpperCase() };
}

function textOf(candidate: any): { text: string; reasoning: string } {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return { text: '', reasoning: '' };
  let text = '';
  let reasoning = '';
  for (const p of parts) {
    if (typeof p?.text !== 'string') continue;
    if (p.thought === true) reasoning += p.text;
    else text += p.text;
  }
  return { text, reasoning };
}

export class GeminiProvider extends BaseProvider {
  private readonly apiKey?: string;
  private readonly base: string;

  constructor(config: GeminiProviderConfig = {}) {
    super(config);
    this.apiKey = config.apiKey ?? firstEnv(['GEMINI_API_KEY', 'BOT_CLIENT_GEMINI_KEY']);
    this.base = (config.baseURL ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  get providerId(): string {
    return 'gemini';
  }

  get providerName(): string {
    return 'Google Gemini';
  }

  protected get baseURL(): string {
    return this.base;
  }

  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    if (this.cached()) return true;
    try {
      await this.http(`${this.base}/v1beta/models`, { params: { key: this.apiKey, pageSize: '1' } });
      return true;
    } catch {
      return false;
    }
  }

  async discoverModels(): Promise<string[]> {
    if (!this.apiKey) return [];
    const hit = this.cached();
    if (hit) return hit;
    try {
      const response = await this.http(`${this.base}/v1beta/models`, { params: { key: this.apiKey } });
      const models = response?.models ?? [];
      return this.setDiscovered(
        models
          .filter((m: { name?: string }) => typeof m.name === 'string' && m.name.includes('gemini'))
          .map((m: { name: string }) => m.name.split('/').pop() as string)
      );
    } catch {
      return this._supportedModels;
    }
  }

  protected classify(_status: number, json: any): Refinement {
    const status: string | undefined = json?.error?.status;
    const message: string = json?.error?.message ?? '';
    const details: any[] = Array.isArray(json?.error?.details) ? json.error.details : [];
    const reason = details.find((d) => typeof d?.reason === 'string')?.reason;
    const retryDelay = details.find((d) => typeof d?.retryDelay === 'string')?.retryDelay;
    const out: Refinement = { providerCode: reason ?? status };
    if (reason === 'API_KEY_INVALID' || status === 'UNAUTHENTICATED') out.code = 'AUTH';
    else if (status === 'PERMISSION_DENIED') out.code = 'PERMISSION';
    // Per-minute limits come back as RESOURCE_EXHAUSTED with a retryDelay; a
    // spent daily quota uses the same status but names a PerDay quotaId.
    else if (status === 'RESOURCE_EXHAUSTED')
      out.code = details.some((d) => d?.violations?.some((v: any) => /perday|daily/i.test(v?.quotaId ?? ''))) ? 'QUOTA' : 'RATE_LIMIT';
    else if (status === 'NOT_FOUND') out.code = 'MODEL_NOT_FOUND';
    else if (status === 'UNAVAILABLE') out.code = 'OVERLOADED';
    else if (status === 'INTERNAL') out.code = 'SERVER';
    else if (status === 'DEADLINE_EXCEEDED') out.code = 'TIMEOUT';
    else if (status === 'INVALID_ARGUMENT')
      out.code = /token|context|too long|input.*large/i.test(message) ? 'CONTEXT_LENGTH' : 'INVALID_REQUEST';
    const seconds = typeof retryDelay === 'string' ? Number(retryDelay.replace(/s$/, '')) : NaN;
    if (Number.isFinite(seconds)) out.retryAfterMs = seconds * 1000;
    return out;
  }

  /** The request body both the one-shot and the streaming call send. */
  private buildBody(request: AIRequest): Record<string, unknown> {
    const messages = buildChatMessages(request);
    const systemParts: Array<{ text: string }> = [];
    const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push({ text: messageText(m.content) });
      } else if (m.role === 'tool') {
        // Every result for one model turn goes in the same user turn.
        const part = { functionResponse: { name: m.name, response: responseOf(m.content) } };
        const prev = contents[contents.length - 1];
        if (prev?.role === 'user' && prev.parts[0]?.functionResponse) prev.parts.push(part);
        else contents.push({ role: 'user', parts: [part] });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        contents.push({
          role: 'model',
          parts: [
            ...(m.content ? [{ text: m.content }] : []),
            ...m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: parseArgs(c.arguments) } })),
          ],
        });
      } else {
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: partsOf(m.content).map((p) => {
            if (p.type === 'text') return { text: p.text };
            const inline = inlineImage(p);
            // A remote URL must be a Files API / GCS URI; Gemini does not fetch arbitrary http(s) URLs.
            return inline ? { inlineData: inline } : { fileData: { mimeType: p.mimeType, fileUri: p.url } };
          }),
        });
      }
    }
    const body: Record<string, unknown> = {
      contents,
      ...(request.tools?.length && {
        tools: [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, ...(t.description && { description: t.description }), parameters: t.parameters })) }],
        ...(request.toolChoice && { toolConfig: { functionCallingConfig: toolConfigOf(request.toolChoice) } }),
      }),
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: request.temperature ?? 0.7,
        ...(wantsJson(request) && { responseMimeType: 'application/json' }),
        ...(jsonSchemaOf(request.schema) !== undefined && { responseSchema: jsonSchemaOf(request.schema) }),
        ...(request.reasoning && { thinkingConfig: { includeThoughts: true } }),
      },
    };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: systemParts };
    }
    return mergeBody(body, request.providerOptions);
  }

  private resolveModel(request: AIRequest): string {
    return request.modelId ?? this.supportedModels[0] ?? DEFAULT_MODEL;
  }

  /** A 200 reply can still carry a refusal: no candidates and a `promptFeedback.blockReason`. */
  private blocked(data: any, model: string) {
    const reason = data?.promptFeedback?.blockReason;
    if (!reason) return null;
    return this.error('CONTENT_FILTER', `Prompt blocked by Gemini (${reason})`, { model, details: data.promptFeedback });
  }

  async process(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey) return this.fail(this.error('NO_API_KEY', 'Gemini API key required'));
    const model = this.resolveModel(request);
    try {
      const data = await this.http(`${this.base}/v1beta/models/${model}:generateContent`, {
        params: { key: this.apiKey },
        body: this.buildBody(request),
        ...this.requestOptions(request),
      });
      const blocked = this.blocked(data, model);
      if (blocked) return this.fail(blocked, model);
      const candidate = data?.candidates?.[0];
      const { text, reasoning } = textOf(candidate);
      const toolCalls = toolCallsOf(candidate);
      const finish = finishReason(candidate?.finishReason);
      if (finish === 'content_filter' && !text) {
        return this.fail(
          this.error('CONTENT_FILTER', `Answer blocked by Gemini (${candidate?.finishReason})`, {
            model,
            details: candidate?.safetyRatings,
          }),
          model
        );
      }
      return this.ok(text, {
        reasoning: reasoning || undefined,
        modelUsed: data?.modelVersion ?? model,
        finishReason: finish,
        toolCalls,
        usage: usageOf(data?.usageMetadata),
      });
    } catch (error) {
      return this.fail(this.toError(error, model), model);
    }
  }

  /**
   * Gemini's `streamGenerateContent`, read as server-sent events.
   *
   * Same body as [process] -- system instruction, JSON mode and schema all
   * travel unchanged -- so a streamed answer is the same answer, delivered in
   * pieces. A frame that does not parse is skipped rather than thrown on.
   */
  async *processStream(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    if (!this.apiKey) throw this.error('NO_API_KEY', 'Gemini API key required');
    const model = this.resolveModel(request);
    let stream: AsyncIterable<Uint8Array>;
    try {
      stream = await this.httpStream(`${this.base}/v1beta/models/${model}:streamGenerateContent`, {
        params: { key: this.apiKey, alt: 'sse' },
        body: this.buildBody(request),
        ...this.requestOptions(request),
      });
    } catch (error) {
      throw this.toError(error, model);
    }

    let usage: TokenUsage | undefined;
    let finish: FinishReason | undefined;
    let wrote = false;
    let modelUsed = model;
    const toolCalls: ToolCall[] = [];
    try {
      for await (const { data } of parseSSE(stream)) {
        if (!data || data === '[DONE]') continue;
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed?.error) {
          const refined = this.classify(0, parsed);
          throw this.error(refined.code ?? 'SERVER', parsed.error.message ?? 'stream error', { model, details: parsed.error });
        }
        const blocked = this.blocked(parsed, model);
        if (blocked) throw blocked;
        if (typeof parsed?.modelVersion === 'string') modelUsed = parsed.modelVersion;
        const candidate = parsed?.candidates?.[0];
        const { text, reasoning } = textOf(candidate);
        if (reasoning) yield { type: 'reasoning', text: reasoning, modelUsed };
        if (text) {
          wrote = true;
          yield { type: 'text', text, modelUsed };
        }
        toolCalls.push(...toolCallsOf(candidate, toolCalls.length));
        if (candidate?.finishReason) finish = finishReason(candidate.finishReason);
        if (parsed?.usageMetadata) usage = usageOf(parsed.usageMetadata);
      }
    } catch (error) {
      throw this.toError(error, model);
    }
    if (finish === 'content_filter' && !wrote) {
      throw this.error('CONTENT_FILTER', 'Answer blocked by Gemini', { model });
    }
    for (const toolCall of toolCalls) yield { type: 'tool-call', toolCall, modelUsed };
    yield {
      type: 'done',
      modelUsed,
      usage,
      finishReason: toolCalls.length ? 'tool_calls' : (finish ?? 'unknown'),
      ...(toolCalls.length && { toolCalls }),
    };
  }
}
