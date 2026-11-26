/**
 * Requests this extension sends to the bridge over its WebSocket (the module
 * switch), and the bookkeeping for their answers.
 *
 * The bridge answers `{responseToRequestId, payload: {status, data | error}}`.
 * A bridge older than the module switch never answers, so every request has a
 * timeout, and a socket that closes fails what is still pending at once.
 */

/** How long a request waits for the bridge. */
export const BRIDGE_REQUEST_TIMEOUT_MS = 5000;

/** WebSocket.OPEN, without depending on the WebSocket global. */
const SOCKET_OPEN = 1;

export interface BridgeSocket {
  readyState: number;
  send(data: string): void;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeRequests {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly timeoutMs: number = BRIDGE_REQUEST_TIMEOUT_MS,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Requests still waiting for an answer. */
  get size(): number {
    return this.pending.size;
  }

  /** Send `{type, requestId, payload}` and wait for the answer's data. */
  request(
    socket: BridgeSocket | null,
    type: string,
    payload?: unknown,
    timeoutMs: number = this.timeoutMs,
  ): Promise<any> {
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      return Promise.reject(new Error('not connected to the bridge'));
    }
    const requestId = this.newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('the bridge did not answer (a bridge older than the module switch?)'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type, requestId, payload }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Settle the request a bridge answer belongs to. False when it is not ours. */
  settle(message: { responseToRequestId?: string; payload?: any }): boolean {
    const id = message?.responseToRequestId;
    const pending = id ? this.pending.get(id) : undefined;
    if (!id || !pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.payload?.status === 'success') pending.resolve(message.payload.data);
    else pending.reject(new Error(message.payload?.error || 'the bridge refused'));
    return true;
  }

  /** The socket went away: fail everything still waiting, with `reason`. */
  rejectAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }
  }
}
