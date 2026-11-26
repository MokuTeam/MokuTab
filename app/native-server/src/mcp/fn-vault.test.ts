import { afterEach, describe, expect, test } from '@jest/globals';
import * as path from 'path';
import {
  VaultError,
  bitwardenVault,
  bwAppDataDir,
  parseSessionFile,
  pageMatchesVaultUris,
  scrubSecrets,
  type VaultHost,
} from './fn-vault';

const ITEM = 'e3e8fa54-5d0a-492b-9c60-b40101865fbf';

describe('pageMatchesVaultUris', () => {
  const page = 'https://4699211.app.netsuite.com/app/login/secure/enterpriselogin.nl?c=4699211';

  test('the default match is the base domain', () => {
    expect(pageMatchesVaultUris(page, [{ uri: 'https://system.netsuite.com', match: null }])).toBe(
      true,
    );
    expect(pageMatchesVaultUris(page, [{ uri: 'netsuite.com', match: 0 }])).toBe(true);
    expect(
      pageMatchesVaultUris(page, [{ uri: 'https://netsuite.com.evil.example', match: null }]),
    ).toBe(false);
    expect(
      pageMatchesVaultUris('https://evil.example/netsuite.com', [
        { uri: 'netsuite.com', match: null },
      ]),
    ).toBe(false);
  });

  test('host, starts-with and exact follow Bitwarden; regex and never do not match', () => {
    expect(pageMatchesVaultUris(page, [{ uri: 'https://system.netsuite.com', match: 1 }])).toBe(
      false,
    );
    expect(
      pageMatchesVaultUris(page, [{ uri: 'https://4699211.app.netsuite.com', match: 1 }]),
    ).toBe(true);
    expect(
      pageMatchesVaultUris(page, [{ uri: 'https://4699211.app.netsuite.com/app/', match: 2 }]),
    ).toBe(true);
    expect(pageMatchesVaultUris(page, [{ uri: page, match: 3 }])).toBe(true);
    expect(pageMatchesVaultUris(page, [{ uri: '.*', match: 4 }])).toBe(false);
    expect(pageMatchesVaultUris(page, [{ uri: 'https://system.netsuite.com', match: 5 }])).toBe(
      false,
    );
  });
});

describe('pageMatchesVaultUris edges', () => {
  test('https pages only, prefixes end at a boundary, app URIs never match', () => {
    const uris = [{ uri: 'https://login.example.com', match: 2 }];
    expect(pageMatchesVaultUris('https://login.example.com/form', uris)).toBe(true);
    expect(pageMatchesVaultUris('https://login.example.com.evil.net/', uris)).toBe(false);
    expect(pageMatchesVaultUris('http://login.example.com/form', uris)).toBe(false);
    expect(
      pageMatchesVaultUris('https://app.example.com/', [
        { uri: 'androidapp://com.example.app', match: null },
      ]),
    ).toBe(false);
  });

  test('an item is named by its id, never by a search word', async () => {
    const vault = bitwardenVault(async () => ({ stdout: 'x', stderr: '' }));
    await expect(vault.get('Alafair', 'password')).rejects.toThrow(/by its id/);
  });
});

describe('scrubSecrets', () => {
  test('a numeric secret is scrubbed from strings without breaking numbers', () => {
    expect(scrubSecrets({ ms: 1234, note: 'pin 1234 typed', list: ['1234'] }, ['1234'])).toEqual({
      ms: 1234,
      note: 'pin <vault value> typed',
      list: ['<vault value>'],
    });
  });

  test('replaces every occurrence, also JSON-escaped ones', () => {
    const value = { a: 'pass "q1w2e3"', b: ['pass "q1w2e3" again'], c: 1 };
    expect(scrubSecrets(value, ['pass "q1w2e3"'])).toEqual({
      a: '<vault value>',
      b: ['<vault value> again'],
      c: 1,
    });
    expect(scrubSecrets('x', [])).toBe('x');
  });
});

