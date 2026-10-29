/**
 * Tab leases: one tab per agent when several agents share an MCP session.
 *
 * Subagents of one client session reuse the same MCP session, so the session
 * pin (profile + tab) is shared by all of them and cannot tell them apart. The
 * only per-caller identity that survives is what the caller passes, so an agent
 * leases a tab (chrome_lease_tab), gets a token back and passes it on every
 * call. The bridge turns the token into the profile and tabId, and while any
 * lease is held it refuses tab-targeting calls that name no tab at all: under
 * parallel agents "the active tab" is always somebody else's.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CORE_TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { installedToolSchemas } from './catalogue';
import { readEnv } from '../env';

export const LEASE_TAB_TOOL = CORE_TOOL_NAMES.BROWSER.LEASE_TAB;
export const RELEASE_TAB_TOOL = CORE_TOOL_NAMES.BROWSER.RELEASE_TAB;
export const LEASE_ARG = 'lease';
/** A lease nobody used for this long is released and its tab closed. */
export const LEASE_IDLE_MS = 30 * 60 * 1000;
export const STRICT_TABS_ENV = 'MOKUTAB_STRICT_TABS';
/** Overrides LEASE_IDLE_MS, in whole minutes (at least 1). */
export const LEASE_IDLE_ENV = 'MOKUTAB_LEASE_IDLE_MINUTES';
/** The lease table's file in the bridge state dir. */
export const LEASES_FILE = 'leases.json';
/** A saved lease whose profile has not reconnected for this long is forgotten. */
export const ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const LEASE_PROPERTY = {
  type: 'string',
  description:
    'Lease from chrome_lease_tab: routes this call to the leased tab (and its profile) without activating it. Use it instead of tabId when agents work in parallel.',
};

/** Tools that never target a tab, or that manage targeting themselves. */
const STRICT_EXEMPT = new Set<string>([
  CORE_TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
  LEASE_TAB_TOOL,
  RELEASE_TAB_TOOL,
  CORE_TOOL_NAMES.BRIDGE.LIST_PROFILES,
  CORE_TOOL_NAMES.BRIDGE.SWITCH_PROFILE,
  CORE_TOOL_NAMES.BRIDGE.BRIDGE_INFO,
  CORE_TOOL_NAMES.BRIDGE.RELOAD_EXTENSION,
]);

export interface TabLease {
  lease: string;
  profile: string;
  tabId: number;
  windowId: number | null;
  created_at: number;
  last_used: number;
  /**
   * Leased from an existing tab (adopt_tab_id) rather than opened by the
   * lease: it may be a tab the user works in, so the bridge never closes it
   * on expiry and release keeps it unless keep_tab:false is explicit.
   */
  adopted?: boolean;
  /**
   * The extension's id for the Chrome session the tab was opened in. Tab ids
   * start over when Chrome restarts, so a lease saved across a bridge restart
   * may only close its tab while the profile reports this same id.
   */
  browser_session?: string | null;
}

/** What a saved lease keeps across a bridge restart. */
export interface SavedLease {
  lease: string;
  profile: string;
  tabId: number;
  windowId: number | null;
  created_at: number;
  adopted: boolean;
  browser_session: string | null;
}

/** The idle limit: MOKUTAB_LEASE_IDLE_MINUTES when it is a whole number of minutes >= 1. */
export function leaseIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = readEnv(LEASE_IDLE_ENV, env);
  if (raw === undefined) return LEASE_IDLE_MS;
  const minutes = Number(raw.trim());
  return Number.isInteger(minutes) && minutes >= 1 ? minutes * 60 * 1000 : LEASE_IDLE_MS;
}

/** Input properties of every installed tool (core and modules, on or off), built once. */
let schemaProperties: Map<string, Record<string, unknown>> | null = null;

function propertiesOf(name: string): Record<string, unknown> {
  if (!schemaProperties) {
    schemaProperties = new Map();
    for (const tool of installedToolSchemas()) {
      const props = ((tool.inputSchema as any)?.properties ?? {}) as Record<string, unknown>;
      schemaProperties.set(tool.name, props);
    }
  }
  return schemaProperties.get(name) ?? {};
}

/** The tool's schema has a tabId, so it targets a tab. */
export function toolTargetsTab(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(propertiesOf(name), 'tabId');
}

function toolHasBackground(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(propertiesOf(name), 'background');
}

