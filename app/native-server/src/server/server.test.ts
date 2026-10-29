import {
  describe,
  expect,
  test,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  jest,
} from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import Server from './index';
import { profileRegistry } from './profile-registry';
import { SERVER_NAME } from '../mcp/server-identity';
import { EXTENSION_IDS } from '../scripts/constant';

describe('server tests', () => {
  beforeAll(async () => {
    await Server.getInstance().ready();
  });

  afterAll(async () => {
    await Server.stop();
  });

  test('GET /ping should return correct response', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/ping')
      .expect(200)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      status: 'ok',
      message: 'pong',
    });
  });

  test('POST /mcp initialize should return a JSON-RPC response as application/json', async () => {
    const response = await supertest(Server.getInstance().server)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'codex-regression-test',
            version: '0.0.0',
          },
        },
      })
      .expect(200)
      .expect('Content-Type', /application\/json/);

    expect(response.body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVER_NAME,
        },
      },
    });
    expect(response.headers['mcp-session-id']).toBeTruthy();
  });

  test('POST /mcp with an invalid session should return a JSON-RPC error', async () => {
    const response = await supertest(Server.getInstance().server)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('mcp-session-id', 'stale-session')
      .send({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: {
          name: 'chrome_list_profiles',
          arguments: {},
        },
      })
      .expect(404)
      .expect('Content-Type', /application\/json/);

    expect(response.body).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Session not found',
      },
      id: null,
    });
  });

  test('GET /ws-client should register the accepted WebSocket for the requested profile', async () => {
    const registerSpy = jest.spyOn(profileRegistry, 'register').mockImplementation(() => undefined);
    let ws: { close: () => void } | undefined;

    try {
      ws = await (Server.getInstance() as any).injectWS('/ws-client?profile=probe');

      expect(registerSpy).toHaveBeenCalledWith(
        'probe',
        expect.objectContaining({
          close: expect.any(Function),
          on: expect.any(Function),
          send: expect.any(Function),
        }),
        null,
      );
    } finally {
      ws?.close();
      registerSpy.mockRestore();
    }
  });

  test('GET /ws-client passes on the Chrome session id the extension sends', async () => {
    const registerSpy = jest.spyOn(profileRegistry, 'register').mockImplementation(() => undefined);
    let ws: { close: () => void } | undefined;

    try {
      ws = await (Server.getInstance() as any).injectWS(
        '/ws-client?profile=probe&browser_session=chrome-1',
      );

      expect(registerSpy).toHaveBeenCalledWith('probe', expect.anything(), 'chrome-1');
    } finally {
      ws?.close();
      registerSpy.mockRestore();
    }
  });

  test('GET /ws-client refuses any other origin with a 403 at the upgrade, and logs it', async () => {
    const registerSpy = jest.spyOn(profileRegistry, 'register').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const upgrade = (headers: Record<string, string>) =>
      (Server.getInstance() as any).injectWS('/ws-client?profile=personal', { headers });
    try {
      for (const origin of [
        'http://127.0.0.1.attacker.tld',
        'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh',
        // Local pages may use the HTTP routes, never the profile socket.
        'http://127.0.0.1:5173',
        // Upstream's Web Store id is not ours any more.
        'chrome-extension://hbdgbgagpkpjffpklnamcljpakneikee',
      ]) {
        // Refused before the upgrade: the client gets an error, not an open socket.
        await expect(upgrade({ origin })).rejects.toThrow('Unexpected server response: 403');
      }
      expect(registerSpy).not.toHaveBeenCalled();
      const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      // Foreign origins stop at the guard every route has...
      expect(logged).toMatch(
        /\[bridge\] refused GET \/ws-client: origin "http:\/\/127\.0\.0\.1\.attacker\.tld" not allowed/,
      );
      // ...a local page passes it, and the socket's own rule refuses it.
      expect(logged).toMatch(
        /\[bridge\] refused a \/ws-client upgrade from origin "http:\/\/127\.0\.0\.1:5173"/,
      );

      const ours = await upgrade({ origin: `chrome-extension://${EXTENSION_IDS[0]}` });
      ours.close();
      const noOrigin = await upgrade({});
      noOrigin.close();
      expect(registerSpy).toHaveBeenCalledTimes(2);
    } finally {
      registerSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  describe('every HTTP route refuses a foreign origin or host before it runs', () => {
    const http = () => supertest(Server.getInstance().server);
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'guard-test', version: '0.0.0' },
      },
    };
    let errorSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };
    let file: string;

    beforeAll(() => {
      file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'secret.txt');
      fs.writeFileSync(file, 'top secret');
    });

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    test('a DNS-rebinding Host is refused, with or without an Origin', async () => {
      for (const host of ['attacker.example:12306', 'attacker.example', '127.0.0.1.attacker.tld']) {
        await http().get('/ping').set('Host', host).expect(403);
        const mcp = await http()
          .post('/mcp')
          .set('Host', host)
          .set('Origin', `http://${host}`)
          .set('Accept', 'application/json, text/event-stream')
          .set('Content-Type', 'application/json')
          .send(initialize);
        expect(mcp.status).toBe(403);
      }
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
        /\[bridge\] refused GET \/ping: host "attacker\.example:12306" not allowed/,
      );
    });

    test('a local host name on another port is refused', async () => {
      await http().get('/ping').set('Host', '127.0.0.1:1').expect(403);
    });

    test('a foreign Origin is refused on /mcp and /file; the route never runs', async () => {
      const mcp = await http()
        .post('/mcp')
        .set('Origin', 'https://evil.example')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .send(initialize);
      expect(mcp.status).toBe(403);
      expect(mcp.headers['mcp-session-id']).toBeUndefined();

      const read = await http()
        .get('/file')
        .query({ path: file })
        .set('Origin', 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh');
      expect(read.status).toBe(403);
      expect(read.text).not.toContain('top secret');
    });

    test('a local client (no Origin, the right Host) and the extension still get through', async () => {
      // supertest sends Host 127.0.0.1:<the port it listens on>, and no Origin:
      // what Claude Code's HTTP client and watch-wait send.
      await http().get('/ping').expect(200);
      const mcp = await http()
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .send(initialize);
      expect(mcp.status).toBe(200);

      const read = await http()
        .get('/file')
        .query({ path: file })
        .set('Origin', `chrome-extension://${EXTENSION_IDS[0]}`);
      expect(read.status).toBe(200);
      expect(read.text).toBe('top secret');
    });

    test('/file takes only the extension or no Origin, never a local page', async () => {
      const page = await http()
        .get('/file')
        .query({ path: file })
        .set('Origin', 'http://127.0.0.1:5173');
      expect(page.status).toBe(403);
      expect(page.text).not.toContain('top secret');
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
        /\[bridge\] refused a \/file read from origin "http:\/\/127\.0\.0\.1:5173"/,
      );
      // The same local page may still use the other routes.
      await http().get('/ping').set('Origin', 'http://127.0.0.1:5173').expect(200);

      const extension = await http()
        .get('/file')
        .query({ path: file })
        .set('Origin', `chrome-extension://${EXTENSION_IDS[0]}`);
      expect(extension.status).toBe(200);
      expect(extension.text).toBe('top secret');

      const noOrigin = await http().get('/file').query({ path: file });
      expect(noOrigin.status).toBe(200);
      expect(noOrigin.text).toBe('top secret');
    });

    test('localhost on the bridge port is the same bridge', async () => {
      const server = Server.getInstance().server;
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      try {
        const port = (server.address() as { port: number }).port;
        await supertest(server).get('/ping').set('Host', `localhost:${port}`).expect(200);
        await supertest(server).get('/ping').set('Host', `127.0.0.1:${port}`).expect(200);
        await supertest(server)
          .get('/ping')
          .set('Host', `localhost:${port + 1}`)
          .expect(403);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  test('CORS answers a preflight only for allowed origins', async () => {
    const preflight = (origin: string) =>
      supertest(Server.getInstance().server)
        .options('/mcp')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');

    const local = await preflight('http://127.0.0.1:12306');
    expect(local.headers['access-control-allow-origin']).toBe('http://127.0.0.1:12306');

    const ours = await preflight(`chrome-extension://${EXTENSION_IDS[0]}`);
    expect(ours.headers['access-control-allow-origin']).toBe(
      `chrome-extension://${EXTENSION_IDS[0]}`,
    );

    for (const origin of [
      'http://127.0.0.1.attacker.tld',
      'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh',
    ]) {
      const refused = await preflight(origin);
      expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});
