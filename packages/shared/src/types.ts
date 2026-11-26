export enum NativeMessageType {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
  CALL_TOOL = 'call_tool',
  CALL_TOOL_RESPONSE = 'call_tool_response',
  // Additional message types used in Chrome extension
  SERVER_STARTED = 'server_started',
  SERVER_STOPPED = 'server_stopped',
  ERROR_FROM_NATIVE_HOST = 'error_from_native_host',
  CONNECT_NATIVE = 'connectNative',
  ENSURE_NATIVE = 'ensure_native',
  PING_NATIVE = 'ping_native',
  DISCONNECT_NATIVE = 'disconnect_native',
  // Bridge -> extension developer requests (chrome_reload_extension)
  DEV_EXTENSION_INFO = 'dev_extension_info',
  DEV_RELOAD_EXTENSION = 'dev_reload_extension',
  // Bridge -> extension: tabs for chrome_lease_tab / chrome_release_tab
  AGENT_TAB_OPEN = 'agent_tab_open',
  AGENT_TAB_CLOSE = 'agent_tab_close',
  // Bridge -> extension: browser function windows (chrome_fn_run). Tab API
  // only, so they work on pages CDP cannot attach to.
  AGENT_TAB_INFO = 'agent_tab_info',
  AGENT_TAB_NAVIGATE = 'agent_tab_navigate',
  // Bridge -> extension: run a chrome_watch_start script in its tabs (one tick)
  WATCH_PROBE = 'watch_probe',
  // Module switch, one per machine, kept in the bridge. Extension -> bridge
  // requests (the popup reads and writes it); bridge -> extension push of the
  // current state on connect and on every change.
  MODULES_GET = 'modules_get',
  MODULES_SET = 'modules_set',
  MODULES_STATE = 'modules_state',
  // Bridge -> extension, NetSuite module: session cookies of one account host
  // and the user of its open tab. Values only ever travel in these messages,
  // never in a tool result.
  NS_COOKIES_READ = 'ns_cookies_read',
  NS_COOKIES_WRITE = 'ns_cookies_write',
  NS_TAB_IDENTITY = 'ns_tab_identity',
}

/** One installed module and whether it is on, as the bridge reports it. */
export interface ModuleStateEntry {
  id: string;
  title: string;
  enabled: boolean;
}

/** Payload of MODULES_STATE and the answer to MODULES_GET / MODULES_SET. */
export interface ModulesStatePayload {
  modules: ModuleStateEntry[];
}

export interface NativeMessage<P = any, E = any> {
  type?: NativeMessageType;
  responseToRequestId?: string;
  payload?: P;
  error?: E;
}

// ============================================================
// Element Picker Types (chrome_request_element_selection)
// ============================================================

/**
 * A single element selection request from the AI.
 */
export interface ElementPickerRequest {
  /**
   * Optional stable request id. If omitted, the extension will generate one.
   */
  id?: string;
  /**
   * Short label shown to the user (e.g., "Login button").
   */
  name: string;
  /**
   * Optional longer instruction shown to the user.
   */
  description?: string;
}

/**
 * Bounding rectangle of a picked element.
 */
export interface PickedElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Center point of a picked element.
 */
export interface PickedElementPoint {
  x: number;
  y: number;
}

/**
 * A picked element that can be used with other tools (click, fill, etc.).
 */
export interface PickedElement {
  /**
   * Element ref written into window.__claudeElementMap (frame-local).
   * Can be used directly with chrome_click_element, chrome_fill_or_select, etc.
   */
  ref: string;
  /**
   * Best-effort stable CSS selector.
   */
  selector: string;
  /**
   * Selector type (currently CSS only).
   */
  selectorType: 'css';
  /**
   * Bounding rect in the element's frame viewport coordinates.
   */
  rect: PickedElementRect;
  /**
   * Center point in the element's frame viewport coordinates.
   * Can be used as coordinates for chrome_computer.
   */
  center: PickedElementPoint;
  /**
   * Optional text snippet to help verify the selection.
   */
  text?: string;
  /**
   * Lowercased tag name.
   */
  tagName?: string;
  /**
   * Chrome frameId for iframe targeting.
   * Pass this to chrome_click_element/chrome_fill_or_select for cross-frame support.
   */
  frameId: number;
}

/**
 * Result for a single element selection request.
 */
export interface ElementPickerResultItem {
  /**
   * The request id (matches the input request).
   */
  id: string;
  /**
   * The request name (for reference).
   */
  name: string;
  /**
   * The picked element, or null if not selected.
   */
  element: PickedElement | null;
  /**
   * Error message if selection failed for this request.
   */
  error?: string;
}

/**
 * Result of the chrome_request_element_selection tool.
 */
export interface ElementPickerResult {
  /**
   * True if the user confirmed all selections.
   */
  success: boolean;
  /**
   * Session identifier for this picker session.
   */
  sessionId: string;
  /**
   * Timeout value used for this session.
   */
  timeoutMs: number;
  /**
   * True if the user cancelled the selection.
   */
  cancelled?: boolean;
  /**
   * True if the selection timed out.
   */
  timedOut?: boolean;
  /**
   * List of request IDs that were not selected (for debugging).
   */
  missingRequestIds?: string[];
  /**
   * Results for each requested element.
   */
  results: ElementPickerResultItem[];
}
