/**
 * `cache: true` stamps Anthropic cache breakpoints on the stable prefix
 * (system prompt + last tool) and is a no-op without it.
 */
import { AnthropicProvider } from '../src/providers/anthropic-provider.js';
import type { AIRequest } from '../src/types/index.js';

const EPHEMERAL = { type: 'ephemeral' };

/** Captures the JSON body the provider sends and answers with `reply`. */
function capture(reply: unknown) {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(reply), { status: 200 }));
  return () => JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
}

afterEach(() => jest.restoreAllMocks());

const TOOLS: AIRequest['tools'] = [
  { name: 'a', parameters: { type: 'object' } },
  { name: 'b', parameters: { type: 'object' } },
];

test('cache: true marks the system prompt and only the last tool', async () => {
  const body = capture({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  await new AnthropicProvider({ apiKey: 'k' }).process({ prompt: 'hi', systemPrompt: 'Be brief.', tools: TOOLS, cache: true });
  const b = body();
  expect(b.system).toEqual([{ type: 'text', text: 'Be brief.', cache_control: EPHEMERAL }]);
  expect(b.tools[0].cache_control).toBeUndefined();
  expect(b.tools[1].cache_control).toEqual(EPHEMERAL);
});

test('no cache: system is a bare string, tools carry no breakpoint', async () => {
  const body = capture({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  await new AnthropicProvider({ apiKey: 'k' }).process({ prompt: 'hi', systemPrompt: 'Be brief.', tools: TOOLS });
  const b = body();
  expect(b.system).toBe('Be brief.');
  expect(b.tools.some((t: { cache_control?: unknown }) => t.cache_control)).toBe(false);
});

test('cache: true with no system and no tools is a no-op', async () => {
  const body = capture({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  await new AnthropicProvider({ apiKey: 'k' }).process({ prompt: 'hi', cache: true });
  const b = body();
  expect(b.system).toBeUndefined();
  expect(b.tools).toBeUndefined();
});
