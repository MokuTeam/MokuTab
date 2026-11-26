/**
 * Typed bridge requests a module answers (ExtensionModule.bridgeRequests):
 * which module owns a message type, and the answer the bridge gets. Kept out
 * of native-host.ts so the gate can be tested on its own.
 */

import type { ExtensionModule } from './extension-module';

export interface ModuleBridgeRequest {
  module: ExtensionModule;
  handler: (payload: any) => Promise<unknown>;
}

/** The module that answers `type` (own keys only: no prototype names like "toString"). */
export function findModuleBridgeRequest(
  modules: readonly ExtensionModule[],
  type: unknown,
): ModuleBridgeRequest | null {
  if (typeof type !== 'string') return null;
  for (const module of modules) {
    const requests = module.bridgeRequests;
    if (requests && Object.hasOwn(requests, type)) return { module, handler: requests[type] };
  }
  return null;
}

/** Run the handler only while the bridge has said the module is on. */
export async function answerModuleBridgeRequest(
  found: ModuleBridgeRequest,
  payload: unknown,
  explicitlyOn: (id: string) => Promise<boolean>,
): Promise<{ status: 'success'; data: unknown } | { status: 'error'; error: string }> {
  try {
    if (!(await explicitlyOn(found.module.id))) {
      throw new Error(`the ${found.module.title} module is switched off`);
    }
    return { status: 'success', data: await found.handler(payload ?? {}) };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}
