/**
 * The Chrome session id survives a service-worker restart and an extension
 * reload, and changes when Chrome starts or when the evidence is unclear.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  browserSessionId,
  resetBrowserSessionForTests,
  watchBrowserLifecycle,
} from '@/entrypoints/background/browser-session';

const chromeAny = (globalThis as any).chrome;

function memoryArea(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    },
  };
}

describe('browserSessionId', () => {
  let originalStorage: unknown;
  let originalRuntime: unknown;
  let onStartup: Array<() => void>;
  let onInstalled: Array<(details: { reason: string }) => void>;

  /** Stand in for Chrome dispatching an event while the service worker waits. */
  const waitThen =
    (dispatch: () => void) =>
    async (_ms: number): Promise<void> => {
      dispatch();
    };

  function setUp(session: Record<string, unknown>, local: Record<string, unknown>) {
    chromeAny.storage = {
      ...chromeAny.storage,
      session: memoryArea(session),
      local: memoryArea(local),
    };
    watchBrowserLifecycle();
  }

  beforeEach(() => {
    originalStorage = chromeAny.storage;
    originalRuntime = chromeAny.runtime;
    onStartup = [];
    onInstalled = [];
    chromeAny.runtime = {
      ...chromeAny.runtime,
      onStartup: { addListener: (fn: () => void) => onStartup.push(fn) },
      onInstalled: { addListener: (fn: (d: { reason: string }) => void) => onInstalled.push(fn) },
    };
    resetBrowserSessionForTests();
  });

  afterEach(() => {
    chromeAny.storage = originalStorage;
    chromeAny.runtime = originalRuntime;
    resetBrowserSessionForTests();
  });

  it('keeps the id storage.session holds (a service-worker restart)', async () => {
    setUp({ browserSessionId: 'kept' }, { browserSessionId: 'older' });
    await expect(browserSessionId(waitThen(() => undefined))).resolves.toBe('kept');
  });

  it('keeps the last id across an extension reload', async () => {
    setUp({}, { browserSessionId: 'before-reload' });
    const id = await browserSessionId(
      waitThen(() => onInstalled.forEach((fn) => fn({ reason: 'update' }))),
    );
    expect(id).toBe('before-reload');
    expect(chromeAny.storage.session.data.browserSessionId).toBe('before-reload');
  });

  it('takes a new id when Chrome starts, even if an update fired too', async () => {
    setUp({}, { browserSessionId: 'last-run' });
    const id = await browserSessionId(
      waitThen(() => {
        onInstalled.forEach((fn) => fn({ reason: 'update' }));
        onStartup.forEach((fn) => fn());
      }),
    );
    expect(id).not.toBe('last-run');
    expect(chromeAny.storage.local.data.browserSessionId).toBe(id);
  });

  it('takes a new id when no event says what happened', async () => {
    setUp({}, { browserSessionId: 'last-run' });
    const id = await browserSessionId(waitThen(() => undefined));
    expect(id).not.toBe('last-run');
    // Decided once: a later connect gets the same id.
    await expect(browserSessionId(waitThen(() => undefined))).resolves.toBe(id);
  });
});
