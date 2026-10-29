import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProfileRegistry } from './profile-registry';

class FakeSocket extends EventEmitter {
  public close = jest.fn();
  public send = jest.fn();
}

describe('ProfileRegistry', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does not write profile lifecycle logs to stdout', () => {
    const stdoutLog = jest.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('console.log writes to native messaging stdout');
    });
    const stderrLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    const registry = new ProfileRegistry();
    const socket = new FakeSocket();

    expect(() => registry.register('dev', socket)).not.toThrow();
    socket.emit('close');

    expect(stdoutLog).not.toHaveBeenCalled();
    expect(stderrLog).toHaveBeenCalled();
  });
});

describe('ProfileRegistry active-profile election', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function quietRegistry(): ProfileRegistry {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    return new ProfileRegistry();
  }

  test('elects the remaining profile when the active one disconnects', () => {
    const registry = quietRegistry();
    const first = new FakeSocket();
    const second = new FakeSocket();

    registry.register('centium', first);
    registry.register('bluBanyan', second);
    expect(registry.getActiveProfile()).toBe('centium');

    first.emit('close');

    expect(registry.getConnectedProfiles()).toEqual(['bluBanyan']);
    expect(registry.getActiveProfile()).toBe('bluBanyan');
  });

  test('a non-active profile disconnecting does not move the active one', () => {
    const registry = quietRegistry();
    const first = new FakeSocket();
    const second = new FakeSocket();
    registry.register('centium', first);
    registry.register('bluBanyan', second);

    second.emit('close');

    expect(registry.getActiveProfile()).toBe('centium');
  });

  test('the last profile leaving clears the active profile', () => {
    const registry = quietRegistry();
    const socket = new FakeSocket();
    registry.register('centium', socket);

    socket.emit('close');

    expect(registry.getActiveProfile()).toBeNull();
    expect(registry.getConnectedProfiles()).toEqual([]);
  });

  test('remembers the Chrome session each connection reports, until it leaves', () => {
    const registry = quietRegistry();
    const socket = new FakeSocket();
    registry.register('centium', socket, 'chrome-1');
    expect(registry.getBrowserSession('centium')).toBe('chrome-1');

    // A reconnect from an extension that sends none must not keep the old id.
    registry.register('centium', new FakeSocket());
    expect(registry.getBrowserSession('centium')).toBeNull();

    const last = new FakeSocket();
    registry.register('centium', last, 'chrome-2');
    last.emit('close');
    expect(registry.getBrowserSession('centium')).toBeNull();
  });

  test('the generation changes on every connect and disconnect', () => {
    const registry = quietRegistry();
    const first = new FakeSocket();
    const start = registry.getGeneration();

    registry.register('centium', first);
    const afterConnect = registry.getGeneration();
    expect(afterConnect).not.toBe(start);

    first.emit('close');
    const afterClose = registry.getGeneration();
    expect(afterClose).not.toBe(afterConnect);

    // A reconnect of the same name is a new browser session, so it must show up.
    registry.register('centium', new FakeSocket());
    expect(registry.getGeneration()).not.toBe(afterClose);
  });
});

