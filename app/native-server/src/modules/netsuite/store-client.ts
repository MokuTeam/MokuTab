/**
 * The bridge's client for the NetSuite session store (see the
 * contract in the module README section).
 *
 * The store host writes `<state dir>/ns-store-token` (line 1: the token; optional
 * line 2: the base URL); the file is re-read when its mtime changes. No file:
 * the store is unconfigured on this machine. A 503, a timeout, any 5xx or a
 * body that is not JSON means "no store" and backs off for 30 s: callers then
 * behave as without a store. Only method, path, status and time are logged,
 * never a body (publish bodies and entry answers carry cookie values).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readEnv } from '../../env';
import { updateStateDir } from '../../update-checker';

export const NS_STORE_TOKEN_FILE = 'ns-store-token';
export const NS_STORE_URL_ENV = 'MOKUTAB_NS_STORE_URL';
export const DEFAULT_NS_STORE_URL = 'http://127.0.0.1:12422/api/ns-sessions';
export const NS_STORE_TIMEOUT_MS = 4_000;
export const NS_STORE_BACKOFF_MS = 30_000;

export type StoreAnswer =
  | { kind: 'ok'; status: number; body: any }
  | { kind: 'error'; status: number; code: string; body: any }
  | { kind: 'unconfigured' }
  | { kind: 'no_store'; reason: string };

export interface StoreIo {
  readFile(file: string): string;
  /** mtime in ms, or null when the file does not exist. */
  mtime(file: string): number | null;
  fetch: typeof fetch;
  now(): number;
  log(line: string): void;
  env: NodeJS.ProcessEnv;
}

const realIo = (): StoreIo => ({
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  mtime: (file) => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  },
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  log: (line) => console.error(line),
  env: process.env,
});

export interface StoreConfig {
  token: string;
  base: string;
}

/** The token file: line 1 the token, optional line 2 a base URL. Null when unusable. */
export function parseTokenFile(text: string): { token: string; base?: string } | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines[0] || /\s/.test(lines[0])) return null;
  const base =
    lines[1] && /^https?:\/\//i.test(lines[1]) ? lines[1].replace(/\/+$/, '') : undefined;
  return { token: lines[0], ...(base ? { base } : {}) };
}

export class NsStoreClient {
  private cached: { mtime: number; config: StoreConfig | null } | null = null;
  private backoffUntil = 0;
  private readonly io: StoreIo;

  constructor(
    private readonly tokenFile: () => string = () =>
      path.join(updateStateDir(), NS_STORE_TOKEN_FILE),
    io: Partial<StoreIo> = {},
    private readonly client: string = `mokutab ${os.hostname()}`,
  ) {
    this.io = { ...realIo(), ...io };
  }

  /** The token and base URL, re-read when the file changed; null when there is no usable file. */
  config(): StoreConfig | null {
    const file = this.tokenFile();
    const mtime = this.io.mtime(file);
    if (mtime === null) {
      this.cached = null;
      return null;
    }
    if (this.cached && this.cached.mtime === mtime) return this.cached.config;
    let config: StoreConfig | null = null;
    try {
      const parsed = parseTokenFile(this.io.readFile(file));
      if (parsed) {
        const override = readEnv(NS_STORE_URL_ENV, this.io.env)?.trim().replace(/\/+$/, '');
        config = { token: parsed.token, base: override || parsed.base || DEFAULT_NS_STORE_URL };
      }
    } catch {
      config = null;
    }
    this.cached = { mtime, config };
    return config;
  }

  async request(
    method: 'GET' | 'POST',
    route: string,
    options: {
      body?: unknown;
      query?: Record<string, string | undefined>;
      clientTag?: string;
    } = {},
  ): Promise<StoreAnswer> {
    const config = this.config();
    if (!config) return { kind: 'unconfigured' };
    if (this.io.now() < this.backoffUntil) {
      return { kind: 'no_store', reason: 'the store did not answer a moment ago (backing off)' };
    }
    const query = Object.entries(options.query ?? {})
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${config.base}${route}${query ? `?${query}` : ''}`;
    const started = this.io.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NS_STORE_TIMEOUT_MS);
    let status = 0;
    try {
      const response = await this.io.fetch(url, {
        method,
        headers: {
          'X-NS-Store-Token': config.token,
          'X-Board': '1',
          'X-NS-Store-Client': options.clientTag
            ? `${this.client} ${options.clientTag}`
            : this.client,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      status = response.status;
      const text = await response.text();
      if (status === 503 || status >= 500) return this.noStore(`the store answered ${status}`);
      let body: any = null;
      if (text.trim() !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          return this.noStore(`the store answered ${status} without JSON`);
        }
      }
      if (status >= 200 && status < 300) return { kind: 'ok', status, body };
      const code =
        typeof body?.code === 'string'
          ? body.code
          : status === 401
            ? 'unauthorized'
            : `http_${status}`;
      return { kind: 'error', status, code, body };
    } catch (err: any) {
      return this.noStore(
        err?.name === 'AbortError'
          ? 'the store did not answer in 4 s'
          : 'the store is not reachable',
      );
    } finally {
      clearTimeout(timer);
      this.io.log(`[ns-store] ${method} ${route} ${status || '-'} ${this.io.now() - started}ms`);
    }
  }

  private noStore(reason: string): StoreAnswer {
    this.backoffUntil = this.io.now() + NS_STORE_BACKOFF_MS;
    return { kind: 'no_store', reason };
  }
}
