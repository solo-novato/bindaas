import { describe, expect, it } from 'vitest';
import {
  acceptsEvent,
  conversationKey,
  harnessCapabilities,
  harnessOf,
} from '../../src/lib/harness';

describe('agent identities and event generations', () => {
  it('qualifies legacy references without collapsing agent namespaces', () => {
    expect(conversationKey('same-id')).toBe('codex:same-id');
    expect(conversationKey('claude:same-id')).toBe('claude:same-id');
    expect(harnessOf('codex:same-id')).toBe('codex');
    expect(harnessOf('claude:same-id')).toBe('claude');
  });
  it('rejects obsolete events only within their native process scope', () => {
    const connections = {
      codex: { type: 'ready', generation: 90 },
      'claude:a': { type: 'ready', generation: 4 },
      'claude:b': { type: 'ready', generation: 2 },
    };
    expect(
      acceptsEvent(
        {
          type: 'ready',
          harness: 'claude',
          threadId: 'claude:a',
          generation: 3,
        },
        connections,
      ),
    ).toBe(false);
    expect(
      acceptsEvent(
        {
          type: 'ready',
          harness: 'claude',
          threadId: 'claude:b',
          generation: 2,
        },
        connections,
      ),
    ).toBe(true);
    expect(
      acceptsEvent(
        {
          type: 'ready',
          harness: 'claude',
          threadId: 'claude:c',
          generation: 1,
        },
        connections,
      ),
    ).toBe(true);
    expect(
      acceptsEvent(
        { type: 'disconnected', harness: 'codex', generation: 89 },
        connections,
      ),
    ).toBe(false);
    expect(harnessCapabilities.claude.steer).toBe(false);
  });
});
