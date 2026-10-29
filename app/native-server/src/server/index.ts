/**
 * HTTP Server - Core server implementation.
 *
 * Author: Roman Chikalenko
 * Version: 1.4.0
 *
 * Responsibilities:
 * - Fastify instance management
 * - Plugin registration (CORS, etc.)
 * - Route delegation to specialized modules
 * - MCP transport handling
 * - Server lifecycle management
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import { NATIVE_SERVER_PORT, SERVER_CONFIG, HTTP_STATUS, ERROR_MESSAGES } from '../constant';
import { NativeMessagingHost } from '../native-messaging-host';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../mcp/mcp-server';
import { profileRegistry } from './profile-registry';
import * as path from 'node:path';
import { markMcpActivity, updateStateDir } from '../update-checker';
import { LEASES_FILE, leaseRegistry } from '../mcp/tab-leases';
import { watchManager } from '../mcp/watch-instance';
import { parseWaitQuery } from '../mcp/browser-watch';
import { isAllowedOrigin, isAllowedWsOrigin, logRefusal, requestRefusal } from './origin-policy';

// ============================================================
// Types
// ============================================================

const JSON_RPC_INTERNAL_ERROR = -32603;
const JSON_RPC_SERVER_ERROR = -32000;
const JSON_RPC_SESSION_NOT_FOUND = -32001;

function jsonRpcError(code: number, message: string) {
  return {
    jsonrpc: '2.0',
    error: {
      code,
      message,
    },
    id: null,
  };
}

function sendJsonRpcError(
  reply: FastifyReply,
  status: number,
  code: number,
  message: string,
): void {
  reply.code(status).type('application/json').send(jsonRpcError(code, message));
}

function writeRawJsonRpcError(
  reply: FastifyReply,
  status: number,
  code: number,
  message: string,
): void {
  reply.raw.writeHead(status, {
    'Content-Type': 'application/json',
  });
  reply.raw.end(JSON.stringify(jsonRpcError(code, message)));
}

// ============================================================
// Server Class
// ============================================================

export class Server {
  private fastify: FastifyInstance;
  public isRunning = false;
  private nativeHost: NativeMessagingHost | null = null;
  private transportsMap: Map<string, StreamableHTTPServerTransport | SSEServerTransport> =
    new Map();

  constructor() {
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.setupPlugins();
    this.fastify.after((error) => {
      if (error) {
        throw error;
      }

      this.setupRoutes();
    });
  }

  /**
   * Associate NativeMessagingHost instance.
   */
  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  private setupPlugins(): void {
    // First, for every route: a request from a foreign browser origin, or one
    // whose Host is not this bridge (a DNS-rebinding page is same-origin with
    // us but sends its own domain), is refused before it runs. CORS alone only
    // withholds headers: the route would still execute, /file would still
    // read the file. See origin-policy.ts.
    this.fastify.addHook('onRequest', async (request, reply) => {
      const refusal = requestRefusal({
        origin: request.headers.origin,
        host: request.headers.host,
        port: request.socket?.localPort ?? null,
      });
      if (!refusal) return;
      logRefusal(`${request.method} ${request.url.split('?')[0]}: ${refusal} not allowed`);
      return reply.code(HTTP_STATUS.FORBIDDEN).send({ error: `${refusal} not allowed` });
    });
    // Any request except health checks counts as activity; the update
    // checker's idle restart waits for this to go quiet.
    this.fastify.addHook('onRequest', async (request) => {
      // A held /watch/wait poll is not activity: it must not block an idle update.
      if (request.url !== '/ping' && !request.url.startsWith('/watch/')) markMcpActivity();
    });
    this.fastify.register(fastifyWebsocket);
    this.fastify.register(cors, {
      // No origin (curl, local MCP clients) is allowed; a browser origin must
      // match exactly. See origin-policy.ts.
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
    });
  }

  private setupRoutes(): void {
    // Health check
    this.setupHealthRoutes();

    // File-read endpoint (bridge has Node.js filesystem access)
    this.setupFileRoutes();

    // MCP routes
    this.setupMcpRoutes();

    // WebSocket routes for Chrome profiles
    this.setupWebSocketRoutes();

    // Long poll for chrome_watch_* events (cli watch-wait)
    this.setupWatchRoutes();
  }

  private setupWatchRoutes(): void {
    this.fastify.get('/watch/wait', async (request: FastifyRequest, reply: FastifyReply) => {
      const { ids, cursor, timeoutMs } = parseWaitQuery((request.query ?? {}) as any);
      let abort: (() => void) | null = null;
      // The waiter goes away with its client (a killed watch-wait process).
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) abort?.();
      });
      const result = await watchManager.waitEvents(ids, cursor, timeoutMs, {
        onAbort: (fn) => {
          abort = fn;
        },
      });
      return reply.status(HTTP_STATUS.OK).send(result);
    });
  }

  private setupWebSocketRoutes(): void {
    this.fastify.get(
      '/ws-client',
      {
        websocket: true,
        // A socket that gets through registers as a Chrome profile and
        // receives that profile's tool calls: only this extension (or no
        // Origin). Refused here, before the upgrade, so the client sees a
        // failed connection and backs off; a socket accepted and then closed
        // looks like a working bridge and reconnects at once, forever.
        preValidation: async (request, reply) => {
          const origin = request.headers.origin;
          if (isAllowedWsOrigin(origin)) return;
          logRefusal(`a /ws-client upgrade from origin ${JSON.stringify(origin)}`);
          await reply.code(403).send({ error: 'origin not allowed' });
        },
      },
      (socket, req) => {
        // Second line, should the hook ever be bypassed.
        const origin = req.headers.origin;
        if (!isAllowedWsOrigin(origin)) {
          logRefusal(`a /ws-client socket from origin ${JSON.stringify(origin)}`);
          socket.close();
          return;
        }

        const query = (req.query as any) || {};
        const profileName = query.profile || 'default';
        const browserSession =
          typeof query.browser_session === 'string' && query.browser_session.trim() !== ''
            ? query.browser_session.trim()
            : null;
        profileRegistry.register(profileName, socket, browserSession);
      },
    );
  }

  // ============================================================
  // File Routes — let the extension stream local files via the
  // bridge so file contents never have to live in agent context.
  // Loopback-only by design (bridge binds 127.0.0.1).
  // ============================================================

  private setupFileRoutes(): void {
    this.fastify.get(
      '/file',
      {
        // It reads any local file by path, and only the extension needs it
        // (lookup table CSV imports): the profile socket's rule, no Origin or
        // this extension, not local http pages.
        preValidation: async (request, reply) => {
          const origin = request.headers.origin;
          if (isAllowedWsOrigin(origin)) return;
          logRefusal(`a /file read from origin ${JSON.stringify(origin)}`);
          await reply.code(HTTP_STATUS.FORBIDDEN).send({ error: 'origin not allowed' });
        },
      },
      async (request: FastifyRequest<{ Querystring: { path?: string } }>, reply: FastifyReply) => {
        const filePath = request.query?.path;
        if (typeof filePath !== 'string' || filePath.length === 0) {
          reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'missing required query param: path' });
          return;
        }
        try {
          // Lazy require so we don't pay startup cost when /file is unused.
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          const resolved = path.resolve(filePath);
          const stat = await fs.stat(resolved);
          if (!stat.isFile()) {
            reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'path is not a file' });
            return;
          }
          const ext = path.extname(resolved).toLowerCase();
          const contentType =
            ext === '.csv'
              ? 'text/csv; charset=utf-8'
              : ext === '.json'
                ? 'application/json; charset=utf-8'
                : ext === '.txt'
                  ? 'text/plain; charset=utf-8'
                  : 'application/octet-stream';
          const buf = await fs.readFile(resolved);
          reply
            .code(HTTP_STATUS.OK)
            .header('content-type', contentType)
            .header('content-length', String(buf.byteLength))
            .header('x-file-path', resolved)
            .send(buf);
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e?.code === 'ENOENT') {
            reply.code(404).send({ error: 'file not found', path: filePath });
          } else if (e?.code === 'EACCES' || e?.code === 'EPERM') {
            reply.code(403).send({ error: 'permission denied', path: filePath });
          } else {
            reply
              .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
              .send({ error: `failed to read file: ${e?.message ?? String(err)}` });
          }
        }
      },
    );
  }

  // ============================================================
  // Health Routes
  // ============================================================

  private setupHealthRoutes(): void {
    this.fastify.get('/ping', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(HTTP_STATUS.OK).send({
        status: 'ok',
        message: 'pong',
      });
    });
  }

  // ============================================================
  // MCP Routes
  // ============================================================

  private setupMcpRoutes(): void {
    // SSE endpoint
    this.fastify.get('/sse', async (_, reply) => {
      reply.hijack();
      try {
        const transport = new SSEServerTransport('/messages', reply.raw);
        this.transportsMap.set(transport.sessionId, transport);

        reply.raw.on('close', () => {
          this.transportsMap.delete(transport.sessionId);
        });

        const server = createMcpServer();
        await server.connect(transport);
      } catch (error) {
        if (!reply.raw.writableEnded) {
          reply.raw.writeHead(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            'Content-Type': 'application/json',
          });
          reply.raw.end(JSON.stringify({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR }));
        }
      }
    });

    // SSE messages endpoint
    this.fastify.post('/messages', async (req, reply) => {
      try {
        const { sessionId } = req.query as { sessionId?: string };
        const transport = this.transportsMap.get(sessionId || '') as SSEServerTransport;
        if (!sessionId || !transport) {
          reply.code(HTTP_STATUS.BAD_REQUEST).send('No transport found for sessionId');
          return;
        }

        await transport.handlePostMessage(req.raw, reply.raw, req.body);
      } catch (error) {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    });

    // MCP POST endpoint
    this.fastify.post('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined = this.transportsMap.get(
        sessionId || '',
      ) as StreamableHTTPServerTransport;

      if (transport) {
        // Transport found, proceed
      } else if (!sessionId && isInitializeRequest(request.body)) {
        const newSessionId = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          enableJsonResponse: true,
          onsessioninitialized: (initializedSessionId) => {
            if (transport && initializedSessionId === newSessionId) {
              this.transportsMap.set(initializedSessionId, transport);
            }
          },
        });

        transport.onclose = () => {
          if (transport?.sessionId && this.transportsMap.get(transport.sessionId)) {
            this.transportsMap.delete(transport.sessionId);
          }
        };
        await createMcpServer().connect(transport);
      } else {
        const hasStaleSession = Boolean(sessionId);
        sendJsonRpcError(
          reply,
          hasStaleSession ? HTTP_STATUS.NOT_FOUND : HTTP_STATUS.BAD_REQUEST,
          hasStaleSession ? JSON_RPC_SESSION_NOT_FOUND : JSON_RPC_SERVER_ERROR,
          hasStaleSession ? 'Session not found' : ERROR_MESSAGES.INVALID_MCP_REQUEST,
        );
        return;
      }

      reply.hijack();
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        if (!reply.raw.writableEnded) {
          writeRawJsonRpcError(
            reply,
            HTTP_STATUS.INTERNAL_SERVER_ERROR,
            JSON_RPC_INTERNAL_ERROR,
            ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR,
          );
        }
      }
    });

    // MCP GET endpoint (SSE stream)
    this.fastify.get('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId
        ? (this.transportsMap.get(sessionId) as StreamableHTTPServerTransport)
        : undefined;

      if (!transport) {
        sendJsonRpcError(
          reply,
          sessionId ? HTTP_STATUS.NOT_FOUND : HTTP_STATUS.BAD_REQUEST,
          sessionId ? JSON_RPC_SESSION_NOT_FOUND : JSON_RPC_SERVER_ERROR,
          sessionId ? 'Session not found' : ERROR_MESSAGES.INVALID_SSE_SESSION,
        );
        return;
      }

      reply.hijack();

      try {
        await transport.handleRequest(request.raw, reply.raw);
      } catch (error) {
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }

      request.socket.on('close', () => {
        request.log.info(`SSE client disconnected for session: ${sessionId}`);
      });
    });

    // MCP DELETE endpoint
    this.fastify.delete('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId
        ? (this.transportsMap.get(sessionId) as StreamableHTTPServerTransport)
        : undefined;

      if (!transport) {
        sendJsonRpcError(
          reply,
          sessionId ? HTTP_STATUS.NOT_FOUND : HTTP_STATUS.BAD_REQUEST,
          sessionId ? JSON_RPC_SESSION_NOT_FOUND : JSON_RPC_SERVER_ERROR,
          sessionId ? 'Session not found' : ERROR_MESSAGES.INVALID_SESSION_ID,
        );
        return;
      }

      reply.hijack();
      try {
        await transport.handleRequest(request.raw, reply.raw);
        if (!reply.raw.writableEnded) {
          reply.raw.writeHead(HTTP_STATUS.NO_CONTENT);
          reply.raw.end();
        }
      } catch (error) {
        if (!reply.raw.writableEnded) {
          writeRawJsonRpcError(
            reply,
            HTTP_STATUS.INTERNAL_SERVER_ERROR,
            JSON_RPC_INTERNAL_ERROR,
            ERROR_MESSAGES.MCP_SESSION_DELETION_ERROR,
          );
        }
      }
    });
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  public async start(port = NATIVE_SERVER_PORT, nativeHost: NativeMessagingHost): Promise<void> {
    if (!this.nativeHost) {
      this.nativeHost = nativeHost;
    } else if (this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      return;
    }

    try {
      await this.fastify.listen({ port, host: SERVER_CONFIG.HOST });

      // Set port environment variables after successful listen for Chrome MCP URL resolution
      process.env.CHROME_MCP_PORT = String(port);
      process.env.MCP_HTTP_PORT = String(port);

      this.isRunning = true;
      // Watches (chrome_watch_start) are persisted and resume with the process
      // that owns the port; a host that lost the port race never runs them.
      watchManager.init();
      // Leases too: a host that lost the port race must not act on the leases
      // of the bridge that won it.
      leaseRegistry.enablePersistence(path.join(updateStateDir(), LEASES_FILE));
    } catch (err) {
      this.isRunning = false;
      throw err;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      // Held long polls would keep close() waiting for minutes.
      watchManager.releaseWaiters();
      watchManager.flush();
      await this.fastify.close();
      this.isRunning = false;
    } catch (err) {
      this.isRunning = false;
      throw err;
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

const serverInstance = new Server();
export default serverInstance;