describe('bitwardenVault', () => {
  const saved = process.env.BW_SESSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.BW_SESSION;
    else process.env.BW_SESSION = saved;
  });

  test('passes the session through the environment and keeps only URIs of an item', async () => {
    process.env.BW_SESSION = 'session-key';
    const calls: Array<{ args: string[]; session?: string }> = [];
    const vault = bitwardenVault(async (file, args, env) => {
      if (file === 'reg') throw new Error('not set');
      calls.push({ args, session: env.BW_SESSION });
      if (args[1] === 'item') {
        return {
          stdout: JSON.stringify({
            login: {
              password: 'hunter22',
              uris: [{ uri: 'https://system.netsuite.com', match: null }],
            },
          }),
          stderr: '',
        };
      }
      return { stdout: 'hunter22\n', stderr: '' };
    });
    expect(await vault.uris(ITEM)).toEqual([{ uri: 'https://system.netsuite.com', match: null }]);
    expect(await vault.get(ITEM, 'password')).toBe('hunter22');
    expect(calls.map((c) => c.args)).toEqual([
      ['get', 'item', ITEM, '--nointeraction'],
      ['get', 'password', ITEM, '--nointeraction'],
    ]);
    expect(calls.every((c) => c.session === 'session-key' && !c.args.includes('session-key'))).toBe(
      true,
    );
  });

  // The registry lookup exists on Windows only.
  (process.platform === 'win32' ? test : test.skip)(
    'the user environment wins over a stale key this process inherited',
    async () => {
      process.env.BW_SESSION = 'stale-key';
      const tried: string[] = [];
      const vault = bitwardenVault(async (file, _args, env) => {
        if (file === 'reg') {
          return { stdout: '\r\n    BW_SESSION    REG_SZ    fresh-key\r\n', stderr: '' };
        }
        tried.push(String(env.BW_SESSION));
        if (env.BW_SESSION !== 'fresh-key') {
          const err: any = new Error('exit 1');
          err.stderr = 'Vault is locked.';
          throw err;
        }
        return { stdout: 'value\n', stderr: '' };
      });
      expect(await vault.get(ITEM, 'password')).toBe('value');
      expect(tried).toEqual(['fresh-key']);
    },
  );

  test('a locked vault is a clear error that never quotes stdout', async () => {
    process.env.BW_SESSION = 'session-key';
    const vault = bitwardenVault(async () => {
      const err: any = new Error('exit 1');
      err.stderr = 'Vault is locked.';
      err.stdout = 'hunter22';
      throw err;
    });
    await expect(vault.get(ITEM, 'password')).rejects.toThrow(VaultError);
    await expect(vault.get(ITEM, 'password')).rejects.toThrow(/locked/);
  });
});

