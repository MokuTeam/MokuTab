/**
 * The order of calls on one tab. Parallel agents each work in their own tab;
 * two calls on the SAME tab (a navigate during a snapshot, two input
 * sequences) would interleave at every await, so a call that drives the page
 * takes the tab alone. A call that only fetches from the page shares it:
 * several of those run at once, and they still wait for a driving call ahead
 * of them, as it waits for them. Different tabs, and calls that name no tab,
 * stay parallel.
 */
interface TabLane {
  /** Settles when the last exclusive call let go. Shared calls start after it. */
  exclusive: Promise<unknown>;
  /** Settles when every call so far let go. Exclusive calls start after it. */
  all: Promise<unknown>;
}

const tabLanes = new Map<number, TabLane>();

/**
 * Longest a call may hold its tab before the next queued call starts anyway.
 * A call stuck on a page that never answers must not make the tab unusable
 * for every later call (the bridge gives up at 120 s, the extension task may
 * never settle). The stuck call keeps running and still answers its own caller.
 * Set past the bridge 120 s give-up so a legitimate long call (a slow
 * chrome_javascript, a long chrome_act) keeps its tab to the end.
 */
export const TAB_QUEUE_MAX_HOLD_MS = 125_000;

function laneOf(tabId: number): TabLane {
  return tabLanes.get(tabId) ?? { exclusive: Promise.resolve(), all: Promise.resolve() };
}

/**
 * Start `task` once `after` settles. `released` settles when the task does,
 * or once it has held the tab for `maxHoldMs`; it never rejects, so a failed
 * call cannot poison the calls queued behind it.
 */
function startAfter<T>(
  tabId: number,
  after: Promise<unknown>,
  task: () => Promise<T>,
  maxHoldMs: number,
): { run: Promise<T>; released: Promise<unknown> } {
  const ready = after.catch(() => undefined);
  const run = ready.then(task);
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const heldTooLong = new Promise<void>((resolve) => {
    // Armed when the task actually starts, so waiting in line does not count.
    ready.then(() => {
      holdTimer = setTimeout(() => {
        console.warn(
          `[tab-queue] a call held tab ${tabId} for over ${maxHoldMs} ms; letting the next call run`,
        );
        resolve();
      }, maxHoldMs);
    });
  });
  const released = Promise.race([run.catch(() => undefined), heldTooLong]).finally(() => {
    if (holdTimer) clearTimeout(holdTimer);
  });
  return { run, released };
}

function keepLane(tabId: number, lane: TabLane): void {
  tabLanes.set(tabId, lane);
  lane.all.then(() => {
    if (tabLanes.get(tabId) === lane) tabLanes.delete(tabId);
  });
}

/** Run `task` alone on the tab: after every call queued so far, ahead of every later one. */
export function runExclusiveForTab<T>(
  tabId: number,
  task: () => Promise<T>,
  maxHoldMs: number = TAB_QUEUE_MAX_HOLD_MS,
): Promise<T> {
  const { run, released } = startAfter(tabId, laneOf(tabId).all, task, maxHoldMs);
  keepLane(tabId, { exclusive: released, all: released });
  return run;
}

/**
 * Run `task` beside the other shared calls on the tab: it waits only for the
 * exclusive calls queued ahead of it, and a later exclusive call waits for it.
 */
export function runSharedForTab<T>(
  tabId: number,
  task: () => Promise<T>,
  maxHoldMs: number = TAB_QUEUE_MAX_HOLD_MS,
): Promise<T> {
  const lane = laneOf(tabId);
  const { run, released } = startAfter(tabId, lane.exclusive, task, maxHoldMs);
  keepLane(tabId, { exclusive: lane.exclusive, all: Promise.all([lane.all, released]) });
  return run;
}

/** Tabs with calls queued or running (for tests and diagnostics). */
export function busyTabs(): number[] {
  return Array.from(tabLanes.keys());
}
