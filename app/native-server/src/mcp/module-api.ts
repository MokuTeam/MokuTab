/**
 * The bridge side of a module: what a module gives the router, and what the
 * router gives a module.
 *
 * Core never imports a module. The router reaches modules only through this
 * interface, and the list of installed modules comes from src/modules/index.ts
 * (the one wiring point). A module may import core freely.
 *
 * The router keeps the parts every tool shares: profile routing, the session
 * pin of profile + tab, leases, strict mode, auto-file, the context-block
 * stamp. A module plugs into five places:
 *
 *   tools / instructions  listed and announced only while the module is on
 *   aliases               old tool names kept working, routed to the tool
 *                         each now names (listed only while the module is on)
 *   prepare               file params in before the extension call, the
 *                         write-out after it (recipe out_file, LCAP content_path)
 *   handle                tools answered in the bridge (pure helpers and
 *                         orchestrators that drive several extension calls)
 *   session               extra pin fields on top of profile + tab (Workato's
 *                         workspace and environment)
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AutoFileRules } from './auto-file';

export type JsonObject = Record<string, any>;

/** The pinned session as the router reports it (chrome_list_profiles' session_context). */
export type SessionSummary = JsonObject;

/** Raw extension request, as the router routes it: no pin, no file params. */
export type ExtensionRequest = (
  name: string,
  args: JsonObject,
  profile: string | null,
  timeoutMs: number,
) => Promise<any>;

/** What the router gives a module's bridge-side tool for one call. */
export interface ModuleCallContext {
  /**
   * Call an extension tool the way the router calls one: with the session pin
   * (tab and module pin fields), the owning module's file params, and this
   * call's routing profile. An unsuccessful reply becomes an error result;
   * a transport failure throws.
   */
  callExtension(name: string, args: JsonObject): Promise<CallToolResult>;
  /** The profile this call is routed to (null: the bridge default profile). */
  profile: string | null;
  /** The pinned session, or null when nothing is pinned. */
  session: SessionSummary | null;
}

/** File params resolved before the extension call. */
export interface PreparedModuleCall {
  args: JsonObject;
  /**
   * Runs on a successful extension reply instead of the generic result path
   * (no auto-file, no context stamp), e.g. writing a pulled recipe to out_file.
   */
  finish?: (
    result: CallToolResult,
    call: { profile: string | null; args: JsonObject },
  ) => CallToolResult | Promise<CallToolResult>;
}

/** Pin fields read off a tab, or why they could not be. */
export interface ModulePinProbe {
  pin?: JsonObject;
  /** Text appended to the chrome_switch_profile reply when the probe failed. */
  note?: string;
}

export interface ModuleRecheck {
  /** Refuse the call: the pinned tab no longer matches. Nothing is sent. */
  refusal?: string;
  /** The pin, refreshed; the router records the registry generation it was checked at. */
  pin?: JsonObject;
}

/**
 * Extra pin fields on top of profile + tab. The router stores a module's pin
 * under its id, hands it back to these hooks, and never reads it itself.
 */
export interface ModuleSessionHooks {
  /** Read this module's pin fields off the tab being pinned. */
  probe(profile: string, tabId: number, request: ExtensionRequest): Promise<ModulePinProbe>;
  /** Fields this module adds to the session summary (a fixed key set, null when unknown). */
  summary(pin: JsonObject | undefined): JsonObject;
  /** Suffix for the chrome_switch_profile reply, e.g. `, workspace 12 "Acme"`. */
  describe(pin: JsonObject | undefined): string;
  /** How the switch reply names the pinned tab (default "tab ID"). */
  tabLabel?: string;
  /** Calls that get the pinned tab and this module's expectations. */
  targets(name: string): boolean;
  /** Add the pin's expectations to a targeted call (runs after the tab pin). */
  inject(name: string, args: JsonObject, pin: JsonObject): JsonObject;
  /** Calls whose job is to change the pinned context (they follow it, never check it). */
  isContextChanging(name: string): boolean;
  /** Whether this call must re-check the pin after the profile registry changed. */
  needsRecheck(name: string, pin: JsonObject): boolean;
  /** Re-read the pinned tab after a registry change. An empty answer means the probe failed. */
  recheck(
    pin: JsonObject,
    target: { profile: string; tabId: number },
    request: ExtensionRequest,
  ): Promise<ModuleRecheck>;
  /** After a successful context-changing call: the pin to keep, or null to leave it. */
  follow(result: CallToolResult, pin: JsonObject | undefined): JsonObject | null;
}

export interface BridgeModule {
  /** Same id as the shared module descriptor (config key, popup switch). */
  id: string;
  title: string;
  /** Tool schemas; listed only while the module is on. */
  tools: Tool[];
  /** Server-instructions snippet, appended while the module is on. */
  instructions: string;
  /**
   * Old name -> the tool it now names (Workato: the 1.x workato_* names of the
   * profile/bridge tools). Not owned: the router lists each with its target's
   * served schema and runs the target, while the module is on.
   */
  aliases?: Readonly<Record<string, string>>;
  /** Tools that change nothing (readOnlyHint) and tools that only remove (destructiveHint). */
  readOnlyTools?: readonly string[];
  destructiveTools?: readonly string[];
  /**
   * 1.x served this module's tools with no switch, so a machine upgraded from
   * 1.x keeps it on (its first 2.x start records that in config.json). A module
   * added later leaves this unset and starts off everywhere.
   */
  onAfterUpgrade?: boolean;
  owns(name: string): boolean;
  /** Read tools that spill to a file, and the tools that accept out_file. */
  autoFile?: AutoFileRules;
  /** File params in, file writes out. Also applied to nested orchestrator calls. */
  prepare?(name: string, args: JsonObject): PreparedModuleCall;
  /** Bridge-side tools and orchestrators; undefined means forward to the extension. */
  handle?(
    name: string,
    args: JsonObject,
    ctx: ModuleCallContext,
  ): Promise<CallToolResult> | undefined;
  session?: ModuleSessionHooks;
  /**
   * Requests the extension sends this module on its own (not tool calls), by
   * message type, answered over the extension connection with the profile
   * they came from. Registered by the running bridge; refused while the
   * module is off.
   */
  extensionRequests?: Readonly<Record<string, (payload: any, profile: string) => unknown>>;
}
