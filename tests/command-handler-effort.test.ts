import { describe, it, expect } from 'vitest';
import { CommandHandler } from '../src/bridge/command-handler.js';
import type { IncomingMessage } from '../src/types.js';

/**
 * /effort sets a per-session Claude reasoning-effort override. It must:
 *   - validate the level (reject anything not low/medium/high/xhigh/max),
 *   - be case-insensitive,
 *   - persist via sessionManager.setSessionEffort,
 *   - clear on reset,
 *   - never call setSessionEffort for an invalid value.
 */

interface RecordedNotice {
  chatId: string;
  title: string;
  content: string;
  color?: string;
}

function buildHandler(opts: { botEffort?: string; sessionEffort?: string; engine?: string } = {}) {
  const notices: RecordedNotice[] = [];
  const session: { engine?: string; effort?: string } = {
    engine: opts.engine,
    effort: opts.sessionEffort,
  };
  const setEffortCalls: Array<string | undefined> = [];

  const sender = {
    sendCard: async () => undefined,
    updateCard: async () => true,
    sendTextNotice: async (chatId: string, title: string, content: string, color?: string) => {
      notices.push({ chatId, title, content, color });
    },
    sendText: async () => {},
    sendImageFile: async () => true,
    sendLocalFile: async () => true,
    downloadImage: async () => true,
    downloadFile: async () => true,
  };
  const sessionManager = {
    getSession: () => session,
    setSessionEffort: (_chatId: string, effort: string | undefined) => {
      setEffortCalls.push(effort);
      session.effort = effort;
    },
  };

  const handler = new CommandHandler(
    { name: 'test-bot', claude: { effort: opts.botEffort } } as any,
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    sender as any,
    sessionManager as any,
    {} as any, // memoryClient — not touched by /effort
    { log: () => {} } as any,
    () => undefined,
    () => {},
    () => 0,
    async () => {},
  );
  return { handler, notices, setEffortCalls: () => setEffortCalls, session };
}

function effortMessage(text: string): IncomingMessage {
  return {
    messageId: 'm1',
    chatId: 'c1',
    chatType: 'p2p',
    userId: 'u1',
    text,
    timestamp: Date.now(),
    isBotMentioned: true,
  } as IncomingMessage;
}

describe('CommandHandler /effort', () => {
  it('no args → shows current effort (bot default) and the available levels', async () => {
    const { handler, notices } = buildHandler({ botEffort: 'high' });
    await handler.handle(effortMessage('/effort'));
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain('Effort');
    expect(notices[0].content).toContain('high');
    // lists the choices
    expect(notices[0].content).toMatch(/low/);
    expect(notices[0].content).toMatch(/max/);
  });

  it('/effort low → sets the session override', async () => {
    const { handler, notices, setEffortCalls, session } = buildHandler();
    await handler.handle(effortMessage('/effort low'));
    expect(setEffortCalls()).toEqual(['low']);
    expect(session.effort).toBe('low');
    expect(notices[0].title).toContain('Set');
  });

  it('/effort MAX → case-insensitive, normalised to lower-case', async () => {
    const { handler, session } = buildHandler();
    await handler.handle(effortMessage('/effort MAX'));
    expect(session.effort).toBe('max');
  });

  it('/effort bogus → rejected, session untouched (no setSessionEffort call)', async () => {
    const { handler, notices, setEffortCalls } = buildHandler({ sessionEffort: 'high' });
    await handler.handle(effortMessage('/effort bogus'));
    expect(setEffortCalls()).toEqual([]);
    expect(notices[0].title).toContain('Invalid');
  });

  it('/effort reset → clears the override (setSessionEffort(undefined))', async () => {
    const { handler, setEffortCalls, notices } = buildHandler({ sessionEffort: 'max' });
    await handler.handle(effortMessage('/effort reset'));
    expect(setEffortCalls()).toEqual([undefined]);
    expect(notices[0].title).toContain('Reset');
  });
});
