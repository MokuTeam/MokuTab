<template>
  <div class="popup-shell">
    <header class="topbar">
      <div class="brand">
        <svg class="brand-mark" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <rect
            x="1.5"
            y="2.5"
            width="15"
            height="13"
            rx="3"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path d="M1.5 6.5h15" stroke="currentColor" stroke-width="1.5" />
          <circle cx="4.5" cy="4.5" r="0.85" fill="currentColor" />
          <circle cx="7" cy="4.5" r="0.85" fill="currentColor" />
          <path
            d="M5.5 9.8l2 1.8-2 1.8M9.2 13.4h3.3"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <h1 class="brand-title">{{ getMessage('extensionName') }}</h1>
      </div>

      <button
        type="button"
        class="profile-pill"
        :title="getMessage('profileNameLabel')"
        @click="settingsOpen = !settingsOpen"
      >
        {{ profileName }}
      </button>
    </header>

    <main class="main">
      <!-- Everyday connection summary -->
      <section class="card connection-card">
        <div class="connection-left">
          <span :class="['status-dot', statusDotClass]" aria-hidden="true"></span>
          <div class="connection-text">
            <p class="status-text">{{ statusText }}</p>
            <p v-if="serverStatus.lastUpdated" class="status-time">
              {{ getMessage('lastUpdatedLabel') }}
              {{ new Date(serverStatus.lastUpdated).toLocaleTimeString() }}
            </p>
          </div>
        </div>

        <div class="connection-actions">
          <button
            type="button"
            class="icon-btn"
            :title="getMessage('refreshStatusButton')"
            :aria-label="getMessage('refreshStatusButton')"
            @click="refreshAll"
          >
            <RefreshIcon class-name="refresh-svg" />
          </button>

          <button
            type="button"
            class="conn-btn"
            :class="nativeConnectionStatus === 'connected' ? 'secondary' : 'primary'"
            :disabled="isConnecting"
            @click="testNativeConnection"
          >
            {{
              isConnecting
                ? getMessage('connectingStatus')
                : nativeConnectionStatus === 'connected'
                  ? getMessage('disconnectButton')
                  : getMessage('connectButton')
            }}
          </button>
        </div>
      </section>

      <!-- Active NetSuite sessions (visible only while NetSuite module is on) -->
      <NsSessionsSection
        v-if="isNetsuiteEnabled"
        :entries="nsSessions"
        :status="nsSessionsStatus"
        :now-ms="nowMs"
        :opening-key="openingNsKey"
        :row-errors="nsRowErrors"
        @open="handleOpenNsSession"
      />

      <!-- Module switches: one per machine, kept in the bridge -->
      <section v-if="modules.length > 0" class="section">
        <div class="section-head">
          <h2 class="section-title">{{ getMessage('modulesSectionLabel') }}</h2>
        </div>

        <div class="card-group">
          <div v-for="module in modules" :key="module.id" class="module-row">
            <div class="module-text">
              <p class="module-name">{{ module.title }}</p>
              <p v-if="module.description" class="module-description">
                {{ module.description }}
              </p>
            </div>

            <button
              type="button"
              role="switch"
              class="switch"
              :class="{ on: module.enabled }"
              :aria-checked="module.enabled"
              :aria-label="module.title"
              :disabled="!modulesEditable || savingModule !== null"
              @click="toggleModule(module)"
            ></button>
          </div>

          <p v-if="modulesNote" class="modules-note">{{ modulesNote }}</p>
        </div>
      </section>

      <!-- Collapsible rare settings (port, profile name, MCP config) -->
      <SettingsSection
        v-model:open="settingsOpen"
        :port="nativeServerPort"
        :profile-name="profileName"
        :show-mcp-config="showMcpConfig"
        :mcp-config-json="mcpConfigJson"
        :copy-label="copyButtonText"
        @update-port="updatePort"
        @update-profile="updateProfileName"
        @copy-config="copyMcpConfig"
      />
    </main>

    <footer class="footer">
      <div class="footer-links">
        <button
          type="button"
          class="footer-link"
          :title="getMessage('guideLinkTitle')"
          @click="openWelcomePage"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="8" cy="8" r="6" stroke-width="1.4" />
            <path d="M8 7.2v3.5M8 5.2h.01" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <span>{{ getMessage('guideLinkLabel') }}</span>
        </button>

        <button
          type="button"
          class="footer-link"
          :title="getMessage('docsLinkTitle')"
          @click="openTroubleshooting"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
            <path
              d="M8 3.8C6.6 3 4.8 2.8 3 3.2v9.3c1.8-.4 3.6-.2 5 .6 1.4-.8 3.2-1 5-.6V3.2c-1.8-.4-3.6-.2-5 .6Zm0 0v9.3"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>{{ getMessage('docsLinkLabel') }}</span>
        </button>
      </div>

      <span class="footer-text">{{ getMessage('footerTagline') }}</span>
    </footer>
  </div>
