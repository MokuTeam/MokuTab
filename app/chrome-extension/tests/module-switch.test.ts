/**
 * The module switch in the extension: the background refuses a switched-off
 * module's tools, and the Workato content script runs only while it is on.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { STORAGE_KEYS } from '@/common/constants';
import { moduleStatesOf } from '@/common/module-state';
import {
  applyBridgeModulesState,
  clearModuleStates,
  moduleEnabled,
  moduleExplicitlyOn,
  resetModuleStateCache,
} from '@/entrypoints/background/extension-module';
import { gateWorkatoContent } from '@/entrypoints/background/modules/workato/content-gate';

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

let stored: Record<string, unknown>;
let listeners: ChangeListener[];

const state = (enabled: boolean) => ({
  modules: [{ id: 'workato', title: 'Workato', enabled }],
  received_at: 1,
});

function pushStorage(value: unknown) {
  stored[STORAGE_KEYS.MODULES_STATE] = value;
  for (const listener of listeners) {
    listener({ [STORAGE_KEYS.MODULES_STATE]: { newValue: value } }, 'local');
  }
}

beforeEach(() => {
  stored = {};
  listeners = [];
  resetModuleStateCache();
  const storage = chrome.storage as any;
  storage.local.get = vi.fn(async (keys: string[]) =>
    Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])),
  );
  storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(stored, items);
  });
  storage.local.remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
  });
  storage.onChanged = {
    addListener: vi.fn((listener: ChangeListener) => listeners.push(listener)),
    removeListener: vi.fn((listener: ChangeListener) => {
      listeners = listeners.filter((l) => l !== listener);
    }),
  };
});

afterEach(() => {
  resetModuleStateCache();
});

describe('the state the background keeps', () => {
  test('a module the bridge never mentioned is on', async () => {
    expect(await moduleEnabled('workato')).toBe(true);
  });

  test('explicitly on only when the bridge said so', async () => {
    expect(await moduleExplicitlyOn('netsuite')).toBe(false);
    await applyBridgeModulesState({
      modules: [{ id: 'netsuite', title: 'NetSuite', enabled: true }],
    });
    expect(await moduleExplicitlyOn('netsuite')).toBe(true);
    await applyBridgeModulesState({
      modules: [{ id: 'netsuite', title: 'NetSuite', enabled: false }],
    });
    expect(await moduleExplicitlyOn('netsuite')).toBe(false);
  });

  test('a push applies at once and is stored for the popup and content scripts', async () => {
    const pending = applyBridgeModulesState({ modules: state(false).modules });
    // In memory before the storage write settles: the next tool call sees it.
    expect(await moduleEnabled('workato')).toBe(false);
    await pending;
    expect(moduleStatesOf(stored[STORAGE_KEYS.MODULES_STATE])).toEqual({ workato: false });
  });

  test('a fresh service worker reads the stored state', async () => {
    stored[STORAGE_KEYS.MODULES_STATE] = state(false);
    expect(await moduleEnabled('workato')).toBe(false);
  });

  test('a new bridge socket clears a stored "off" until that bridge pushes its own', async () => {
    stored[STORAGE_KEYS.MODULES_STATE] = state(false);
    expect(await moduleEnabled('workato')).toBe(false);

    await clearModuleStates();
    // An older bridge never pushes: the module is on again, for the content
    // scripts too.
    expect(await moduleEnabled('workato')).toBe(true);
    expect(stored[STORAGE_KEYS.MODULES_STATE]).toBeUndefined();

    // A current bridge pushes on connect, and that is the state again.
    await applyBridgeModulesState({ modules: state(false).modules });
    expect(await moduleEnabled('workato')).toBe(false);
  });

  test('malformed entries are ignored, so the module stays on', () => {
    expect(moduleStatesOf({ modules: [{ id: 'workato', enabled: 'no' }, null] })).toEqual({});
    expect(moduleStatesOf(null)).toEqual({});
  });
});

describe('the background refuses a switched-off module', () => {
  let handleCallTool: (typeof import('@/entrypoints/background/tools'))['handleCallTool'];

  // The whole tool registry loads here: slow on a busy machine.
  beforeAll(async () => {
    ({ handleCallTool } = await import('@/entrypoints/background/tools'));
  }, 60_000);

  test('a Workato tool is refused with the module name; a core tool is not', async () => {
    await applyBridgeModulesState({ modules: state(false).modules });

    const refused = await handleCallTool({ name: 'workato_session_context', args: {} });
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as any).text).toContain('Workato module');

    const core = await handleCallTool({ name: 'get_windows_and_tabs', args: {} });
    expect(JSON.stringify(core.content)).not.toContain('Workato module');

    // Unknown names keep their old answer.
    const unknown = await handleCallTool({ name: 'no_such_tool', args: {} });
    expect((unknown.content[0] as any).text).toBe('Tool no_such_tool not found');
  });

  test('the refusal points at the popup and never says "not found"', async () => {
    await applyBridgeModulesState({ modules: state(false).modules });
    const result = await handleCallTool({ name: 'workato_pull_recipe', args: { recipe_id: 1 } });
    const text = (result.content[0] as any).text as string;
    expect(result.isError).toBe(true);
    expect(text).toContain('workato_pull_recipe');
    expect(text).toContain('MokuTab popup (Modules)');
    expect(text).not.toMatch(/not found/i);
  });
});

describe('the Workato content script runs only while the module is on', () => {
  test('off: the script never starts', async () => {
    stored[STORAGE_KEYS.MODULES_STATE] = state(false);
    const start = vi.fn(() => () => {});
    await gateWorkatoContent(start);
    expect(start).not.toHaveBeenCalled();
  });

  test('on (or never heard of): it starts once', async () => {
    const start = vi.fn(() => () => {});
    await gateWorkatoContent(start);
    expect(start).toHaveBeenCalledTimes(1);
  });

  test('an open tab follows the popup: stopped when switched off, restarted when on', async () => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    await gateWorkatoContent(start);
    expect(start).toHaveBeenCalledTimes(1);

    pushStorage(state(false));
    expect(stop).toHaveBeenCalledTimes(1);

    pushStorage(state(false));
    expect(stop).toHaveBeenCalledTimes(1);

    pushStorage(state(true));
    expect(start).toHaveBeenCalledTimes(2);
  });

  test('the returned function stops following and stops the script', async () => {
    const stop = vi.fn();
    const unfollow = await gateWorkatoContent(() => stop);
    unfollow();
    expect(stop).toHaveBeenCalledTimes(1);
    pushStorage(state(true));
    expect(listeners).toHaveLength(0);
  });
});
