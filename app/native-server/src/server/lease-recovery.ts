/**
 * Tabs a previous bridge leased and never released.
 *
 * Leases live in MCP sessions, and sessions do not outlive the bridge: after a
 * restart every saved lease is an orphan nobody can pass or release. When the
 * profile it was opened in connects, its tab is closed, but only while the
 * profile reports the Chrome session the lease was taken in: tab ids start
 * over when Chrome restarts, and a stale id could name one of the user's own
 * tabs. An adopted tab may be the user's own too, so its lease is just
 * forgotten. Every orphan of the profile is dropped either way.
 */

import { NativeMessageType } from '@mokuhub/mokutab-shared';
import { leaseRegistry, type LeaseRegistry, type SavedLease } from '../mcp/tab-leases';
import { profileRegistry, type ProfileRegistry } from './profile-registry';

const CLOSE_TIMEOUT_MS = 15_000;

export interface LeaseRecoveryDeps {
  registry?: ProfileRegistry;
  leases?: LeaseRegistry;
  log?: (message: string) => void;
}

/** Whether the bridge may close this orphan's tab in a profile now in `browserSession`. */
export function mayCloseOrphan(orphan: SavedLease, browserSession: string | null): boolean {
  return (
    !orphan.adopted && orphan.browser_session !== null && orphan.browser_session === browserSession
  );
}

/** Close the orphans' tabs as their profiles connect. Returns an undo for tests. */
export function installLeaseRecovery(deps: LeaseRecoveryDeps = {}): () => void {
  const registry = deps.registry ?? profileRegistry;
  const leases = deps.leases ?? leaseRegistry;
  const log = deps.log ?? ((message: string) => console.error(message));

  return registry.onRegister((profile) => {
    const orphans = leases.takeOrphans(profile);
    if (orphans.length === 0) return;
    const browserSession = registry.getBrowserSession(profile);
    for (const orphan of orphans) {
      if (!mayCloseOrphan(orphan, browserSession)) continue;
      void registry
        .sendRequest(
          profile,
          { tabId: orphan.tabId },
          NativeMessageType.AGENT_TAB_CLOSE,
          CLOSE_TIMEOUT_MS,
        )
        .then((reply: any) => {
          if (reply?.status !== 'success') {
            log(
              `[lease-recovery] Tab ${orphan.tabId} of lease ${orphan.lease} in "${profile}" ` +
                `was not closed: ${reply?.error || 'the extension refused'}`,
            );
          }
        })
        .catch((err: any) => {
          log(
            `[lease-recovery] Tab ${orphan.tabId} of lease ${orphan.lease} in "${profile}" ` +
              `was not closed: ${err?.message || String(err)}`,
          );
        });
    }
  });
}
