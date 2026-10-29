/**
 * Core MCP tool names and schemas: the browser tools and the profile/bridge tools.
 *
 * Module tools live under ./modules; ./modules/index.ts assembles the full
 * TOOL_NAMES / TOOL_SCHEMAS catalogue from these and every installed module.
 *
 * Author: Roman Chikalenko
 * Version: 1.4.0
 */
import { type Tool } from '@modelcontextprotocol/sdk/types.js';

export const CORE_TOOL_NAMES = {
  BROWSER: {
    GET_WINDOWS_AND_TABS: 'get_windows_and_tabs',
    NAVIGATE: 'chrome_navigate',
    SCREENSHOT: 'chrome_screenshot',
    CLOSE_TABS: 'chrome_close_tabs',
    SWITCH_TAB: 'chrome_switch_tab',
    WEB_FETCHER: 'chrome_get_web_content',
    CLICK: 'chrome_click_element',
    FILL: 'chrome_fill_or_select',
    REQUEST_ELEMENT_SELECTION: 'chrome_request_element_selection',
    NETWORK_CAPTURE: 'chrome_network_capture',
    // Legacy tool names (kept for internal use, not exposed in TOOL_SCHEMAS)
    NETWORK_CAPTURE_START: 'chrome_network_capture_start',
    NETWORK_CAPTURE_STOP: 'chrome_network_capture_stop',
    NETWORK_REQUEST: 'chrome_network_request',
    NETWORK_DEBUGGER_START: 'chrome_network_debugger_start',
    NETWORK_DEBUGGER_STOP: 'chrome_network_debugger_stop',
    KEYBOARD: 'chrome_keyboard',
    HISTORY: 'chrome_history',
    BOOKMARK_SEARCH: 'chrome_bookmark_search',
    BOOKMARK_ADD: 'chrome_bookmark_add',
    BOOKMARK_DELETE: 'chrome_bookmark_delete',
    JAVASCRIPT: 'chrome_javascript',
    CONSOLE: 'chrome_console',
    FILE_UPLOAD: 'chrome_upload_file',
    READ_PAGE: 'chrome_read_page',
    COMPUTER: 'chrome_computer',
    HANDLE_DIALOG: 'chrome_handle_dialog',
    HANDLE_DOWNLOAD: 'chrome_handle_download',
    FETCH_TO_FILE: 'chrome_fetch_to_file',
    PERFORMANCE_START_TRACE: 'performance_start_trace',
    PERFORMANCE_STOP_TRACE: 'performance_stop_trace',
    PERFORMANCE_ANALYZE_INSIGHT: 'performance_analyze_insight',
    GIF_RECORDER: 'chrome_gif_recorder',
    SNAPSHOT: 'chrome_snapshot',
    LEASE_TAB: 'chrome_lease_tab',
    SNAPSHOT_FILL_FORM: 'chrome_snapshot_fill_form',
    ACT: 'chrome_act',
    SEARCH_PAGE: 'chrome_search_page',
    FIND_ELEMENTS: 'chrome_find_elements',
    RELEASE_TAB: 'chrome_release_tab',
    WATCH_START: 'chrome_watch_start',
    WATCH_STOP: 'chrome_watch_stop',
    WATCH_LIST: 'chrome_watch_list',
    WATCH_EVENTS: 'chrome_watch_events',
    FN_LIST: 'chrome_fn_list',
    FN_GET: 'chrome_fn_get',
    FN_RUN: 'chrome_fn_run',
    FN_SAVE: 'chrome_fn_save',
    FN_RUNS: 'chrome_fn_runs',
    SNAPSHOT_CLICK: 'chrome_snapshot_click',
    SNAPSHOT_FILL: 'chrome_snapshot_fill',
    SNAPSHOT_HOVER: 'chrome_snapshot_hover',
    SNAPSHOT_WAIT_FOR: 'chrome_snapshot_wait_for',
  },
  /**
   * Profile and bridge tools. Named workato_* until 2.0; the Workato module
   * keeps those old names as aliases until 3.0 (modules/workato/aliases.ts).
   */
  BRIDGE: {
    LIST_PROFILES: 'chrome_list_profiles',
    BRIDGE_INFO: 'chrome_bridge_info',
    RELOAD_EXTENSION: 'chrome_reload_extension',
    SWITCH_PROFILE: 'chrome_switch_profile',
  },
};

