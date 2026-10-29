#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import * as path from 'path';
import { startUpdateChecker, updateStateDir } from './update-checker';
import { profileRegistry } from './server/profile-registry';
import { watchManager } from './mcp/watch-instance';
import { installModuleSync } from './server/module-sync';
import { installLeaseRecovery } from './server/lease-recovery';
import { wireToolListChanged } from './mcp/mcp-server';
import { migrateOnStart } from './startup-migration';

// First, before anything reads the data dir or writes the state dir: the
// first 2.x start moves ~/.workatomcp to ~/.mokutab and records whether this
// machine is an upgrade, which it reads off the state dir 1.x left (so
// nothing below may create that dir earlier). It never throws, and a failure
// must not keep the bridge from starting either.
try {
  migrateOnStart();
} catch (error) {
  console.error('[data-dir] the data dir check failed:', error);
}

try {
  // The default profile outlives a bridge restart (an extension reload of the
  // profile that owns the port restarts this process).
  profileRegistry.enablePreferencePersistence(path.join(updateStateDir(), 'default-profile.json'));
  // The module switch: popups read and write it over the extension
  // connection, profiles get it pushed, open MCP sessions get list_changed.
  installModuleSync();
  // Tabs leased before a restart close when their profile reconnects.
  installLeaseRecovery();
  wireToolListChanged();
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  nativeMessagingHostInstance.start();
  // Self-update: exiting cleanly makes the extension respawn the host via the
  // wrapper, which installs the pending version before the next launch.
  startUpdateChecker(() => {
    serverInstance
      .stop()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
} catch (error) {
  process.exit(1);
}

process.on('error', (error) => {
  process.exit(1);
});

// Handle process signals and uncaught exceptions
process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('exit', () => {
  // Watch state written on a timer must not be lost to a restart.
  watchManager.flush();
});

process.on('uncaughtException', (error) => {
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Don't exit immediately, let the program continue running
});
