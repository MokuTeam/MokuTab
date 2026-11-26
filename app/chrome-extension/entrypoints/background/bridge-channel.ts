/**
 * A request from a module to the bridge over this profile's connection,
 * without the module importing native-host.ts (which imports the modules).
 * native-host.ts sets the sender when it starts.
 */

export type BridgeSender = (type: string, payload: unknown, timeoutMs?: number) => Promise<any>;

export const BRIDGE_RECONNECT_WAIT_MS = 15_000;
const SOCKET_CLOSED_RE = /not connected|connection closed/i;

let sender: BridgeSender | null = null;

export function setBridgeSender(next: BridgeSender | null): void {
  sender = next;
}

type ReadyListener = () => void;
const readyListeners = new Set<ReadyListener>();

/** Called when the bridge (re)connects and has pushed its module state. */
export function onBridgeReady(listener: ReadyListener): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

/** native-host.ts: the bridge connection is (back) up and the module state is known. */
export function notifyBridgeReady(): void {
  for (const listener of [...readyListeners]) {
    try {
      listener();
    } catch {
      /* a listener's failure is its own */
    }
  }
}

function isClosedSocketError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return SOCKET_CLOSED_RE.test(message);
}

function waitForBridgeReady(waitMs: number): Promise<boolean> {
  if (waitMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, waitMs);
    off = onBridgeReady(() => {
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

/**
 * Send a typed request to the bridge. On a closed-socket failure, wait once
 * for the bridge to reconnect and retry once before rejecting.
 */
export async function askBridge(type: string, payload: unknown, timeoutMs?: number): Promise<any> {
  const waitMs = Math.min(timeoutMs ?? 5_000, BRIDGE_RECONNECT_WAIT_MS);
  if (!sender) {
    const ready = await waitForBridgeReady(waitMs);
    if (!ready || !sender) throw new Error('not connected to the bridge');
    return await sender(type, payload, timeoutMs);
  }
  try {
    return await sender(type, payload, timeoutMs);
  } catch (err) {
    if (!isClosedSocketError(err)) throw err;
    const ready = await waitForBridgeReady(waitMs);
    if (!ready || !sender) throw err;
    return await sender(type, payload, timeoutMs);
  }
}
