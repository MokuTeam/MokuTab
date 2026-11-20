import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findWorkatoTab,
  isWorkatoAppHost,
  runInWorkatoTab,
  WorkatoDispatchError,
} from '../../entrypoints/background/modules/workato/tools/workato/tab-dispatch';

import { setLeasedTabs } from '../../entrypoints/background/leased-tabs';

type Tab = chrome.tabs.Tab;
const mockTabs: Tab[] = [];

beforeEach(() => {
  mockTabs.length = 0;
  setLeasedTabs(undefined);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: vi.fn(async (info: { windowId?: number } = {}) =>
        mockTabs.filter((t) => info.windowId === undefined || t.windowId === info.windowId),
      ),
      get: vi.fn(async (tabId: number) => {
        const found = mockTabs.find((candidate) => candidate.id === tabId);
        if (!found) throw new Error(`No tab with id: ${tabId}`);
        return found;
      }),
    },
  };
});

function tab(id: number, url: string, windowId = 1): Tab {
  return { id, url, windowId } as Tab;
}

describe('findWorkatoTab and leased tabs', () => {
  it('a call that names no tab never picks a tab an agent leased', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/1'));
    mockTabs.push(tab(2, 'https://app.workato.com/recipes/2'));
    setLeasedTabs([1]);

    expect((await findWorkatoTab()).tabId).toBe(2);
    // Naming the tab is the bridge's to allow: here it resolves as before.
    expect((await findWorkatoTab(1)).tabId).toBe(1);
  });

  it('says TabLeased, not TabNotFound, when every Workato tab is leased', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/1'));
    setLeasedTabs([1]);

    await expect(findWorkatoTab()).rejects.toMatchObject({ code: 'TabLeased' });
  });

  it('skips a leased tab inside a named window too', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/1', 20));
    mockTabs.push(tab(2, 'https://app.workato.com/recipes/2', 20));
    setLeasedTabs([1]);

    expect((await findWorkatoTab(undefined, { windowId: 20 })).tabId).toBe(2);
  });

  it('a leased tab on another host does not trip the two-hosts guard', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/1'));
    mockTabs.push(tab(2, 'https://app.eu.workato.com/recipes/2'));
    setLeasedTabs([2]);

    expect((await findWorkatoTab()).tabId).toBe(1);
  });

  it('the list is replaced by each call: an absent list means no leases', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/1'));
    setLeasedTabs([1]);
    setLeasedTabs(undefined);

    expect((await findWorkatoTab()).tabId).toBe(1);
  });
});

describe('findWorkatoTab windowId', () => {
  it('is ignored when an explicit tabId is given', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/1', 10));
    mockTabs.push(tab(2, 'https://app.workato.com/recipes/2', 20));

    const info = await findWorkatoTab(1, { windowId: 20 });
    expect(info.tabId).toBe(1);
  });

  it('picks the Workato app tab in the named window', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/1', 10));
    mockTabs.push(tab(2, 'https://app.workato.com/recipes/2', 20));

    const info = await findWorkatoTab(undefined, { windowId: 20 });
    expect(info).toEqual({
      tabId: 2,
      host: 'app.workato.com',
      origin: 'https://app.workato.com',
    });
  });

  it('does not retarget to another window when the named one has no app tab', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/1', 10));
    mockTabs.push(tab(2, 'https://docs.workato.com/recipes.html', 20));

    await expect(findWorkatoTab(undefined, { windowId: 20 })).rejects.toMatchObject({
      code: 'TabNotFound',
    });
  });

  it('tolerates two Workato hosts as long as the named window holds one', async () => {
    // The global search would refuse this with MultipleWorkatoHosts; scoping to
    // one window is exactly how a caller resolves that.
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/1', 10));
    mockTabs.push(tab(2, 'https://app.eu.workato.com/recipes/2', 20));

    const info = await findWorkatoTab(undefined, { windowId: 20 });
    expect(info.host).toBe('app.eu.workato.com');
    await expect(findWorkatoTab()).rejects.toMatchObject({ code: 'MultipleWorkatoHosts' });
  });

  it('falls back to the global search when no windowId is given', async () => {
    mockTabs.push(tab(3, 'https://app.workato.com/recipes/3', 42));
    const info = await findWorkatoTab(undefined, {});
    expect(info.tabId).toBe(3);
  });
});

