/**
 * Which NetSuite user each Chrome profile expects for an account: the one it
 * last published or imported, so a profile never silently switches to
 * another user's session (design: "Expected user per account"). Names only,
 * in the bridge state dir.
 */

import * as fs from 'fs';
import * as path from 'path';
import { updateStateDir } from '../../update-checker';

export const EXPECTED_USERS_FILE = 'ns-expected-users.json';

type Doc = Record<string, Record<string, { user: string; at: string }>>;

export class ExpectedUsers {
  constructor(
    private readonly file: () => string = () => path.join(updateStateDir(), EXPECTED_USERS_FILE),
    private readonly now: () => number = Date.now,
  ) {}

  private read(): Doc {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  get(profile: string, account: string): string | null {
    const user = this.read()[profile]?.[account]?.user;
    return typeof user === 'string' && user ? user : null;
  }

  set(profile: string, account: string, user: string): void {
    const doc = this.read();
    const current = doc[profile]?.[account]?.user;
    if (current === user) return;
    doc[profile] = {
      ...(doc[profile] ?? {}),
      [account]: { user, at: new Date(this.now()).toISOString() },
    };
    try {
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify(doc, null, 2));
    } catch (err: any) {
      console.error(`[ns-store] could not save the expected user: ${err?.message}`);
    }
  }
}
