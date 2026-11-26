<template>
  <section class="settings-card">
    <button
      type="button"
      class="settings-toggle"
      :aria-expanded="open"
      aria-controls="popup-settings-body"
      @click="emit('update:open', !open)"
    >
      <span class="settings-toggle-left">
        <svg
          class="settings-icon"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            d="M6.8 2.2h2.4l.4 1.5c.3.1.6.3.9.5l1.5-.5 1.2 2.1-1.1 1c0 .3.1.5.1.8s0 .5-.1.8l1.1 1-1.2 2.1-1.5-.5c-.3.2-.6.4-.9.5l-.4 1.5H6.8l-.4-1.5a4.6 4.6 0 0 1-.9-.5l-1.5.5-1.2-2.1 1.1-1a4 4 0 0 1 0-1.6l-1.1-1 1.2-2.1 1.5.5c.3-.2.6-.4.9-.5l.4-1.5Z"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
          <circle cx="8" cy="8" r="1.8" stroke-width="1.3" />
        </svg>
        <span class="settings-title">{{ getMessage('settingsSectionLabel') }}</span>
      </span>

      <span class="settings-toggle-right">
        <span class="settings-summary">:{{ port }} / {{ profileName }}</span>
        <svg
          class="chevron"
          :class="{ open }"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            d="M6 4l4 4-4 4"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    </button>

    <div v-show="open" id="popup-settings-body" class="settings-body">
      <div class="fields-grid">
        <div class="field">
          <label for="port" class="field-label">{{ getMessage('connectionPortLabel') }}</label>
          <input
            id="port"
            type="text"
            inputmode="numeric"
            class="field-input mono"
            :value="port"
            @input="emit('update-port', $event)"
          />
        </div>

        <div class="field">
          <label for="profile" class="field-label">{{ getMessage('profileNameLabel') }}</label>
          <input
            id="profile"
            type="text"
            class="field-input"
            :value="profileName"
            :placeholder="getMessage('profileNamePlaceholder')"
            @input="emit('update-profile', $event)"
          />
        </div>
      </div>

      <div v-if="showMcpConfig" class="mcp-block">
        <div class="mcp-head">
          <button
            type="button"
            class="mcp-toggle"
            :aria-expanded="showConfigDetails"
            @click="showConfigDetails = !showConfigDetails"
          >
            <span>{{ getMessage('mcpServerConfigLabel') }}</span>
            <svg
              class="chevron small"
              :class="{ open: showConfigDetails }"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                d="M6 4l4 4-4 4"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>

          <button type="button" class="copy-btn" @click="emit('copy-config')">
            {{ copyLabel }}
          </button>
        </div>

        <pre v-show="showConfigDetails" class="mcp-json">{{ mcpConfigJson }}</pre>
      </div>
    </div>
  </section>
</template>

<script lang="ts" setup>
/**
 * Collapsible rare settings section for port, profile name, and MCP configuration.
 *
 * Author: Roman Chikalenko
 * Version: 1.0.0
 */
import { ref } from 'vue';
import { getMessage } from '@/utils/i18n';

defineProps<{
  open: boolean;
  port: number;
  profileName: string;
  showMcpConfig: boolean;
  mcpConfigJson: string;
  copyLabel: string;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  'update-port': [event: Event];
  'update-profile': [event: Event];
  'copy-config': [];
}>();

const showConfigDetails = ref(false);
</script>

<style scoped>
.settings-card {
  border-radius: var(--r-md);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.settings-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 11px;
  text-align: left;
  transition: background 120ms ease;
}

.settings-toggle:hover {
  background: var(--fill-2);
}

.settings-toggle:focus-visible {
  outline-offset: -2px;
}

.settings-toggle-left {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.settings-icon {
  width: 14px;
  height: 14px;
  color: var(--label-2);
  flex: none;
}

.settings-title {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--label);
}

.settings-toggle-right {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.settings-summary {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--label-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 170px;
}

.chevron {
  width: 13px;
  height: 13px;
  color: var(--label-3);
  transition: transform 160ms ease;
  flex: none;
}

.chevron.open {
  transform: rotate(90deg);
}

.chevron.small {
  width: 12px;
  height: 12px;
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 11px 11px;
  border-top: 1px solid var(--border);
}

.fields-grid {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 8px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--label-2);
}

.field-input {
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--label);
  font-size: 12.5px;
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease;
}

.field-input.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.field-input::placeholder {
  color: var(--label-3);
}

.field-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.mcp-block {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-top: 9px;
  border-top: 1px solid var(--border);
}

.mcp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mcp-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--label-2);
}

.mcp-toggle:hover {
  color: var(--label);
}

.copy-btn {
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--label-2);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  transition:
    background 120ms ease,
    color 120ms ease,
    border-color 120ms ease;
}

.copy-btn:hover {
  background: var(--surface-2);
  color: var(--label);
  border-color: var(--border-strong);
}

.mcp-json {
  padding: 8px 9px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--label);
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 1.45;
  overflow-x: auto;
  white-space: pre;
}
</style>