</template>

<script lang="ts" setup>
/**
 * Extension popup UI main component.
 * Displays connection state, active NetSuite sessions, module switches, and collapsible settings.
 *
 * Author: Roman Chikalenko
 * Version: 1.6.0
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { LINKS, NATIVE_HOST, STORAGE_KEYS } from '@/common/constants';
import { getMessage } from '@/utils/i18n';
import { RefreshIcon } from './components/icons';
import NsSessionsSection from './components/NsSessionsSection.vue';
import SettingsSection from './components/SettingsSection.vue';
import {
  fetchNsSessions,
  NETSUITE_MODULE_ID,
  NS_SESSIONS_REFRESH_MS,
  errorMessageKey,
  openNsSession,
  sessionKey,
  type NsSessionEntry,
  type RuntimeSender,
} from './ns-sessions';

const nativeConnectionStatus = ref<'unknown' | 'connected' | 'disconnected'>('unknown');
const isConnecting = ref(false);
const nativeServerPort = ref<number>(NATIVE_HOST.DEFAULT_PORT);
const profileName = ref<string>('default');
const settingsOpen = ref(false);

const serverStatus = ref<{
  isRunning: boolean;
  port?: number;
  lastUpdated: number;
}>({
  isRunning: false,
  lastUpdated: Date.now(),
});

const showMcpConfig = computed(() => {
  return nativeConnectionStatus.value === 'connected' && serverStatus.value.isRunning;
});

const copyButtonText = ref(getMessage('copyShortButton'));
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

// Module switches. The state is the bridge's (one per machine); the background
// relays reads and writes over its bridge connection.
interface PopupModule {
  id: string;
  title: string;
  description?: string;
  enabled: boolean;
}
type ModulesBridge = 'connected' | 'disconnected' | 'unsupported';

const modules = ref<PopupModule[]>([]);
const modulesBridge = ref<ModulesBridge>('disconnected');
const modulesError = ref('');
const savingModule = ref<string | null>(null);

const modulesEditable = computed(() => modulesBridge.value === 'connected');

const modulesNote = computed(() => {
  if (modulesError.value) return getMessage('modulesSaveFailed', [modulesError.value]);
  if (modulesBridge.value === 'disconnected') return getMessage('modulesBridgeOffNote');
  if (modulesBridge.value === 'unsupported') return getMessage('modulesBridgeOldNote');
  return '';
});

// Active NetSuite sessions state.
const isNetsuiteEnabled = computed(() =>
  modules.value.some((module) => module.id === NETSUITE_MODULE_ID && module.enabled),
);
const nsSessions = ref<NsSessionEntry[]>([]);
const nsSessionsStatus = ref<'loading' | 'ready' | 'unreachable'>('loading');
const openingNsKey = ref<string | null>(null);
const nsRowErrors = ref<Record<string, string>>({});
const nowMs = ref(Date.now());
let nsRefreshTimer: ReturnType<typeof setInterval> | null = null;
let nsFetchSeq = 0;

const sendRuntimeMessage: RuntimeSender = (message) => chrome.runtime.sendMessage(message);

const stopNsRefreshTimer = () => {
  if (nsRefreshTimer !== null) {
    clearInterval(nsRefreshTimer);
    nsRefreshTimer = null;
  }
};

const loadNsSessions = async (silent = false) => {
  if (!isNetsuiteEnabled.value) return;
  const seq = ++nsFetchSeq;
  if (!silent && nsSessionsStatus.value !== 'ready') {
    nsSessionsStatus.value = 'loading';
  }
  const result = await fetchNsSessions(sendRuntimeMessage);
  if (seq !== nsFetchSeq || !isNetsuiteEnabled.value) return;
  nowMs.value = Date.now();
  nsSessionsStatus.value = result.status;
  nsSessions.value = result.entries;
};

watch(
  isNetsuiteEnabled,
  (enabled) => {
    stopNsRefreshTimer();
    nsFetchSeq++;
    if (!enabled) {
      nsSessions.value = [];
      nsSessionsStatus.value = 'loading';
      nsRowErrors.value = {};
      openingNsKey.value = null;
      return;
    }
    void loadNsSessions(false);
    nsRefreshTimer = setInterval(() => {
      void loadNsSessions(true);
    }, NS_SESSIONS_REFRESH_MS);
  },
  { immediate: true },
);

const handleOpenNsSession = async (entry: NsSessionEntry) => {
  if (openingNsKey.value !== null) return;
  const key = sessionKey(entry);
  openingNsKey.value = key;
  if (nsRowErrors.value[key]) {
    const nextErrors = { ...nsRowErrors.value };
    delete nextErrors[key];
    nsRowErrors.value = nextErrors;
  }
  try {
    const result = await openNsSession(entry.account, entry.user, sendRuntimeMessage);
    if (!result.ok) {
      nsRowErrors.value = { ...nsRowErrors.value, [key]: getMessage(errorMessageKey(result.code)) };
    }
  } finally {
    openingNsKey.value = null;
  }
};

/**
 * New module state from the bridge (after a connect, a switch, a push): when
 * the NetSuite module was on already, its list is reloaded now rather than at
 * the next 30 s tick (a change of the switch reloads through the watcher).
 */
