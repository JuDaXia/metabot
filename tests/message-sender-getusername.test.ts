import { describe, it, expect, vi } from 'vitest';
import { MessageSender } from '../src/feishu/message-sender.js';

/**
 * getUserName resolves a group member's display name from the chat member list
 * (im scope — no contact scope needed), cached per chat. It must:
 *   - return the name for a known member,
 *   - resolve from a cached list on repeat lookups (one API call),
 *   - return undefined for unknown members (caller falls back to a short id),
 *   - never throw when the API fails (missing scope / network),
 *   - page through multi-page member lists.
 */

function fakeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
}

function senderWithMembers(get: (...args: any[]) => Promise<any>) {
  const client = { im: { v1: { chatMembers: { get } } } } as any;
  return new MessageSender(client, fakeLogger());
}

describe('MessageSender.getUserName', () => {
  it('resolves a member name from the chat member list', async () => {
    const sender = senderWithMembers(async () => ({
      data: {
        items: [
          { member_id: 'ou_alice', name: 'Alice' },
          { member_id: 'ou_bob', name: 'Bob' },
        ],
        has_more: false,
      },
    }));
    expect(await sender.getUserName('oc_1', 'ou_bob')).toBe('Bob');
  });

  it('caches the member list — repeated lookups make one API call', async () => {
    const get = vi.fn(async () => ({
      data: { items: [{ member_id: 'ou_a', name: 'A' }], has_more: false },
    }));
    const sender = senderWithMembers(get);
    await sender.getUserName('oc_1', 'ou_a');
    await sender.getUserName('oc_1', 'ou_a');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for an unknown member (caller falls back to id)', async () => {
    const sender = senderWithMembers(async () => ({
      data: { items: [{ member_id: 'ou_a', name: 'A' }], has_more: false },
    }));
    expect(await sender.getUserName('oc_1', 'ou_missing')).toBeUndefined();
  });

  it('never throws when the members API fails — returns undefined', async () => {
    const sender = senderWithMembers(async () => {
      throw new Error('app has no permission to read chat members');
    });
    await expect(sender.getUserName('oc_1', 'ou_a')).resolves.toBeUndefined();
  });

  it('pages through a multi-page member list', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [{ member_id: 'ou_a', name: 'A' }], has_more: true, page_token: 'p2' },
      })
      .mockResolvedValueOnce({
        data: { items: [{ member_id: 'ou_b', name: 'B' }], has_more: false },
      });
    const sender = senderWithMembers(get);
    expect(await sender.getUserName('oc_1', 'ou_b')).toBe('B');
    expect(get).toHaveBeenCalledTimes(2);
  });
});
