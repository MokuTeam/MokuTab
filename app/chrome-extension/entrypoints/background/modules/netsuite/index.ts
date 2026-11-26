/**
 * The NetSuite module, extension side: no tools of its own (the
 * netsuite_session_* tools run in the bridge), only the typed bridge requests
 * that read and write one account host's session cookies, and the transparent
 * mode watcher (transparent.ts) that reports hosts to the bridge.
 */

import {
  NETSUITE_MODULE_ID,
  NETSUITE_MODULE_TITLE,
  NativeMessageType,
} from '@mokuhub/mokutab-shared';
import type { ExtensionModule } from '../../extension-module';
import { nsTabIdentity, probeNsSession, readNsCookies, writeNsCookies } from './cookies';
import { startNsTransparent } from './transparent';
import { startNsPopup } from './popup-requests';

const DESCRIPTION_KEY = 'moduleDescription_netsuite';
const DESCRIPTION = 'NetSuite sessions shared between machines through the session store.';

function description(): string {
  try {
    return chrome.i18n?.getMessage?.(DESCRIPTION_KEY) || DESCRIPTION;
  } catch {
    return DESCRIPTION;
  }
}

export const netsuiteExtensionModule: ExtensionModule = {
  id: NETSUITE_MODULE_ID,
  title: NETSUITE_MODULE_TITLE,
  description: description(),
  executors: [],
  bridgeRequests: {
    [NativeMessageType.NS_COOKIES_READ]: readNsCookies,
    [NativeMessageType.NS_COOKIES_WRITE]: writeNsCookies,
    [NativeMessageType.NS_TAB_IDENTITY]: nsTabIdentity,
    [NativeMessageType.NS_SESSION_PROBE]: probeNsSession,
  },
  // Transparent mode and the popup's sessions section: the listeners exist
  // always and act only while the module is on.
  start: () => {
    startNsTransparent();
    startNsPopup();
  },
};