export const CORE_TOOL_SCHEMAS: Tool[] = [
  {
    name: CORE_TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
    description:
      'Get all currently open browser windows and tabs. Pass filter to return only tabs whose ' +
      'URL or title contains the substring (e.g. filter:"workato") — strongly preferred when ' +
      'looking for a specific app tab, so unrelated personal tabs never enter the context.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            'Case-insensitive substring matched against each tab URL and title. Windows with no matching tabs are dropped.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.PERFORMANCE_START_TRACE,
    description:
      'Starts a performance trace recording on the selected page. Optionally reloads the page and/or auto-stops after a short duration.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Target tab. Omit for the active tab of the last-focused window (refused while this session holds tab leases).',
        },
        reload: {
          type: 'boolean',
          description:
            'Determines if, once tracing has started, the page should be automatically reloaded (ignore cache).',
        },
        autoStop: {
          type: 'boolean',
          description: 'Determines if the trace should be automatically stopped (default false).',
        },
        durationMs: {
          type: 'number',
          description: 'Auto-stop duration in milliseconds when autoStop is true (default 5000).',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.PERFORMANCE_STOP_TRACE,
    description: 'Stops the active performance trace recording on the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab the trace was started on. Omit for the active tab.',
        },
        saveToDownloads: {
          type: 'boolean',
          description: 'Whether to save the trace as a JSON file in Downloads (default true).',
        },
        filenamePrefix: {
          type: 'string',
          description: 'Optional filename prefix for the downloaded trace JSON.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.PERFORMANCE_ANALYZE_INSIGHT,
    description:
      'Provides a lightweight summary of the last recorded trace. For deep insights (CWV, breakdowns), integrate native-side DevTools trace engine.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab whose last trace to summarise. Omit for the active tab.',
        },
        insightName: {
          type: 'string',
          description:
            'Optional insight name for future deep analysis (e.g., "DocumentLatency"). Currently informational only.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Timeout for deep analysis via native host (milliseconds). Default 60000. Increase for large traces.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.READ_PAGE,
    description:
      'Get an accessibility tree representation of visible elements on the page. Only returns elements that are visible in the viewport. Optionally filter for only interactive elements.\nTip: If the returned elements do not include the specific element you need, use the computer tool\'s screenshot (action="screenshot") to capture the element\'s on-screen coordinates, then operate by coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            'Filter elements: "interactive" for such as  buttons/links/inputs only (default: all visible elements)',
        },
        depth: {
          type: 'number',
          description:
            'Maximum DOM depth to traverse (integer >= 0). Lower values reduce output size and can improve performance.',
        },
        refId: {
          type: 'string',
          description:
            'Focus on the subtree rooted at this element refId (e.g., "ref_12"). The refId must come from a recent chrome_read_page response in the same tab (refs may expire).',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.COMPUTER,
    description:
      "Use a mouse and keyboard to interact with a web browser, and take screenshots.\n* Whenever you intend to click on an element like an icon, you should consult a read_page to determine the ref of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try screenshot and then adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
    inputSchema: {
      type: 'object',
      properties: {
        settle: {
          type: 'boolean',
          description:
            'After the action, wait for any navigation it started and for the DOM to go quiet, then report the page (url, title, navigated, open dialog, new tabs it opened). Default true.',
          default: true,
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Upper bound for that wait. Default 3000.',
        },
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
        background: {
          type: 'boolean',
          description:
            'Avoid focusing/activating tab/window for certain operations (best-effort). Default: false',
        },
        action: {
          type: 'string',
          description:
            'Action to perform: left_click | right_click | double_click | triple_click | left_click_drag | scroll | scroll_to | type | key | fill | fill_form | hover | wait | resize_page | zoom | screenshot',
        },
        ref: {
          type: 'string',
          description:
            'Element ref from chrome_read_page. For click/scroll/scroll_to/key/type and drag end when provided; takes precedence over coordinates.',
        },
        coordinates: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
          },
          description:
            'Coordinates for actions (in screenshot space if a recent screenshot was taken, otherwise viewport). Required for click/scroll and as end point for drag.',
        },
        startCoordinates: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          description: 'Starting coordinates for drag action',
        },
        startRef: {
          type: 'string',
          description: 'Drag start ref from chrome_read_page (alternative to startCoordinates).',
        },
        scrollDirection: {
          type: 'string',
          description: 'Scroll direction: up | down | left | right',
        },
        scrollAmount: {
          type: 'number',
          description: 'Scroll ticks (1-10), default 3',
        },
        text: {
          type: 'string',
          description:
            'Text to type (for action=type) or keys/chords separated by space (for action=key, e.g. "Backspace Enter" or "cmd+a")',
        },
        repeat: {
          type: 'number',
          description:
            'For action=key: number of times to repeat the key sequence (integer 1-100, default 1).',
        },
        modifiers: {
          type: 'object',
          description:
            'Modifier keys for click actions (left_click/right_click/double_click/triple_click).',
          properties: {
            altKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
            shiftKey: { type: 'boolean' },
          },
        },
        region: {
          type: 'object',
          description:
            'For action=zoom: rectangular region to capture (x0,y0)-(x1,y1) in viewport pixels (or screenshot-space if a recent screenshot context exists).',
          properties: {
            x0: { type: 'number' },
            y0: { type: 'number' },
            x1: { type: 'number' },
            y1: { type: 'number' },
          },
          required: ['x0', 'y0', 'x1', 'y1'],
        },
        // For action=fill
        selector: {
          type: 'string',
          description: 'CSS selector for fill (alternative to ref).',
        },
        value: {
          oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }],
          description: 'Value to set for action=fill (string | boolean | number)',
        },
        elements: {
          type: 'array',
          description: 'For action=fill_form: list of elements to fill (ref + value)',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Element ref from chrome_read_page' },
              value: { type: 'string', description: 'Value to set (stringified if non-string)' },
            },
            required: ['ref', 'value'],
          },
        },
        width: { type: 'number', description: 'For action=resize_page: viewport width' },
        height: { type: 'number', description: 'For action=resize_page: viewport height' },
        appear: {
          type: 'boolean',
          description:
            'For action=wait with text: whether to wait for the text to appear (true, default) or disappear (false)',
        },
        timeout: {
          type: 'number',
          description:
            'For action=wait with text: timeout in milliseconds (default 10000, max 120000)',
        },
        duration: {
          type: 'number',
          description: 'Seconds to wait for action=wait (max 30s)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.NAVIGATE,
    description:
      'Navigate to a URL, refresh the current tab, or navigate browser history (back/forward)',
    inputSchema: {
      type: 'object',
      properties: {
        settle: {
          type: 'boolean',
          description:
            'Wait for the navigation to load and for the DOM to go quiet, then report the page (url, title, navigated, open dialog, new tabs it opened). Default true. When the server has not answered by the end of the wait (a slow page, a PDF being generated), pending_url names where the tab is going and url/title are still the previous page: do not navigate again.',
          default: true,
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Upper bound for that wait. Default 15000.',
        },
        url: {
          type: 'string',
          description:
            'URL to navigate to. Special values: "back" or "forward" to navigate browser history in the target tab.',
        },
        newWindow: {
          type: 'boolean',
          description: 'Create a new window to navigate to the URL or not. Defaults to false',
        },
        tabId: {
          type: 'number',
          description:
            'Target an existing tab by ID (if provided, navigate/refresh/back/forward that tab instead of the active tab).',
        },
        windowId: {
          type: 'number',
          description:
            'Target an existing window by ID (when creating a new tab in existing window, or picking active tab if tabId is not provided).',
        },
        background: {
          type: 'boolean',
          description:
            'Perform the operation without stealing focus (do not activate the tab or focus the window). Default: false',
        },
        width: {
          type: 'number',
          description:
            'Window width in pixels (default: 1280). When width or height is provided, a new window will be created.',
        },
        height: {
          type: 'number',
          description:
            'Window height in pixels (default: 720). When width or height is provided, a new window will be created.',
        },
        refresh: {
          type: 'boolean',
          description:
            'Refresh the current active tab instead of navigating to a URL. When true, the url parameter is ignored. Defaults to false',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.SCREENSHOT,
    description:
      '[Prefer read_page over taking a screenshot and Prefer chrome_computer] Take a screenshot of the current page or a specific element. For new usage, use chrome_computer with action="screenshot". Use this tool if you need advanced options. ' +
      'storeBase64:true returns the capture as an MCP image block; the accompanying text block holds metadata only (tabId, url, name, width, height, mimeType, bytes, fileSaved, fullPath), never the base64 payload. ' +
      'storeBase64 and savePng are independent flags: setting both returns the image and writes a PNG to the Downloads folder. ' +
      'out_file writes the image bytes to an absolute path of your choosing and returns a saved_to summary; add no_inline:true to keep the image out of the response. ' +
      'A hidden tab of the agents window (a leased tab that is not the visible one) is moved to an unfocused window of its own when the capture needs a visible tab (fullPage, selector, or a failed CDP viewport capture); the metadata then carries moved_to_window. A hidden tab outside the agents window is never moved.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the screenshot, if saving as PNG' },
        selector: { type: 'string', description: 'CSS selector for element to screenshot' },
        tabId: {
          type: 'number',
          description: 'Target tab ID to capture from (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab from when tabId is not provided.',
        },
        background: {
          type: 'boolean',
          description:
            'Attempt capture without bringing tab/window to foreground. CDP-based capture is used for simple viewport captures. For element/full-page capture, the tab may still be made active in its window without focusing the window. Default: false',
        },
        width: { type: 'number', description: 'Width in pixels (default: 800)' },
        height: { type: 'number', description: 'Height in pixels (default: 600)' },
        storeBase64: {
          type: 'boolean',
          description:
            'Return the capture as an MCP image block (default: false). Set this when you want to look at the page; the metadata width/height then describe that image.',
        },
        fullPage: {
          type: 'boolean',
          description:
            'Capture the whole scrollable page instead of the viewport (default: false). Independent of storeBase64 and savePng.',
        },
        savePng: {
          type: 'boolean',
          description:
            'Save the capture as a PNG in the Chrome Downloads folder (default: true). Independent of storeBase64; set false when you only want the image block.',
        },
        out_file: {
          type: 'string',
          description:
            'Absolute path to write the captured image to (its directory must exist). Requires storeBase64:true; the response keeps the image block unless no_inline is set.',
        },
        no_inline: {
          type: 'boolean',
          description:
            'With out_file, return only the file summary and leave the image block out of the response (default: false).',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.SNAPSHOT_FILL_FORM,
    description:
      'Fill several fields of a form in one call: each {uid, value} is applied like chrome_snapshot_fill (text, <select>/combobox by option text, checkbox/radio/switch by "true"/"false") and read back. Stops at the first field that fails and reports which. Prefer it over repeated fill calls.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: { uid: { type: 'number' }, value: { type: 'string' } },
            required: ['uid', 'value'],
          },
          description: 'Fields to fill, in order.',
        },
        tabId: { type: 'number', description: 'Target tab ID.' },
        settle: {
          type: 'boolean',
          description: 'Wait for the page to settle after the last field. Default true.',
          default: true,
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Upper bound for that wait. Default 3000.',
        },
        includeSnapshot: {
          type: 'boolean',
          description: 'Also return a fresh chrome_snapshot. Default false.',
          default: false,
        },
      },
      required: ['fields'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.ACT,
    description:
      'Run several uid actions on one tab in one call to save round trips: click, double_click, fill, hover, press_key, wait_for. Stops at the first action that fails, and after any action that navigates, opens a tab or raises a dialog (the rest would target a page that changed). Returns one result per action run plus the final page report.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['click', 'double_click', 'fill', 'hover', 'press_key', 'wait_for'],
              },
              uid: {
                type: 'number',
                description: 'Element uid (click, double_click, fill, hover).',
              },
              value: { type: 'string', description: 'Value for fill.' },
              key: {
                type: 'string',
                description: 'Key or combo for press_key, e.g. "Enter", "Control+A".',
              },
              text: { type: 'string', description: 'Text to wait for (wait_for).' },
              timeoutMs: { type: 'number', description: 'Timeout for wait_for. Default 5000.' },
            },
            required: ['action'],
          },
          description: 'Actions in order.',
        },
        tabId: { type: 'number', description: 'Target tab ID.' },
        includeSnapshot: {
          type: 'boolean',
          description: 'Return a fresh chrome_snapshot at the end. Default false.',
          default: false,
        },
      },
      required: ['actions'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.SEARCH_PAGE,
    description:
      'Find text on the page without dumping it: returns each match with surrounding context, like grep. Cheaper than chrome_get_web_content for "is X on this page, and where". Read only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to find (or a regular expression with regex:true).',
        },
        regex: {
          type: 'boolean',
          description: 'Treat query as a JavaScript regular expression. Default false.',
          default: false,
        },
        caseSensitive: { type: 'boolean', description: 'Default false.', default: false },
        contextChars: {
          type: 'number',
          description: 'Characters of context on each side. Default 80.',
        },
        cssScope: {
          type: 'string',
          description: 'Only search inside elements matching this CSS selector.',
        },
        maxResults: { type: 'number', description: 'Default 20.' },
        tabId: { type: 'number', description: 'Target tab ID.' },
      },
      required: ['query'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.FIND_ELEMENTS,
    description:
      'Query the page with a CSS selector and get chosen attributes and text of the matches, capped. For "list all rows/links/ids of X" without writing chrome_javascript. Read only.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector.' },
        attributes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Attributes to return. Default: id, name, class, href, value, type, role, aria-label.',
        },
        includeText: {
          type: 'boolean',
          description: 'Include each match text (trimmed, capped). Default true.',
          default: true,
        },
        maxResults: { type: 'number', description: 'Default 30.' },
        tabId: { type: 'number', description: 'Target tab ID.' },
      },
      required: ['selector'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.LEASE_TAB,
    description:
      'Get a tab of your own for parallel work: several agents sharing one MCP server and one Chrome profile must each lease a tab and pass the returned `lease` on every browser call, instead of relying on the active tab. Opens the tab in a separate, unfocused agents window. Screenshots that need a visible tab move a hidden agents-window tab to a window of its own by themselves; own_window:true (that window up front) is still the choice for chrome_computer mouse/keyboard input, which a hidden tab drops. The bridge turns `lease` into the right profile and tabId, never activates or focuses the tab, and while this MCP session holds any lease it REFUSES tab-targeting calls that carry neither `lease` nor tabId. Calls on the same tab run one at a time. Leases end with chrome_release_tab, when the tab is closed, when this MCP session ends (the tab closes; an adopted tab stays open), or after 30 minutes unused (a call that names the tab by tabId counts as use). Returns {lease, tabId, windowId, profile}.',
    inputSchema: {
      type: 'object',
      properties: {
        adopt_tab_id: {
          type: 'number',
          description:
            'Lease an EXISTING tab instead of opening one, e.g. a tab an action opened (reported in new_tabs). url and own_window are ignored.',
        },
        url: { type: 'string', description: 'Page to open in the new tab. Default about:blank.' },
        own_window: {
          type: 'boolean',
          description:
            'Open the tab in its own unfocused window so it is visible from the start (chrome_computer input, screenshots). Default false: a shared agents window; a screenshot that needs a visible tab moves it out then.',
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.RELEASE_TAB,
    description:
      'End a lease from chrome_lease_tab and close its tab (keep_tab:true leaves the tab open). Call it when the agent is done.',
    inputSchema: {
      type: 'object',
      properties: {
        lease: { type: 'string', description: 'Lease id from chrome_lease_tab.' },
        keep_tab: {
          type: 'boolean',
          description: 'Leave the tab open. Default false.',
          default: false,
        },
      },
      required: ['lease'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.WATCH_START,
    description:
      'Watch tabs in the background without spending tokens: the bridge runs `script` in each target tab every `every_seconds` and records an event when its result changes, so an agent can sleep until something happens (new mail, a chat message, a job finishing) instead of polling with snapshots. The script is the body of an async function (return and await work) that returns a JSON value; return null while the page is not ready. An array result wakes only on items not seen before (identified by `key`, else the whole item), so return e.g. the visible rows as {id, from, subject} and each new row is one event; any other value wakes when it differs from the last reading. The first reading of each tab is the baseline. Runs once right away and reports that reading, so a broken script is caught now. Returns {watch_id, cursor, wait_command}: run wait_command in the background (Bash run_in_background) and the process exits with the events when something changes; then handle them and run the re-arm command it prints. Watches survive bridge restarts and expire after ttl_minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description:
            'Body of an async function run in the page (full DOM access; do not rely on page JS globals): e.g. return [...document.querySelectorAll("tr.zE")].map(r => ({id: r.id, text: r.innerText.slice(0, 200)})). Keep results small: they are what the agent reads.',
        },
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Tabs to watch, in the routed profile. Each stays tied to the site it showed at its first reading (a tab that moves to another site is not read). Tab ids change when Chrome restarts, so prefer url for long watches.',
        },
        url: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Chrome match patterns, e.g. ["https://mail.google.com/*"]: every matching tab of the profile is watched, looked up again on each tick (survives reloads and browser restarts). Give tabIds, url, or both.',
        },
        name: { type: 'string', description: 'Short label shown in events.' },
        every_seconds: {
          type: 'number',
          description: 'Interval between readings. Default 30, minimum 10.',
        },
        key: {
          type: 'string',
          description:
            'For array results of objects: the field that identifies an item (e.g. "id"). Default: the whole item.',
        },
        ttl_minutes: {
          type: 'number',
          description: 'Stop watching after this long. Default 720 (12 h), maximum 10080 (7 days).',
        },
      },
      required: ['script'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.WATCH_STOP,
    description: 'Stop a watch from chrome_watch_start (or all of them with all:true).',
    inputSchema: {
      type: 'object',
      properties: {
        watch_id: { type: 'string', description: 'Watch to stop.' },
        all: { type: 'boolean', description: 'Stop every watch. Default false.', default: false },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.WATCH_LIST,
    description:
      'List active watches with their status: last reading per tab (short preview), errors, events so far, expiry, and the current event cursor.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.WATCH_EVENTS,
    description:
      'Read watch events after `cursor` (all watches, or watch_ids), optionally waiting up to wait_seconds for the first one. Returns {events, cursor}; pass the returned cursor next time. For long waits use the wait_command from chrome_watch_start in the background instead of holding this call.',
    inputSchema: {
      type: 'object',
      properties: {
        watch_ids: { type: 'array', items: { type: 'string' }, description: 'Default: all.' },
        cursor: {
          type: 'number',
          description: 'Return events after this one. Default: the oldest kept.',
        },
        wait_seconds: {
          type: 'number',
          description: 'Wait this long for an event when there is none yet. Default 0, max 100.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.FN_LIST,
    description:
      'List saved browser functions: named, versioned flows (open a page, wait, run JS, check, commit) that replace rebuilding the same chrome_javascript sequence every session. Check here before scripting a flow by hand. Shows name, kind (read | write | send), version, description and draft (true until a run committed successfully). Functions that never ran successfully at all are hidden unless include_drafts:true.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words that must all appear in name, description or tags.',
        },
        tag: { type: 'string', description: 'Only functions with this tag.' },
        include_drafts: {
          type: 'boolean',
          description: 'Also list functions that never ran successfully.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.FN_GET,
    description:
      'Read a browser function definition (current, or version N), with history:true its versions and changelogs. out_file writes it as YAML to edit and save back with chrome_fn_save(source_path). Definition: {name, description, tags, kind, params (JSON Schema), target {url template, profile, host}, helpers, steps [{id, type: navigate | wait_for | js | verify | tool | pause | finish | fail, when, commit, ...}], preview, result, dedupe_key, verify_hint}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function name, e.g. "netsuite.case.read_messages".' },
        version: { type: 'number', description: 'An older version. Default: current.' },
        history: { type: 'boolean', description: 'Include the version history.' },
        out_file: {
          type: 'string',
          description: 'Absolute path: write the definition there as YAML.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.FN_RUN,
    description:
      'Run a saved browser function in a background window of its own (it never touches other tabs; the window closes when the run ends). Returns {status, result | preview | needs | error, trace}. status: ok; preview (write/send without confirm: stopped before its first commit step, nothing changed, window kept 10 min: show the preview to your user, then call again with run_id and confirm:true to commit exactly that); paused (pass the named params with run_id); failed (nothing committed); unknown (a commit step failed or timed out: it MAY have landed; check with verify_hint before anything else, never just rerun). A write may also run in one call with confirm:true; a send always needs the preview first. A failure names the step: fix the definition with chrome_fn_save.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function to run. Not needed with run_id.' },
        params: {
          type: 'object',
          description: 'Values for the function params (see chrome_fn_get).',
        },
        confirm: {
          type: 'boolean',
          description:
            'Commit: with run_id after a preview, or a write in one call. Only after your user approved.',
        },
        run_id: {
          type: 'string',
          description: 'Continue a preview (with confirm) or a pause (with params).',
        },
        cancel: {
          type: 'boolean',
          description: 'With run_id: drop the pending run and close its window.',
        },
        allow_duplicate: {
          type: 'boolean',
          description: 'Commit even though the same dedupe key was committed in the last 24 h.',
        },
        keep_open: {
          type: 'boolean',
          description:
            'Leave the window open when the run ends (to inspect a failure); returns its tabId.',
        },
        caller: { type: 'string', description: 'Your session name, for the run log.' },
        out_file: {
          type: 'string',
          description: 'Absolute path for a large result (written unredacted).',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.FN_SAVE,
    description:
      'Create a browser function, save a new version, or roll back (from_version: N saves version N again as the newest). Pass base_version = the version you read (omit for a new name); a save on top of a newer version is refused. Each save is a git commit in the private registry with changelog as its message. The definition is validated first (step ids, templates, JS syntax, no embedded credentials); all problems come back at once. Save a fix after a real failure with a changelog that says what broke. Helpers ("_helpers.<word>", {name, description, code}) are saved the same way.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Function name (dotted, lower case) or "_helpers.<word>".',
        },
        definition: { type: 'object', description: 'The definition (see chrome_fn_get).' },
        source_path: {
          type: 'string',
          description: 'Absolute path of a YAML or JSON definition to save.',
        },
        from_version: {
          type: 'number',
          description: 'Roll back: save this old version as the newest.',
        },
        base_version: { type: 'number', description: 'The current version this save builds on.' },
        changelog: { type: 'string', description: 'What changed and why (required).' },
        caller: { type: 'string', description: 'Your session name, recorded in the commit.' },
      },
      required: ['name', 'changelog'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.FN_RUNS,
    description:
      'The browser function run log, newest first: time, function and version, phase, status, committed, caller, failed step, duration. Param values are never logged (only a hash).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Only runs of this function.' },
        limit: { type: 'number', description: 'Default 20, max 200.' },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.CLOSE_TABS,
    description:
      'Close browser tabs by tabIds or by exact url. Pass one of them: a call with neither is refused (it used to close the active tab, which under parallel agents is another agent tab). For a leased tab use chrome_release_tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Tab IDs to close.',
        },
        url: {
          type: 'string',
          description: 'Close tabs matching this URL. Can be used instead of tabIds.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.SWITCH_TAB,
    description: 'Switch to a specific browser tab',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to switch to.',
        },
        windowId: {
          type: 'number',
          description: 'The ID of the window where the tab is located.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.WEB_FETCHER,
    description: 'Fetch content from a web page',
    inputSchema: {
      type: 'object',
      properties: {
        startChar: {
          type: 'number',
          description:
            'Return text starting at this character (for reading a long page in chunks). Default 0.',
        },
        maxChars: {
          type: 'number',
          description:
            'Return at most this many characters; the reply carries next_start_char when there is more.',
        },
        url: {
          type: 'string',
          description: 'URL to fetch content from. If not provided, uses the current active tab',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        background: {
          type: 'boolean',
          description: 'Do not activate tab/focus window while fetching (default: false)',
        },
        htmlContent: {
          type: 'boolean',
          description:
            'Get the visible HTML content of the page. If true, textContent will be ignored (default: false)',
        },
        textContent: {
          type: 'boolean',
          description:
            'Get the visible text content of the page with metadata. Ignored if htmlContent is true (default: true)',
        },

        selector: {
          type: 'string',
          description:
            'CSS selector to get content from a specific element. If provided, only content from this element will be returned',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.NETWORK_REQUEST,
    description: 'Send a network request from the browser with cookies and other browser context',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Tab whose page context and cookies send the request. Omit for the active tab.',
        },
        url: {
          type: 'string',
          description: 'URL to send the request to',
        },
        method: {
          type: 'string',
          description: 'HTTP method to use (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Headers to include in the request',
        },
        body: {
          type: 'string',
          description: 'Body of the request (for POST, PUT, etc.)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
        formData: {
          type: 'object',
          description:
            'Multipart/form-data descriptor. If provided, overrides body and builds FormData with optional file attachments. Shape: { fields?: Record<string,string|number|boolean>, files?: Array<{ name: string, fileUrl?: string, filePath?: string, base64Data?: string, filename?: string, contentType?: string }> }. Also supports a compact array form: [ [name, fileSpec, filename?], ... ] where fileSpec may be url:, file:, or base64:.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.NETWORK_CAPTURE,
    description:
      'Unified network capture tool. Use action="start" to begin capturing, action="stop" to end and retrieve results. Set needResponseBody=true to capture response bodies (uses Debugger API, may conflict with DevTools). Default mode uses webRequest API (lightweight, no debugger conflict, but no response body).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Tab to capture (start) or to stop and read (stop). Omit to use url or the active tab; stop then only ends the capture of that tab.',
        },
        action: {
          type: 'string',
          enum: ['start', 'stop'],
          description: 'Action to perform: "start" begins capture, "stop" ends and returns results',
        },
        needResponseBody: {
          type: 'boolean',
          description:
            'When true, captures response body using Debugger API (default: false). Only use when you need to inspect response content.',
        },
        url: {
          type: 'string',
          description:
            'URL to capture network requests from. For action="start". If not provided, uses the current active tab.',
        },
        maxCaptureTime: {
          type: 'number',
          description: 'Maximum capture time in milliseconds (default: 180000)',
        },
        inactivityTimeout: {
          type: 'number',
          description: 'Stop after inactivity in milliseconds (default: 60000). Set 0 to disable.',
        },
        includeStatic: {
          type: 'boolean',
          description: 'Include static resources like images/scripts/styles (default: false)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD,
    description:
      'Wait for a browser download and return details (id, filename, url, state, size). Only downloads that start after the call, or are already in progress, count. An interrupted download fails at once with its reason. A timeout says which case it was: no matching download ever started (script-started downloads are often held or dropped by the "multiple automatic downloads" site permission, with no event), or one started and did not finish (state, bytes received, error). To save the body of a URL, chrome_fetch_to_file is the reliable route.',
    inputSchema: {
      type: 'object',
      properties: {
        filenameContains: { type: 'string', description: 'Filter by substring in filename or URL' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 60000, max 300000)' },
        waitForComplete: { type: 'boolean', description: 'Wait until completed (default true)' },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.FETCH_TO_FILE,
    description:
      'Fetch a URL in the tab and write the response body straight to a local file. The request runs in the page (main world) with the session cookies, so it works for anything the logged-in page could fetch: PDF print URLs, CSV/XLSX exports, template or script sources. The bytes go to disk only, never into the reply and never through the output redaction, so binary files and text with query strings or tokens arrive intact. Use it instead of Blob + anchor.click() downloads, which Chrome blocks after the first. Returns {saved_to, bytes, sha256, status, ok, content_type, filename (from Content-Disposition), final_url (after redirects), magic (the first bytes when printable, e.g. "%PDF-1.7")}. A non-2xx response is still written (it is diagnostic) and reported as an error with its status; check content_type and magic too, because a login or error page often comes back as HTML with status 200. A cross-origin URL needs CORS with credentials, and the page CSP applies. Pages that take no scripts (chrome://, the built-in PDF viewer) cannot fetch: navigate the tab to an HTML page of the same site first.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to fetch. A relative URL resolves against the page.',
        },
        out_file: {
          type: 'string',
          description:
            'Absolute path to write the body to; its directory must exist. An existing file is replaced.',
        },
        tabId: {
          type: 'number',
          description: 'Tab whose page and session make the request. Omit for the active tab.',
        },
        method: { type: 'string', description: 'HTTP method (default GET).' },
        headers: { type: 'object', description: 'Request headers.' },
        body: { type: 'string', description: 'Request body, for POST and the like.' },
        timeoutMs: {
          type: 'number',
          description: 'Request timeout in ms (default 60000, max 110000).',
        },
        max_bytes: {
          type: 'number',
          description:
            'Refuse a body larger than this, writing nothing (default 26214400 = 25 MB, max 41943040 = 40 MB).',
        },
      },
      required: ['url', 'out_file'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.HISTORY,
    description: 'Retrieve and search browsing history from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Text to search for in history URLs and titles. Leave empty to retrieve all history entries within the time range.',
        },
        startTime: {
          type: 'string',
          description:
            'Start time as a date string. Supports ISO format (e.g., "2023-10-01", "2023-10-01T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: 24 hours ago',
        },
        endTime: {
          type: 'string',
          description:
            'End time as a date string. Supports ISO format (e.g., "2023-10-31", "2023-10-31T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: current time',
        },
        maxResults: {
          type: 'number',
          description:
            'Maximum number of history entries to return. Use this to limit results for performance or to focus on the most relevant entries. (default: 100)',
        },
        excludeCurrentTabs: {
          type: 'boolean',
          description:
            "When set to true, filters out URLs that are currently open in any browser tab. Useful for finding pages you've visited but don't have open anymore. (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.BOOKMARK_SEARCH,
    description: 'Search Chrome bookmarks by title and URL',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query to match against bookmark titles and URLs. Leave empty to retrieve all bookmarks.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of bookmarks to return (default: 50)',
        },
        folderPath: {
          type: 'string',
          description:
            'Optional folder path or ID to limit search to a specific bookmark folder. Can be a path string (e.g., "Work/Projects") or a folder ID.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.BOOKMARK_ADD,
    description: 'Add a new bookmark to Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to bookmark. If not provided, uses the current active tab URL.',
        },
        title: {
          type: 'string',
          description: 'Title for the bookmark. If not provided, uses the page title from the URL.',
        },
        parentId: {
          type: 'string',
          description:
            'Parent folder path or ID to add the bookmark to. Can be a path string (e.g., "Work/Projects") or a folder ID. If not provided, adds to the "Bookmarks Bar" folder.',
        },
        createFolder: {
          type: 'boolean',
          description: 'Whether to create the parent folder if it does not exist (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
    description: 'Delete a bookmark from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        bookmarkId: {
          type: 'string',
          description: 'ID of the bookmark to delete. Either bookmarkId or url must be provided.',
        },
        url: {
          type: 'string',
          description: 'URL of the bookmark to delete. Used if bookmarkId is not provided.',
        },
        title: {
          type: 'string',
          description: 'Title of the bookmark to help with matching when deleting by URL.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.JAVASCRIPT,
    description:
      'Execute JavaScript code in a browser tab and return the result. Uses CDP Runtime.evaluate with awaitPromise and returnByValue; automatically falls back to chrome.scripting.executeScript if the debugger is busy. Inline output is sanitized (sensitive data redacted) and truncated by default; an explicit out_file gets the returned value itself, unredacted. ' +
      'For work that outlasts one call (a page busy 40+ s), start it with async_job:true, which returns {job_id, state:"running"} at once, then poll with job_id (+ wait_ms): state is running, busy (the page main thread is blocked, poll again), done (result as usual), error, or lost (the page navigated or reloaded, outcome unknown). A finished job can be read once more within 60 s, then it is dropped. Jobs need CDP (no fallback).',
    inputSchema: {
      type: 'object',
      properties: {
        async_job: {
          type: 'boolean',
          description:
            'Start the code in the page and return a job_id immediately instead of waiting for it (default false). The code starts after the call returns, so synchronous page work cannot block the reply. Poll with job_id. Not combinable with uids.',
        },
        job_id: {
          type: 'string',
          description:
            'Poll a job started with async_job, on the same tab. Pass it instead of code.',
        },
        wait_ms: {
          type: 'number',
          description:
            'With job_id: how long to wait for the job to finish before answering (default 0, one look; max 100000).',
        },
        out_file: {
          type: 'string',
          description:
            'Absolute path (its directory must exist) to write the returned value itself to: a string verbatim, anything else as indented JSON, unredacted, up to 32 MB. The response becomes a summary {saved_to, bytes, sha256, raw, tabId, engine, metrics}. Works on a job_id poll too (written once the job is done).',
        },
        uids: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Elements from chrome_snapshot of this tab, handed to your code as the array `elements` (elements[0] is uids[0]), so you never rebuild a selector for an element you already have. With uids the code runs in the frame of elements[0] (when the first uid is inside an iframe, document is the document of that iframe).',
        },
        code: {
          type: 'string',
          description:
            'JavaScript code to execute. Runs inside an async function body, so top-level await and "return ..." are supported. Required unless job_id is given.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Execution timeout in milliseconds (default: 60000, ceiling ~110000 before the bridge ' +
            'call itself times out). A timeout abandons the wait but does NOT cancel the script — ' +
            'page-side fetches still complete, so retrying non-idempotent code can execute it twice.',
        },
        maxOutputBytes: {
          type: 'number',
          description:
            'Maximum output size in bytes after sanitization (default: 51200). Output exceeding this limit will be truncated.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.CLICK,
    description:
      'Click on an element in a web page. Supports multiple targeting methods: CSS selector, XPath, element ref (from chrome_read_page), or viewport coordinates. More focused than chrome_computer for simple click operations.',
    inputSchema: {
      type: 'object',
      properties: {
        settle: {
          type: 'boolean',
          description:
            'After the action, wait for any navigation it started and for the DOM to go quiet, then report the page (url, title, navigated, open dialog, new tabs it opened). Default true.',
          default: true,
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Upper bound for that wait. Default 3000.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for the element to click.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Type of selector (default: "css").',
        },
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page (takes precedence over selector).',
        },
        coordinates: {
          type: 'object',
          description: 'Viewport coordinates to click at.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
        double: {
          type: 'boolean',
          description: 'Perform double click when true (default: false).',
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button to click (default: "left").',
        },
        modifiers: {
          type: 'object',
          description: 'Modifier keys to hold during click.',
          properties: {
            altKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
            shiftKey: { type: 'boolean' },
          },
        },
        waitForNavigation: {
          type: 'boolean',
          description: 'Wait for navigation to complete after click (default: false).',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds for waiting (default: 5000).',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
        frameId: {
          type: 'number',
          description: 'Target frame ID for iframe support.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.FILL,
    description:
      'Fill or select a form element on a web page. Supports input, textarea, select, checkbox, and radio elements. Use CSS selector, XPath, or element ref to target the element.',
    inputSchema: {
      type: 'object',
      properties: {
        settle: {
          type: 'boolean',
          description:
            'After the action, wait for any navigation it started and for the DOM to go quiet, then report the page (url, title, navigated, open dialog, new tabs it opened). Default true.',
          default: true,
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Upper bound for that wait. Default 3000.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for the form element.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Type of selector (default: "css").',
        },
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page (takes precedence over selector).',
        },
        value: {
          type: ['string', 'number', 'boolean'],
          description:
            'Value to fill. For text inputs: string. For checkboxes/radios: boolean. For selects: option value or text.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
        frameId: {
          type: 'number',
          description: 'Target frame ID for iframe support.',
        },
      },
      required: ['value'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.REQUEST_ELEMENT_SELECTION,
    description:
      'Request the user to manually select one or more elements on the current page. Use this as a human-in-the-loop fallback when you cannot reliably locate the target element after approximately 3 attempts using chrome_read_page combined with chrome_click_element/chrome_fill_or_select/chrome_computer. The user will see a panel with instructions and can click on the requested elements. Returns element refs compatible with chrome_click_element/chrome_fill_or_select (including iframe frameId for cross-frame support).',
    inputSchema: {
      type: 'object',
      properties: {
        requests: {
          type: 'array',
          description:
            'A list of element selection requests. Each request produces exactly one picked element. The user will see these requests in a panel and select each element by clicking on the page.',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description:
                  'Optional stable request id for correlation. If omitted, an id is auto-generated (e.g., "req_1").',
              },
              name: {
                type: 'string',
                description:
                  'Short label shown to the user describing what element to select (e.g., "Login button", "Email input field").',
              },
              description: {
                type: 'string',
                description:
                  'Optional longer instruction shown to the user with more context (e.g., "Click on the primary login button in the top-right corner").',
              },
            },
            required: ['name'],
          },
        },
        timeoutMs: {
          type: 'number',
          description:
            'Timeout in milliseconds for the user to complete all selections. Default: 180000 (3 minutes). Maximum: 600000 (10 minutes).',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
      },
      required: ['requests'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.KEYBOARD,
    description:
      'Simulate keyboard input on a web page. Supports single keys (Enter, Tab, Escape), key combinations (Ctrl+C, Ctrl+V), and text input. Can target a specific element or send to the focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        settle: {
          type: 'boolean',
          description:
            'After the action, wait for any navigation it started and for the DOM to go quiet, then report the page (url, title, navigated, open dialog, new tabs it opened). Default true.',
          default: true,
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Upper bound for that wait. Default 3000.',
        },
        keys: {
          type: 'string',
          description:
            'Keys or key combinations to simulate. Examples: "Enter", "Tab", "Ctrl+C", "Shift+Tab", "Hello World".',
        },
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for target element to receive keyboard events.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Type of selector (default: "css").',
        },
        delay: {
          type: 'number',
          description: 'Delay between keystrokes in milliseconds (default: 50).',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
        frameId: {
          type: 'number',
          description: 'Target frame ID for iframe support.',
        },
      },
      required: ['keys'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.CONSOLE,
    description:
      'Capture console output from a browser tab. Supports snapshot mode (default; one-time capture with ~2s wait) and buffer mode (persistent per-tab buffer you can read/clear instantly without waiting).',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to and capture console from. If not provided, uses the current active tab',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        background: {
          type: 'boolean',
          description: 'Do not activate tab/focus window when capturing via CDP. Default: false',
        },
        includeExceptions: {
          type: 'boolean',
          description: 'Include uncaught exceptions in the output (default: true)',
        },
        maxMessages: {
          type: 'number',
          description:
            'Maximum number of console messages to capture in snapshot mode (default: 100). If limit is provided, it takes precedence.',
        },
        mode: {
          type: 'string',
          enum: ['snapshot', 'buffer'],
          description:
            'Console capture mode: snapshot (default; waits ~2s for messages) or buffer (persistent per-tab buffer; reads from memory instantly).',
        },
        buffer: {
          type: 'boolean',
          description: 'Alias for mode="buffer" (default: false).',
        },
        clear: {
          type: 'boolean',
          description:
            'Buffer mode only: clear the buffered logs for this tab before reading (default: false). Use clearAfterRead instead to clear after reading (mcp-tools.js style).',
        },
        clearAfterRead: {
          type: 'boolean',
          description:
            'Buffer mode only: clear the buffered logs for this tab AFTER reading, to avoid duplicate messages on subsequent calls (default: false). This matches mcp-tools.js behavior.',
        },
        pattern: {
          type: 'string',
          description:
            'Optional regex filter applied to message/exception text. Supports /pattern/flags syntax.',
        },
        onlyErrors: {
          type: 'boolean',
          description:
            'Only return error-level console messages (and exceptions when includeExceptions=true). Default: false.',
        },
        limit: {
          type: 'number',
          description:
            'Limit returned console messages. In snapshot mode this is an alias for maxMessages; in buffer mode it limits returned messages from the buffer.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.FILE_UPLOAD,
    description:
      'Upload files to web forms with file input elements using Chrome DevTools Protocol. Target the input by selector (top document only) or by uid from chrome_snapshot, which also reaches inputs inside same-process iframes (an embedded uploader page). Inputs inside out-of-process (cross-site) iframes are not reachable either way.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector for the file input element (input[type="file"]) in the top document. Pass this or uid.',
        },
        uid: {
          type: 'number',
          description:
            'uid of the file input from chrome_snapshot of this tab; use it for an input inside an iframe. Pass this or selector.',
        },
        filePath: {
          type: 'string',
          description: 'Local file path to upload',
        },
        fileUrl: {
          type: 'string',
          description: 'URL to download file from before uploading',
        },
        base64Data: {
          type: 'string',
          description: 'Base64 encoded file data to upload',
        },
        fileName: {
          type: 'string',
          description: 'Optional filename when using base64 or URL (default: "uploaded-file")',
        },
        multiple: {
          type: 'boolean',
          description: 'Whether the input accepts multiple files (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.HANDLE_DIALOG,
    description: 'Handle JavaScript dialogs (alert/confirm/prompt) via CDP',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab showing the dialog. Omit for the active tab.',
        },
        action: { type: 'string', description: 'accept | dismiss' },
        promptText: {
          type: 'string',
          description: 'Optional prompt text when accepting a prompt',
        },
      },
      required: ['action'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.GIF_RECORDER,
    description:
      'Record browser tab activity as an animated GIF.\n\nModes:\n- Fixed FPS mode (action="start"): Captures frames at regular intervals. Good for animations/videos.\n- Auto-capture mode (action="auto_start"): Captures frames automatically when chrome_computer or chrome_navigate actions succeed. Better for interaction recordings with natural pacing.\n\nUse "stop" to end recording and save the GIF.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status', 'auto_start', 'capture', 'clear', 'export'],
          description:
            'Action to perform:\n- "start": Begin fixed-FPS recording (captures frames at regular intervals)\n- "auto_start": Begin auto-capture mode (frames captured on tool actions)\n- "stop": End recording and save GIF\n- "status": Get current recording state\n- "capture": Manually trigger a frame capture in auto mode\n- "clear": Clear all recording state and cached GIF without saving\n- "export": Export the last recorded GIF (download or drag&drop upload)',
        },
        tabId: {
          type: 'number',
          description:
            'Target tab ID (default: active tab). Used with "start"/"auto_start" for recording, and with "export" (download=false) for drag&drop upload target.',
        },
        fps: {
          type: 'number',
          description:
            'Frames per second for fixed-FPS mode (1-30, default: 5). Higher values = smoother but larger file.',
        },
        durationMs: {
          type: 'number',
          description:
            'Maximum recording duration in milliseconds (default: 5000, max: 60000). Only for fixed-FPS mode.',
        },
        maxFrames: {
          type: 'number',
          description:
            'Maximum number of frames to capture (default: 50 for fixed-FPS, 100 for auto mode, max: 300).',
        },
        width: {
          type: 'number',
          description: 'Output GIF width in pixels (default: 800, max: 1920).',
        },
        height: {
          type: 'number',
          description: 'Output GIF height in pixels (default: 600, max: 1080).',
        },
        maxColors: {
          type: 'number',
          description:
            'Maximum colors in palette (default: 256). Lower values = smaller file size.',
        },
        filename: {
          type: 'string',
          description: 'Output filename (without extension). Defaults to timestamped name.',
        },
        captureDelayMs: {
          type: 'number',
          description:
            'Auto-capture mode only: Delay in ms after action before capturing frame (default: 150). Allows UI to stabilize.',
        },
        frameDelayCs: {
          type: 'number',
          description:
            'Auto-capture mode only: Display duration per frame in centiseconds (default: 20 = 200ms per frame).',
        },
        annotation: {
          type: 'string',
          description:
            'Auto-capture mode only (action="capture"): Optional text label to render on the captured frame.',
        },
        download: {
          type: 'boolean',
          description:
            'Export action only: Set to true (default) to download the GIF, or false to upload via drag&drop.',
        },
        coordinates: {
          type: 'object',
          description:
            'Export action only (when download=false): Target coordinates for drag&drop upload.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
        ref: {
          type: 'string',
          description:
            'Export action only (when download=false): Element ref from chrome_read_page for drag&drop target.',
        },
        selector: {
          type: 'string',
          description:
            'Export action only (when download=false): CSS selector for drag&drop target element.',
        },
        enhancedRendering: {
          type: 'object',
          description:
            'Auto-capture mode only: Configure visual overlays for recorded actions (click indicators, drag paths, labels). Pass `true` to enable all defaults.',
          properties: {
            clickIndicators: {
              oneOf: [
                { type: 'boolean' },
                {
                  type: 'object',
                  properties: {
                    enabled: {
                      type: 'boolean',
                      description: 'Enable click indicators (default: true)',
                    },
                    color: {
                      type: 'string',
                      description:
                        'CSS color for click indicator (default: "rgba(255, 87, 34, 0.8)")',
                    },
                    radius: { type: 'number', description: 'Initial radius in px (default: 20)' },
                    animationDurationMs: {
                      type: 'number',
                      description: 'Animation duration in ms (default: 400)',
                    },
                    animationFrames: {
                      type: 'number',
                      description: 'Number of animation frames (default: 3)',
                    },
                    animationIntervalMs: {
                      type: 'number',
                      description: 'Interval between animation frames in ms (default: 80)',
                    },
                  },
                },
              ],
              description:
                'Click indicator overlay config (true for defaults, or object for custom).',
            },
            dragPaths: {
              oneOf: [
                { type: 'boolean' },
                {
                  type: 'object',
                  properties: {
                    enabled: {
                      type: 'boolean',
                      description: 'Enable drag path rendering (default: true)',
                    },
                    color: {
                      type: 'string',
                      description: 'CSS color for drag path (default: "rgba(33, 150, 243, 0.7)")',
                    },
                    lineWidth: { type: 'number', description: 'Line width in px (default: 3)' },
                    lineDash: {
                      type: 'array',
                      items: { type: 'number' },
                      description: 'Dash pattern (default: [6, 4])',
                    },
                    arrowSize: {
                      type: 'number',
                      description: 'Arrow head size in px (default: 10)',
                    },
                  },
                },
              ],
              description: 'Drag path overlay config (true for defaults, or object for custom).',
            },
            labels: {
              oneOf: [
                { type: 'boolean' },
                {
                  type: 'object',
                  properties: {
                    enabled: {
                      type: 'boolean',
                      description: 'Enable action labels (default: true)',
                    },
                    font: {
                      type: 'string',
                      description: 'Font for labels (default: "bold 12px sans-serif")',
                    },
                    textColor: { type: 'string', description: 'Text color (default: "#fff")' },
                    bgColor: {
                      type: 'string',
                      description: 'Background color (default: "rgba(0,0,0,0.7)")',
                    },
                    padding: { type: 'number', description: 'Padding in px (default: 4)' },
                    borderRadius: {
                      type: 'number',
                      description: 'Border radius in px (default: 4)',
                    },
                    offset: {
                      type: 'object',
                      properties: { x: { type: 'number' }, y: { type: 'number' } },
                      description: 'Offset from action position (default: {x: 10, y: -20})',
                    },
                  },
                },
              ],
              description: 'Action label overlay config (true for defaults, or object for custom).',
            },
            durationMs: {
              type: 'number',
              description: 'How long overlays remain visible in ms (default: 1500).',
            },
          },
        },
      },
      required: ['action'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.SNAPSHOT,
    description:
      'Accessibility-tree snapshot of a tab: every element worth acting on gets a [uid=N] marker, with its state (value, checked, expanded, selected, disabled, required, url) and iframes included. ' +
      'A uid stays valid for as long as that element exists, across snapshots; a uid whose element is gone (or from before a navigation) is refused instead of guessed. ' +
      'Call it before chrome_snapshot_click/_fill/_hover/_fill_form, chrome_act and chrome_javascript(uids).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.SNAPSHOT_CLICK,
    description:
      'Click an element by uid from chrome_snapshot with real mouse events: scrolls it into view and checks it is visible and not covered (the error names what covers it). ' +
      'A <select> is not clicked: its options come back so you can pick one with chrome_snapshot_fill; a file input points you to chrome_upload_file. ' +
      'Waits for what the click caused (navigation, quiet DOM) and reports it unless settle:false. Refused while a JS dialog is open.',
    inputSchema: {
      type: 'object',
      properties: {
        double: {
          type: 'boolean',
          description: 'Double-click instead of a single click. Default false.',
          default: false,
        },
        settle: {
          type: 'boolean',
          description:
            'After the action, wait for any navigation it started and for the DOM to go quiet, then report the page (url, title, navigated, open dialog, new tabs it opened). Default true.',
          default: true,
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Upper bound for that wait. Default 3000.',
        },
        includeSnapshot: {
          type: 'boolean',
          description:
            'Also return a fresh chrome_snapshot of the tab after the action. Default false.',
          default: false,
        },
        uid: {
          type: 'number',
          description: 'Element UID from the latest chrome_snapshot of this tab.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
      },
      required: ['uid'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.SNAPSHOT_FILL,
    description:
      'Set the value of an element by uid from chrome_snapshot. Text inputs and editors: clear, type, fire input/change events, then read the value back and report a mismatch. ' +
      '<select> and comboboxes: the option is matched by visible text or value. Checkbox, radio and switch: pass "true" or "false". ' +
      'For several fields use chrome_snapshot_fill_form. Refused while a JS dialog is open.',
    inputSchema: {
      type: 'object',
      properties: {
        settle: {
          type: 'boolean',
          description:
            'After the action, wait for any navigation it started and for the DOM to go quiet, then report the page (url, title, navigated, open dialog, new tabs it opened). Default true.',
          default: true,
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Upper bound for that wait. Default 3000.',
        },
        includeSnapshot: {
          type: 'boolean',
          description:
            'Also return a fresh chrome_snapshot of the tab after the action. Default false.',
          default: false,
        },
        uid: {
          type: 'number',
          description: 'Element UID from the latest chrome_snapshot of this tab.',
        },
        value: {
          type: 'string',
          description: 'Text to insert into the focused element after clearing it.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
      },
      required: ['uid', 'value'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.SNAPSHOT_HOVER,
    description:
      'Hover the mouse over an element identified by a UID from the latest chrome_snapshot of this tab. ' +
      'Useful for surfacing hover-triggered menus/tooltips before a subsequent click. Call chrome_snapshot first.',
    inputSchema: {
      type: 'object',
      properties: {
        settle: {
          type: 'boolean',
          description:
            'After the action, wait for any navigation it started and for the DOM to go quiet, then report the page (url, title, navigated, open dialog, new tabs it opened). Default true.',
          default: true,
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Upper bound for that wait. Default 3000.',
        },
        includeSnapshot: {
          type: 'boolean',
          description:
            'Also return a fresh chrome_snapshot of the tab after the action. Default false.',
          default: false,
        },
        uid: {
          type: 'number',
          description: 'Element UID from the latest chrome_snapshot of this tab.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
      },
      required: ['uid'],
    },
  },
  {
    name: CORE_TOOL_NAMES.BROWSER.SNAPSHOT_WAIT_FOR,
    description:
      'Poll the accessibility tree until an element matching the given role and/or text appears (or timeout). ' +
      'On success, returns a fresh chrome_snapshot of the tab so you immediately have new UIDs to act on. ' +
      'Provide at least one of `role` or `text`.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description:
            'Substring (case-insensitive) to match against accessible names, or an array: resolves when any one appears.',
        },
        role: {
          type: 'string',
          description: 'Exact ARIA role to match (case-insensitive), e.g. "button", "link".',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum time to wait in milliseconds (default 10000, max 120000).',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BRIDGE.LIST_PROFILES,
    description:
      'List all currently active/connected Chrome profiles (e.g. "prod", "staging", "dev") ' +
      'and see which one is selected for this MCP session, if any. Also returns session_context: ' +
      'the profile, tab, host, workspace and environment this session is pinned to (null when ' +
      'nothing is pinned, in which case calls follow the bridge default profile).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BRIDGE.RELOAD_EXTENSION,
    description:
      'Developer tool: make Chrome run a freshly built extension (and bridge) without anyone ' +
      'clicking reload in chrome://extensions. Call it after `pnpm build` instead of asking ' +
      'the user. Every connected profile loads the same unpacked dist/, so by default all of ' +
      'them reload, one at a time: each is asked for its build stamp, reloaded, and awaited ' +
      'until it reconnects, and the result shows built_at before and after. The profile whose ' +
      'native host serves the bridge (owns_bridge) always goes last, and its reload also ' +
      'restarts the bridge process, which picks up a rebuilt native-server: that profile is ' +
      'reported as "scheduled" because this call returns before the restart. The bridge is ' +
      'then down for 5-10s (a call in that window fails with ECONNREFUSED): wait about 10s, ' +
      'then confirm with check_only:true (every profile stale:false). The MCP session ' +
      'reconnects by itself. check_only:true reloads nothing and reports each ' +
      "profile's running build against the dist/ on disk (stale:true means a reload is due). " +
      'The default profile for unpinned calls is kept across the reload. A profile that does ' +
      'not answer the build-info request runs a build older than this tool and needs one ' +
      'manual reload. Changes no Workato data.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description:
            'Reload only this connected profile. Omit to reload every connected profile.',
        },
        check_only: {
          type: 'boolean',
          description:
            "Report each profile's running build and whether the dist/ on disk is newer, reload nothing.",
          default: false,
        },
        timeout_ms: {
          type: 'number',
          description:
            'How long to wait for each profile to reconnect after its reload. Default 20000, 3000-60000.',
        },
      },
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BRIDGE.BRIDGE_INFO,
    description:
      'What build is actually answering these calls. Runs entirely in the local bridge: no ' +
      'browser tab, no Workato request, safe to call when everything else is failing. ' +
      'Returns bridge_version and shared_version (the two published packages), tool_count and ' +
      'schema_revision (a stable sha256 prefix of the served tool catalogue, so two sessions ' +
      'can be compared without diffing schemas), connected_profiles, session_context, ' +
      'node_version and platform. ' +
      'CALL THIS FIRST when a tool is missing, a parameter is rejected as unknown, or a ' +
      'response does not match its documented shape: those are deployment drift, and the ' +
      'usual cause is a bridge or an unpacked extension that was not reloaded after an ' +
      'upgrade. A schema_revision that differs from the one a working session reported, or a ' +
      'bridge_version behind the released one, names the problem instead of guessing at it. ' +
      'versions_read reports where each version came from, so an "unknown" is visible as a ' +
      'failed read rather than a missing package. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: CORE_TOOL_NAMES.BRIDGE.SWITCH_PROFILE,
    description:
      'Switch the active profile context for this MCP session. All subsequent tool calls in ' +
      'this session will automatically route to the selected browser profile unless an individual ' +
      'call passes its own profile argument. Optionally pins subsequent Workato tools to a ' +
      'specific Workato tab id so browser focus changes do not retarget the session. ' +
      'With a tabId the bridge also pins that tab workspace/environment and returns it: later ' +
      'writes are refused when the tab moved to another workspace, and a pinned session never ' +
      'falls back to another profile or transport.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description:
            'The name of the connected profile to switch context to (e.g. "prod", "staging", "dev").',
        },
        tabId: {
          type: 'number',
          description:
            'Optional Workato tab id to pin for this MCP session. Get it from get_windows_and_tabs.',
        },
      },
      required: ['profile'],
    },
  },
];