const refreshNsAfterModules = (wasEnabled: boolean) => {
  if (wasEnabled && isNetsuiteEnabled.value) void loadNsSessions(true);
};

const applyModulesReply = (reply: any) => {
  const wasEnabled = isNetsuiteEnabled.value;
  if (Array.isArray(reply?.modules)) modules.value = reply.modules;
  if (reply?.bridge) modulesBridge.value = reply.bridge;
  modulesError.value = reply?.success === false && reply?.error ? String(reply.error) : '';
  refreshNsAfterModules(wasEnabled);
};

const loadModules = async () => {
  try {
    applyModulesReply(
      await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.GET_MODULES }),
    );
  } catch (error) {
    console.error('Failed to load module switches:', error);
  }
};

const toggleModule = async (module: PopupModule) => {
  if (!modulesEditable.value || savingModule.value !== null) return;
  savingModule.value = module.id;
  try {
    const reply = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.SET_MODULE,
      id: module.id,
      enabled: !module.enabled,
    });
    applyModulesReply(reply);
  } catch (error) {
    modulesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    savingModule.value = null;
  }
};

const onModulesChanged = (payload: any) => {
  const wasEnabled = isNetsuiteEnabled.value;
  const pushed = new Map<string, boolean>();
  for (const entry of Array.isArray(payload?.modules) ? payload.modules : []) {
    if (entry && typeof entry.id === 'string' && typeof entry.enabled === 'boolean') {
      pushed.set(entry.id, entry.enabled);
    }
  }
  modules.value = modules.value.map((module) => ({
    ...module,
    enabled: pushed.get(module.id) ?? module.enabled,
  }));
  refreshNsAfterModules(wasEnabled);
};

const mcpConfigJson = computed(() => {
  const port = serverStatus.value.port || nativeServerPort.value;
  const config = {
    mcpServers: {
      mokutab: {
        type: 'streamable-http',
        url: `http://127.0.0.1:${port}/mcp`,
      },
    },
  };
  return JSON.stringify(config, null, 2);
});

const statusDotClass = computed(() => {
  if (nativeConnectionStatus.value === 'connected') {
    return serverStatus.value.isRunning ? 'running' : 'idle';
  }
  if (nativeConnectionStatus.value === 'disconnected') return 'offline';
  return 'unknown';
});

const statusText = computed(() => {
  if (nativeConnectionStatus.value === 'connected') {
    if (serverStatus.value.isRunning) {
      return getMessage('serviceRunningStatus', [
        (serverStatus.value.port || 'Unknown').toString(),
      ]);
    }
    return getMessage('connectedServiceNotStartedStatus');
  }
  if (nativeConnectionStatus.value === 'disconnected') {
    return getMessage('serviceNotConnectedStatus');
  }
  return getMessage('detectingStatus');
});

