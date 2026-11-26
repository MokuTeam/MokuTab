/**
 * NetSuite account ids and hosts, as the store contract spells them: the
 * account upper case with an underscore before a sandbox suffix (1234567_SB2,
 * TD3125712), the host lower case with a dash (1234567-sb2.app.netsuite.com).
 */

import { createHash } from 'crypto';

export interface NsAccount {
  account: string;
  host: string;
}

const ACCOUNT = /^([0-9]+|[Tt][Dd][0-9]+)(?:[_-]([A-Za-z0-9]+))?$/;
const HOST = /^([0-9a-z]+(?:-[0-9a-z]+)?)\.app\.netsuite\.com$/i;

export function normalizeAccount(input: unknown): NsAccount | null {
  const match = ACCOUNT.exec(String(input ?? '').trim());
  if (!match) return null;
  const account = (match[1] + (match[2] ? `_${match[2]}` : '')).toUpperCase();
  return { account, host: `${account.toLowerCase().replace(/_/g, '-')}.app.netsuite.com` };
}

export function accountFromHost(host: unknown): NsAccount | null {
  const match = HOST.exec(String(host ?? '').trim());
  return match ? normalizeAccount(match[1]) : null;
}

/** The only trace of a session value that leaves the store: 8 hex chars of its sha256. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}
