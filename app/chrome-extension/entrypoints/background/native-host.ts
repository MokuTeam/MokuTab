/**
 * Native Host background service worker script.
 * Manages WebSocket client lifecycle, failover native host server election,
 * and handles MCP tool execution requests from the native server.
 *
 * Author: Roman Chikalenko
 * Version: 1.4.0
 */
import { NativeMessageType } from '@mokuhub/mokutab-shared';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { NATIVE_HOST, STORAGE_KEYS, ERROR_MESSAGES, SUCCESS_MESSAGES } from '@/common/constants';
import { handleCallTool } from './tools';
import { acquireKeepalive } from './keepalive-manager';
import { getExtensionBuildInfo, scheduleExtensionReload } from './dev-reload';
import { agentTabInfo, closeAgentTab, navigateAgentTab, openAgentTab } from './agent-tabs';
import { runWatchProbe } from './watch-probe';
import { applyBridgeModulesState, clearModuleStates } from './extension-module';
import { EXTENSION_MODULES } from './modules';
import { moduleStatesOf, readStoredModulesState } from '@/common/module-state';
import { BridgeRequests } from './bridge-requests';
import { createModulePopupHandlers } from './module-popup';
import { browserSessionId, watchBrowserLifecycle } from './browser-session';

const LOG_PREFIX = '[NativeHost]';

/** Requests this extension sent to the bridge (module switch). */
const bridgeRequests = new BridgeRequests();

let nativePort: chrome.runtime.Port | null = null;
/**
 * True while the native host this profile started is the one serving the
 * bridge port (it answered SERVER_STARTED). A host that lost the port election
 * keeps nativePort set without ever sending that, so nativePort alone is not
 * ownership.
 */
let ownsBridge = false;
export const HOST_NAME = NATIVE_HOST.NAME;

/**
 * Compatibility shim for bridges before 2.0, to be removed later: those
 * bridges ask for the record-replay flow list on every tools/list and wait
 * 20 s for an answer. Answering with an empty list keeps tools/list instant.
 */
const LEGACY_FLOW_LIST_REQUEST = 'rr_list_published_flows';

// ==================== WebSocket Aggregator Client State ====================
let wsClient: WebSocket | null = null;
let isWsConnecting = false;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsReconnectAttempts = 0;
const WS_MAX_RECONNECT_ATTEMPTS = 5;

// ==================== Reconnect Configuration ====================

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_MAX_FAST_ATTEMPTS = 8;
const RECONNECT_COOLDOWN_DELAY_MS = 5 * 60_000;

// ==================== Auto-connect State ====================

let keepaliveRelease: (() => void) | null = null;
let autoConnectEnabled = true;
let autoConnectLoaded = false;
let ensurePromise: Promise<boolean> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let manualDisconnect = false;

/**
 * Server status management interface
 */
interface ServerStatus {
  isRunning: boolean;
  port?: number;
  lastUpdated: number;
}

let currentServerStatus: ServerStatus = {
  isRunning: false,
  lastUpdated: Date.now(),
};

/**
 * Save server status to chrome.storage
 */
async function saveServerStatus(status: ServerStatus): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.SERVER_STATUS]: status });
  } catch (error) {
    console.error(ERROR_MESSAGES.SERVER_STATUS_SAVE_FAILED, error);
  }
}

/**
 * Load server status from chrome.storage
 */
async function loadServerStatus(): Promise<ServerStatus> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.SERVER_STATUS]);
    if (result[STORAGE_KEYS.SERVER_STATUS]) {
      return result[STORAGE_KEYS.SERVER_STATUS];
    }
  } catch (error) {
    console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
  }
  return {
    isRunning: false,
    lastUpdated: Date.now(),
  };
}

/**
 * Broadcast server status change to all listeners
 */
function broadcastServerStatusChange(status: ServerStatus): void {
  chrome.runtime
    .sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED,
      payload: status,
    })
    .catch(() => {
      // Ignore errors if no listeners are present
    });
}

