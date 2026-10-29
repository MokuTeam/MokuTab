/**
 * Profile Registry - Manage active Chrome profile connections over WebSockets.
 *
 * Author: Roman Chikalenko
 * Version: 1.4.0
 */
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeoutId: NodeJS.Timeout;
  /** The socket the request went out on; its close fails the request. */
  socket: any;
}

function logProfileRegistry(message: string): void {
  console.error(message);
}

export class ProfileRegistry {
  private connections: Map<string, any> = new Map(); // profileName -> WebSocket socket
  private activeProfile: string | null = null;
  /**
   * The profile calls default to. Unlike activeProfile it survives the profile
   * disconnecting: when it comes back it is the default again, so a reload or
   * a reconnect cannot quietly move unpinned calls to another client's
   * workspace. Persisted when a preference file is set (the running bridge),
   * so a bridge restart keeps it too.
   */
  private preferredProfile: string | null = null;
  private preferenceFile: string | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private defaultTimeoutMs = 120000;
  /**
   * Bumped whenever the set of connected profiles changes. A pinned MCP session
   * watches it: a profile that reconnected is a new browser session, so the
   * tab it pinned has to be re-validated before the next call is routed.
   */
  private generation = 0;
  /** Per-profile serial of the current socket; a reconnect gets a higher one. */
  private connectionSerials: Map<string, number> = new Map();
  /** Per-profile id of the Chrome session its extension runs in (see browser-session.ts there). */
  private browserSessions: Map<string, string> = new Map();
  private nextSerial = 0;
  /** Requests the extension sends to the bridge (popup -> background -> here), by type. */
  private requestHandlers: Map<string, (payload: any, profileName: string) => unknown> = new Map();
  private registerListeners: Set<(profileName: string) => void> = new Set();

  /**
   * Answer extension-initiated requests of `type` (`{type, requestId, payload}`)
   * with `{responseToRequestId, payload: {status, data | error}}`.
   */
  public setRequestHandler(
    type: string,
    handler: (payload: any, profileName: string) => unknown,
  ): void {
    this.requestHandlers.set(type, handler);
  }

  /** Called after a profile (re)connects, e.g. to push it the current state. */
  public onRegister(listener: (profileName: string) => void): () => void {
    this.registerListeners.add(listener);
    return () => this.registerListeners.delete(listener);
  }

  /** Fire-and-forget message to one profile. False when it is not connected. */
  public notify(profileName: string, type: string, payload: unknown): boolean {
    const socket = this.connections.get(profileName);
    if (!socket) return false;
    try {
      socket.send(JSON.stringify({ type, payload }));
      return true;
    } catch (err: any) {
      logProfileRegistry(
        `[ProfileRegistry] Could not send ${type} to profile "${profileName}": ${err?.message}`,
      );
      return false;
    }
  }

  /** Fire-and-forget message to every connected profile; returns how many got it. */
  public broadcast(type: string, payload: unknown): number {
    let sent = 0;
    for (const profileName of this.connections.keys()) {
      if (this.notify(profileName, type, payload)) sent += 1;
    }
    return sent;
  }