describe('findWorkatoTab', () => {
  it('throws TabNotFound when no tabs match', async () => {
    await expect(findWorkatoTab()).rejects.toMatchObject({
      name: 'WorkatoDispatchError',
      code: 'TabNotFound',
    });
  });

  it('returns the single matching tab', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/123'));
    const info = await findWorkatoTab();
    expect(info).toEqual({
      tabId: 1,
      host: 'app.workato.com',
      origin: 'https://app.workato.com',
    });
  });

  it('returns the first tab when many tabs share one host', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/123'));
    mockTabs.push(tab(2, 'https://app.workato.com/jobs'));
    const info = await findWorkatoTab();
    expect(info.tabId).toBe(1);
  });

  it('returns an explicitly requested Workato tab', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/123'));
    mockTabs.push(tab(2, 'https://app.workato.com/jobs'));
    const info = await findWorkatoTab(2);
    expect(info).toEqual({
      tabId: 2,
      host: 'app.workato.com',
      origin: 'https://app.workato.com',
    });
  });

  it('throws TabNotFound when an explicitly requested tab is not a Workato app tab', async () => {
    mockTabs.push(tab(3, 'https://docs.workato.com/en/formulas'));
    await expect(findWorkatoTab(3)).rejects.toMatchObject({
      name: 'WorkatoDispatchError',
      code: 'TabNotFound',
    });
  });

  it('throws MultipleWorkatoHosts when tabs span >1 distinct host', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/recipes/123'));
    mockTabs.push(tab(2, 'https://app.eu.workato.com/recipes/999'));
    await expect(findWorkatoTab()).rejects.toMatchObject({
      name: 'WorkatoDispatchError',
      code: 'MultipleWorkatoHosts',
    });
  });

  it('throws TabNotFound when matching tabs have no id/url', async () => {
    mockTabs.push({ id: undefined, url: 'https://app.workato.com/' } as Tab);
    await expect(findWorkatoTab()).rejects.toMatchObject({
      code: 'TabNotFound',
    });
  });

  it('is a WorkatoDispatchError instance with details', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/'));
    mockTabs.push(tab(2, 'https://app.workato.is/'));
    try {
      await findWorkatoTab();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkatoDispatchError);
      expect((err as WorkatoDispatchError).details?.hosts).toEqual(
        expect.arrayContaining(['app.workato.com', 'app.workato.is']),
      );
    }
  });

  it('ignores docs.workato.com when an app tab is also open', async () => {
    mockTabs.push(tab(1, 'https://docs.workato.com/en/formulas'));
    mockTabs.push(tab(2, 'https://app.workato.com/recipes/123'));
    const info = await findWorkatoTab();
    expect(info.tabId).toBe(2);
    expect(info.host).toBe('app.workato.com');
  });

  it('does not trip MultipleWorkatoHosts when only one host is an app host', async () => {
    mockTabs.push(tab(1, 'https://docs.workato.com/'));
    mockTabs.push(tab(2, 'https://www.workato.com/'));
    mockTabs.push(tab(3, 'https://app.workato.com/jobs'));
    const info = await findWorkatoTab();
    expect(info.tabId).toBe(3);
  });

  it('throws TabNotFound when only non-app workato hosts are open', async () => {
    mockTabs.push(tab(1, 'https://docs.workato.com/'));
    mockTabs.push(tab(2, 'https://support.workato.com/'));
    try {
      await findWorkatoTab();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkatoDispatchError);
      expect((err as WorkatoDispatchError).code).toBe('TabNotFound');
      expect((err as WorkatoDispatchError).message).toMatch(/app\.workato\.com/);
      expect((err as WorkatoDispatchError).details?.seenHosts).toEqual(
        expect.arrayContaining(['docs.workato.com', 'support.workato.com']),
      );
    }
  });

  it('still trips MultipleWorkatoHosts when two distinct app hosts are open', async () => {
    mockTabs.push(tab(1, 'https://app.workato.com/'));
    mockTabs.push(tab(2, 'https://app.eu.workato.com/'));
    mockTabs.push(tab(3, 'https://docs.workato.com/'));
    await expect(findWorkatoTab()).rejects.toMatchObject({
      code: 'MultipleWorkatoHosts',
    });
  });
});

describe('runInWorkatoTab', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setScripting(executeScript: () => Promise<unknown>) {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      scripting: { executeScript: vi.fn(executeScript) },
    };
  }

  it('honors a custom timeout and rejects with ScriptExecutionFailed when the script never settles', async () => {
    vi.useFakeTimers();
    setScripting(() => new Promise<unknown>(() => {})); // never resolves
    const p = runInWorkatoTab(1, () => 'x' as unknown, [], {
      timeoutMs: 5000,
      retryOnTimeout: false,
    });
    const expectation = expect(p).rejects.toMatchObject({
      name: 'WorkatoDispatchError',
      code: 'ScriptExecutionFailed',
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expectation;
  });

  it('does not time out before the custom deadline elapses', async () => {
    vi.useFakeTimers();
    setScripting(() => new Promise<unknown>(() => {}));
    let settled = false;
    const p = runInWorkatoTab(1, () => 'x' as unknown, [], {
      timeoutMs: 5000,
      retryOnTimeout: false,
    }).catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(settled).toBe(true);
  });

  it('auto-retries once on timeout when retryOnTimeout is enabled (default for short timeouts)', async () => {
    vi.useFakeTimers();
    let calls = 0;
    setScripting(() => {
      calls += 1;
      if (calls === 1) return new Promise<unknown>(() => {}); // first attempt hangs
      return Promise.resolve([{ result: 'second-attempt' }]);
    });
    const p = runInWorkatoTab(1, () => 'x' as unknown, [], 5000);
    await vi.advanceTimersByTimeAsync(5000); // first attempt times out → retry fires
    await expect(p).resolves.toBe('second-attempt');
    expect(calls).toBe(2);
  });

  it('returns the script result and clears the timer on success', async () => {
    vi.useFakeTimers();
    setScripting(async () => [{ result: { ok: true } }]);
    const result = await runInWorkatoTab(1, () => ({ ok: true }) as unknown, [], 5000);
    expect(result).toEqual({ ok: true });
    // No dangling timeout left to keep the service worker awake.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('isWorkatoAppHost', () => {
  it.each([
    ['app.workato.com', true],
    ['app.workato.is', true],
    ['app.eu.workato.com', true],
    ['app.jp.workato.com', true],
    ['app.trial.workato.com', true],
    ['docs.workato.com', false],
    ['www.workato.com', false],
    ['support.workato.com', false],
    ['community.workato.com', false],
    ['status.workato.com', false],
    ['careers.workato.com', false],
    ['app.workato.evil.com', false],
    ['evil-app.workato.com', false],
    ['workato.com', false],
  ])('isWorkatoAppHost(%s) === %s', (host, expected) => {
    expect(isWorkatoAppHost(host)).toBe(expected);
  });
});