async function openWelcomePage() {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  } catch {
    // ignore
  }
}

async function openTroubleshooting() {
  try {
    await chrome.tabs.create({ url: LINKS.TROUBLESHOOTING });
  } catch {
    // ignore
  }
}

const updatePort = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const parsed = Number(target.value);
  if (Number.isFinite(parsed) && parsed > 0) {
    nativeServerPort.value = parsed;
    await savePortPreference(parsed);
  }
};

const updateProfileName = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const newName = target.value.trim() || 'default';
  profileName.value = newName;
  await saveProfileNamePreference(newName);
};

const checkNativeConnection = async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ping_native' });
    nativeConnectionStatus.value = response?.connected ? 'connected' : 'disconnected';
  } catch (error) {
    console.error('Failed to check native connection status:', error);
    nativeConnectionStatus.value = 'disconnected';
  }
};

const checkServerStatus = async () => {
  try {
    const response = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS,
    });
    if (response?.success && response.serverStatus) {
      serverStatus.value = response.serverStatus;
    }
    if (response?.connected !== undefined) {
      nativeConnectionStatus.value = response.connected ? 'connected' : 'disconnected';
    }
  } catch (error) {
    console.error('Failed to check server status:', error);
  }
};

const refreshServerStatus = async () => {
  try {
    const response = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.REFRESH_SERVER_STATUS,
    });
    if (response?.success && response.serverStatus) {
      serverStatus.value = response.serverStatus;
    }
    if (response?.connected !== undefined) {
      nativeConnectionStatus.value = response.connected ? 'connected' : 'disconnected';
    }
  } catch (error) {
    console.error('Failed to refresh server status:', error);
  }
};

const refreshAll = async () => {
  await refreshServerStatus();
  await loadModules();
  if (isNetsuiteEnabled.value) {
    await loadNsSessions(true);
  }
};

const copyMcpConfig = async () => {
  if (copyResetTimer) {
    clearTimeout(copyResetTimer);
    copyResetTimer = null;
  }
  try {
    await navigator.clipboard.writeText(mcpConfigJson.value);
    copyButtonText.value = getMessage('copiedShortLabel');
  } catch (error) {
    console.error('Failed to copy config:', error);
    copyButtonText.value = getMessage('copyFailedShortLabel');
  }
  copyResetTimer = setTimeout(() => {
    copyButtonText.value = getMessage('copyShortButton');
    copyResetTimer = null;
  }, 2000);
};

const testNativeConnection = async () => {
  if (isConnecting.value) return;
  isConnecting.value = true;
  try {
    if (nativeConnectionStatus.value === 'connected') {
      await chrome.runtime.sendMessage({ type: 'disconnect_native' });
      nativeConnectionStatus.value = 'disconnected';
    } else {
      const response = await chrome.runtime.sendMessage({
        type: 'connectNative',
        port: nativeServerPort.value,
      });
      if (response && response.success) {
        nativeConnectionStatus.value = 'connected';
        await savePortPreference(nativeServerPort.value);
      } else {
        nativeConnectionStatus.value = 'disconnected';
      }
    }
  } catch (error) {
    console.error('Connection test failed:', error);
    nativeConnectionStatus.value = 'disconnected';
  } finally {
    isConnecting.value = false;
    void loadModules();
  }
};

const savePortPreference = async (port: number) => {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_SERVER_PORT]: port });
  } catch (error) {
    console.error('Failed to save port preference:', error);
  }
};

const loadPortPreference = async () => {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.NATIVE_SERVER_PORT]);
    if (result.nativeServerPort) {
      nativeServerPort.value = result.nativeServerPort;
    }
  } catch (error) {
    console.error('Failed to load port preference:', error);
  }
};

const saveProfileNamePreference = async (name: string) => {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE_NAME]: name });
  } catch (error) {
    console.error('Failed to save profile name preference:', error);
  }
};

const loadProfileNamePreference = async () => {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.PROFILE_NAME]);
    if (result.profileName) {
      profileName.value = result.profileName;
    }
  } catch (error) {
    console.error('Failed to load profile name preference:', error);
  }
};

let runtimeMessageListener: ((message: { type?: string; payload?: unknown }) => void) | null = null;

