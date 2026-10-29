/**
 * MCP Tools Registry.
 * Handles listing and dispatching MCP tool calls to the active WebSocket Chrome profile connection.
 *
 * The router is core: profile routing, the session pin of profile + tab,
 * leases and strict mode, watches, browser functions, fetch-to-file and
 * auto-file. Module tools reach it through the BridgeModule interface
 * (module-api.ts); the installed modules come from src/modules/index.ts.
 *
 * Author: Roman Chikalenko
 * Version: 1.4.0
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import nativeMessagingHostInstance from '../native-messaging-host';
import {
  CORE_TOOL_NAMES,
  NativeMessageType,
  aliasOffMessage,
  moduleOffMessage,
} from '@mokuhub/mokutab-shared';
import { INSTALLED_MODULES } from '../modules';
import { listedToolSchemas, withAliasToolSchemas } from './catalogue';
import type {
  BridgeModule,
  ExtensionRequest,
  JsonObject,
  ModuleCallContext,
  PreparedModuleCall,
} from './module-api';
import { moduleSwitch, type ModuleSwitchView } from './module-switch';
import { stampContextBlock } from './tool-result';
import { handleBridgeInfoCall, isBridgeInfoTool, servedToolSchemas } from './bridge-info';
import { handleReloadExtensionCall, isReloadExtensionTool } from './reload-extension';
import {
  applyAutoFile,
  combineAutoFileRules,
  CORE_AUTO_FILE_RULES,
  prepareAutoFileCall,
  RAW_OUTPUT_ARG,
  withOutFileToolSchemas,
  type AutoFilePlan,
  type AutoFileRules,
} from './auto-file';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { profileRegistry } from '../server/profile-registry';
import {
  LEASE_ARG,
  LEASE_TAB_TOOL,
  LeaseTable,
  leaseIdleMs,
  type LeaseRegistry,
  RELEASE_TAB_TOOL,
  applyLease,
  leaseResult,
  newLeaseId,
  strictTabsFromEnv,
  strictTabsViolation,
  withLeaseToolSchemas,
  type TabLease,
} from './tab-leases';
import { handleWatchToolCall, isWatchTool } from './browser-watch';
import { watchManager } from './watch-instance';
import {
  finishFetchToFile,
  isFetchToFileTool,
  prepareFetchToFileCall,
} from './chrome-fetch-to-file';
import { handleFnToolCall, isFnTool, profileDriver, type FnDeps } from './browser-functions';
import { FnRegistry } from './fn-registry';
import { FnRunsLog } from './fn-runs-log';
import { bitwardenVault } from './fn-vault';

// One registry and run log per bridge process, shared by every MCP session.
let fnDepsInstance: FnDeps | null = null;
function fnDeps(): FnDeps {
  if (!fnDepsInstance) {
    fnDepsInstance = {
      registry: new FnRegistry(),
      log: new FnRunsLog(),
      vault: bitwardenVault(),
      driverFor: (profile) =>
        profileDriver(profile, (target, payload, type, timeoutMs) =>
          profileRegistry.sendRequest(target, payload, type, timeoutMs),
        ),
      connectedProfiles: () => profileRegistry.getConnectedProfiles(),
      activeProfile: () => profileRegistry.getActiveProfile(),
      now: () => Date.now(),
    };
  }
  return fnDepsInstance;
}

export const PROFILE_ROUTING_ARG = 'profile';
export const TAB_ROUTING_ARG = 'tabId';

const PROFILE_ROUTING_PROPERTY = {
  type: 'string',
  description:
    'Optional connected Chrome profile name for this call only. Overrides this MCP session profile without changing it.',
};

const PROFILE_MANAGEMENT_TOOLS = new Set([
  CORE_TOOL_NAMES.BRIDGE.LIST_PROFILES,
  CORE_TOOL_NAMES.BRIDGE.SWITCH_PROFILE,
  // Its own `profile` argument selects which profiles reload, not where to route.
  CORE_TOOL_NAMES.BRIDGE.RELOAD_EXTENSION,
]);

interface RoutedArgs {
  args: JsonObject;
  profile: string | null;
}

/**
 * What this MCP session is pinned to.
 *
 * Core pins profile + tab: a tab id means something only inside one Chrome
 * profile, and a long session must not drift to another tab. A module adds
 * what the pinned tab IS for its tools (Workato: host, workspace, environment)
 * under its id in `modules`; the router stores those fields and hands them
 * back to the module, but never reads them. Pinning the tuple, and refusing to
 * route around it, is what keeps a long session on one target.
 */
