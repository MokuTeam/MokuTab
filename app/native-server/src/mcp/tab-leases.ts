/**
 * Tab leases: one tab per agent when several agents share an MCP session.
 *
 * Subagents of one client session reuse the same MCP session, so the session
 * pin (profile + tab) is shared by all of them and cannot tell them apart. The
 * only per-caller identity that survives is what the caller passes, so an agent
 * leases a tab (chrome_lease_tab), gets a token back and passes it on every
 * call. The bridge turns the token into the profile and tabId, and while a
 * session holds a lease it refuses that session's tab-targeting calls that
 * name no tab at all: under parallel agents "the active tab" is always
 * somebody else's.
 *
 * The table is one per bridge, not one per session: several client sessions
 * share the browser too, so a tab leased in one is off limits to the others
 * (a call naming it without its lease is refused, and the extension leaves it
 * out when a call names no tab). The token is the capability: whoever passes
 * it uses the tab.
 */

import { randomBytes } from 'crypto';
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

const LEASE_PROPERTY = {
  type: 'string',
  // Served on every tab tool: the long form lives in chrome_lease_tab.
  description: 'Lease from chrome_lease_tab: targets its tab and profile. Use instead of tabId.',
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
  /** The MCP session that took the lease. */
  owner: string;
  created_at: number;
  last_used: number;
  /**
   * Leased from an existing tab (adopt_tab_id) rather than opened by the
   * lease: it may be a tab the user works in, so the bridge never closes it
   * on expiry and release keeps it unless keep_tab:false is explicit.
   */
  adopted?: boolean;
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

/** The token is the capability to use the tab, from any session: 64 random bits. */
export function newLeaseId(): string {
  return `L${randomBytes(8).toString('hex')}`;
}

/** The leases of one bridge, each owned by the MCP session that took it. */
export class LeaseTable {
  private leases = new Map<string, TabLease>();

  add(lease: TabLease): void {
    this.leases.set(lease.lease, lease);
  }

  get(id: string): TabLease | undefined {
    return this.leases.get(id);
  }

  /** The lease that holds `tabId` in `profile`, whoever owns it. */
  findByTab(profile: string, tabId: number): TabLease | undefined {
    for (const lease of this.leases.values()) {
      if (lease.profile === profile && lease.tabId === tabId) return lease;
    }
    return undefined;
  }

  delete(id: string): boolean {
    return this.leases.delete(id);
  }

  get size(): number {
    return this.leases.size;
  }

  /** How many leases `owner` holds: what switches that session to strict targeting. */
  ownedBy(owner: string): number {
    let count = 0;
    for (const lease of this.leases.values()) if (lease.owner === owner) count++;
    return count;
  }

  /** Forget every lease (tests). */
  clear(): void {
    this.leases.clear();
  }

  /** Remove and return every lease idle for LEASE_IDLE_MS or longer. */
  takeExpired(now: number): TabLease[] {
    const expired: TabLease[] = [];
    for (const lease of this.leases.values()) {
      if (now - lease.last_used >= LEASE_IDLE_MS) expired.push(lease);
    }
    for (const lease of expired) this.leases.delete(lease.lease);
    return expired;
  }

  /**
   * Every lease as `owner` may see it: its own with the token, another
   * session's without (the tab to stay away from, not a tab to use).
   */
  summary(now: number, owner: string) {
    return [...this.leases.values()].map((l) => ({
      ...(l.owner === owner ? { lease: l.lease } : { other_session: true }),
      profile: l.profile,
      tabId: l.tabId,
      windowId: l.windowId,
      idle_ms: now - l.last_used,
      ...(l.adopted ? { adopted: true } : {}),
    }));
  }

  /** Every leased tab in `profile`, whoever owns the lease. */
  tabIdsIn(profile: string): Set<number> {
    const ids = new Set<number>();
    for (const lease of this.leases.values()) if (lease.profile === profile) ids.add(lease.tabId);
    return ids;
  }

  /** The lease tokens of `owner`. */
  ids(owner: string): string[] {
    return [...this.leases.values()].filter((l) => l.owner === owner).map((l) => l.lease);
  }
}

/** The one lease table of this bridge process. */
export const bridgeLeases = new LeaseTable();

/**
 * A tool call carries the tabs leased in its profile (when there are any), so
 * the extension leaves them out when the call names no tab: "the first
 * Workato tab" must never be a tab some agent leased. The extension keeps the
 * list of the latest call, so EVERY tool call to a profile goes through here:
 * one that left it out would read as "no leases".
 */
export function withLeasedTabs<T extends object>(payload: T, profile: string): T {
  if (bridgeLeases.size === 0) return payload;
  const leasedTabs = [...bridgeLeases.tabIdsIn(profile)];
  return leasedTabs.length > 0 ? { ...payload, leasedTabs } : payload;
}

/** An id for one MCP session, to mark the leases it takes. */
export function newSessionKey(): string {
  return `S${randomBytes(6).toString('hex')}`;
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
  owner: string,
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
        `UnknownLease: no lease "${id}" (unknown or expired). Leases of this session: ${JSON.stringify(table.ids(owner))}. ` +
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
