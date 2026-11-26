/**
 * Which NetSuite user each Chrome profile expects for an account: the one it
 * last published or imported, so a profile never silently switches to
 * another user's session (design: "Expected user per account"). Names only.
 *
 * Kept in the data dir (~/.mokutab, or MOKUTAB_DATA_DIR), which every
 * profile's bridge on a machine shares. It used to be in the bridge state dir,
 * which follows the profile whose native host started the bridge: on a
 * machine with several Chrome instances the remembered users then vanished
 * whenever another profile started it. A file left in the state dir is merged
 * in once per bridge start (the newer entry wins).
 */

import * as fs from 'fs';
import * as path from 'path';
import { dataDir } from '../../data-dir';
import { updateStateDir } from '../../update-checker';

export const EXPECTED_USERS_FILE = 'ns-expected-users.json';

type Entry = { user: string; at: string };
type Doc = Record<string, Record<string, Entry>>;

function readDoc(file: string): Doc | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Merge `from` into `into` (newest `at` wins); true when `into` changed. */
export function mergeExpectedUsers(into: Doc, from: Doc): boolean {
  let changed = false;
  for (const [profile, accounts] of Object.entries(from)) {
    if (!accounts || typeof accounts !== 'object') continue;
    for (const [account, entry] of Object.entries(accounts)) {
      if (typeof entry?.user !== 'string' || !entry.user) continue;
      const mine = into[profile]?.[account];
      const theirs = Date.parse(entry.at ?? '') || 0;
      if (mine && (Date.parse(mine.at ?? '') || 0) >= theirs) continue;
      into[profile] = {
        ...(into[profile] ?? {}),
        [account]: { user: entry.user, at: typeof entry.at === 'string' ? entry.at : '' },
      };
      changed = true;
    }
  }
  return changed;
}

export class ExpectedUsers {
  private migrated = false;

  constructor(
    private readonly file: () => string = () => path.join(dataDir(), EXPECTED_USERS_FILE),
    private readonly now: () => number = Date.now,
    /** Where older bridges kept the file (merged in once). */
    private readonly legacyFiles: () => string[] = () => [
      path.join(updateStateDir(), EXPECTED_USERS_FILE),
    ],
  ) {}

  private write(doc: Doc): void {
    try {
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify(doc, null, 2));
    } catch (err: any) {
      console.error(`[ns-store] could not save the expected users: ${err?.message}`);
    }
  }

  private read(): Doc {
    const doc = readDoc(this.file()) ?? {};
    if (!this.migrated) {
      this.migrated = true;
      let changed = false;
      for (const legacy of this.legacyFiles()) {
        if (path.resolve(legacy) === path.resolve(this.file())) continue;
        const old = readDoc(legacy);
        if (old && mergeExpectedUsers(doc, old)) changed = true;
      }
      if (changed) this.write(doc);
    }
    return doc;
  }

  get(profile: string, account: string): string | null {
    const user = this.read()[profile]?.[account]?.user;
    return typeof user === 'string' && user ? user : null;
  }

  /** Every account this profile expects a user for: {account: user}. */
  all(profile: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [account, entry] of Object.entries(this.read()[profile] ?? {})) {
      if (typeof entry?.user === 'string' && entry.user) out[account] = entry.user;
    }
    return out;
  }

  set(profile: string, account: string, user: string): void {
    const doc = this.read();
    const current = doc[profile]?.[account]?.user;
    if (current === user) return;
    doc[profile] = {
      ...(doc[profile] ?? {}),
      [account]: { user, at: new Date(this.now()).toISOString() },
    };
    this.write(doc);
  }
}
