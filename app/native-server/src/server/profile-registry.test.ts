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

    registry.register('work', first);
    registry.register('bluBanyan', second);
    expect(registry.getActiveProfile()).toBe('work');

    first.emit('close');

    expect(registry.getConnectedProfiles()).toEqual(['bluBanyan']);
    expect(registry.getActiveProfile()).toBe('bluBanyan');
  });

  test('a non-active profile disconnecting does not move the active one', () => {
    const registry = quietRegistry();
    const first = new FakeSocket();
    const second = new FakeSocket();
    registry.register('work', first);
    registry.register('bluBanyan', second);

    second.emit('close');

    expect(registry.getActiveProfile()).toBe('work');
  });

  test('the last profile leaving clears the active profile', () => {
    const registry = quietRegistry();
    const socket = new FakeSocket();
    registry.register('work', socket);

    socket.emit('close');

    expect(registry.getActiveProfile()).toBeNull();
    expect(registry.getConnectedProfiles()).toEqual([]);
  });

  test('the generation changes on every connect and disconnect', () => {
    const registry = quietRegistry();
    const first = new FakeSocket();
    const start = registry.getGeneration();

    registry.register('work', first);
    const afterConnect = registry.getGeneration();
    expect(afterConnect).not.toBe(start);

    first.emit('close');
    const afterClose = registry.getGeneration();
    expect(afterClose).not.toBe(afterConnect);

    // A reconnect of the same name is a new browser session, so it must show up.
    registry.register('work', new FakeSocket());
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
    registry.register('work', socket);

    const pending = registry.sendRequest('work', {}, 'call_tool', 60000);
    socket.emit('close');

    await expect(pending).rejects.toThrow('Profile "work" disconnected before replying');
  });

  test("a replaced socket's close fails only its own requests", async () => {
    const registry = quietRegistry();
    const oldSocket = new FakeSocket();
    registry.register('work', oldSocket);
    const onOld = registry.sendRequest('work', {}, 'call_tool', 60000);

    const newSocket = new FakeSocket();
    registry.register('work', newSocket);
    const onNew = registry.sendRequest('work', {}, 'call_tool', 60000);
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
    registry.register('work', new FakeSocket());

    personal.emit('close');
    expect(registry.getActiveProfile()).toBe('work');

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

    registry.register('work', new FakeSocket());
    expect(registry.getActiveProfile()).toBe('work');
    registry.register('personal', new FakeSocket());
    expect(registry.getActiveProfile()).toBe('personal');
  });

  test('the first profile to connect is persisted when no default is stored', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const file = tempFile();
    const registry = new ProfileRegistry();
    registry.enablePreferencePersistence(file);

    registry.register('bluBanyan', new FakeSocket());
    registry.register('work', new FakeSocket());

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

  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.parse('2026-11-26T12:00:00Z');

  function registryAt(file: string, clock: { t: number }, env: NodeJS.ProcessEnv = {}) {
    const registry = new ProfileRegistry();
    registry.enablePreferencePersistence(file, { env, now: () => clock.t, heartbeat: false });
    return registry;
  }

  /** The hourly heartbeat, run by hand. */
  function runFor(registry: ProfileRegistry, clock: { t: number }, ms: number) {
    for (let done = 0; done < ms; done += HOUR) {
      clock.t += HOUR;
      registry.flushPreference();
    }
  }

  test('a default away for 7 days of bridge running time gives way to the profile that connects', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const file = tempFile();
    fs.writeFileSync(file, JSON.stringify({ profile: 'default' }));
    const clock = { t: NOW };
    const registry = registryAt(file, clock);

    registry.register('bsd', new FakeSocket());
    expect(registry.getPreferredProfile()).toBe('default');
    runFor(registry, clock, 8 * DAY);
    registry.register('bb', new FakeSocket());

    expect(registry.getPreferredProfile()).toBe('bb');
    expect(registry.getActiveProfile()).toBe('bb');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.profile).toBe('bb');
    expect(saved.default_absent_ms).toBe(0);
  });

  test('a default that stayed connected for days keeps its place when it drops', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const file = tempFile();
    const clock = { t: NOW };
    const registry = registryAt(file, clock);
    registry.register('A', new FakeSocket());
    runFor(registry, clock, 10 * DAY);
    registry.deregister('A');
    registry.register('B', new FakeSocket());

    expect(registry.getPreferredProfile()).toBe('A');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).profile).toBe('A');
  });

  test('time with the bridge stopped counts nothing (a week away, then a restart)', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const file = tempFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ profile: 'A', set_at: new Date(NOW - 30 * DAY).toISOString() }),
    );
    const clock = { t: NOW + 10 * DAY };
    const registry = registryAt(file, clock);
    registry.register('B', new FakeSocket());
    clock.t += 3 * HOUR; // a sleeping laptop: one gap, no ticks
    registry.register('C', new FakeSocket());

    expect(registry.getPreferredProfile()).toBe('A');
  });

  test('the absence survives a restart', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const file = tempFile();
    const clock = { t: NOW };
    const first = registryAt(file, clock);
    first.register('A', new FakeSocket());
    first.deregister('A');
    runFor(first, clock, 5 * DAY);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).default_absent_ms).toBe(5 * DAY);

    const second = registryAt(file, clock);
    second.register('B', new FakeSocket());
    expect(second.getPreferredProfile()).toBe('A');
    runFor(second, clock, 3 * DAY);
    second.register('C', new FakeSocket());
    expect(second.getPreferredProfile()).toBe('C');
  });

  test('MOKUTAB_DEFAULT_PROFILE pins the default over the file and a switch', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const file = tempFile();
    fs.writeFileSync(file, JSON.stringify({ profile: 'bb', set_at: new Date(NOW).toISOString() }));
    const clock = { t: NOW };
    const registry = registryAt(file, clock, { MOKUTAB_DEFAULT_PROFILE: 'bsd' });

    registry.register('bb', new FakeSocket());
    expect(registry.getActiveProfile()).toBe('bb');
    registry.register('bsd', new FakeSocket());
    registry.register('pf', new FakeSocket());
    expect(registry.getActiveProfile()).toBe('bsd');

    expect(registry.switchProfile('pf')).toBe(true);
    expect(registry.getActiveProfile()).toBe('pf');
    expect(registry.getPreferredProfile()).toBe('bsd');
    // Under a pin a switch is still remembered as the unpinned default:
    // dropping the pin brings back the last switch.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).profile).toBe('pf');
    // A pinned default is never "away".
    runFor(registry, clock, 8 * DAY);
    registry.deregister('bsd');
    registry.register('x', new FakeSocket());
    expect(registry.getPreferredProfile()).toBe('bsd');
  });

  test('the file keeps a shape older bridges read: profile is a string or null', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const file = tempFile();
    const clock = { t: NOW };
    const pinned = registryAt(file, clock, { MOKUTAB_DEFAULT_PROFILE: 'bsd' });
    pinned.register('bsd', new FakeSocket());
    const saved = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { profile: null };
    expect(saved.profile === null || typeof saved.profile === 'string').toBe(true);

    const plain = registryAt(tempFile(), clock);
    plain.register('bsd', new FakeSocket());
    const savedPlain = JSON.parse(fs.readFileSync(path.join(dir, 'default-profile.json'), 'utf8'));
    expect(savedPlain.profile).toBe('bsd');
    expect(typeof savedPlain.set_at).toBe('string');
  });
});
