/**
 * The tabs agents hold a lease on in this profile, as the bridge last said.
 *
 * Every tool call from the bridge carries the list (absent means none), so a
 * restarted service worker learns it with the first call. A call that names a
 * tab is the bridge's to allow or refuse; this list is for the calls that name
 * none and let a tool pick. Today one picker reads it: findWorkatoTab, so "the
 * first Workato tab" is never a tab some agent leased. The core tools that
 * fall back to the active tab do not.
 */
let leased = new Set<number>();

export function setLeasedTabs(tabIds: unknown): void {
  leased = new Set(
    Array.isArray(tabIds) ? tabIds.filter((id): id is number => typeof id === 'number') : [],
  );
}

export function isLeasedTab(tabId: number | undefined): boolean {
  return typeof tabId === 'number' && leased.has(tabId);
}
