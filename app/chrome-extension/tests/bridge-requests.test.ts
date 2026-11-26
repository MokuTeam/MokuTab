/**
 * The module switch requests the background sends to the bridge: the 5 s
 * timeout, a closed socket, and an old bridge that never answers.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NativeMessageType } from '@mokuhub/mokutab-shared';
import {
  BRIDGE_REQUEST_TIMEOUT_MS,
  BridgeRequests,
  type BridgeSocket,
} from '@/entrypoints/background/bridge-requests';
import {
  BRIDGE_RECONNECT_WAIT_MS,
  askBridge,
  notifyBridgeReady,
  setBridgeSender,
} from '@/entrypoints/background/bridge-channel';
import { createModulePopupHandlers } from '@/entrypoints/background/module-popup';

const OPEN = 1;
const CLOSED = 3;

/** A socket that records what is sent; `answer` plays the bridge. */
function fakeSocket(answer?: (message: any) => unknown) {
  const sent: any[] = [];
  const socket: BridgeSocket & { sent: any[] } = {
    readyState: OPEN,
    sent,
    send(data: string) {
      const message = JSON.parse(data);
      sent.push(message);
      if (answer) queueMicrotask(() => answer(message));
    },
  };
  return socket;
}

let ids = 0;
const nextId = () => `r${++ids}`;

beforeEach(() => {
  ids = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  setBridgeSender(null);
  vi.useRealTimers();
});