  /**
   * Remember the default profile in `file` across bridge restarts. Only the
   * running host calls this; tests keep the registry in memory.
   */
  public enablePreferencePersistence(file: string): void {
    this.preferenceFile = file;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { profile?: unknown };
      if (typeof parsed.profile === 'string' && parsed.profile.trim() !== '') {
        this.preferredProfile = parsed.profile;
        if (this.connections.has(parsed.profile)) this.activeProfile = parsed.profile;
      }
    } catch {
      // No file yet, or unreadable: the first profile to connect becomes the default.
    }
  }

  private setPreferredProfile(profileName: string): void {
    this.preferredProfile = profileName;
    if (!this.preferenceFile) return;
    try {
      fs.mkdirSync(path.dirname(this.preferenceFile), { recursive: true });
      fs.writeFileSync(
        this.preferenceFile,
        JSON.stringify({ profile: profileName, set_at: new Date().toISOString() }),
      );
    } catch (error: any) {
      logProfileRegistry(
        `[ProfileRegistry] Could not persist default profile "${profileName}": ${error?.message}`,
      );
    }
  }

  /**
   * Register a new profile connection
   */
  public register(profileName: string, socket: any, browserSession?: string | null): void {
    // Take the slot before closing the old socket, so a close event that fires
    // synchronously already sees the new socket and leaves the profile alone.
    const existing = this.connections.get(profileName);
    this.connections.set(profileName, socket);
    if (existing && existing !== socket) {
      try {
        existing.close();
      } catch (e) {
        // Ignore
      }
    }

    this.nextSerial += 1;
    this.connectionSerials.set(profileName, this.nextSerial);
    // An extension from before the lease fix sends none: no saved lease matches it.
    if (browserSession) this.browserSessions.set(profileName, browserSession);
    else this.browserSessions.delete(profileName);
    this.generation += 1;
    logProfileRegistry(`[ProfileRegistry] Profile "${profileName}" connected.`);

    if (this.preferredProfile === profileName && this.activeProfile !== profileName) {
      this.activeProfile = profileName;
      logProfileRegistry(
        `[ProfileRegistry] Default profile "${profileName}" is back; active again.`,
      );
    } else if (!this.activeProfile || !this.connections.has(this.activeProfile)) {
      // If no active profile, or the active profile is no longer connected, set this as active
      this.activeProfile = profileName;
      logProfileRegistry(`[ProfileRegistry] Active profile automatically set to "${profileName}".`);
      if (this.preferredProfile === null) this.setPreferredProfile(profileName);
    }

    // Set up message handling for this socket
    socket.on('message', (rawData: any) => {
      try {
        const message = JSON.parse(rawData.toString());
        this.handleIncomingMessage(profileName, message);
      } catch (error: any) {
        console.error(
          `[ProfileRegistry] Failed to parse message from profile "${profileName}":`,
          error.message,
        );
      }
    });

    socket.on('close', () => {
      this.handleSocketClosed(profileName, socket);
    });

    socket.on('error', (err: any) => {
      console.error(`[ProfileRegistry] Socket error for profile "${profileName}":`, err);
      this.handleSocketClosed(profileName, socket);
    });

    for (const listener of this.registerListeners) {
      try {
        listener(profileName);
      } catch (err: any) {
        logProfileRegistry(`[ProfileRegistry] A connect listener failed: ${err?.message}`);
      }
    }
  }

  /**
   * A socket went away. Its in-flight requests fail now instead of waiting out
   * their timeout, and the profile is dropped only if this is still its socket:
   * after a reconnect the old socket's close can arrive late, and it must not
   * remove the new connection.
   */
  private handleSocketClosed(profileName: string, socket: any): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(`Profile "${profileName}" disconnected before replying`));
    }
    if (this.connections.get(profileName) === socket) {
      this.deregister(profileName);
    }
  }

  /**
   * Deregister a profile connection
   */
  public deregister(profileName: string): void {
    if (this.connections.has(profileName)) {
      this.connections.delete(profileName);
      this.connectionSerials.delete(profileName);
      this.browserSessions.delete(profileName);
      this.generation += 1;
      logProfileRegistry(`[ProfileRegistry] Profile "${profileName}" disconnected.`);

      if (this.activeProfile === profileName) {
        // Elect a new active profile from remaining connections
        const remaining = Array.from(this.connections.keys());
        if (remaining.length > 0) {
          this.activeProfile = remaining[0];
          logProfileRegistry(
            `[ProfileRegistry] Active profile automatically switched to "${this.activeProfile}".`,
          );
        } else {
          this.activeProfile = null;
          logProfileRegistry(`[ProfileRegistry] No profiles connected. Active profile is null.`);
        }
      }
    }
  }

  /**
   * Switch the active profile
   */
  public switchProfile(profileName: string): boolean {
    if (this.connections.has(profileName)) {
      this.activeProfile = profileName;
      this.setPreferredProfile(profileName);
      logProfileRegistry(`[ProfileRegistry] Active profile switched to "${profileName}".`);
      return true;
    }
    console.warn(
      `[ProfileRegistry] Cannot switch to "${profileName}" because it is not connected.`,
    );
    return false;
  }

  /**
   * Connection-set generation. Changes on every register/deregister, including
   * a reconnect of the same profile name.
   */
  public getGeneration(): number {
    return this.generation;
  }

  /**
   * Serial of the profile's current socket, or null when it is not connected.
   * A reconnect always yields a higher serial, so a caller that recorded one
   * can tell "reconnected" from "never dropped".
   */
  public getConnectionSerial(profileName: string): number | null {
    return this.connectionSerials.get(profileName) ?? null;
  }

  /**
   * The id the profile's extension gave for its Chrome session, or null (not
   * connected, or an extension that sends none). Tab ids are only meaningful
   * within one Chrome session.
   */
  public getBrowserSession(profileName: string): string | null {
    return this.browserSessions.get(profileName) ?? null;
  }

  /**
   * Get the active profile name
   */
  public getActiveProfile(): string | null {
    // Double check that activeProfile is still connected
    if (this.activeProfile && !this.connections.has(this.activeProfile)) {
      const remaining = Array.from(this.connections.keys());
      this.activeProfile = remaining.length > 0 ? remaining[0] : null;
    }
    return this.activeProfile;
  }

  /** The profile unpinned calls return to once it is connected. */
  public getPreferredProfile(): string | null {
    return this.preferredProfile;
  }

  /**
   * Get all connected profile names
   */
  public getConnectedProfiles(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Send a request to a specific profile and wait for response
   */
  public sendRequest(
    profileName: string,
    messagePayload: any,
    messageType: string = 'request_data',
    timeoutMs: number = this.defaultTimeoutMs,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = this.connections.get(profileName);
      if (!socket) {
        return reject(new Error(`Profile "${profileName}" is not connected`));
      }

      const requestId = uuidv4();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request to profile "${profileName}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeoutId, socket });

      const envelope = {
        type: messageType,
        payload: messagePayload,
        requestId: requestId,
      };

      try {
        socket.send(JSON.stringify(envelope));
      } catch (err: any) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(requestId);
        reject(new Error(`Failed to send message to profile "${profileName}": ${err.message}`));
      }
    });
  }

  /** Run an extension-initiated request and send the answer back on its socket. */
  private async answerRequest(
    profileName: string,
    message: any,
    handler: (payload: any, profileName: string) => unknown,
  ): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = { status: 'success', data: await handler(message.payload, profileName) };
    } catch (err: any) {
      payload = { status: 'error', error: err?.message || String(err) };
    }
    const socket = this.connections.get(profileName);
    try {
      socket?.send(JSON.stringify({ responseToRequestId: message.requestId, payload }));
    } catch (err: any) {
      logProfileRegistry(
        `[ProfileRegistry] Could not answer ${message.type} from "${profileName}": ${err?.message}`,
      );
    }
  }

  /**
   * Handle incoming message from WebSocket client
   */
  private handleIncomingMessage(profileName: string, message: any): void {
    if (!message || typeof message !== 'object') return;

    if (typeof message.type === 'string' && message.requestId && !message.responseToRequestId) {
      const handler = this.requestHandlers.get(message.type);
      if (handler) void this.answerRequest(profileName, message, handler);
      return;
    }

    if (message.responseToRequestId) {
      const requestId = message.responseToRequestId;
      const pending = this.pendingRequests.get(requestId);

      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(requestId);
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          // Return the full payload (containing status, data, error)
          pending.resolve(message.payload);
        }
      }
    }
  }
}

export const profileRegistry = new ProfileRegistry();
