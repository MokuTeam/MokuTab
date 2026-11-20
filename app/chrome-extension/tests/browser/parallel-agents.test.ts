import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  busyTabs,
  runExclusiveForTab,
  runSharedForTab,
} from '@/entrypoints/background/tools/tab-queue';
import {
  __resetUidStoreForTest,
  assignUid,
  beginSnapshot,
  getTabUids,
  lookupUid,
} from '@/entrypoints/background/tools/browser/snapshot/uid-store';
import {
  closeAgentTab,
  navigateAgentTab,
  openAgentTab,
  promoteToOwnWindow,
} from '@/entrypoints/background/agent-tabs';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('runExclusiveForTab', () => {
  it('runs calls on one tab one at a time, and other tabs in parallel', async () => {
    const order: string[] = [];
    const gate = deferred();
    const first = runExclusiveForTab(1, async () => {
      order.push('a:start');
      await gate.promise;
      order.push('a:end');
    });
    const second = runExclusiveForTab(1, async () => {
      order.push('b');
    });
    const otherTab = runExclusiveForTab(2, async () => {
      order.push('other');
    });
    await otherTab;
    expect(order).toEqual(['a:start', 'other']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'other', 'a:end', 'b']);
  });

  it('a failed call does not block the next one and the queue drains', async () => {
    const failed = runExclusiveForTab(7, async () => {
      throw new Error('boom');
    });
    const next = runExclusiveForTab(7, async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    await new Promise((r) => setTimeout(r, 0));
    expect(busyTabs()).not.toContain(7);
  });
});

describe('runExclusiveForTab hold bound', () => {
  it('lets the next call run when one holds the tab past the bound, and the stuck call still answers', async () => {
    let releaseStuck: (v: string) => void = () => undefined;
    const stuck = runExclusiveForTab(
      21,
      () => new Promise<string>((resolve) => (releaseStuck = resolve)),
      30,
    );
    const next = runExclusiveForTab(21, async () => 'next ran', 30);
    await expect(next).resolves.toBe('next ran');
    releaseStuck('stuck finished');
    await expect(stuck).resolves.toBe('stuck finished');
  });
});

describe('runSharedForTab', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('lets fetch-only calls overlap, behind the driving call ahead of them and ahead of the next one', async () => {
    const order: string[] = [];
    const drive = deferred();
    const readA = deferred();
    const readB = deferred();
    const first = runExclusiveForTab(31, async () => {
      order.push('drive:start');
      await drive.promise;
      order.push('drive:end');
    });
    const a = runSharedForTab(31, async () => {
      order.push('a:start');
      await readA.promise;
      order.push('a:end');
    });
    const b = runSharedForTab(31, async () => {
      order.push('b:start');
      await readB.promise;
      order.push('b:end');
    });
    const last = runExclusiveForTab(31, async () => {
      order.push('last');
    });

    await tick();
    expect(order).toEqual(['drive:start']);
    drive.resolve();
    await first;
    await tick();
    // Both reads are in the page at once.
    expect(order).toEqual(['drive:start', 'drive:end', 'a:start', 'b:start']);
    readB.resolve();
    await b;
    await tick();
    // The next driving call waits for the read still running.
    expect(order).not.toContain('last');
    readA.resolve();
    await Promise.all([a, last]);
    expect(order.slice(4)).toEqual(['b:end', 'a:end', 'last']);
    await tick();
    expect(busyTabs()).not.toContain(31);
  });

  it('a read that arrives behind a queued driving call waits for it, not for earlier reads', async () => {
    const order: string[] = [];
    const slowRead = deferred();
    const early = runSharedForTab(32, async () => {
      await slowRead.promise;
      order.push('early read');
    });
    const drive = runExclusiveForTab(32, async () => {
      order.push('drive');
    });
    const late = runSharedForTab(32, async () => {
      order.push('late read');
    });
    await tick();
    expect(order).toEqual([]);
    slowRead.resolve();
    await Promise.all([early, drive, late]);
    expect(order).toEqual(['early read', 'drive', 'late read']);
  });

  it('a failed read does not hold the tab', async () => {
    const failed = runSharedForTab(33, async () => {
      throw new Error('fetch failed');
    });
    const next = runExclusiveForTab(33, async () => 'ok');
    await expect(failed).rejects.toThrow('fetch failed');
    await expect(next).resolves.toBe('ok');
  });
});

describe('snapshot uids across snapshots of one tab', () => {
  beforeEach(() => __resetUidStoreForTest());

  it('keeps a node on its uid, never reuses a uid, and refuses a uid whose page navigated', async () => {
    const tabId = 4242;
    const state = await getTabUids(tabId);
    beginSnapshot(state, new Map([['F', 'L1']]));
    const one = assignUid(state, 'F', 'L1', 11);
    const two = assignUid(state, 'F', 'L1', 12);

    beginSnapshot(state, new Map([['F', 'L1']]));
    // Same node, second snapshot: same uid. A new node gets a new number.
    expect(assignUid(state, 'F', 'L1', 11)).toBe(one);
    const three = assignUid(state, 'F', 'L1', 13);
    expect(three).toBeGreaterThan(two);
    await expect(lookupUid(tabId, two)).resolves.toMatchObject({ backendNodeId: 12 });

    // The frame navigated: every uid of the old document is gone, numbers go on.
    beginSnapshot(state, new Map([['F', 'L2']]));
    await expect(lookupUid(tabId, one)).rejects.toThrow('no longer exists');
    expect(assignUid(state, 'F', 'L2', 11)).toBeGreaterThan(three);
    await expect(lookupUid(tabId, 999)).rejects.toThrow('never issued');
  });
});

