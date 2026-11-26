/**
 * The installed modules, extension side.
 *
 * The one place core reaches modules: tools/index.ts and native-host.ts take
 * this list and use each entry only through the ExtensionModule interface
 * (../extension-module.ts).
 */

import type { ExtensionModule } from '../extension-module';
import { workatoExtensionModule } from './workato';
import { netsuiteExtensionModule } from './netsuite';

export const EXTENSION_MODULES: readonly ExtensionModule[] = [
  workatoExtensionModule,
  netsuiteExtensionModule,
];