// ==================== Port Normalization ====================

/**
 * Normalize a port value to a valid port number or null.
 */
function normalizePort(value: unknown): number | null {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const port = Math.floor(n);
  if (port <= 0 || port > 65535) return null;
  return port;
}

// ==================== Reconnect Utilities ====================

/**
 * Add jitter to a delay value to avoid thundering herd.
 */
function withJitter(ms: number): number {
  const ratio = 0.7 + Math.random() * 0.6;
  return Math.max(0, Math.round(ms * ratio));
}

/**
 * Calculate reconnect delay based on attempt number.
 * Uses exponential backoff with jitter, then switches to cooldown interval.
 */
function getReconnectDelayMs(attempt: number): number {
  if (attempt >= RECONNECT_MAX_FAST_ATTEMPTS) {
    return withJitter(RECONNECT_COOLDOWN_DELAY_MS);
  }
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt), RECONNECT_MAX_DELAY_MS);
  return withJitter(delay);
}

/**
 * Clear the reconnect timer if active.
 */
function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/**
 * Reset reconnect state after successful connection.
 */
function resetReconnectState(): void {
  reconnectAttempts = 0;
  clearReconnectTimer();
}

// ==================== Keepalive Management ====================

/**
 * Sync keepalive hold based on autoConnectEnabled state.
 * When auto-connect is enabled, we hold a keepalive reference to keep SW alive.
 */
function syncKeepaliveHold(): void {
  if (autoConnectEnabled) {
    if (!keepaliveRelease) {
      keepaliveRelease = acquireKeepalive('native-host');
      console.debug(`${LOG_PREFIX} Acquired keepalive`);
    }
    return;
  }
  if (keepaliveRelease) {
    try {
      keepaliveRelease();
      console.debug(`${LOG_PREFIX} Released keepalive`);
    } catch {
      // Ignore
    }
    keepaliveRelease = null;
  }
}

// ==================== Auto-connect Settings ====================

/**
 * Load the nativeAutoConnectEnabled setting from storage.
 */
async function loadNativeAutoConnectEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED]);
    const raw = result[STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED];
    if (typeof raw === 'boolean') return raw;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to load nativeAutoConnectEnabled`, error);
  }
  return true; // Default to enabled
}

/**
 * Set the nativeAutoConnectEnabled setting and persist to storage.
 */
async function setNativeAutoConnectEnabled(enabled: boolean): Promise<void> {
  autoConnectEnabled = enabled;
  autoConnectLoaded = true;
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED]: enabled });
    console.debug(`${LOG_PREFIX} Set nativeAutoConnectEnabled=${enabled}`);
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to persist nativeAutoConnectEnabled`, error);
  }
  syncKeepaliveHold();
}

// ==================== Port Preference ====================

/**
 * Get the preferred port for connecting to native server.
 * Priority: explicit override > user preference > last known port > default
 */
