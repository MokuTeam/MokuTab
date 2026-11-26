<template>
  <section class="section" aria-labelledby="ns-sessions-heading">
    <div class="section-head">
      <h2 id="ns-sessions-heading" class="section-title">
        {{ getMessage('nsSessionsSectionLabel') }}
      </h2>
      <span v-if="status === 'ready' && entries.length > 0" class="section-count">
        {{ entries.length }}
      </span>
    </div>

    <div v-if="status === 'loading'" class="card quiet-state">
      <span class="mini-spinner" aria-hidden="true"></span>
      <span>{{ getMessage('nsSessionsLoading') }}</span>
    </div>

    <div v-else-if="status === 'unreachable'" class="card quiet-state">
      <span class="quiet-dot" aria-hidden="true"></span>
      <span>{{ getMessage('nsSessionsUnreachable') }}</span>
    </div>

    <div v-else-if="entries.length === 0" class="card quiet-state">
      <span>{{ getMessage('nsSessionsEmpty') }}</span>
    </div>

    <div v-else class="card-group">
      <button
        v-for="entry in entries"
        :key="entry.account"
        type="button"
        class="ns-row"
        :class="{ opening: openingAccount === entry.account }"
        :disabled="openingAccount !== null"
        :title="getMessage('nsSessionOpenTooltip', [entry.account])"
        @click="emit('open', entry.account)"
      >
        <div class="ns-row-top">
          <div class="ns-account-wrap">
            <span class="ns-account">{{ splitAccountId(entry.account).base }}</span>
            <span v-if="splitAccountId(entry.account).suffix" class="ns-suffix">
              {{ splitAccountId(entry.account).suffix }}
            </span>
            <span class="ns-badge" :class="entry.state === 'dying' ? 'dying' : 'live'">
              {{
                entry.state === 'dying'
                  ? getMessage('nsSessionStateDying')
                  : getMessage('nsSessionStateLive')
              }}
            </span>
          </div>

          <div class="ns-right">
            <span
              v-if="openingAccount === entry.account"
              class="mini-spinner"
              aria-hidden="true"
            ></span>
            <span
              v-else-if="formatTimeLeft(entry, nowMs)"
              class="ns-ttl"
              :class="{ dying: entry.state === 'dying' }"
            >
              {{ formatTimeLeft(entry, nowMs) }}
            </span>
          </div>
        </div>

        <div class="ns-row-meta">
          <span class="ns-user">{{ entry.user }}</span>
          <span v-if="formatLastActivity(entry, nowMs)" class="ns-activity">
            {{ formatLastActivity(entry, nowMs) }}
          </span>
        </div>

        <p v-if="rowErrors[entry.account]" class="ns-row-error" role="alert">
          {{ rowErrors[entry.account] }}
        </p>
      </button>
    </div>
  </section>
</template>

<script lang="ts" setup>
/**
 * Active NetSuite sessions list inside the popup.
 *
 * Author: Roman Chikalenko
 * Version: 1.0.0
 */
import { getMessage } from '@/utils/i18n';
import {
  formatLastActivity,
  formatTimeLeft,
  splitAccountId,
  type NsSessionEntry,
} from '../ns-sessions';

defineProps<{
  entries: NsSessionEntry[];
  status: 'loading' | 'ready' | 'unreachable';
  nowMs: number;
  openingAccount: string | null;
  rowErrors: Record<string, string>;
}>();

const emit = defineEmits<{
  open: [account: string];
}>();
</script>

<style scoped>
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

.section-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--label-3);
  font-variant-numeric: tabular-nums;
}

.card,
.card-group {
  border-radius: var(--r-md);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.quiet-state {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 11px;
  font-size: 12px;
  color: var(--label-2);
}

.quiet-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--label-3);
  flex: none;
}

.ns-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 8px 11px;
  text-align: left;
  transition: background 120ms ease;
}

.ns-row + .ns-row {
  border-top: 1px solid var(--border);
}

.ns-row:hover:not(:disabled) {
  background: var(--fill-2);
}

.ns-row:active:not(:disabled) {
  background: var(--fill);
}

.ns-row:focus-visible {
  outline-offset: -2px;
}

.ns-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.ns-account-wrap {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.ns-account {
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--label);
  letter-spacing: -0.01em;
}

.ns-suffix {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--label-2);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.3;
}

.ns-badge {
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.35;
}

.ns-badge.live {
  background: color-mix(in srgb, var(--green) 14%, transparent);
  color: var(--green);
}

.ns-badge.dying {
  background: color-mix(in srgb, var(--orange) 14%, transparent);
  color: var(--orange);
}

.ns-right {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}

.ns-ttl {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--label-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ns-ttl.dying {
  color: var(--orange);
}

.ns-row:hover:not(:disabled) .ns-account,
.ns-row:focus-visible .ns-account {
  color: var(--accent);
}

.ns-row-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  font-size: 11.5px;
  color: var(--label-2);
}

.ns-user {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ns-activity {
  flex: none;
  color: var(--label-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ns-row-error {
  margin-top: 2px;
  font-size: 11px;
  color: var(--red);
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.mini-spinner {
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: ns-spin 0.7s linear infinite;
  flex: none;
}

@keyframes ns-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
