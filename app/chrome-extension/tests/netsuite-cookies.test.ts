/**
 * The NetSuite module's cookie requests: only one account host, only plain
 * cookies of that host, and only while the bridge says the module is on.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  probeNsSession,
  readNsCookies,
  writeNsCookies,
} from '@/entrypoints/background/modules/netsuite/cookies';
import {
  answerModuleBridgeRequest,
  findModuleBridgeRequest,
} from '@/entrypoints/background/module-bridge-requests';
import type { ExtensionModule } from '@/entrypoints/background/extension-module';

const HOST = '1234567-sb2.app.netsuite.com';
const base = { path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction' };

let jar: any[];
let setCalls: any[];

beforeEach(() => {
  jar = [
    { ...base, name: 'JSESSIONID', value: 'v1', domain: HOST, hostOnly: true },
    { ...base, name: 'NS_ROUTING', value: 'v2', domain: `.${HOST}`, hostOnly: false },
    { ...base, name: 'OTHER', value: 'v3', domain: '.netsuite.com', hostOnly: false },
    { ...base, name: 'SUB', value: 'v4', domain: `x.${HOST}`, hostOnly: true },
  ];
  setCalls = [];
  (globalThis as any).chrome = {
    ...(globalThis as any).chrome,
    cookies: {
      getAll: vi.fn(async () => jar),
      set: vi.fn(async (details: any) => {
        setCalls.push(details);
        return details.name === 'REFUSED' ? null : details;
      }),
    },
  };
});

describe('readNsCookies', () => {
  test('returns only the cookies of the account host and its dot-domain', async () => {
    const { cookies } = await readNsCookies({ host: HOST });
    expect(cookies.map((c) => c.name)).toEqual(['JSESSIONID', 'NS_ROUTING']);
  });

  test('refuses anything that is not an account host', async () => {
    for (const host of [
      'system.netsuite.com',
      'evil.com',
      `${HOST}.evil.com`,
      '',
      'a.b.app.netsuite.com',
    ]) {
      await expect(readNsCookies({ host })).rejects.toThrow(/not a NetSuite account host/);
    }
  });
});

describe('writeNsCookies', () => {
  test('sets host-only cookies without a domain and domain cookies with theirs', async () => {
    const { written } = await writeNsCookies({
      host: HOST,
      cookies: [
        { ...base, name: 'JSESSIONID', value: 'v1', domain: HOST },
        { ...base, name: 'NS_ROUTING', value: 'v2', domain: `.${HOST}` },
      ],
    });
    expect(written).toBe(2);
    expect(setCalls[0]).toMatchObject({ url: `https://${HOST}/`, name: 'JSESSIONID' });
    expect('domain' in setCalls[0]).toBe(false);
    expect(setCalls[1].domain).toBe(`.${HOST}`);
  });

  test('refuses the whole write when one cookie is of another host or not plain', async () => {
    for (const bad of [
      { ...base, name: 'X', value: 'v', domain: '.netsuite.com' },
      { ...base, name: 'X', value: 'a;b', domain: HOST },
      { ...base, name: 'X Y', value: 'v', domain: HOST },
      { ...base, name: 'X', value: 'v', domain: HOST, path: 'relative' },
      { ...base, name: 'X', value: 1, domain: HOST },
    ]) {
      await expect(
        writeNsCookies({
          host: HOST,
          cookies: [{ ...base, name: 'OK', value: 'v', domain: HOST }, bad],
        }),
      ).rejects.toThrow(/refused a cookie/);
    }
    expect(setCalls).toEqual([]);
  });

  test('counts only the cookies Chrome accepted', async () => {
    const { written } = await writeNsCookies({
      host: HOST,
      cookies: [
        { ...base, name: 'JSESSIONID', value: 'v1', domain: HOST },
        { ...base, name: 'REFUSED', value: 'v2', domain: HOST },
      ],
    });
    expect(written).toBe(1);
  });
});

describe('probeNsSession', () => {
  const answer = (url: string, ok = true) => vi.fn(async () => ({ ok, url }) as any);

  test('alive when card.nl ends on a page of the host that is not a login page', async () => {
    (globalThis as any).fetch = answer(`https://${HOST}/app/center/card.nl`);
    expect(await probeNsSession({ host: HOST })).toEqual({ alive: true });
    (globalThis as any).fetch = answer(`https://${HOST}/app/setup/mainsetup.nl`);
    expect(await probeNsSession({ host: HOST })).toEqual({ alive: true });
  });

  test('dead on a login page, another host, an error status or a failed fetch', async () => {
    for (const fetchFn of [
      answer(`https://${HOST}/app/login/secure/enterpriselogin.nl?c=1234567_SB2`),
      answer('https://system.netsuite.com/pages/customerlogin.jsp'),
      answer('https://login.microsoftonline.com/x'),
      answer(`https://${HOST}/app/center/card.nl`, false),
      vi.fn(async () => {
        throw new Error('offline');
      }),
    ]) {
      (globalThis as any).fetch = fetchFn;
      expect(await probeNsSession({ host: HOST })).toEqual({ alive: false });
    }
  });
});

describe('the module gate', () => {
  const handler = vi.fn(async () => ({ cookies: [] }));
  const module: ExtensionModule = {
    id: 'netsuite',
    title: 'NetSuite',
    description: '',
    executors: [],
    bridgeRequests: { ns_cookies_read: handler },
  };

  test('finds a module by its own request types only', () => {
    expect(findModuleBridgeRequest([module], 'ns_cookies_read')?.module.id).toBe('netsuite');
    expect(findModuleBridgeRequest([module], 'toString')).toBeNull();
    expect(findModuleBridgeRequest([module], 'call_tool')).toBeNull();
    expect(findModuleBridgeRequest([module], undefined)).toBeNull();
  });

  test('answers only while the bridge said the module is on', async () => {
    const found = findModuleBridgeRequest([module], 'ns_cookies_read')!;
    expect(await answerModuleBridgeRequest(found, { host: HOST }, async () => true)).toEqual({
      status: 'success',
      data: { cookies: [] },
    });
    handler.mockClear();
    expect(await answerModuleBridgeRequest(found, { host: HOST }, async () => false)).toEqual({
      status: 'error',
      error: 'the NetSuite module is switched off',
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
