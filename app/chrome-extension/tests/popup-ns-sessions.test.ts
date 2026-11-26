/**
 * Tests for the popup NetSuite session store message contract and helpers.
 *
 * Author: Roman Chikalenko
 * Version: 1.0.0
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  effectiveExpiry,
  fetchNsSessions,
  formatLastActivity,
  formatTimeLeft,
  isSessionExpired,
  NS_SESSION_MESSAGES,
  errorMessageKey,
  openNsSession,
  sessionKey,
  splitAccountId,
  type NsSessionEntry,
} from '@/entrypoints/popup/ns-sessions';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const sampleEntry = (overrides: Partial<NsSessionEntry> = {}): NsSessionEntry => ({
  account: '1234567_SB2',
  user: 'a@b.c',
  role: '3',
  state: 'live',
  abs_expiry: NOW + 4 * HOUR,
  idle_expiry: NOW + 2 * HOUR + 10 * MIN,
  last_activity: NOW - 5 * MIN,
  last_where: { machine: 'server-2', profile: 'bb' },
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('expiry and account formatting helpers', () => {
  test('effectiveExpiry returns minimum of abs_expiry and idle_expiry', () => {
    expect(effectiveExpiry(sampleEntry())).toBe(NOW + 2 * HOUR + 10 * MIN);
    expect(
      effectiveExpiry(sampleEntry({ abs_expiry: NOW + 30 * MIN, idle_expiry: NOW + HOUR })),
    ).toBe(NOW + 30 * MIN);
    expect(effectiveExpiry(sampleEntry({ abs_expiry: null, idle_expiry: NOW + MIN }))).toBe(
      NOW + MIN,
    );
    expect(effectiveExpiry(sampleEntry({ abs_expiry: null, idle_expiry: null }))).toBeNull();
  });

  test('isSessionExpired detects expired sessions against nowMs', () => {
    expect(isSessionExpired(sampleEntry(), NOW)).toBe(false);
    expect(isSessionExpired(sampleEntry({ idle_expiry: NOW }), NOW)).toBe(true);
    expect(isSessionExpired(sampleEntry({ abs_expiry: NOW - 1 }), NOW)).toBe(true);
    expect(isSessionExpired(sampleEntry({ abs_expiry: null, idle_expiry: null }), NOW)).toBe(false);
  });

  test('splitAccountId splits sandbox suffix on underscore', () => {
    expect(splitAccountId('1234567_SB2')).toEqual({ base: '1234567', suffix: 'SB2' });
    expect(splitAccountId('1234567')).toEqual({ base: '1234567', suffix: null });
    expect(splitAccountId('1234567_')).toEqual({ base: '1234567_', suffix: null });
  });

  test('formatTimeLeft formats hours and minutes cleanly', () => {
    expect(formatTimeLeft(sampleEntry(), NOW)).toBe('2 h 10 min');
    expect(
      formatTimeLeft(sampleEntry({ abs_expiry: NOW + 2 * HOUR, idle_expiry: null }), NOW),
    ).toBe('2 h');
    expect(
      formatTimeLeft(sampleEntry({ abs_expiry: null, idle_expiry: NOW + 14 * MIN }), NOW),
    ).toBe('14 min');
    expect(formatTimeLeft(sampleEntry({ abs_expiry: null, idle_expiry: NOW + 20_000 }), NOW)).toBe(
      '< 1 min',
    );
    expect(formatTimeLeft(sampleEntry({ abs_expiry: null, idle_expiry: null }), NOW)).toBe('');
  });

  test('formatLastActivity formats relative time and machine/profile', () => {
    expect(formatLastActivity(sampleEntry(), NOW)).toBe('5 min ago, server-2/bb');
    expect(formatLastActivity(sampleEntry({ last_activity: NOW - 10_000 }), NOW)).toBe(
      'just now, server-2/bb',
    );
    expect(
      formatLastActivity(
        sampleEntry({
          last_activity: NOW - 2 * HOUR,
          last_where: { machine: 'server-2', profile: '' },
        }),
        NOW,
      ),
    ).toBe('2 h ago, server-2');
    expect(formatLastActivity(sampleEntry({ last_activity: null, last_where: null }), NOW)).toBe(
      '',
    );
  });
});

describe('fetchNsSessions', () => {
  test('filters expired entries and drops unexpected fields', async () => {
    const send = vi.fn(async () => ({
      ok: true,
      entries: [
        { ...sampleEntry(), unexpected: 'should-not-survive' },
        sampleEntry({ account: '1234567', idle_expiry: NOW - 1000 }),
      ],
    }));

    const result = await fetchNsSessions(send, 3000, NOW);
    expect(send).toHaveBeenCalledWith({ type: NS_SESSION_MESSAGES.LIST });
    expect(result.status).toBe('ready');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].account).toBe('1234567_SB2');
    expect('unexpected' in result.entries[0]).toBe(false);
  });

  test('returns unreachable on error reply, empty reply, or rejection', async () => {
    expect(await fetchNsSessions(async () => ({ ok: false, error: 'down' }), 3000, NOW)).toEqual({
      status: 'unreachable',
      entries: [],
    });
    expect(await fetchNsSessions(async () => undefined, 3000, NOW)).toEqual({
      status: 'unreachable',
      entries: [],
    });
    expect(
      await fetchNsSessions(
        async () => {
          throw new Error('no receiver');
        },
        3000,
        NOW,
      ),
    ).toEqual({
      status: 'unreachable',
      entries: [],
    });
  });

  test('returns unreachable when background does not answer within 3 s', async () => {
    vi.useFakeTimers();
    const pending = fetchNsSessions(() => new Promise(() => {}), 3000, NOW);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toEqual({ status: 'unreachable', entries: [] });
  });
});

describe('openNsSession', () => {
  test('sends ns_session_open with account and user, returns tabId or a code', async () => {
    const okSend = vi.fn(async () => ({ ok: true, tabId: 42 }));
    expect(await openNsSession('1234567_SB2', 'a@b.c', okSend)).toEqual({ ok: true, tabId: 42 });
    expect(okSend).toHaveBeenCalledWith({
      type: NS_SESSION_MESSAGES.OPEN,
      account: '1234567_SB2',
      user: 'a@b.c',
    });

    expect(
      await openNsSession('1234567', 'a@b.c', async () => ({ ok: false, code: 'other_user' })),
    ).toEqual({ ok: false, code: 'other_user' });
    expect(
      await openNsSession('1234567', 'a@b.c', async () => ({ ok: false, code: 'weird' })),
    ).toEqual({ ok: false, code: 'open_failed' });
    expect(
      await openNsSession('1234567', 'a@b.c', async () => {
        throw new Error('closed');
      }),
    ).toEqual({ ok: false, code: 'open_failed' });
  });
});

describe('row keys and error texts', () => {
  test('two users of one account are two rows', () => {
    expect(sessionKey({ account: '1234567', user: 'a@b.c' })).not.toBe(
      sessionKey({ account: '1234567', user: 'd@e.f' }),
    );
  });

  test('every code maps to a message key; unknown codes read as a failed open', () => {
    expect(errorMessageKey('module_off')).toBe('nsErrorModuleOff');
    expect(errorMessageKey('store_unreachable')).toBe('nsErrorStoreUnreachable');
    expect(errorMessageKey('other_user')).toBe('nsErrorOtherUser');
    expect(errorMessageKey('could_not_check')).toBe('nsErrorCouldNotCheck');
    expect(errorMessageKey('open_failed')).toBe('nsSessionOpenFailed');
    expect(errorMessageKey('anything')).toBe('nsSessionOpenFailed');
  });
});
