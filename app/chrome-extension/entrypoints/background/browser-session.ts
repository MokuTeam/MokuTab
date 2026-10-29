/**
 * An id for the Chrome session this profile runs in, sent to the bridge on
 * connect.
 *
 * Tab ids start over when Chrome restarts. The bridge saves the leases it
 * hands out and, after its own restart, closes their tabs, but only while this
 * id is the one the lease was taken under, so a stale tab id never closes one
 * of the user's tabs.
 *
 * storage.session survives a service-worker restart but not a Chrome restart,
 * and also not an extension reload or update. A reload keeps every tab id, so
 * it keeps the id too: Chrome fires onInstalled(update) for it, and the id
 * comes back from storage.local. A start of Chrome fires onStartup. Anything
 * unclear gets a new id, which only means saved leases are dropped instead of
 * closed.
 */

const SESSION_KEY = 'browserSessionId';
/** How long to wait for onStartup / onInstalled when storage.session is empty. */
const LIFECYCLE_WAIT_MS = 1000;

let startupSeen = false;
let updateSeen = false;
let decided: Promise<string> | null = null;

/** Must run in the service worker's first turn, before Chrome dispatches the events. */
export function watchBrowserLifecycle(): void {
  chrome.runtime.onStartup.addListener(() => {
    startupSeen = true;
  });
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'update') updateSeen = true;
  });
}

function newId(): string {
  return crypto.randomUUID();
}

async function readString(area: chrome.storage.StorageArea): Promise<string | null> {
  try {
    const stored = await area.get(SESSION_KEY);
    const value = stored[SESSION_KEY];
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

async function decide(wait: (ms: number) => Promise<void>): Promise<string> {
  const current = await readString(chrome.storage.session);
  if (current) return current;
  await wait(LIFECYCLE_WAIT_MS);
  const kept = updateSeen && !startupSeen ? await readString(chrome.storage.local) : null;
  const id = kept ?? newId();
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: id });
    await chrome.storage.local.set({ [SESSION_KEY]: id });
  } catch {
    // Memory alone is enough until the service worker restarts.
  }
  return id;
}

/** This Chrome session's id; decided once per service-worker lifetime. */
export function browserSessionId(
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string> {
  decided ??= decide(wait);
  return decided;
}

/** Forget the decision and the events seen (tests). */
export function resetBrowserSessionForTests(): void {
  startupSeen = false;
  updateSeen = false;
  decided = null;
}
