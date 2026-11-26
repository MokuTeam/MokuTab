/**
 * NetSuite module tool names: the session store client (see the bridge module).
 */
export const NETSUITE_TOOL_NAMES = {
  NETSUITE_SESSION: {
    STATUS: 'netsuite_session_status',
    ENSURE: 'netsuite_session_ensure',
    PUBLISH: 'netsuite_session_publish',
    LOCK: 'netsuite_session_lock',
    UNLOCK: 'netsuite_session_unlock',
  },
} as const;

/** Tools that change nothing (served with readOnlyHint). */
export const NETSUITE_READ_ONLY_TOOL_NAMES: readonly string[] = ['netsuite_session_status'];

/** Tools whose whole job is to remove something. */
export const NETSUITE_DESTRUCTIVE_TOOL_NAMES: readonly string[] = [];

/** The tools a browser function's tool step may call (they run in the bridge, not in the page). */
export const NETSUITE_FN_TOOL_NAMES: readonly string[] = [
  'netsuite_session_ensure',
  'netsuite_session_publish',
  'netsuite_session_lock',
  'netsuite_session_unlock',
];