export interface SessionContext {
  profile: string;
  tabId: number | null;
  /** Pin fields each module added on top of profile + tab, by module id. */
  modules: Record<string, JsonObject>;
  /** ISO timestamp of the pin. */
  pinned_at: string;
  /**
   * profileRegistry generation observed when the context was last verified. A
   * change means a profile connected or disconnected, so a module's pin is
   * re-checked before the next call is routed.
   */
  generation: number;
}

interface ToolRouter {
  listTools: () => Promise<{ tools: Tool[] }>;
  handleToolCall: (name: string, args: any, signal?: AbortSignal) => Promise<CallToolResult>;
  /** The MCP session ended: release its leases, closing the tabs they opened. */
  close: () => Promise<void>;
}

export interface ToolRouterOptions {
  /** Installed modules; defaults to src/modules/index.ts. */
  modules?: readonly BridgeModule[];
  /** Which modules are on; defaults to the bridge config file. */
  switch?: ModuleSwitchView;
  /** Where this session's leases are registered; defaults to the bridge's one registry. */
  leaseRegistry?: LeaseRegistry;
}

const CANCELLED_TEXT = 'Cancelled by the MCP client; the browser may still finish the action.';

/**
 * Stop waiting when the client cancels (or its request timed out): the handler
 * returns at once instead of holding the call for up to 120s. The browser side
 * is not interrupted, which the message says.
 */
export function raceAbort(
  work: Promise<CallToolResult>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  if (!signal) return work;
  const cancelled: CallToolResult = {
    content: [{ type: 'text', text: CANCELLED_TEXT }],
    isError: true,
  };
  if (signal.aborted) return Promise.resolve(cancelled);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(cancelled);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export function withProfileRoutingToolSchemas(tools: Tool[]): Tool[] {
  return tools.map((tool) => {
    if (PROFILE_MANAGEMENT_TOOLS.has(tool.name)) return tool;

    const inputSchema = (tool.inputSchema || { type: 'object' }) as JsonObject;
    if (inputSchema.type !== 'object') return tool;

    const properties = { ...(inputSchema.properties || {}) };
    if (!properties[PROFILE_ROUTING_ARG]) {
      properties[PROFILE_ROUTING_ARG] = PROFILE_ROUTING_PROPERTY;
    }

    return {
      ...tool,
      inputSchema: {
        ...inputSchema,
        type: 'object',
        properties,
        required: Array.isArray(inputSchema.required) ? inputSchema.required : [],
      },
    };
  });
}

/** Auto-file rules of core plus every installed module. */
export function autoFileRulesFor(modules: readonly BridgeModule[]): AutoFileRules {
  return combineAutoFileRules([
    CORE_AUTO_FILE_RULES,
    ...modules.flatMap((module) => (module.autoFile ? [module.autoFile] : [])),
  ]);
}

export { listedToolSchemas };

/**
 * The tools/list payload: routing, file and lease params added the same way
 * for core and module tools, then the enabled modules' aliases as copies of
 * the served tools they name.
 */
export function servedToolList(enabled: readonly BridgeModule[], rules: AutoFileRules): Tool[] {
  return withAliasToolSchemas(
    withLeaseToolSchemas(
      withOutFileToolSchemas(withProfileRoutingToolSchemas(listedToolSchemas(enabled)), rules),
    ),
    enabled,
  );
}

function routeError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function normalizeProfile(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${PROFILE_ROUTING_ARG} must be a non-empty connected profile name`);
  }
  return value.trim();
}

function extractRoutedArgs(args: any): RoutedArgs {
  const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const profile = normalizeProfile(source[PROFILE_ROUTING_ARG]);
  const { [PROFILE_ROUTING_ARG]: _profile, ...cleanArgs } = source;
  return { args: cleanArgs, profile };
}

function normalizeTabId(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${TAB_ROUTING_ARG} must be a non-negative integer Chrome tab id`);
  }
  return value;
}

function isConnectedProfile(profile: string): boolean {
  return profileRegistry.getConnectedProfiles().includes(profile);
}

function requireConnectedProfile(profile: string): void {
  if (!isConnectedProfile(profile)) {
    throw new Error(
      `profile "${profile}" is not connected. Connected profiles: ${JSON.stringify(
        profileRegistry.getConnectedProfiles(),
      )}`,
    );
  }
}

/**
 * Route one message to the extension.
 *
 * A pinned profile is honoured absolutely: a failure there is reported, never
 * retried against another profile or the stdio native-messaging host, because
 * "the call silently went somewhere else" is the drift this whole subsystem
 * exists to stop. The native host stays reachable only when no Chrome profile
 * is connected at all, and the response says so.
 */