describe('agent tabs', () => {
  beforeEach(() => {
    (chrome as any).windows = {
      create: vi.fn().mockResolvedValue({ id: 900, tabs: [{ id: 901 }] }),
      get: vi.fn().mockResolvedValue({ id: 900 }),
    };
    (chrome as any).storage.session = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    };
    (chrome.tabs.create as any) = vi.fn().mockResolvedValue({ id: 902 });
  });

  it('opens tabs unfocused, reusing one agents window, and own_window gets its own', async () => {
    const first = await openAgentTab({ url: 'https://example.com' });
    const second = await openAgentTab({});
    expect(chrome.windows.create).toHaveBeenCalledWith({
      url: 'https://example.com',
      focused: false,
    });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      windowId: first.windowId,
      url: 'about:blank',
      active: false,
    });
    expect(second).toEqual({ tabId: 902, windowId: 900 });

    await openAgentTab({ own_window: true });
    expect(chrome.windows.create).toHaveBeenCalledTimes(2);
  });

  it('closing a tab that is already gone is not an error', async () => {
    (chrome.tabs.remove as any) = vi.fn().mockRejectedValue(new Error('No tab with id'));
    (chrome.tabs.get as any) = vi.fn().mockRejectedValue(new Error('No tab with id'));
    await expect(closeAgentTab(5)).resolves.toEqual({ closed: false, gone: true });
  });

  describe('navigateAgentTab', () => {
    type Listener = (id: number, change: { status?: string; url?: string }, tab: any) => void;
    let listeners: Listener[];

    beforeEach(() => {
      listeners = [];
      (chrome.tabs as any).onUpdated = {
        addListener: vi.fn((fn: Listener) => listeners.push(fn)),
        removeListener: vi.fn((fn: Listener) => (listeners = listeners.filter((l) => l !== fn))),
      };
      (chrome.tabs as any).onRemoved = { addListener: vi.fn(), removeListener: vi.fn() };
      (chrome.tabs.get as any) = vi
        .fn()
        .mockResolvedValue({ id: 7, url: 'https://a.example/old', status: 'complete' });
    });

    it('waits for the new page: the old page finishing its load does not count', async () => {
      const emit = (change: { status?: string; url?: string }, url: string) =>
        listeners.forEach((l) => l(7, change, { id: 7, url, status: change.status, title: 'T' }));
      (chrome.tabs.update as any) = vi.fn(async () => {
        // The page being replaced reports complete first, then the new load runs.
        emit({ status: 'complete' }, 'https://a.example/old');
        setTimeout(() => {
          emit({ status: 'loading', url: 'https://a.example/new' }, 'https://a.example/new');
          emit({ status: 'complete' }, 'https://a.example/new');
        }, 5);
      });
      const info = await navigateAgentTab({
        tabId: 7,
        url: 'https://a.example/new',
        timeout_ms: 1000,
      });
      expect(info).toMatchObject({ exists: true, url: 'https://a.example/new' });
      expect(listeners).toHaveLength(0);
    });

    it('a hash-only change returns at once instead of waiting for a load that never comes', async () => {
      (chrome.tabs.update as any) = vi.fn().mockResolvedValue({});
      const started = Date.now();
      const info = await navigateAgentTab({
        tabId: 7,
        url: 'https://a.example/old#x',
        timeout_ms: 5000,
      });
      expect(info.exists).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: 'https://a.example/old#x' });
    });
  });

  it('a tab that survives its close (a leave-page prompt) is reported as not gone', async () => {
    (chrome.tabs.remove as any) = vi.fn().mockResolvedValue(undefined);
    (chrome.tabs.get as any) = vi.fn().mockResolvedValue({ id: 5 });
    await expect(closeAgentTab(5)).resolves.toEqual({ closed: true, gone: false });
  });

  it('moves a tab of the agents window to an unfocused window of its own', async () => {
    const opened = await openAgentTab({});
    (chrome.tabs.get as any) = vi.fn().mockResolvedValue({ id: 902, windowId: opened.windowId });
    (chrome.windows.create as any).mockResolvedValue({ id: 950 });
    await expect(promoteToOwnWindow(902)).resolves.toBe(950);
    expect(chrome.windows.create).toHaveBeenLastCalledWith({ tabId: 902, focused: false });
  });

  it('never moves a tab outside the agents window', async () => {
    await openAgentTab({});
    (chrome.tabs.get as any) = vi.fn().mockResolvedValue({ id: 5, windowId: 1 });
    (chrome.windows.create as any).mockClear();
    await expect(promoteToOwnWindow(5)).resolves.toBeNull();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('moves nothing when the agents window is gone', async () => {
    (chrome.windows.get as any).mockRejectedValue(new Error('No window with id'));
    (chrome.tabs.get as any) = vi.fn().mockResolvedValue({ id: 902, windowId: 900 });
    await expect(promoteToOwnWindow(902)).resolves.toBeNull();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });
});