describe('ProfileRegistry reconnects', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function quietRegistry(): ProfileRegistry {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    return new ProfileRegistry();
  }

  test('a late close of the replaced socket does not drop the new connection', () => {
    const registry = quietRegistry();
    const oldSocket = new FakeSocket();
    const newSocket = new FakeSocket();
    registry.register('bluBanyan', oldSocket);
    registry.register('bluBanyan', newSocket);

    // The old socket's close arrives after the new registration.
    oldSocket.emit('close');

    expect(registry.getConnectedProfiles()).toEqual(['bluBanyan']);
    newSocket.emit('close');
    expect(registry.getConnectedProfiles()).toEqual([]);
  });

  test('a replaced socket that closes synchronously leaves the new one registered', () => {
    const registry = quietRegistry();
    const oldSocket = new FakeSocket();
    oldSocket.close.mockImplementation(() => {
      oldSocket.emit('close');
    });
    registry.register('bluBanyan', oldSocket);
    const serial = registry.getConnectionSerial('bluBanyan')!;

    registry.register('bluBanyan', new FakeSocket());

    expect(registry.getConnectedProfiles()).toEqual(['bluBanyan']);
    expect(registry.getConnectionSerial('bluBanyan')!).toBeGreaterThan(serial);
  });

  test('a closing socket fails its in-flight requests at once', async () => {
    const registry = quietRegistry();
    const socket = new FakeSocket();
    registry.register('centium', socket);

    const pending = registry.sendRequest('centium', {}, 'call_tool', 60000);
    socket.emit('close');

    await expect(pending).rejects.toThrow('Profile "centium" disconnected before replying');
  });

  test("a replaced socket's close fails only its own requests", async () => {
    const registry = quietRegistry();
    const oldSocket = new FakeSocket();
    registry.register('centium', oldSocket);
    const onOld = registry.sendRequest('centium', {}, 'call_tool', 60000);

    const newSocket = new FakeSocket();
    registry.register('centium', newSocket);
    const onNew = registry.sendRequest('centium', {}, 'call_tool', 60000);
    oldSocket.emit('close');

    await expect(onOld).rejects.toThrow('disconnected before replying');
    const sent = JSON.parse(newSocket.send.mock.calls[0][0] as string);
    newSocket.emit(
      'message',
      Buffer.from(JSON.stringify({ responseToRequestId: sent.requestId, payload: { ok: 1 } })),
    );
    await expect(onNew).resolves.toEqual({ ok: 1 });
  });

  test('the connection serial rises on a reconnect and is null while gone', () => {
    const registry = quietRegistry();
    const first = new FakeSocket();
    registry.register('personal', first);
    const serial = registry.getConnectionSerial('personal');
    expect(serial).not.toBeNull();

    first.emit('close');
    expect(registry.getConnectionSerial('personal')).toBeNull();

    registry.register('personal', new FakeSocket());
    expect(registry.getConnectionSerial('personal')!).toBeGreaterThan(serial!);
  });

  test('the first default comes back as the default after it reconnects', () => {
    const registry = quietRegistry();
    const personal = new FakeSocket();
    registry.register('personal', personal);
    registry.register('centium', new FakeSocket());

    personal.emit('close');
    expect(registry.getActiveProfile()).toBe('centium');

    registry.register('personal', new FakeSocket());
    expect(registry.getActiveProfile()).toBe('personal');
  });
});

describe('ProfileRegistry default-profile persistence', () => {
  let dir: string;

  afterEach(() => {
    jest.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempFile(): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-registry-'));
    return path.join(dir, 'default-profile.json');
  }

  test('a persisted default wins over whichever profile connects first', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const file = tempFile();
    fs.writeFileSync(file, JSON.stringify({ profile: 'personal' }));
    const registry = new ProfileRegistry();
    registry.enablePreferencePersistence(file);

    registry.register('centium', new FakeSocket());
    expect(registry.getActiveProfile()).toBe('centium');
    registry.register('personal', new FakeSocket());
    expect(registry.getActiveProfile()).toBe('personal');
  });

  test('the first profile to connect is persisted when no default is stored', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const file = tempFile();
    const registry = new ProfileRegistry();
    registry.enablePreferencePersistence(file);

    registry.register('bluBanyan', new FakeSocket());
    registry.register('centium', new FakeSocket());

    expect(JSON.parse(fs.readFileSync(file, 'utf8')).profile).toBe('bluBanyan');
  });

  test('switchProfile moves the persisted default', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const file = tempFile();
    const registry = new ProfileRegistry();
    registry.enablePreferencePersistence(file);
    registry.register('bluBanyan', new FakeSocket());
    registry.register('personal', new FakeSocket());

    expect(registry.switchProfile('personal')).toBe(true);

    expect(JSON.parse(fs.readFileSync(file, 'utf8')).profile).toBe('personal');
    expect(registry.getPreferredProfile()).toBe('personal');
  });
});