async function sendRequestToExtension(
  messagePayload: any,
  messageType: string = 'request_data',
  timeoutMs?: number,
  profile: string | null = null,
): Promise<any> {
  if (profile) {
    requireConnectedProfile(profile);
    try {
      return await profileRegistry.sendRequest(profile, messagePayload, messageType, timeoutMs);
    } catch (err: any) {
      throw new Error(
        `call to pinned profile "${profile}" failed: ${err?.message || String(err)}. ` +
          `Connected profiles: ${JSON.stringify(profileRegistry.getConnectedProfiles())}. ` +
          'The call was NOT re-sent to another profile or to the native-messaging host, because ' +
          'this session is pinned. Use chrome_switch_profile to move the session deliberately.',
      );
    }
  }

  const activeProfile = profileRegistry.getActiveProfile();
  if (activeProfile) {
    try {
      return await profileRegistry.sendRequest(
        activeProfile,
        messagePayload,
        messageType,
        timeoutMs,
      );
    } catch (err: any) {
      throw new Error(
        `call to the bridge default profile "${activeProfile}" failed: ` +
          `${err?.message || String(err)}. Connected profiles: ` +
          `${JSON.stringify(profileRegistry.getConnectedProfiles())}. No profile is pinned for ` +
          'this MCP session and the call was NOT re-sent through the native-messaging host, ' +
          'because a Chrome profile is connected. Pin the intended one with ' +
          'chrome_switch_profile(profile, tabId).',
      );
    }
  }

  // No Chrome profile is connected at all: the legacy stdio host is the only
  // transport left, and the caller is told that is what happened.
  try {
    return await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
      messagePayload,
      messageType,
      timeoutMs,
    );
  } catch (err: any) {
    throw new Error(
      `no Chrome profile is connected to the bridge, so the call was sent through the legacy ` +
        `native-messaging host, which failed: ${err?.message || String(err)}. Open Chrome with ` +
        'the MokuTab extension, then check chrome_list_profiles.',
    );
  }
}

/** A tool call to the extension, routed like any other: what module hooks get. */
const requestExtension: ExtensionRequest = (name, args, profile, timeoutMs) =>
  sendRequestToExtension({ name, args }, NativeMessageType.CALL_TOOL, timeoutMs, profile);

export const setupTools = (server: Server, options: ToolRouterOptions = {}) => {
  const router = createToolRouter(options);

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, router.listTools);

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    router.handleToolCall(request.params.name, request.params.arguments || {}, extra?.signal),
  );

  // A session that ends (DELETE, a dropped SSE stream) releases its leases.
  const previousOnClose = server.onclose;
  server.onclose = () => {
    void router.close();
    previousOnClose?.();
  };
};