/** Add an optional `lease` to every tool that takes a tabId. */
export function withLeaseToolSchemas(tools: Tool[]): Tool[] {
  return tools.map((tool) => {
    if (tool.name === LEASE_TAB_TOOL || tool.name === RELEASE_TAB_TOOL) return tool;
    const inputSchema = (tool.inputSchema || {}) as Record<string, any>;
    const properties = inputSchema.properties || {};
    if (!properties.tabId || properties[LEASE_ARG]) return tool;
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        type: 'object' as const,
        properties: { ...properties, [LEASE_ARG]: LEASE_PROPERTY },
      },
    };
  });
}

export function newLeaseId(): string {
  return `L${randomBytes(4).toString('hex')}`;
}

function savedLease(lease: TabLease): SavedLease {
  return {
    lease: lease.lease,
    profile: lease.profile,
    tabId: lease.tabId,
    windowId: lease.windowId,
    created_at: lease.created_at,
    adopted: lease.adopted === true,
    browser_session: lease.browser_session ?? null,
  };
}

function parseSavedLease(raw: any): SavedLease | null {
  if (!raw || typeof raw.lease !== 'string' || typeof raw.profile !== 'string') return null;
  if (typeof raw.tabId !== 'number' || typeof raw.created_at !== 'number') return null;
  return {
    lease: raw.lease,
    profile: raw.profile,
    tabId: raw.tabId,
    windowId: typeof raw.windowId === 'number' ? raw.windowId : null,
    created_at: raw.created_at,
    adopted: raw.adopted === true,
    browser_session: typeof raw.browser_session === 'string' ? raw.browser_session : null,
  };
}

/**
 * Every lease of every MCP session in this bridge, and the leases a previous
 * bridge left behind.
 *
 * Sessions live in memory, so after a restart none of the saved leases has a
 * session any more: they are orphans, and their tabs are closed when their
 * profile reconnects (lease-recovery.ts). The file holds who owns a tab, not
 * when it was last used, so a call writes nothing; adds and removals do.
 */
export class LeaseRegistry {
  private live = new Set<TabLease>();
  private orphans: SavedLease[] = [];
  private file: string | null = null;

  /**
   * Save leases in `file` and take the ones a previous bridge saved there as
   * orphans. Only the process that owns the port calls this; tests keep the
   * registry in memory.
   */
  enablePersistence(file: string, now: number = Date.now()): void {
    this.file = file;
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (raw?.version !== 1 || !Array.isArray(raw.leases)) return;
    for (const entry of raw.leases) {
      const saved = parseSavedLease(entry);
      if (saved && now - saved.created_at < ORPHAN_MAX_AGE_MS) this.orphans.push(saved);
    }
  }

  add(lease: TabLease): void {
    this.live.add(lease);
    this.persist();
  }

  remove(lease: TabLease): void {
    if (this.live.delete(lease)) this.persist();
  }

  /**
   * A call named `tabId` in `profile` without its lease (a script that leased
   * once and then passes the tabId, often from another MCP session): count it
   * as use of whichever lease holds that tab, so the idle sweep spares it.
   */
  touchTab(profile: string, tabId: number, now: number): boolean {
    let touched = false;
    for (const lease of this.live) {
      if (lease.profile === profile && lease.tabId === tabId) {
        lease.last_used = now;
        touched = true;
      }
    }
    return touched;
  }

  /** Remove and return the orphans of `profile`. */
  takeOrphans(profile: string): SavedLease[] {
    const taken = this.orphans.filter((o) => o.profile === profile);
    if (taken.length === 0) return taken;
    this.orphans = this.orphans.filter((o) => o.profile !== profile);
    this.persist();
    return taken;
  }

  get orphanCount(): number {
    return this.orphans.length;
  }

  private persist(): void {
    const file = this.file;
    if (!file) return;
    // Orphans whose profile has not reconnected yet stay in the file, so a
    // second restart before it does still finds them.
    const data = {
      version: 1,
      leases: [...this.orphans, ...[...this.live].map(savedLease)],
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      try {
        fs.renameSync(tmp, file);
      } catch {
        // Windows: a scanner holding the target makes rename fail; write in place.
        fs.writeFileSync(file, JSON.stringify(data));
      }
    } catch (error: any) {
      console.error(`[tab-leases] Could not save the lease table: ${error?.message}`);
    }
  }
}

/** The bridge's one lease registry. */
export const leaseRegistry = new LeaseRegistry();

/** Per-MCP-session lease table. */
export class LeaseTable {
  private leases = new Map<string, TabLease>();

