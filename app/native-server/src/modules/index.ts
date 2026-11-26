/**
 * The installed modules, bridge side.
 *
 * The one place core reaches modules: the router and the MCP server take this
 * list and talk to each entry only through the BridgeModule interface
 * (src/mcp/module-api.ts). Adding a module is a folder next to workato/ and
 * one line here (plus its shared descriptor and its extension side).
 */

import type { BridgeModule } from '../mcp/module-api';
import { workatoModule } from './workato';
import { netsuiteModule } from './netsuite';

export const INSTALLED_MODULES: readonly BridgeModule[] = [workatoModule, netsuiteModule];