export function createToolRouter(options: ToolRouterOptions = {}): ToolRouter {
  const installed = options.modules ?? INSTALLED_MODULES;
  const switches = options.switch ?? moduleSwitch;
  const autoFileRules = autoFileRulesFor(installed);

  const enabledModules = (): BridgeModule[] =>
    installed.filter((module) => switches.isEnabled(module.id));
  const installedOwner = (name: string): BridgeModule | undefined =>
    installed.find((module) => module.owns(name));
  /** The module that owns `name`, when it is on. */
  const enabledOwner = (name: string): BridgeModule | undefined => {
    const owner = installedOwner(name);
    return owner && switches.isEnabled(owner.id) ? owner : undefined;
  };
  /** Old tool name -> the module keeping it and the tool it now names. */
  const aliases = new Map<string, { module: BridgeModule; target: string }>();
  for (const module of installed) {
    for (const [alias, target] of Object.entries(module.aliases ?? {})) {
      aliases.set(alias, { module, target });
    }
  }

  // The served catalogue changes only when a module is switched; bridge_info
  // hashes it, so the same array is reused while the switch stays put.
  let servedCache: { key: string; tools: Tool[] } | null = null;
  const servedCatalogue = (): Tool[] => {
    const enabled = enabledModules();
    const key = enabled.map((module) => module.id).join(',');
    if (!servedCache || servedCache.key !== key) {
      servedCache = {
        key,
        tools: withAliasToolSchemas(
          servedToolSchemas(listedToolSchemas(enabled), autoFileRules),
          enabled,
        ),
      };
    }
    return servedCache.tools;
  };

  // One pinned tuple per MCP session (one createToolRouter per transport).
  let session: SessionContext | null = null;

  const getRoutingProfile = (callProfile: string | null): string | null =>
    callProfile || session?.profile || null;

  /**
   * Put the session's pinned tab, and the owning module's pin, on a call.
   *
   * Applied to the top-level call and to every nested orchestrator call, so a
   * multi-step operation cannot read one tab and write another. An explicit
   * tabId/windowId always wins, and the module decides what else a call
   * carries (Workato: expected_context, unless allow_context_mismatch:true).
   */
  const withSessionTarget = (
    name: string,
    args: JsonObject,
    routingProfile: string | null,
  ): JsonObject => {
    if (!session) return args;
    const owner = enabledOwner(name);
    const hooks = owner?.session;
    if (!owner || !hooks || !hooks.targets(name)) return args;
    // Tab ids and module pins belong to one Chrome profile: a call routed to
    // another profile (explicit profile arg, or a lease there) gets nothing
    // from this pin.
    if (routingProfile !== null && routingProfile !== session.profile) return args;
    let next = args;
    if (
      session.tabId !== null &&
      typeof args.tabId !== 'number' &&
      typeof args.windowId !== 'number'
    ) {
      next = { ...next, tabId: session.tabId };
    }
    const pin = session.modules[owner.id];
    return pin ? hooks.inject(name, next, pin) : next;
  };

  // Leases of THIS MCP session. Subagents share the session, so the lease id
  // they pass is what tells their calls apart.
  const leaseRegistry = options.leaseRegistry;
  const leases = new LeaseTable(leaseRegistry);
  let sweepTimer: NodeJS.Timeout | null = null;

  const closeLeaseTab = async (lease: TabLease): Promise<string | null> => {
    try {
      const reply = await profileRegistry.sendRequest(
        lease.profile,
        { tabId: lease.tabId },
        NativeMessageType.AGENT_TAB_CLOSE,
        15000,
      );
      return reply?.status === 'success' ? null : reply?.error || 'the extension refused';
    } catch (err: any) {
      return err?.message || String(err);
    }
  };

  const stopSweepWhenIdle = () => {
    if (leases.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };

  const sweepLeases = () => {
    for (const lease of leases.takeExpired(Date.now())) {
      // An adopted tab may be the user's own: forget the lease, keep the tab.
      if (!lease.adopted) void closeLeaseTab(lease);
    }
    stopSweepWhenIdle();
  };

  /**
   * The window of `tabId` in `profile`, or null when the profile has no such
   * tab. Reads get_windows_and_tabs once: cheap, and it proves the tab exists
   * before a lease points every later call at it.
   */
  const findTabWindow = async (profile: string, tabId: number): Promise<number | null> => {
    const reply = await profileRegistry.sendRequest(
      profile,
      { name: CORE_TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS, args: {} },
      NativeMessageType.CALL_TOOL,
      15000,
    );
    const text = reply?.data?.content?.[0]?.text;
    if (reply?.status !== 'success' || typeof text !== 'string') {
      throw new Error(
        `could not list the tabs of profile "${profile}": ${reply?.error || 'no data'}`,
      );
    }
    const windows = JSON.parse(text)?.windows;
    for (const win of Array.isArray(windows) ? windows : []) {
      for (const tab of Array.isArray(win?.tabs) ? win.tabs : []) {
        if (tab?.tabId === tabId) return typeof win.windowId === 'number' ? win.windowId : null;
      }
    }
    return null;
  };

  const handleLeaseTab = async (
    args: JsonObject,
    profile: string | null,
    signal?: AbortSignal,
  ): Promise<CallToolResult> => {
    const target = profile ?? profileRegistry.getActiveProfile();
    if (!target) return routeError('Error: no Chrome profile is connected to lease a tab in.');
    requireConnectedProfile(target);

    let tabId: number;
    let windowId: number | null;
    const adopt = args.adopt_tab_id;
    if (adopt !== undefined) {
      if (typeof adopt !== 'number' || !Number.isInteger(adopt) || adopt < 0) {
        return routeError('Error: adopt_tab_id must be a tab id (a non-negative integer).');
      }
      const held = leases.findByTab(target, adopt);
      if (held) {
        return routeError(
          `Error: tab ${adopt} is already leased as ${held.lease} in this session. Nothing was leased.`,
        );
      }
      let found: number | null;
      try {
        found = await findTabWindow(target, adopt);
      } catch (err: any) {
        return routeError(`Error: ${err?.message || String(err)}. Nothing was leased.`);
      }
      if (found === null) {
        return routeError(
          `Error: tab ${adopt} is not open in profile "${target}". Nothing was leased.`,
        );
      }
      tabId = adopt;
      windowId = found;
    } else {
      const reply = await profileRegistry.sendRequest(
        target,
        {
          url: typeof args.url === 'string' ? args.url : undefined,
          own_window: args.own_window === true,
        },
        NativeMessageType.AGENT_TAB_OPEN,
        20000,
      );
      if (reply?.status !== 'success' || typeof reply?.data?.tabId !== 'number') {
        return routeError(
          `Error: could not open a tab in profile "${target}": ` +
            `${reply?.error || 'no tab id came back'}`,
        );
      }
      tabId = reply.data.tabId;
      windowId = typeof reply.data.windowId === 'number' ? reply.data.windowId : null;
    }

    const now = Date.now();
    const adopted = adopt !== undefined;
    const lease: TabLease = {
      lease: newLeaseId(),
      profile: target,
      tabId,
      windowId,
      created_at: now,
      last_used: now,
      ...(adopted ? { adopted: true } : {}),
      browser_session: profileRegistry.getBrowserSession(target),
    };
    if (signal?.aborted) {
      // The caller gave up: nobody will ever pass this lease, and holding it
      // would switch the session into strict mode. Close a tab we opened.
      if (!adopted) await closeLeaseTab(lease);
      return routeError('Error: the call was cancelled; no lease was kept.');
    }
    leases.add(lease);
    if (!sweepTimer) {
      sweepTimer = setInterval(sweepLeases, 60_000);
      sweepTimer.unref();
    }
    return leaseResult({
      lease: lease.lease,
      tabId: lease.tabId,
      windowId: lease.windowId,
      profile: lease.profile,
      ...(adopted ? { adopted: true } : {}),
      note:
        'Pass lease on every browser call. While this session holds a lease, calls that name ' +
        'no tab are refused. Release it with chrome_release_tab when done (idle leases expire ' +
        `after ${Math.round(leaseIdleMs() / 60_000)} minutes, and the tab closes when this ` +
        'MCP session ends).' +
        (adopted
          ? ' This tab was adopted, so releasing or expiring the lease, or the session ending, leaves it open ' +
            '(chrome_release_tab keep_tab:false closes it).'
          : ''),
    });
  };

  /**
   * chrome_close_tabs must not close a tab another agent of this session holds
   * a lease on: tabIds naming one are refused (release it instead), and a url
   * close is refused while leased tabs exist in that profile, since the url
   * match could reach them.
   */
  const leasedTabCloseGuard = (
    name: string,
    args: JsonObject,
    profile: string | null,
  ): string | null => {
    if (name !== CORE_TOOL_NAMES.BROWSER.CLOSE_TABS || leases.size === 0) return null;
    const target = profile ?? profileRegistry.getActiveProfile();
    if (!target) return null;
    const leased = leases.tabIdsIn(target);
    if (leased.size === 0) return null;
    const ids: unknown[] = Array.isArray(args.tabIds) ? args.tabIds : [];
    const hit = ids.filter((id) => typeof id === 'number' && leased.has(id));
    if (hit.length > 0) {
      return (
        `Error: tab(s) ${hit.join(', ')} are leased in this session; close them with ` +
        'chrome_release_tab(lease). Nothing was closed.'
      );
    }
    if (typeof args.url === 'string' && args.url.trim() !== '') {
      return (
        'Error: closing by url is refused while this session holds leased tabs in profile ' +
        `"${target}" (the url could match a tab another agent leased). Pass tabIds instead. ` +
        'Nothing was closed.'
      );
    }
    return null;
  };

  const handleReleaseTab = async (args: JsonObject): Promise<CallToolResult> => {
    const id = typeof args.lease === 'string' ? args.lease.trim() : '';
    const lease = leases.get(id);
    if (!lease) {
      return routeError(
        `Error: unknown lease "${args.lease}". Leases of this session: ` +
          `${JSON.stringify(leases.ids())}.`,
      );
    }
    leases.delete(id);
    stopSweepWhenIdle();
    // An adopted tab stays open unless the caller explicitly asks to close it.
    const keep = lease.adopted ? args.keep_tab !== false : args.keep_tab === true;
    const closeError = keep ? null : await closeLeaseTab(lease);
    return leaseResult({
      released: lease.lease,
      tabId: lease.tabId,
      tab_closed: !keep && closeError === null,
      ...(closeError ? { close_error: closeError } : {}),
    });
  };

  /** `{profile, tab_id, <each module's pin fields>, pinned_at}`, or null. */
  const sessionSummary = (): JsonObject | null => {
    if (!session) return null;
    const summary: JsonObject = { profile: session.profile, tab_id: session.tabId };
    for (const module of enabledModules()) {
      if (module.session)
        Object.assign(summary, module.session.summary(session.modules[module.id]));
    }
    summary.pinned_at = session.pinned_at;
    return summary;
  };

  /**
   * An extension call the way the router makes one, for a module's bridge-side
   * tools: the same pinned tab and module pin as a top-level call (an
   * orchestrator that reads in one tab must not write in another), and the
   * same file-param resolution, so an orchestrator can pass code_path straight
   * through to the save tool.
   */
  const moduleContext = (routingProfile: string | null): ModuleCallContext => ({
    profile: routingProfile,
    session: sessionSummary(),
    callExtension: async (toolName, toolArgs) => {
      let nestedArgs: JsonObject = withSessionTarget(toolName, toolArgs || {}, routingProfile);
      let nested: PreparedModuleCall | undefined;
      const nestedOwner = enabledOwner(toolName);
      if (nestedOwner?.prepare) {
        nested = nestedOwner.prepare(toolName, nestedArgs);
        nestedArgs = nested.args;
      }
      const response = await sendRequestToExtension(
        {
          name: toolName,
          args: nestedArgs,
        },
        NativeMessageType.CALL_TOOL,
        120000,
        routingProfile,
      );
      if (response.status === 'success') {
        return nested?.finish
          ? nested.finish(response.data, { profile: routingProfile, args: nestedArgs })
          : response.data;
      }
      return {
        content: [{ type: 'text', text: `Error calling tool: ${response.error}` }],
        isError: true,
      };
    },
  });

  const handleToolCall = async (
    requested: string,
    args: any,
    signal?: AbortSignal,
  ): Promise<CallToolResult> => {
    try {
      // 0. An alias runs the tool it names, while the module keeping it is on.
      // Everything below sees the real name, so routing, the pin, strict mode
      // and auto-file treat the two names alike.
      const alias = aliases.get(requested);
      if (alias && !switches.isEnabled(alias.module.id)) {
        return routeError(aliasOffMessage(alias.module, requested, alias.target));
      }
      const name = alias ? alias.target : requested;

      // A module switched off on this machine refuses its tools, named, so
      // a session that still has the old tool list learns why.
      const owner = installedOwner(name);
      if (owner && !switches.isEnabled(owner.id)) {
        return routeError(moduleOffMessage(owner, name));
      }

      // 1. Check for Profile Management Admin Tools
      if (name === CORE_TOOL_NAMES.BRIDGE.LIST_PROFILES) {
        const defaultProfile = profileRegistry.getActiveProfile();
        const connected = profileRegistry.getConnectedProfiles();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  active_profile: session?.profile || defaultProfile,
                  session_profile: session?.profile ?? null,
                  session_tab_id: session?.tabId ?? null,
                  session_context: sessionSummary(),
                  server_default_profile: defaultProfile,
                  connected_profiles: connected,
                  leases: leases.summary(Date.now()),
                  routing_note: session
                    ? `This session is pinned to profile "${session.profile}"` +
                      (session.tabId !== null ? ` and tab ${session.tabId}` : '') +
                      '. Calls never fall back to another profile or transport.'
                    : connected.length > 0
                      ? 'No profile is pinned: calls follow the bridge default profile, which ' +
                        'can change when profiles connect or disconnect. Pin one with ' +
                        'chrome_switch_profile(profile, tabId).'
                      : 'No Chrome profile is connected: calls go through the legacy ' +
                        'native-messaging host, which has no profile or tab identity.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === CORE_TOOL_NAMES.BRIDGE.SWITCH_PROFILE) {
        const targetProfile = normalizeProfile(args?.profile);
        if (!targetProfile) {
          return routeError('Error: target profile parameter is required.');
        }
        if (!isConnectedProfile(targetProfile)) {
          return routeError(
            `Error: profile "${targetProfile}" is not connected. Connected profiles: ${JSON.stringify(
              profileRegistry.getConnectedProfiles(),
            )}`,
          );
        }
        const nextSessionTabId = normalizeTabId(args?.tabId);
        const profileChanged = session?.profile !== targetProfile;
        const nextTabId =
          nextSessionTabId !== null
            ? nextSessionTabId
            : profileChanged
              ? null
              : (session?.tabId ?? null);
        const next: SessionContext = {
          profile: targetProfile,
          tabId: nextTabId,
          modules: {},
          pinned_at: new Date().toISOString(),
          generation: profileRegistry.getGeneration(),
        };

        // Each module that pins more than the tab reads it off the tab now.
        const pinning = enabledModules().filter((module) => module.session);
        let contextNote = '';
        if (nextTabId !== null) {
          for (const module of pinning) {
            const probe = await module.session!.probe(targetProfile, nextTabId, requestExtension);
            if (probe.pin) next.modules[module.id] = probe.pin;
            else if (probe.note) contextNote += probe.note;
          }
        }
        session = next;

        const summary = sessionSummary();
        const tabLabel =
          pinning.find((module) => module.session?.tabLabel)?.session?.tabLabel ?? 'tab ID';
        const pinned = session;
        return {
          content: [
            {
              type: 'text',
              text:
                `Successfully switched this MCP session to profile context: "${targetProfile}"` +
                (pinned.tabId !== null ? ` and ${tabLabel}: ${pinned.tabId}` : '') +
                pinning
                  .map((module) => module.session!.describe(pinned.modules[module.id]))
                  .join('') +
                contextNote +
                `\n${JSON.stringify({ session_context: summary })}`,
            },
          ],
        };
      }

      // Runs across every connected profile, so it bypasses profile routing.
      if (isReloadExtensionTool(name)) {
        return handleReloadExtensionCall(args, {
          connectedProfiles: () => profileRegistry.getConnectedProfiles(),
          connectionSerial: (profile) => profileRegistry.getConnectionSerial(profile),
          defaultProfile: () => profileRegistry.getActiveProfile(),
          request: (profile, type, payload, timeoutMs) =>
            profileRegistry.sendRequest(profile, payload, type, timeoutMs),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
        });
      }

      sweepLeases();
      const routed = extractRoutedArgs(args);
      if (name === LEASE_TAB_TOOL) {
        // Awaited here so a rejection becomes a tool error, not a protocol error.
        return await handleLeaseTab(routed.args, getRoutingProfile(routed.profile), signal);
      }
      if (name === RELEASE_TAB_TOOL) return await handleReleaseTab(routed.args);

      // A lease names both the profile and the tab of this call.
      let leaseProfile: string | null = null;
      if (routed.args[LEASE_ARG] !== undefined) {
        const applied = applyLease(name, routed.args, leases, Date.now());
        if (!applied.ok) return routeError(`Error: ${applied.error}`);
        if (routed.profile && routed.profile !== applied.lease.profile) {
          return routeError(
            `Error: lease ${applied.lease.lease} is in profile "${applied.lease.profile}", ` +
              `but the call passed profile "${routed.profile}".`,
          );
        }
        routed.args = applied.args;
        leaseProfile = applied.lease.profile;
      }
      const routingProfile = getRoutingProfile(leaseProfile ?? routed.profile);
      // A tabId without its lease still works the leased tab: keep that lease
      // (this session's or another's) from expiring under it.
      if (leaseProfile === null && typeof routed.args.tabId === 'number') {
        const tabProfile = routingProfile ?? profileRegistry.getActiveProfile();
        if (tabProfile) leases.touchTab(tabProfile, routed.args.tabId, Date.now());
      }

      // Watches live in the bridge, outside any one session; start reads its tabs
      // in the routed profile.
      if (isWatchTool(name)) {
        return await handleWatchToolCall(
          watchManager,
          name,
          routed.args,
          routingProfile ?? profileRegistry.getActiveProfile(),
        );
      }

      // Browser functions run here: registry files, the run log, and a window
      // of their own driven through tab and tool messages.
      if (isFnTool(name)) {
        return await handleFnToolCall(
          name,
          routed.args,
          { callProfile: routed.profile, sessionProfile: session?.profile ?? null, signal },
          fnDeps(),
        );
      }

      // A profile that reconnected may be a different browser session: the
      // owning module re-checks its pin once per registry generation before
      // anything is routed.
      const hooks = owner?.session;
      // The session this check reads; a switch_profile during the probe
      // replaces `session`, and the answer must not land on the new pin.
      const checkedSession = session;
      if (owner && hooks && checkedSession && checkedSession.tabId !== null) {
        const pin = checkedSession.modules[owner.id];
        if (pin && hooks.needsRecheck(name, pin)) {
          const generation = profileRegistry.getGeneration();
          if (generation !== checkedSession.generation) {
            const checked = await hooks.recheck(
              pin,
              { profile: checkedSession.profile, tabId: checkedSession.tabId },
              requestExtension,
            );
            // Both answers concern the session that was read. A re-pin during
            // the probe made it moot: the call goes on under the new pin.
            if (checked.refusal && session === checkedSession) {
              return routeError(checked.refusal);
            }
            // A failed probe leaves the generation alone so the next call retries;
            // the call itself surfaces the real transport failure.
            if (checked.pin && session === checkedSession) {
              checkedSession.modules[owner.id] = checked.pin;
              checkedSession.generation = generation;
            }
          }
        }
      }

      // Strict targeting looks at the caller's own arguments (lease applied),
      // before the session pin is injected: the pin is shared by every agent
      // of the session, so it must not count as naming a tab.
      const strictRefusal = strictTabsViolation(
        name,
        routed.args || {},
        leases.size > 0 || strictTabsFromEnv(),
      );
      if (strictRefusal) return routeError(strictRefusal);
      const closeRefusal = leasedTabCloseGuard(name, routed.args || {}, routingProfile);
      if (closeRefusal) return routeError(closeRefusal);
      let effectiveArgs: any = withSessionTarget(name, routed.args || {}, routingProfile);
      // Unredacted output is the bridge's call, never the caller's: drop any
      // rawOutput here, whatever the tool. prepareAutoFileCall sets it again
      // only for chrome_javascript with an explicit out_file.
      if (effectiveArgs && RAW_OUTPUT_ARG in effectiveArgs) {
        effectiveArgs = { ...effectiveArgs };
        delete effectiveArgs[RAW_OUTPUT_ARG];
      }

      // A module's own file params (Workato: recipe out_file / code_path, LCAP
      // content_path): resolved here, since this process has filesystem access.
      let prepared: PreparedModuleCall | undefined;
      if (owner?.prepare) {
        prepared = owner.prepare(name, effectiveArgs || {});
        effectiveArgs = prepared.args;
      }

      // chrome_fetch_to_file(out_file): the extension replies with the body as
      // base64, which only the file writer below may see. See chrome-fetch-to-file.ts.
      let fetchOutFile: string | undefined;
      if (isFetchToFileTool(name)) {
        const preparedFetch = prepareFetchToFileCall(effectiveArgs || {});
        effectiveArgs = preparedFetch.args;
        fetchOutFile = preparedFetch.outFile;
      }

      // Generic out_file / auto-file for every other read tool and for
      // chrome_screenshot: strip the file params here, spill the result on the
      // way back out. See auto-file.ts.
      let autoFilePlan: AutoFilePlan | undefined;
      {
        const preparedAutoFile = prepareAutoFileCall(name, effectiveArgs || {}, autoFileRules);
        effectiveArgs = preparedAutoFile.args;
        autoFilePlan = preparedAutoFile.plan;
      }

      // A module's bridge-side tools: pure helpers, and orchestrators that drive
      // several extension tools in sequence. Returned as is, like before.
      if (owner?.handle) {
        const handled = owner.handle(name, effectiveArgs || {}, moduleContext(routingProfile));
        if (handled) return handled;
      }

      // `chrome_bridge_info` reports this build's own identity, locally.
      if (isBridgeInfoTool(name)) {
        return handleBridgeInfoCall(
          {
            connected_profiles: profileRegistry.getConnectedProfiles(),
            session_context: sessionSummary(),
            default_profile: profileRegistry.getActiveProfile(),
          },
          servedCatalogue(),
        );
      }

      const response = await sendRequestToExtension(
        {
          name,
          args: effectiveArgs,
        },
        NativeMessageType.CALL_TOOL,
        120000,
        routingProfile,
      );
      if (response.status === 'success') {
        if (prepared?.finish) {
          return await prepared.finish(response.data, {
            profile: routingProfile,
            args: effectiveArgs,
          });
        }
        if (fetchOutFile) return finishFetchToFile(fetchOutFile, response.data);
        // A call whose job is to change the pinned context: a pin on the profile
        // that just switched follows it, or its next call reports ContextChanged.
        if (hooks?.isContextChanging(name) && session && session.profile === routingProfile) {
          const followed = hooks.follow(response.data, session.modules[owner!.id]);
          if (followed) {
            session = {
              ...session,
              modules: { ...session.modules, [owner!.id]: followed },
              generation: profileRegistry.getGeneration(),
            };
          }
        }
        // Single return path for a routed tool response: spill a large result
        // to disk first (the context block is kept out of the file), then stamp
        // the profile into the context block (only this side knows the name).
        return stampContextBlock(applyAutoFile(name, autoFilePlan, response.data), routingProfile);
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `Error calling tool: ${response.error}`,
            },
          ],
          isError: true,
        };
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error calling tool: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  };

  const listTools = async () => ({ tools: servedToolList(enabledModules(), autoFileRules) });

  const handleToolCallWithCancel = (name: string, args: any, signal?: AbortSignal) =>
    raceAbort(handleToolCall(name, args, signal), signal);

  const close = async (): Promise<void> => {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    // An adopted tab may be the user's own: forget the lease, keep the tab.
    const opened = leases.takeAll().filter((lease) => !lease.adopted);
    await Promise.all(opened.map((lease) => closeLeaseTab(lease)));
  };

  return { listTools, handleToolCall: handleToolCallWithCancel, close };
}
