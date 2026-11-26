/**
 * A request from a module to the bridge over this profile's connection,
 * without the module importing native-host.ts (which imports the modules).
 * native-host.ts sets the sender when it starts.
 */

export type BridgeSender = (type: string, payload: unknown, timeoutMs?: number) => Promise<any>;

let sender: BridgeSender | null = null;

export function setBridgeSender(next: BridgeSender | null): void {
  sender = next;
}

/** Send a typed request to the bridge; rejects when there is no connection. */
export function askBridge(type: string, payload: unknown, timeoutMs?: number): Promise<any> {
  if (!sender) return Promise.reject(new Error('not connected to the bridge'));
  return sender(type, payload, timeoutMs);
}