describe('session file', () => {
  test('parseSessionFile reads env-file lines and a bare key', () => {
    expect(parseSessionFile('# bw\nexport BW_SESSION="abc=="\n')).toBe('abc==');
    expect(parseSessionFile("BW_SESSION='k1'\r\nOTHER=1\r\n")).toBe('k1');
    expect(parseSessionFile('BW_SESSION=plain\n')).toBe('plain');
    expect(parseSessionFile('barekey==\n')).toBe('barekey==');
    expect(parseSessionFile('OTHER=1\n')).toBeNull();
    expect(parseSessionFile('BW_SESSION=\n')).toBeNull();
    expect(parseSessionFile('')).toBeNull();
  });

  test('the file is re-read on every call and wins over the process environment', async () => {
    let fileText = 'export BW_SESSION="first"\n';
    const used: string[] = [];
    const vault = bitwardenVault(
      async (_file, _args, env) => {
        used.push(String(env.BW_SESSION));
        return { stdout: 'v\n', stderr: '' };
      },
      {
        platform: 'linux',
        env: { MOKUTAB_BW_SESSION_FILE: '/run/bw/session.env', BW_SESSION: 'inherited' },
        readFile: (f) => {
          expect(f).toBe('/run/bw/session.env');
          return fileText;
        },
        exists: () => false,
      },
    );
    await vault.get(ITEM, 'password');
    fileText = 'BW_SESSION=second\n';
    await vault.get(ITEM, 'password');
    expect(used).toEqual(['first', 'second']);
  });

  test('a stale file key falls back to BW_SESSION; a missing file is not an error', async () => {
    const used: string[] = [];
    const vault = bitwardenVault(
      async (_file, _args, env) => {
        used.push(String(env.BW_SESSION));
        if (env.BW_SESSION !== 'good') {
          const err: any = new Error('exit 1');
          err.stderr = 'Vault is locked.';
          throw err;
        }
        return { stdout: 'v\n', stderr: '' };
      },
      {
        platform: 'linux',
        env: { MOKUTAB_BW_SESSION_FILE: '/x', BW_SESSION: 'good' },
        readFile: () => 'BW_SESSION=stale',
        exists: () => false,
      },
    );
    expect(await vault.get(ITEM, 'password')).toBe('v');
    expect(used).toEqual(['stale', 'good']);

    const noFile = bitwardenVault(async () => ({ stdout: 'v\n', stderr: '' }), {
      platform: 'linux',
      env: { MOKUTAB_BW_SESSION_FILE: '/x' },
      readFile: () => {
        throw new Error('ENOENT');
      },
      exists: () => false,
    });
    await expect(noFile.get(ITEM, 'password')).rejects.toThrow(/\/x \(MOKUTAB_BW_SESSION_FILE\)/);
  });
});

describe('bwAppDataDir', () => {
  const home = '/home/agent';
  const usual = path.join(home, '.config', 'Bitwarden CLI');
  const host = (
    env: NodeJS.ProcessEnv,
    present: string[],
    platform: NodeJS.Platform = 'linux',
  ): VaultHost => ({
    env,
    platform,
    home,
    readFile: () => '',
    exists: (f) => present.includes(f),
  });

  test('a per-profile XDG_CONFIG_HOME without bw data points bw back at ~/.config', () => {
    const env = { XDG_CONFIG_HOME: '/home/agent/browser/bsd/config' };
    expect(bwAppDataDir(host(env, [path.join(usual, 'data.json')]))).toBe(usual);
  });

  test('leaves bw alone when its XDG dir has data, nothing has data, or it is not Linux', () => {
    const xdg = '/home/agent/browser/bsd/config';
    const env = { XDG_CONFIG_HOME: xdg };
    expect(
      bwAppDataDir(
        host(env, [path.join(xdg, 'Bitwarden CLI', 'data.json'), path.join(usual, 'data.json')]),
      ),
    ).toBeUndefined();
    expect(bwAppDataDir(host(env, []))).toBeUndefined();
    expect(bwAppDataDir(host(env, [path.join(usual, 'data.json')], 'win32'))).toBeUndefined();
    expect(bwAppDataDir(host({}, [path.join(usual, 'data.json')]))).toBeUndefined();
    expect(
      bwAppDataDir(
        host({ ...env, BITWARDENCLI_APPDATA_DIR: '/set' }, [path.join(usual, 'data.json')]),
      ),
    ).toBeUndefined();
  });

  test('MOKUTAB_BW_APPDATA wins and reaches bw', async () => {
    expect(bwAppDataDir(host({ MOKUTAB_BW_APPDATA: '/data/bw' }, [], 'win32'))).toBe('/data/bw');
    let seen: string | undefined;
    const vault = bitwardenVault(
      async (_f, _a, env) => {
        seen = env.BITWARDENCLI_APPDATA_DIR;
        return { stdout: 'v\n', stderr: '' };
      },
      {
        platform: 'linux',
        env: { MOKUTAB_BW_APPDATA: '/data/bw', BW_SESSION: 'k' },
        exists: () => false,
      },
    );
    await vault.get(ITEM, 'password');
    expect(seen).toBe('/data/bw');
  });
});
