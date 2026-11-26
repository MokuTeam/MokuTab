/**
 * The NetSuite module, bridge side: the session store client tools, and the
 * transparent mode the extension drives on its own (transparent.ts).
 *
 * Cookie values move only between this process and the extension through
 * typed messages (ns_cookies_read / ns_cookies_write / ns_tab_identity), never
 * as a tool the router could forward, and between this process and the store.
 */

import * as os from 'os';
import { NETSUITE_MODULE, NativeMessageType } from '@mokuhub/mokutab-shared';
import type { BridgeModule } from '../../mcp/module-api';
import { bitwardenVault } from '../../mcp/fn-vault';
import { profileRegistry } from '../../server/profile-registry';
import { ExpectedUsers } from './expected-users';
import { NsSessionTools, type NsCookie, type NsDeps, type TabIdentity } from './session-tools';
import { NsStoreClient } from './store-client';
import { NsTransparent } from './transparent';
import { serverVersion } from '../../mcp/server-identity';
import { moduleSwitch } from '../../mcp/module-switch';

const OWNED = new Set(NETSUITE_MODULE.tools.map((tool) => tool.name));

/**
 * A typed request to the profile's extension. Short timeouts: an extension
 * older than this bridge does not know these types, and must not hold a
 * call for long.
 */
async function ask(
  profile: string,
  type: string,
  payload: unknown,
  timeoutMs = 5_000,
): Promise<any> {
  const reply = await profileRegistry.sendRequest(profile, payload, type, timeoutMs);
  if (reply?.status !== 'success') throw new Error(reply?.error || `${type} failed`);
  return reply.data;
}

let toolsInstance: NsSessionTools | null = null;

/** The live tools; tests build their own NsSessionTools with fakes. */
function liveTools(): NsSessionTools {
  if (!toolsInstance) {
    const vault = bitwardenVault();
    const deps: NsDeps = {
      store: new NsStoreClient(undefined, {}, { version: serverVersion(), machine: os.hostname() }),
      users: new ExpectedUsers(),
      readCookies: async (profile, host) => {
        const data = await ask(profile, NativeMessageType.NS_COOKIES_READ, { host });
        return Array.isArray(data?.cookies) ? (data.cookies as NsCookie[]) : [];
      },
      writeCookies: async (profile, host, cookies) => {
        const data = await ask(profile, NativeMessageType.NS_COOKIES_WRITE, { host, cookies });
        return typeof data?.written === 'number' ? data.written : 0;
      },
      tabIdentity: async (profile, host) => {
        const data = await ask(profile, NativeMessageType.NS_TAB_IDENTITY, { host });
        return (data?.identity ?? null) as TabIdentity | null;
      },
      sessionState: async (profile, host) => {
        try {
          const data = await ask(profile, NativeMessageType.NS_SESSION_PROBE, { host }, 12_000);
          return data?.state === 'alive' || data?.state === 'dead' ? data.state : 'unknown';
        } catch {
          // An extension without the probe, or one that did not answer: not known.
          return 'unknown';
        }
      },
      vaultUris: (item) => vault.uris(item),
      vaultUsername: (item) => vault.get(item, 'username'),
      connectedProfiles: () => profileRegistry.getConnectedProfiles(),
      machine: os.hostname(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    };
    toolsInstance = new NsSessionTools(deps);
  }
  return toolsInstance;
}

let transparentInstance: NsTransparent | null = null;

function transparent(): NsTransparent {
  if (!transparentInstance) {
    transparentInstance = new NsTransparent(liveTools(), {
      isOn: () => moduleSwitch.isEnabled(NETSUITE_MODULE.id),
      now: () => Date.now(),
    });
  }
  return transparentInstance;
}

export const netsuiteModule: BridgeModule = {
  id: NETSUITE_MODULE.id,
  title: NETSUITE_MODULE.title,
  tools: NETSUITE_MODULE.tools,
  instructions: NETSUITE_MODULE.instructions,
  readOnlyTools: NETSUITE_MODULE.readOnlyTools,
  destructiveTools: NETSUITE_MODULE.destructiveTools,
  owns: (name) => OWNED.has(name),
  // Every tool runs here: the store is reached from this process only.
  handle(name, args, ctx) {
    if (!OWNED.has(name)) return undefined;
    return liveTools().call(name, args, ctx.profile);
  },
  // Transparent mode: the extension reports a host, the bridge acts.
  extensionRequests: {
    [NativeMessageType.NS_SESSION_CHANGED]: (payload, profile) =>
      transparent().onChanged(payload, profile),
    [NativeMessageType.NS_LOGIN_LANDING]: (payload, profile) =>
      transparent().onLanding(payload, profile),
    [NativeMessageType.NS_ACTIVITY]: (payload, profile) =>
      transparent().onActivity(payload, profile),
    [NativeMessageType.NS_SESSION_ENDING]: (payload, profile) =>
      transparent().onEnding(payload, profile),
  },
};