async function getPreferredPort(override?: unknown): Promise<number> {
  const explicit = normalizePort(override);
  if (explicit) return explicit;

  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.NATIVE_SERVER_PORT,
      STORAGE_KEYS.SERVER_STATUS,
    ]);

    const userPort = normalizePort(result[STORAGE_KEYS.NATIVE_SERVER_PORT]);
    if (userPort) return userPort;

    const status = result[STORAGE_KEYS.SERVER_STATUS] as Partial<ServerStatus> | undefined;
    const statusPort = normalizePort(status?.port);
    if (statusPort) return statusPort;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to read preferred port`, error);
  }

  const inMemoryPort = normalizePort(currentServerStatus.port);
  if (inMemoryPort) return inMemoryPort;

  return NATIVE_HOST.DEFAULT_PORT;
}

// ==================== Reconnect Scheduling ====================

/**
 * Schedule a reconnect attempt with exponential backoff.
 */
function scheduleReconnect(reason: string): void {
  if (nativePort) return;
  if (manualDisconnect) return;
  if (!autoConnectEnabled) return;
  if (reconnectTimer) return;

  const delay = getReconnectDelayMs(reconnectAttempts);
  console.debug(
    `${LOG_PREFIX} Reconnect scheduled in ${delay}ms (attempt=${reconnectAttempts}, reason=${reason})`,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (nativePort) return;
    if (manualDisconnect || !autoConnectEnabled) return;

    reconnectAttempts += 1;
    void ensureNativeConnected(`reconnect:${reason}`).catch(() => {});
  }, delay);
}

// ==================== Server Status Update ====================

/**
 * Mark server as stopped and broadcast the change.
 */
async function markServerStopped(reason: string): Promise<void> {
  currentServerStatus = {
    isRunning: false,
    port: currentServerStatus.port,
    lastUpdated: Date.now(),
  };
  try {
    await saveServerStatus(currentServerStatus);
  } catch {
    // Ignore
  }
  broadcastServerStatusChange(currentServerStatus);
  console.debug(`${LOG_PREFIX} Server marked stopped (${reason})`);
}

// ==================== Core Ensure Function ====================

/**
 * Ensure native connection is established.
 * This is the main entry point for auto-connect logic.
 *
 * @param trigger - Description of what triggered this call (for logging)
 * @param portOverride - Optional explicit port to use
 * @returns Whether the connection is now established
 */
async function ensureNativeConnected(trigger: string, portOverride?: unknown): Promise<boolean> {
  // Concurrency protection: only one ensure flow at a time
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    // Load auto-connect setting if not yet loaded
    if (!autoConnectLoaded) {
      autoConnectEnabled = await loadNativeAutoConnectEnabled();
      autoConnectLoaded = true;
      syncKeepaliveHold();
    }

    // If auto-connect is disabled, do nothing
    if (!autoConnectEnabled) {
      console.debug(`${LOG_PREFIX} Auto-connect disabled, skipping ensure (trigger=${trigger})`);
      return false;
    }

    // Sync keepalive hold
    syncKeepaliveHold();

    // Already connected
    if (nativePort || wsClient) {
      console.debug(`${LOG_PREFIX} Already connected (trigger=${trigger})`);
      return true;
    }

    // Get the port to use
    const port = await getPreferredPort(portOverride);

    // 1. Try connecting to the central server via WebSocket first
    console.debug(
      `${LOG_PREFIX} Checking for active native server via WS on port ${port}... (trigger=${trigger})`,
    );
    const wsConnected = await connectWebSocket(port);
    if (wsConnected) {
      console.log(`${LOG_PREFIX} Connected to existing native server via WS.`);
      return true;
    }

    // 2. If WS connection failed, the server is down. Start native host process (host election!)
    console.debug(
      `${LOG_PREFIX} No active native server found via WS. Spawning local server... (trigger=${trigger})`,
    );
    const ok = connectNativeHost(port);
    if (!ok) {
      console.warn(`${LOG_PREFIX} Connection failed (trigger=${trigger})`);
      scheduleReconnect(`connect_failed:${trigger}`);
      return false;
    }

    console.debug(`${LOG_PREFIX} Spawning initiated, waiting to establish WebSocket connection...`);
    // Wait for native server to start and establish the WebSocket connection
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const finalConnected = await connectWebSocket(port);
    if (!finalConnected) {
      console.warn(`${LOG_PREFIX} Native host spawned but WebSocket connection failed.`);
    }
    return finalConnected;
  })().finally(() => {
    ensurePromise = null;
  });

  return ensurePromise;
}

// ==================== Module Switch (bridge state) ====================

/** A modules_state push or answer: keep it, and tell an open popup. */
async function onBridgeModulesState(payload: unknown): Promise<void> {
  const stored = await applyBridgeModulesState(payload);
  chrome.runtime
    .sendMessage({ type: BACKGROUND_MESSAGE_TYPES.MODULES_CHANGED, payload: stored })
    .catch(() => {
      // No popup open.
    });
}

/** get_modules / set_module from the popup, answered over the bridge socket. */
const modulePopup = createModulePopupHandlers({
  socket: () => wsClient,
  requests: bridgeRequests,
  applyState: onBridgeModulesState,
  storedStates: async () => moduleStatesOf(await readStoredModulesState()),
  modules: EXTENSION_MODULES,
});

// ==================== WebSocket Client Helpers ====================

async function connectWebSocket(port: number): Promise<boolean> {
  if (wsClient) {
    return true;
  }
  if (isWsConnecting) {
    return false;
  }

  isWsConnecting = true;

  // Retrieve profileName from storage
  let profileName = 'default';
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.PROFILE_NAME]);
    if (result[STORAGE_KEYS.PROFILE_NAME]) {
      profileName = result[STORAGE_KEYS.PROFILE_NAME];
    }
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Failed to load profile name from storage, defaulting to 'default'`,
      error,
    );
  }

  // Lets the bridge tell tabs of this Chrome session from same-numbered tabs
  // of an earlier one (see browser-session.ts).
  const browserSession = await browserSessionId();

  return new Promise((resolve) => {
    const wsUrl =
      `ws://127.0.0.1:${port}/ws-client?profile=${encodeURIComponent(profileName)}` +
      `&browser_session=${encodeURIComponent(browserSession)}`;
    console.debug(`${LOG_PREFIX} Connecting WebSocket to ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`${LOG_PREFIX} WebSocket connected for profile "${profileName}"`);
      // Until this bridge pushes its module state, none is known: an older
      // bridge never pushes, and a stored "off" must not strand it.
      void clearModuleStates();
      wsClient = ws;
      isWsConnecting = false;
      wsReconnectAttempts = 0;
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }

      // Update in-memory server status since server is confirmed running
      currentServerStatus = {
        isRunning: true,
        port: port,
        lastUpdated: Date.now(),
      };
      void saveServerStatus(currentServerStatus);
      broadcastServerStatusChange(currentServerStatus);

      resolve(true);
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.debug(`${LOG_PREFIX} WebSocket received message type: ${message.type}`);

        if (message.responseToRequestId) {
          // The bridge answering a request this extension sent (module switch).
          bridgeRequests.settle(message);
        } else if (message.type === NativeMessageType.MODULES_STATE) {
          await onBridgeModulesState(message.payload);
        } else if (message.type === NativeMessageType.CALL_TOOL && message.requestId) {
          const requestId = message.requestId;
          try {
            const result = await handleCallTool(message.payload);
            ws.send(
              JSON.stringify({
                responseToRequestId: requestId,
                payload: {
                  status: 'success',
                  message: SUCCESS_MESSAGES.TOOL_EXECUTED,
                  data: result,
                },
              }),
            );
          } catch (error) {
            ws.send(
              JSON.stringify({
                responseToRequestId: requestId,
                payload: {
                  status: 'error',
                  message: ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
                  error: error instanceof Error ? error.message : String(error),
                },
              }),
            );
          }
        } else if (message.type === LEGACY_FLOW_LIST_REQUEST && message.requestId) {
          // Compatibility shim for bridges before 2.0 (see LEGACY_FLOW_LIST_REQUEST).
          ws.send(
            JSON.stringify({
              responseToRequestId: message.requestId,
              payload: { status: 'success', items: [] },
            }),
          );
        } else if (message.type === NativeMessageType.DEV_EXTENSION_INFO && message.requestId) {
          ws.send(
            JSON.stringify({
              responseToRequestId: message.requestId,
              payload: { status: 'success', data: await getExtensionBuildInfo(ownsBridge) },
            }),
          );
        } else if (message.type === NativeMessageType.DEV_RELOAD_EXTENSION && message.requestId) {
          // Answer first: the reload kills this worker and the socket with it.
          let payload: Record<string, unknown>;
          try {
            const info = await getExtensionBuildInfo(ownsBridge);
            payload = {
              status: 'success',
              data: { ...info, ...scheduleExtensionReload(message.payload?.delay_ms) },
            };
          } catch (error) {
            payload = {
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            };
          }
          ws.send(JSON.stringify({ responseToRequestId: message.requestId, payload }));
        } else if (
          (message.type === NativeMessageType.AGENT_TAB_OPEN ||
            message.type === NativeMessageType.AGENT_TAB_CLOSE ||
            message.type === NativeMessageType.AGENT_TAB_INFO ||
            message.type === NativeMessageType.AGENT_TAB_NAVIGATE) &&
          message.requestId
        ) {
          let payload: Record<string, unknown>;
          try {
            const data =
              message.type === NativeMessageType.AGENT_TAB_OPEN
                ? await openAgentTab(message.payload ?? {})
                : message.type === NativeMessageType.AGENT_TAB_INFO
                  ? await agentTabInfo(message.payload ?? {})
                  : message.type === NativeMessageType.AGENT_TAB_NAVIGATE
                    ? await navigateAgentTab(message.payload ?? {})
                    : await closeAgentTab(message.payload?.tabId);
            payload = { status: 'success', data };
          } catch (error) {
            payload = {
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            };
          }
          ws.send(JSON.stringify({ responseToRequestId: message.requestId, payload }));
        } else if (message.type === NativeMessageType.WATCH_PROBE && message.requestId) {
          let payload: Record<string, unknown>;
          try {
            payload = { status: 'success', data: await runWatchProbe(message.payload ?? {}) };
          } catch (error) {
            payload = {
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            };
          }
          ws.send(JSON.stringify({ responseToRequestId: message.requestId, payload }));
        }
      } catch (err: any) {
        console.error(`${LOG_PREFIX} Error handling WS message:`, err);
      }
    };

    ws.onclose = () => {
      console.warn(`${LOG_PREFIX} WebSocket connection closed`);
      wsClient = null;
      isWsConnecting = false;
      bridgeRequests.rejectAll('the bridge connection closed');

      // If we didn't initiate a manual disconnect, handle reconnection
      if (!manualDisconnect && autoConnectEnabled) {
        scheduleWsReconnect(port);
      }
    };

    ws.onerror = (err) => {
      console.warn(`${LOG_PREFIX} WebSocket error:`, err);
      isWsConnecting = false;
      resolve(false);
    };
  });
}

function scheduleWsReconnect(port: number): void {
  if (wsClient) return;
  if (wsReconnectTimer) return;

  if (wsReconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
    console.warn(
      `${LOG_PREFIX} WebSocket max reconnect attempts reached. Triggering failover host election...`,
    );
    wsReconnectAttempts = 0;

    // FAILOVER: Elect ourselves as the host!
    void triggerHostElection(port);
    return;
  }

  const delay = getReconnectDelayMs(wsReconnectAttempts);
  console.debug(
    `${LOG_PREFIX} WebSocket reconnect scheduled in ${delay}ms (attempt=${wsReconnectAttempts})`,
  );

  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsReconnectAttempts++;
    void connectWebSocket(port).then((ok) => {
      if (!ok) {
        scheduleWsReconnect(port);
      }
    });
  }, delay);
}

async function triggerHostElection(port: number): Promise<void> {
  console.log(`${LOG_PREFIX} Electing this profile to spin up local native host server...`);
  const ok = connectNativeHost(port);
  if (ok) {
    // Wait for native server to start, then try to connect the WS
    setTimeout(() => {
      void connectWebSocket(port);
    }, 1500);
  }
}

/**
 * Connect to the native messaging host
 * @returns Whether the connection was initiated successfully
 */
export function connectNativeHost(port: number = NATIVE_HOST.DEFAULT_PORT): boolean {
  if (nativePort) {
    return true;
  }

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);

    nativePort.onMessage.addListener(async (message) => {
      if (message.type === NativeMessageType.CALL_TOOL && message.requestId) {
        const requestId = message.requestId;
        try {
          const result = await handleCallTool(message.payload);
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: 'success',
              message: SUCCESS_MESSAGES.TOOL_EXECUTED,
              data: result,
            },
          });
        } catch (error) {
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: 'error',
              message: ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      } else if (message.type === LEGACY_FLOW_LIST_REQUEST && message.requestId) {
        // Compatibility shim for bridges before 2.0 (see LEGACY_FLOW_LIST_REQUEST).
        nativePort?.postMessage({
          responseToRequestId: message.requestId,
          payload: { status: 'success', items: [] },
        });
      } else if (message.type === NativeMessageType.SERVER_STARTED) {
        ownsBridge = true;
        const port = message.payload?.port;
        currentServerStatus = {
          isRunning: true,
          port: port,
          lastUpdated: Date.now(),
        };
        await saveServerStatus(currentServerStatus);
        broadcastServerStatusChange(currentServerStatus);
        // Server is confirmed running - now we can reset reconnect state
        resetReconnectState();
        console.log(`${SUCCESS_MESSAGES.SERVER_STARTED} on port ${port}`);
      } else if (message.type === NativeMessageType.SERVER_STOPPED) {
        currentServerStatus = {
          isRunning: false,
          port: currentServerStatus.port, // Keep last known port for reconnection
          lastUpdated: Date.now(),
        };
        await saveServerStatus(currentServerStatus);
        broadcastServerStatusChange(currentServerStatus);
        console.log(SUCCESS_MESSAGES.SERVER_STOPPED);
      } else if (message.type === NativeMessageType.ERROR_FROM_NATIVE_HOST) {
        console.error('Error from native host:', message.payload?.message || 'Unknown error');
      } else if (message.type === 'file_operation_response') {
        // Forward file operation response back to the requesting tool
        chrome.runtime.sendMessage(message).catch(() => {
          // Ignore if no listeners
        });
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.warn(ERROR_MESSAGES.NATIVE_DISCONNECTED, chrome.runtime.lastError);
      nativePort = null;
      ownsBridge = false;

      // Mark server as stopped since native host disconnection means server is down
      void markServerStopped('native_port_disconnected');

      // Handle reconnection based on disconnect reason
      if (manualDisconnect) {
        manualDisconnect = false;
        return;
      }
      if (!autoConnectEnabled) return;
      scheduleReconnect('native_port_disconnected');
    });

    nativePort.postMessage({ type: NativeMessageType.START, payload: { port } });
    // Note: Don't reset reconnect state here. Wait for SERVER_STARTED confirmation.
    // Chrome may return a Port but disconnect immediately if native host is missing.
    return true;
  } catch (error) {
    console.warn(ERROR_MESSAGES.NATIVE_CONNECTION_FAILED, error);
    nativePort = null;
    return false;
  }
}

/**
 * Initialize native host listeners and load initial state
 */
export const initNativeHostListener = () => {
  // First, synchronously: onStartup / onInstalled decide the browser session id.
  watchBrowserLifecycle();

  // Initialize server status from storage
  loadServerStatus()
    .then((status) => {
      currentServerStatus = status;
    })
    .catch((error) => {
      console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
    });

  // Auto-connect on SW activation (covers SW restart after idle termination)
  void ensureNativeConnected('sw_startup').catch(() => {});

  // Auto-connect on Chrome browser startup
  chrome.runtime.onStartup.addListener(() => {
    void ensureNativeConnected('onStartup').catch(() => {});
  });

  // Auto-connect on extension install/update
  chrome.runtime.onInstalled.addListener(() => {
    void ensureNativeConnected('onInstalled').catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msgType = typeof message === 'string' ? message : message?.type;

    // ENSURE_NATIVE: Trigger ensure without changing autoConnectEnabled
    if (msgType === NativeMessageType.ENSURE_NATIVE) {
      const portOverride = typeof message === 'object' ? message.port : undefined;
      ensureNativeConnected('ui_ensure', portOverride)
        .then((connected) => {
          sendResponse({ success: true, connected, autoConnectEnabled });
        })
        .catch((e) => {
          sendResponse({
            success: false,
            connected: nativePort !== null || wsClient !== null,
            error: String(e),
          });
        });
      return true;
    }

    // CONNECT_NATIVE: Explicit user connect, re-enables auto-connect
    if (msgType === NativeMessageType.CONNECT_NATIVE) {
      const portOverride = typeof message === 'object' ? message.port : undefined;
      const normalized = normalizePort(portOverride);

      (async () => {
        // Explicit user connect: re-enable auto-connect
        await setNativeAutoConnectEnabled(true);

        if (normalized) {
          // Best-effort: persist preferred port
          try {
            await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_SERVER_PORT]: normalized });
          } catch {
            // Ignore
          }
        }

        return ensureNativeConnected('ui_connect', normalized ?? undefined);
      })()
        .then((connected) => {
          sendResponse({ success: true, connected });
        })
        .catch((e) => {
          sendResponse({
            success: false,
            connected: nativePort !== null || wsClient !== null,
            error: String(e),
          });
        });
      return true;
    }

    if (msgType === NativeMessageType.PING_NATIVE) {
      const connected = nativePort !== null || wsClient !== null;
      sendResponse({ connected, autoConnectEnabled });
      return true;
    }

    // DISCONNECT_NATIVE: Explicit user disconnect, disables auto-connect
    if (msgType === NativeMessageType.DISCONNECT_NATIVE) {
      (async () => {
        // Explicit user disconnect: disable auto-connect and stop reconnect loop
        await setNativeAutoConnectEnabled(false);
        clearReconnectTimer();
        reconnectAttempts = 0;
        syncKeepaliveHold();

        if (wsClient) {
          try {
            wsClient.close();
          } catch {
            // Ignore
          }
          wsClient = null;
        }

        if (nativePort) {
          // Only set manualDisconnect if we actually have a port to disconnect.
          // This prevents the flag from persisting when there's no active connection.
          manualDisconnect = true;
          try {
            nativePort.disconnect();
          } catch {
            // Ignore
          }
          nativePort = null;
          ownsBridge = false;
        }
        await markServerStopped('manual_disconnect');
      })()
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((e) => {
          sendResponse({ success: false, error: String(e) });
        });
      return true;
    }

    // Module switch: the popup reads and writes the bridge's state through here.
    if (message.type === BACKGROUND_MESSAGE_TYPES.GET_MODULES) {
      modulePopup
        .getModules()
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: String(e) }));
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.SET_MODULE) {
      modulePopup
        .setModule(message.id, message.enabled)
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: String(e) }));
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS) {
      sendResponse({
        success: true,
        serverStatus: currentServerStatus,
        connected: nativePort !== null || wsClient !== null,
      });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.REFRESH_SERVER_STATUS) {
      loadServerStatus()
        .then((storedStatus) => {
          currentServerStatus = storedStatus;
          sendResponse({
            success: true,
            serverStatus: currentServerStatus,
            connected: nativePort !== null || wsClient !== null,
          });
        })
        .catch((error) => {
          console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
          sendResponse({
            success: false,
            error: ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED,
            serverStatus: currentServerStatus,
            connected: nativePort !== null || wsClient !== null,
          });
        });
      return true;
    }

    // Forward file operation messages to native host
    if (message.type === 'forward_to_native' && message.message) {
      if (nativePort) {
        nativePort.postMessage(message.message);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Native host not connected' });
      }
      return true;
    }
  });
};
