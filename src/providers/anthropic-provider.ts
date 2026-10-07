/** @module llmwire/anthropic */
import type { AIRequest, AIResponse, AIStreamChunk, BaseProviderConfig, FinishReason, TokenUsage } from '../types/index.js';
import type { Refinement } from '../core/errors.js';
import { BaseProvider, buildChatMessages, firstEnv, inlineImage, mergeBody, partsOf, textOf, totalTokens } from './base-provider.js';
import { parseArgs } from '../core/tools.js';
import { jsonSchemaOf, wantsJson } from '../core/schema.js';
import type { ToolCall } from '../types/index.js';
import { parseSSE } from '../core/http.js';

const DEFAULT_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const SYSTEM_JOINER = '\n\n';
/** Anthropic has no native JSON mode; the instruction goes into the system prompt. */
const JSON_NUDGE = 'Respond with a single valid JSON value and nothing else: no prose, no code fences.';

export interface AnthropicProviderConfig extends BaseProviderConfig {
  apiKey?: string;
  /** Origin; defaults to api.anthropic.com. Point at a gateway that speaks the Messages API. */
  baseURL?: string;
}

function toolChoiceOf(choice: NonNullable<AIRequest['toolChoice']>): unknown {
  if (typeof choice === 'object') return { type: 'tool', name: choice.name };
  return { type: choice === 'required' ? 'any' : choice };
}

function finishReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

export class AnthropicProvider extends BaseProvider {
  private readonly apiKey?: string;
  private readonly base: string;