describe('BridgeRequests', () => {
  test('the answer with the request id resolves to its data', async () => {
    const requests = new BridgeRequests(BRIDGE_REQUEST_TIMEOUT_MS, nextId);
    const socket = fakeSocket((message) =>
      requests.settle({
        responseToRequestId: message.requestId,
        payload: { status: 'success', data: { modules: [] } },
      }),
    );
    await expect(requests.request(socket, NativeMessageType.MODULES_GET)).resolves.toEqual({
      modules: [],
    });
    expect(socket.sent).toEqual([
      { type: NativeMessageType.MODULES_GET, requestId: 'r1', payload: undefined },
    ]);
    expect(requests.size).toBe(0);
  });

  test('an error answer rejects with the bridge message', async () => {
    const requests = new BridgeRequests(BRIDGE_REQUEST_TIMEOUT_MS, nextId);
    const socket = fakeSocket((message) =>
      requests.settle({
        responseToRequestId: message.requestId,
        payload: { status: 'error', error: 'unknown module "x"' },
      }),
    );
    await expect(
      requests.request(socket, NativeMessageType.MODULES_SET, { id: 'x', enabled: false }),
    ).rejects.toThrow('unknown module "x"');
  });

  test('no answer within 5 s rejects, and nothing is left pending', async () => {
    const requests = new BridgeRequests(BRIDGE_REQUEST_TIMEOUT_MS, nextId);
    const pending = requests.request(fakeSocket(), NativeMessageType.MODULES_GET);
    const outcome = expect(pending).rejects.toThrow(/did not answer/);
    await vi.advanceTimersByTimeAsync(BRIDGE_REQUEST_TIMEOUT_MS - 1);
    expect(requests.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(requests.size).toBe(0);
  });

  test('a late answer after the timeout is ignored', async () => {
    const requests = new BridgeRequests(BRIDGE_REQUEST_TIMEOUT_MS, nextId);
    const pending = requests.request(fakeSocket(), NativeMessageType.MODULES_GET);
    const outcome = expect(pending).rejects.toThrow(/did not answer/);
    await vi.advanceTimersByTimeAsync(BRIDGE_REQUEST_TIMEOUT_MS);
    await outcome;
    expect(requests.settle({ responseToRequestId: 'r1', payload: { status: 'success' } })).toBe(
      false,
    );
  });

  test('a closed or missing socket is refused at once', async () => {
    const requests = new BridgeRequests(BRIDGE_REQUEST_TIMEOUT_MS, nextId);
    const closed = fakeSocket();
    closed.readyState = CLOSED;
    await expect(requests.request(closed, NativeMessageType.MODULES_GET)).rejects.toThrow(
      'not connected to the bridge',
    );
    await expect(requests.request(null, NativeMessageType.MODULES_GET)).rejects.toThrow(
      'not connected to the bridge',
    );
    expect(closed.sent).toEqual([]);
  });

  test('a socket that closes fails what is pending, before the timeout', async () => {
    const requests = new BridgeRequests(BRIDGE_REQUEST_TIMEOUT_MS, nextId);
    const first = requests.request(fakeSocket(), NativeMessageType.MODULES_GET);
    const second = requests.request(fakeSocket(), NativeMessageType.MODULES_SET, {});
    requests.rejectAll('the bridge connection closed');
    await expect(first).rejects.toThrow('the bridge connection closed');
    await expect(second).rejects.toThrow('the bridge connection closed');
    expect(requests.size).toBe(0);
  });
});

describe('the popup handlers', () => {
  const MODULES = [{ id: 'workato', title: 'Workato', description: 'Workato things.' }];

  /** `makeSocket` gets the request table, so a fake bridge can answer through it. */
  function handlers(
    makeSocket: (requests: BridgeRequests) => (BridgeSocket & { sent: any[] }) | null,
    stored: Record<string, boolean> = {},
  ) {
    const requests = new BridgeRequests(BRIDGE_REQUEST_TIMEOUT_MS, nextId);
    const socket = makeSocket(requests);
    const applied: unknown[] = [];
    const popup = createModulePopupHandlers({
      socket: () => socket,
      requests,
      applyState: async (payload) => {
        applied.push(payload);
      },
      storedStates: async () => stored,
      modules: MODULES,
    });
    return { popup, socket, applied };
  }

  test('no bridge: the stored state, marked disconnected', async () => {
    const { popup } = handlers(() => null, { workato: false });
    await expect(popup.getModules()).resolves.toEqual({
      success: true,
      bridge: 'disconnected',
      modules: [{ ...MODULES[0], enabled: false }],
    });
    const set = await popup.setModule('workato', true);
    expect(set.success).toBe(false);
    expect(set.bridge).toBe('disconnected');
  });

  test('a current bridge: its answer is applied, and the switch is editable', async () => {
    const made = handlers((requests) =>
      fakeSocket((message) =>
        requests.settle({
          responseToRequestId: message.requestId,
          payload: { status: 'success', data: { modules: [{ id: 'workato', enabled: true }] } },
        }),
      ),
    );
    const reply = await made.popup.getModules();
    expect(reply.bridge).toBe('connected');
    expect(made.applied).toEqual([{ modules: [{ id: 'workato', enabled: true }] }]);
  });

  test('an old bridge that never answers: unsupported after the timeout, nothing applied', async () => {
    const { popup, applied } = handlers(() => fakeSocket(), { workato: true });
    const reply = popup.getModules();
    await vi.advanceTimersByTimeAsync(BRIDGE_REQUEST_TIMEOUT_MS);
    await expect(reply).resolves.toMatchObject({
      success: true,
      bridge: 'unsupported',
      error: expect.stringMatching(/did not answer/),
      modules: [{ id: 'workato', enabled: true }],
    });
    expect(applied).toEqual([]);
  });

  test('a refused set says why and keeps the switch editable', async () => {
    const made = handlers((requests) =>
      fakeSocket((message) =>
        requests.settle({
          responseToRequestId: message.requestId,
          payload: {
            status: 'error',
            error: 'could not read config.json (EBUSY); nothing changed',
          },
        }),
      ),
    );
    const reply = await made.popup.setModule('workato', false);
    expect(reply).toMatchObject({ success: false, bridge: 'connected' });
    expect(reply.error).toMatch(/EBUSY/);
    expect(made.socket?.sent[0]).toMatchObject({
      type: NativeMessageType.MODULES_SET,
      payload: { id: 'workato', enabled: false },
    });
  });
});

describe('askBridge reconnect retry', () => {
  test('a closed socket or missing sender waits once for notifyBridgeReady and retries', async () => {
    const calls: string[] = [];
    const pending = askBridge('ns_session_changed', { host: '1234567.app.netsuite.com' });
    setBridgeSender(async (type) => {
      calls.push(type);
      return { state: 'published' };
    });
    notifyBridgeReady();
    await expect(pending).resolves.toEqual({ state: 'published' });
    expect(calls).toEqual(['ns_session_changed']);

    let attempt = 0;
    setBridgeSender(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('the bridge connection closed');
      return { ok: true };
    });
    const closedPending = askBridge('ns_activity', { host: '1234567.app.netsuite.com' });
    await Promise.resolve();
    notifyBridgeReady();
    await expect(closedPending).resolves.toEqual({ ok: true });
    expect(attempt).toBe(2);
  });

  test('a failed retry does not retry a second time', async () => {
    let attempts = 0;
    setBridgeSender(async () => {
      attempts += 1;
      throw new Error('the bridge connection closed');
    });
    const pending = askBridge('ns_session_changed', { host: '1234567.app.netsuite.com' });
    await Promise.resolve();
    notifyBridgeReady();
    await expect(pending).rejects.toThrow('the bridge connection closed');
    expect(attempts).toBe(2);
  });

  test('gives up when the bridge does not reconnect within the wait window', async () => {
    setBridgeSender(null);
    const pending = askBridge('ns_session_changed', { host: '1234567.app.netsuite.com' }, 20_000);
    const outcome = expect(pending).rejects.toThrow('not connected to the bridge');
    await vi.advanceTimersByTimeAsync(BRIDGE_RECONNECT_WAIT_MS);
    await outcome;
  });

  test('non-socket errors reject immediately without waiting', async () => {
    let attempts = 0;
    setBridgeSender(async () => {
      attempts += 1;
      throw new Error('unknown module "x"');
    });
    await expect(askBridge('ns_session_changed', {})).rejects.toThrow('unknown module "x"');
    expect(attempts).toBe(1);
  });
});
