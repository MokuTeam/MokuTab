/**
 * The module switch over the extension connection.
 *
 * The popup of any connected Chrome profile reads and writes the one switch
 * per machine (popup -> background message -> WebSocket request -> here), and
 * every connected profile gets the state pushed on connect and on each change,
 * so its background can refuse a switched-off module's tools and its content
 * scripts can stay idle.
 */

import {
  NativeMessageType,
  type ModuleStateEntry,
  type ModulesStatePayload,
} from '@mokuhub/mokutab-shared';
import { INSTALLED_MODULES } from '../modules';
import type { BridgeModule } from '../mcp/module-api';
import { moduleSwitch, type ModuleSwitch } from '../mcp/module-switch';
import { profileRegistry, type ProfileRegistry } from './profile-registry';

export function modulesState(
  modules: readonly Pick<BridgeModule, 'id' | 'title'>[],
  switches: Pick<ModuleSwitch, 'snapshot'>,
): ModulesStatePayload {
  const states = switches.snapshot(modules.map((module) => module.id));
  return {
    modules: modules.map(
      (module): ModuleStateEntry => ({
        id: module.id,
        title: module.title,
        enabled: states[module.id],
      }),
    ),
  };
}

export interface ModuleSyncDeps {
  registry?: ProfileRegistry;
  switches?: ModuleSwitch;
  modules?: readonly Pick<BridgeModule, 'id' | 'title' | 'extensionRequests'>[];
}

/** Wire the switch to the extension connection. Returns an undo for tests. */
export function installModuleSync(deps: ModuleSyncDeps = {}): () => void {
  const registry = deps.registry ?? profileRegistry;
  const switches = deps.switches ?? moduleSwitch;
  const modules = deps.modules ?? INSTALLED_MODULES;
  const state = () => modulesState(modules, switches);

  registry.setRequestHandler(NativeMessageType.MODULES_GET, () => state());
  registry.setRequestHandler(NativeMessageType.MODULES_SET, (payload: any) => {
    const id = payload?.id;
    const enabled = payload?.enabled;
    if (typeof id !== 'string' || !modules.some((module) => module.id === id)) {
      throw new Error(
        `unknown module "${String(id)}"; installed: ${modules.map((m) => m.id).join(', ')}`,
      );
    }
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
    switches.set(id, enabled);
    return state();
  });
  // Requests a module takes from the extension on its own (NetSuite transparent
  // mode), refused while that module is off.
  for (const module of modules) {
    for (const [type, handler] of Object.entries(module.extensionRequests ?? {})) {
      registry.setRequestHandler(type, (payload: any, profile: string) => {
        if (!switches.isEnabled(module.id)) throw new Error(`the ${module.title} module is off`);
        return handler(payload, profile);
      });
    }
  }
  const offRegister = registry.onRegister((profile) => {
    registry.notify(profile, NativeMessageType.MODULES_STATE, state());
  });
  const offChange = switches.onChange(() => {
    registry.broadcast(NativeMessageType.MODULES_STATE, state());
  });
  return () => {
    offRegister();
    offChange();
  };
}
