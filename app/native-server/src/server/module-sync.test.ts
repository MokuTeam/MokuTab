import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeMessageType } from '@mokuhub/mokutab-shared';
import { ModuleSwitch } from '../mcp/module-switch';
import { installModuleSync } from './module-sync';
import { ProfileRegistry } from './profile-registry';

/** A fake WebSocket: records what the bridge sends, lets the test send to it. */
class FakeSocket extends EventEmitter {
  sent: any[] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.emit('close');
  }
  fromExtension(message: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }
}

const MODULES = [{ id: 'workato', title: 'Workato' }];

let dir: string;
let registry: ProfileRegistry;
let switches: ModuleSwitch;
let undo: () => void;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-sync-'));
  // A machine upgraded from 1.x: Workato on.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ modules: { workato: true } }));
  registry = new ProfileRegistry();
  switches = new ModuleSwitch(
    () => path.join(dir, 'config.json'),
    () => {},
  );
  undo = installModuleSync({ registry, switches, modules: MODULES });
});

afterEach(() => {
  undo();
  fs.rmSync(dir, { recursive: true, force: true });
});

const stateMessages = (socket: FakeSocket) =>
  socket.sent.filter((message) => message.type === NativeMessageType.MODULES_STATE);

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('the module switch over the extension connection', () => {
  test('a profile that connects is pushed the current state', () => {
    const socket = new FakeSocket();
    registry.register('personal', socket);
    expect(stateMessages(socket)).toEqual([
      {
        type: NativeMessageType.MODULES_STATE,
        payload: { modules: [{ id: 'workato', title: 'Workato', enabled: true }] },
      },
    ]);
  });

  test('modules_get answers with the state', async () => {
    const socket = new FakeSocket();
    registry.register('personal', socket);
    socket.fromExtension({ type: NativeMessageType.MODULES_GET, requestId: 'r1' });
    await flush();
    expect(socket.sent.find((message) => message.responseToRequestId === 'r1')).toEqual({
      responseToRequestId: 'r1',
      payload: {
        status: 'success',
        data: { modules: [{ id: 'workato', title: 'Workato', enabled: true }] },
      },
    });
  });

  test('modules_set from one profile persists and reaches every profile', async () => {
    const personal = new FakeSocket();
    const centium = new FakeSocket();
    registry.register('personal', personal);
    registry.register('centium', centium);

    personal.fromExtension({
      type: NativeMessageType.MODULES_SET,
      requestId: 'r2',
      payload: { id: 'workato', enabled: false },
    });
    await flush();

    const reply = personal.sent.find((message) => message.responseToRequestId === 'r2');
    expect(reply.payload.status).toBe('success');
    expect(reply.payload.data.modules[0].enabled).toBe(false);
    expect(switches.isEnabled('workato')).toBe(false);
    for (const socket of [personal, centium]) {
      const pushed = stateMessages(socket);
      expect(pushed[pushed.length - 1].payload.modules[0].enabled).toBe(false);
    }
  });

  test('an unknown module or a non-boolean value is refused, and nothing changes', async () => {
    const socket = new FakeSocket();
    registry.register('personal', socket);
    socket.fromExtension({
      type: NativeMessageType.MODULES_SET,
      requestId: 'r3',
      payload: { id: 'nope', enabled: false },
    });
    socket.fromExtension({
      type: NativeMessageType.MODULES_SET,
      requestId: 'r4',
      payload: { id: 'workato', enabled: 'off' },
    });
    await flush();
    const r3 = socket.sent.find((message) => message.responseToRequestId === 'r3');
    const r4 = socket.sent.find((message) => message.responseToRequestId === 'r4');
    expect(r3.payload).toMatchObject({ status: 'error' });
    expect(r3.payload.error).toMatch(/unknown module "nope"/);
    expect(r4.payload).toMatchObject({ status: 'error' });
    expect(switches.isEnabled('workato')).toBe(true);
  });
});

describe('requests a module takes from the extension', () => {
  test('answered with the profile they came from, and refused while the module is off', async () => {
    const seen: Array<{ payload: any; profile: string }> = [];
    const local = new ProfileRegistry();
    const undoLocal = installModuleSync({
      registry: local,
      switches,
      modules: [
        {
          id: 'workato',
          title: 'Workato',
          extensionRequests: {
            demo_report: (payload: any, profile: string) => {
              seen.push({ payload, profile });
              return { state: 'ok' };
            },
          },
        },
      ],
    });
    const socket = new FakeSocket();
    local.register('work', socket);
    socket.fromExtension({ type: 'demo_report', requestId: 'q1', payload: { host: 'h' } });
    await flush();
    expect(socket.sent.find((m) => m.responseToRequestId === 'q1')?.payload).toEqual({
      status: 'success',
      data: { state: 'ok' },
    });
    expect(seen).toEqual([{ payload: { host: 'h' }, profile: 'work' }]);

    switches.set('workato', false);
    socket.fromExtension({ type: 'demo_report', requestId: 'q2', payload: { host: 'h' } });
    await flush();
    const refused = socket.sent.find((m) => m.responseToRequestId === 'q2');
    expect(refused?.payload.status).toBe('error');
    expect(seen).toHaveLength(1);
    undoLocal();
  });
});
