/**
 * The extension side of a module, and the switch state the background keeps.
 *
 * Core never imports a module: the installed modules come from
 * ./modules/index.ts (the one wiring point) and core uses them only through
 * this interface. Every module's executors are compiled into the extension;
 * the bridge decides whether a module is on, pushes that state, and the
 * background refuses a switched-off module's tools too.
 */

import type { ToolResult } from '@/common/tool-handler';
import { STORAGE_KEYS } from '@/common/constants';
import {
  isModuleOn,
  moduleStatesOf,
  readStoredModulesState,
  type ModuleStates,
  type StoredModulesState,
} from '@/common/module-state';

export interface ModuleToolExecutor {
  name: string;
  execute(args: any): Promise<ToolResult>;
}

export interface ExtensionModule {
  /** Same id as the shared module descriptor and the bridge module. */
  id: string;
  title: string;
  /** One line for the popup's Modules section; the module owns its text. */
  description: string;
  executors: ModuleToolExecutor[];
  /**
   * Runs on the result of each of this module's tools before it goes back to
   * the bridge (Workato: append the tab's workspace context block). Must
   * never turn a successful call into a failure.
   */
  afterCall?(name: string, args: any, result: ToolResult): Promise<ToolResult>;
  /**
   * Tools that only fetch from the page and never drive it: several of them
   * may run on one tab at once (see tools/tab-queue.ts). Every other tool
   * takes its tab alone.
   */
  sharesTab?(name: string): boolean;
  /**
   * Typed bridge -> extension requests this module answers, by message type
   * (NetSuite: session cookies). Not tools: what they return never reaches a
   * tool result. Refused while the module is off.
   */
  bridgeRequests?: Readonly<Record<string, (payload: any) => Promise<unknown>>>;
  /**
   * Called once when the service worker starts, before any await: the place to
   * register browser event listeners this module needs (MV3 drops listeners
   * added later). The module checks its own switch before acting on an event.
   */
  start?(): void;
}

let cache: ModuleStates | null = null;
let loading: Promise<void> | null = null;

/** Load the last pushed state once per service worker life. */
export function loadModuleStates(): Promise<void> {
  if (cache) return Promise.resolve();
  if (!loading) {
    loading = readStoredModulesState().then((stored) => {
      // A push that arrived while this read was pending wins.
      if (!cache) cache = moduleStatesOf(stored);
    });
  }
  return loading;
}

/**
 * Whether the bridge said this module is on. Unlike moduleEnabled, a module
 * the bridge never mentioned counts as off: for requests that touch secrets
 * (NetSuite cookies), the default-on of a pre-switch bridge is not enough.
 */
export async function moduleExplicitlyOn(id: string): Promise<boolean> {
  await loadModuleStates();
  return cache?.[id] === true;
}

/** Whether a module is on, as last pushed by the bridge (on when never heard of). */
export async function moduleEnabled(id: string): Promise<boolean> {
  await loadModuleStates();
  return isModuleOn(cache ?? {}, id);
}

/**
 * A modules_state push or reply from the bridge: kept in memory at once (the
 * next tool call on the same socket must see it) and stored for the popup,
 * the content scripts and the next service worker.
 */
export async function applyBridgeModulesState(payload: unknown): Promise<StoredModulesState> {
  const modules = Array.isArray((payload as any)?.modules) ? (payload as any).modules : [];
  cache = moduleStatesOf({ modules });
  const stored: StoredModulesState = { modules, received_at: Date.now() };
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.MODULES_STATE]: stored });
  } catch {
    /* the in-memory state still applies */
  }
  return stored;
}

/**
 * Forget the stored state until the bridge pushes its own. Called when the
 * bridge socket opens: a bridge from before the module switch never pushes,
 * and an "off" stored under a newer bridge must not keep refusing tools (or
 * idle the content scripts) on it. A current bridge pushes on connect, so
 * the real state is back at once.
 */
export async function clearModuleStates(): Promise<void> {
  cache = {};
  try {
    await chrome.storage.local.remove(STORAGE_KEYS.MODULES_STATE);
  } catch {
    /* the in-memory state still applies */
  }
}

/** Test seam: forget the cached state. */
export function resetModuleStateCache(): void {
  cache = null;
  loading = null;
}