  constructor(private registry: LeaseRegistry = leaseRegistry) {}

  add(lease: TabLease): void {
    this.leases.set(lease.lease, lease);
    this.registry.add(lease);
  }

  get(id: string): TabLease | undefined {
    return this.leases.get(id);
  }

  /** The lease of this session that already holds `tabId` in `profile`, if any. */
  findByTab(profile: string, tabId: number): TabLease | undefined {
    for (const lease of this.leases.values()) {
      if (lease.profile === profile && lease.tabId === tabId) return lease;
    }
    return undefined;
  }

  delete(id: string): boolean {
    const lease = this.leases.get(id);
    if (!lease) return false;
    this.leases.delete(id);
    this.registry.remove(lease);
    return true;
  }

  /** Count a call naming `tabId` as use of whichever lease holds it, in any session. */
  touchTab(profile: string, tabId: number, now: number): boolean {
    return this.registry.touchTab(profile, tabId, now);
  }

  /** Remove and return every lease (the session closed). */
  takeAll(): TabLease[] {
    const all = [...this.leases.values()];
    for (const lease of all) this.delete(lease.lease);
    return all;
  }

  get size(): number {
    return this.leases.size;
  }

  /** Remove and return every lease idle for `idleMs` (leaseIdleMs()) or longer. */
  takeExpired(now: number, idleMs: number = leaseIdleMs()): TabLease[] {
    const expired: TabLease[] = [];
    for (const lease of this.leases.values()) {
      if (now - lease.last_used >= idleMs) expired.push(lease);
    }
    for (const lease of expired) this.delete(lease.lease);
    return expired;
  }

  summary(now: number) {
    return [...this.leases.values()].map((l) => ({
      lease: l.lease,
      profile: l.profile,
      tabId: l.tabId,
      windowId: l.windowId,
      idle_ms: now - l.last_used,
      ...(l.adopted ? { adopted: true } : {}),
    }));
  }

  /** Every leased tab of this session in `profile`. */
  tabIdsIn(profile: string): Set<number> {
    const ids = new Set<number>();
    for (const lease of this.leases.values()) if (lease.profile === profile) ids.add(lease.tabId);
    return ids;
  }

  ids(): string[] {
    return [...this.leases.keys()];
  }
}

export type LeaseApplication =
  | { ok: true; args: Record<string, any>; lease: TabLease }
  | { ok: false; error: string };

/**
 * Turn `lease` in a call's args into its tabId (and background:true where the
 * tool has that switch). The profile check is the caller's: it knows the
 * explicit routing argument.
 */
export function applyLease(
  name: string,
  args: Record<string, any>,
  table: LeaseTable,
  now: number,
): LeaseApplication {
  const id = args[LEASE_ARG];
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, error: 'lease must be the string returned by chrome_lease_tab.' };
  }
  const lease = table.get(id.trim());
  if (!lease) {
    return {
      ok: false,
      error:
        `Unknown or expired lease "${id}". Leases of this session: ${JSON.stringify(table.ids())}. ` +
        'Take a new one with chrome_lease_tab.',
    };
  }
  if (typeof args.tabId === 'number' && args.tabId !== lease.tabId) {
    return {
      ok: false,
      error: `lease ${lease.lease} is tab ${lease.tabId}, but the call also passed tabId ${args.tabId}. Pass one of them.`,
    };
  }
  const { [LEASE_ARG]: _lease, ...rest } = args;
  const next: Record<string, any> = { ...rest, tabId: lease.tabId };
  if (toolHasBackground(name) && next.background === undefined) next.background = true;
  lease.last_used = now;
  return { ok: true, args: next, lease };
}

export function strictTabsFromEnv(): boolean {
  return readEnv(STRICT_TABS_ENV) === '1';
}

/**
 * Refusal text when strict targeting applies and the call names no tab, else
 * null. `args` must be the caller's own arguments after the lease is applied
 * but BEFORE the session pin is injected: a pinned tab is shared by every
 * agent of the session, so it cannot satisfy strict mode.
 */
export function strictTabsViolation(
  name: string,
  args: Record<string, any>,
  strict: boolean,
): string | null {
  if (!strict || STRICT_EXEMPT.has(name) || !toolTargetsTab(name)) return null;
  if (typeof args.tabId === 'number') return null;
  return (
    'StrictTabs: pass lease (from chrome_lease_tab) or tabId; parallel agents must not act on ' +
    'the active tab. Nothing was sent.'
  );
}

export function leaseResult(body: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError };
}