  constructor(config: AnthropicProviderConfig = {}) {
    super(config);
    this.apiKey = config.apiKey ?? firstEnv(['ANTHROPIC_API_KEY', 'BOT_CLIENT_ANTHROPIC_KEY']);
    this.base = (config.baseURL ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  get providerId(): string {
    return 'anthropic';
  }

  get providerName(): string {
    return 'Anthropic';
  }

  protected get baseURL(): string {
    return this.base;
  }

  private get headers(): Record<string, string> {
    return { 'anthropic-version': API_VERSION, 'x-api-key': this.apiKey ?? '' };
  }

  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    if (this.cached()) return true;
    try {
      await this.http(`${this.base}/v1/models`, { headers: this.headers, params: { limit: '1' } });
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
      const response = await this.http(`${this.base}/v1/models`, { headers: this.headers, params: { limit: '100' } });
      const ids: string[] = (response?.data ?? [])
        .map((m: { id?: string }) => m.id)
        .filter((id: unknown): id is string => typeof id === 'string');
      return this.setDiscovered(ids);
    } catch {
      return this._supportedModels;
    }
  }

  protected classify(status: number, json: any): Refinement {
    const type: string | undefined = json?.error?.type;
    const message: string = json?.error?.message ?? '';
    const out: Refinement = { providerCode: type };
    switch (type) {
      case 'authentication_error':
        out.code = 'AUTH';
        break;
      case 'permission_error':
        out.code = 'PERMISSION';
        break;
      case 'billing_error':
        out.code = 'QUOTA';
        break;
      case 'not_found_error':
        out.code = /model/i.test(message) ? 'MODEL_NOT_FOUND' : 'INVALID_REQUEST';
        break;
      case 'rate_limit_error':
        out.code = 'RATE_LIMIT';
        break;
      case 'overloaded_error':
        out.code = 'OVERLOADED';
        break;
      case 'api_error':
        out.code = 'SERVER';
        break;
      case 'request_too_large':
        out.code = 'CONTEXT_LENGTH';
        break;
      case 'invalid_request_error':
        out.code = /prompt is too long|too many tokens|context/i.test(message) ? 'CONTEXT_LENGTH' : 'INVALID_REQUEST';
        break;
    }
    if (status === 529) out.code = 'OVERLOADED';
    return out;
  }

  private body(request: AIRequest, model: string, stream: boolean): Record<string, unknown> {
    // The Messages API takes the system prompt as a top-level field and
    // rejects a system role inside `messages`.
    const all = buildChatMessages(request);
    const systemParts = all.filter((m) => m.role === 'system').map((m) => textOf(m.content));
    const messages: Array<{ role: string; content: unknown }> = [];
    for (const m of all) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        // Results go back as a user turn; every result for one assistant turn shares that turn.
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
        const prev = messages[messages.length - 1];
        if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content[0]?.type === 'tool_result') prev.content.push(block);
        else messages.push({ role: 'user', content: [block] });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.arguments) })),
          ],
        });
        continue;
      }
      messages.push({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : partsOf(m.content).map((p) => {
                if (p.type === 'text') return { type: 'text', text: p.text };
                const inline = inlineImage(p);
                return {
                  type: 'image',
                  source: inline ? { type: 'base64', media_type: inline.mimeType, data: inline.data } : { type: 'url', url: p.url },
                };
              }),
      });
    }
    const tools = request.tools?.length && {
      // A cache breakpoint on the last tool caches the whole tool block (it comes before system and messages on the wire).
      tools: request.tools.map((t, i) => ({
        name: t.name,
        ...(t.description && { description: t.description }),
        input_schema: t.parameters,
        ...(request.cache && i === request.tools!.length - 1 && { cache_control: { type: 'ephemeral' } }),
      })),
      ...(request.toolChoice && { tool_choice: toolChoiceOf(request.toolChoice) }),
    };
    if (wantsJson(request)) {
      // No native JSON mode on the Messages API: ask, and show the schema when there is one.
      const schema = jsonSchemaOf(request.schema);
      systemParts.push(schema ? `${JSON_NUDGE} The JSON must match this JSON Schema: ${JSON.stringify(schema)}` : JSON_NUDGE);
    }
    const systemText = systemParts.join(SYSTEM_JOINER);
    // `cache` sends the system prompt as a single cached text block instead of a bare string.
    const system = systemText
      ? request.cache
        ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
        : systemText
      : undefined;
    const maxTokens = request.maxTokens ?? 4096;
    // Extended thinking needs a budget of at least 1024 below max_tokens and
    // rejects any temperature but 1.
    const thinking = request.reasoning
      ? { thinking: { type: 'enabled', budget_tokens: Math.max(1024, Math.floor(maxTokens / 2)) }, temperature: 1 }
      : { temperature: request.temperature ?? 0.7 };
    return mergeBody(
      {
        model,
        messages,
        ...tools,
        ...(system && { system }),
        max_tokens: request.reasoning ? Math.max(maxTokens, 2048) : maxTokens,
        ...thinking,
        ...(stream && { stream: true }),
      },
      request.providerOptions
    );
  }

  private resolveModel(request: AIRequest): string {
    return request.modelId ?? this.supportedModels[0] ?? DEFAULT_MODEL;
  }

  async process(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey) return this.fail(this.error('NO_API_KEY', 'Anthropic API key required'));
    const model = this.resolveModel(request);
    try {
      const { data, headers } = await this.httpFull(`${this.base}/v1/messages`, {
        headers: this.headers,
        body: this.body(request, model, false),
        ...this.requestOptions(request),
      });
      const blocks: Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }> = data?.content ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const reasoning = blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking ?? '').join('\n');
      const toolCalls: ToolCall[] = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b, i) => ({ id: b.id ?? `call_${i}`, name: b.name ?? '', arguments: b.input ?? {} }));
      const u = data?.usage;
      return this.ok(text, {
        reasoning: reasoning || undefined,
        modelUsed: data?.model ?? model,
        finishReason: finishReason(data?.stop_reason),
        toolCalls,
        requestId: headers.get('request-id') ?? undefined,
        usage: u && {
          promptTokens: u.input_tokens,
          completionTokens: u.output_tokens,
          totalTokens: totalTokens(u.input_tokens, u.output_tokens),
          ...(u.cache_read_input_tokens !== undefined && { cachedTokens: u.cache_read_input_tokens }),
        },
      });
    } catch (error) {
      return this.fail(this.toError(error, model), model);
    }
  }

  /**
   * Messages API event stream: `message_start` carries input tokens,
   * `content_block_delta` the text, `message_delta` the stop reason and
   * output tokens, `error` a failure mid-stream (overloaded, mostly).
   */
  async *processStream(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    if (!this.apiKey) throw this.error('NO_API_KEY', 'Anthropic API key required');
    const model = this.resolveModel(request);
    let stream: AsyncIterable<Uint8Array>;
    try {
      stream = await this.httpStream(`${this.base}/v1/messages`, {
        headers: this.headers,
        body: this.body(request, model, true),
        ...this.requestOptions(request),
      });
    } catch (error) {
      throw this.toError(error, model);
    }

    let modelUsed = model;
    let finish: FinishReason | undefined;
    const usage: TokenUsage = {};
    // A tool_use block opens with its id and name; the input arrives as JSON text deltas.
    const calls: Array<{ id: string; name: string; json: string }> = [];
    let open: (typeof calls)[number] | undefined;
    try {
      for await (const { event, data } of parseSSE(stream)) {
        let frame: any;
        try {
          frame = JSON.parse(data);
        } catch {
          continue;
        }
        const type = frame?.type ?? event;
        if (type === 'error') {
          throw this.streamError(frame.error ?? {}, model);
        }
        if (type === 'message_start') {
          if (typeof frame.message?.model === 'string') modelUsed = frame.message.model;
          usage.promptTokens = frame.message?.usage?.input_tokens;
          if (frame.message?.usage?.cache_read_input_tokens !== undefined)
            usage.cachedTokens = frame.message.usage.cache_read_input_tokens;
        } else if (type === 'content_block_start' && frame.content_block?.type === 'tool_use') {
          open = { id: frame.content_block.id ?? `call_${calls.length}`, name: frame.content_block.name ?? '', json: '' };
          calls.push(open);
        } else if (type === 'content_block_stop') {
          open = undefined;
        } else if (type === 'content_block_delta') {
          if (frame.delta?.type === 'input_json_delta' && open && typeof frame.delta.partial_json === 'string') open.json += frame.delta.partial_json;
          const text = frame.delta?.text;
          if (frame.delta?.type === 'text_delta' && typeof text === 'string' && text.length > 0) yield { type: 'text', text, modelUsed };
          const thinking = frame.delta?.thinking;
          if (frame.delta?.type === 'thinking_delta' && typeof thinking === 'string' && thinking.length > 0)
            yield { type: 'reasoning', text: thinking, modelUsed };
        } else if (type === 'message_delta') {
          if (frame.delta?.stop_reason) finish = finishReason(frame.delta.stop_reason);
          if (frame.usage?.output_tokens !== undefined) usage.completionTokens = frame.usage.output_tokens;
        }
      }
    } catch (error) {
      throw this.toError(error, model);
    }
    usage.totalTokens = totalTokens(usage.promptTokens, usage.completionTokens);
    const toolCalls: ToolCall[] = calls.map((c) => ({ id: c.id, name: c.name, arguments: c.json ? parseArgs(c.json) : {} }));
    for (const toolCall of toolCalls) yield { type: 'tool-call', toolCall, modelUsed };
    yield {
      type: 'done',
      modelUsed,
      usage,
      finishReason: toolCalls.length ? 'tool_calls' : (finish ?? 'unknown'),
      ...(toolCalls.length && { toolCalls }),
    };
  }

  /** An `error` event mid-stream, classified the same way as an HTTP error body. */
  private streamError(e: { type?: string; message?: string }, model: string) {
    const refined = this.classify(0, { error: e });
    const err = this.error(refined.code ?? 'SERVER', e.message ?? 'stream error', { model, details: e });
    err.providerCode = e.type;
    return err;
  }
}