const setupServerStatusListener = () => {
  runtimeMessageListener = (message: { type?: string; payload?: unknown }) => {
    if (message.type === BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED && message.payload) {
      serverStatus.value = message.payload as typeof serverStatus.value;
      void loadModules();
    }
    if (message.type === BACKGROUND_MESSAGE_TYPES.MODULES_CHANGED && message.payload) {
      onModulesChanged(message.payload);
    }
  };
  chrome.runtime.onMessage.addListener(runtimeMessageListener);
};

onMounted(async () => {
  await loadPortPreference();
  await loadProfileNamePreference();
  await checkNativeConnection();
  await checkServerStatus();

  setupServerStatusListener();
  await loadModules();
});

onUnmounted(() => {
  stopNsRefreshTimer();
  if (copyResetTimer) {
    clearTimeout(copyResetTimer);
    copyResetTimer = null;
  }
  try {
    if (runtimeMessageListener && chrome?.runtime?.onMessage?.removeListener) {
      chrome.runtime.onMessage.removeListener(runtimeMessageListener);
    }
  } catch {
    // ignore
  }
});
</script>

<style scoped>
.popup-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 220px;
  background: var(--bg);
  color: var(--label);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 40px;
  padding: 0 14px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.brand-mark {
  width: 16px;
  height: 16px;
  color: var(--accent);
  flex: none;
}

.brand-title {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.015em;
  color: var(--label);
}

.profile-pill {
  max-width: 150px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  background: var(--fill-2);
  border: 1px solid var(--border);
  color: var(--label-2);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition:
    background 120ms ease,
    color 120ms ease;
}

.profile-pill:hover {
  background: var(--fill);
  color: var(--label);
}

.main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
}

.card,
.card-group {
  border-radius: var(--r-md);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.connection-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 11px;
}

.connection-left {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--r-pill);
  background: var(--gray);
  flex: none;
}

.status-dot.running {
  background: var(--green);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 20%, transparent);
}

.status-dot.idle {
  background: var(--orange);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--orange) 20%, transparent);
}

.status-dot.offline {
  background: var(--red);
}

.connection-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.status-text {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--label);
  line-height: 1.3;
}

.status-time {
  font-size: 11px;
  color: var(--label-3);
  font-variant-numeric: tabular-nums;
}

.connection-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  color: var(--label-2);
  transition:
    background 120ms ease,
    color 120ms ease;
}

.icon-btn:hover {
  background: var(--surface-2);
  color: var(--label);
}

:deep(.refresh-svg) {
  width: 14px;
  height: 14px;
}

.conn-btn {
  height: 26px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}

.conn-btn.primary {
  background: var(--accent);
  color: #ffffff;
}

.conn-btn.primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.conn-btn.secondary {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--label-2);
}

.conn-btn.secondary:hover:not(:disabled) {
  background: var(--surface-2);
  border-color: var(--border-strong);
  color: var(--label);
}

.section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--label-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.module-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 11px;
}

.module-row + .module-row {
  border-top: 1px solid var(--border);
}

.module-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.module-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--label);
}

.module-description {
  font-size: 11.5px;
  color: var(--label-2);
  line-height: 1.35;
}

.switch {
  position: relative;
  width: 32px;
  height: 18px;
  border-radius: var(--r-pill);
  background: var(--border-strong);
  flex: none;
  transition: background 140ms ease;
}

.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: var(--r-pill);
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
  transition: transform 140ms ease;
}

.switch.on {
  background: var(--accent);
}

.switch.on::after {
  transform: translateX(14px);
}

.modules-note {
  padding: 7px 11px;
  border-top: 1px solid var(--border);
  background: var(--fill-2);
  font-size: 11px;
  color: var(--label-2);
  line-height: 1.38;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 14px;
  background: var(--surface);
  border-top: 1px solid var(--border);
}

.footer-links {
  display: flex;
  align-items: center;
  gap: 4px;
}

.footer-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 7px;
  border-radius: var(--r-sm);
  color: var(--label-2);
  font-size: 11.5px;
  font-weight: 500;
  transition:
    background 120ms ease,
    color 120ms ease;
}

.footer-link:hover {
  background: var(--surface-2);
  color: var(--label);
}

.footer-link svg {
  width: 13px;
  height: 13px;
  flex: none;
}

.footer-text {
  font-size: 10.5px;
  color: var(--label-3);
  letter-spacing: 0.02em;
  white-space: nowrap;
}
</style>
