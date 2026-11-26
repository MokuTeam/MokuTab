/**
 * Runs before any module of a test file loads (jest `setupFiles`).
 *
 * The operations journal defaults to the bridge's real state directory
 * (%LOCALAPPDATA%/mcp-chrome-bridge/operations on Windows). Any test that
 * drives save_with_dependents or the operation status tool without setting
 * MOKUTAB_OPERATIONS_DIR itself therefore wrote real journal files during
 * the suite. Point the whole run at a fresh temp directory instead: a test
 * that sets its own override still wins, because this only fills in a blank.
 * The new names are set, so a WORKATOMCP_* override left in the shell (still
 * read as a fallback) cannot point the suite at real data either.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.MOKUTAB_OPERATIONS_DIR) {
  const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  process.env.MOKUTAB_OPERATIONS_DIR = path.join(os.tmpdir(), `mokutab-jest-operations-${unique}`);
}

// The same for the data dir (~/.mokutab): the module switch reads
// config.json there, and a machine with a module switched off must not turn
// the suite red. The suite runs as a machine upgraded from 1.x, with Workato
// on as the tests expect; the tests of the default bring their own dirs.
if (!process.env.MOKUTAB_DATA_DIR) {
  const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(os.tmpdir(), `mokutab-jest-data-${unique}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ modules: { workato: true } }));
  process.env.MOKUTAB_DATA_DIR = dir;
}

// The machine's own vault and profile settings must not reach the tests: a
// session file or a pinned default set on a dev box or a server changes what
// the vault and the profile registry do.
for (const name of [
  'MOKUTAB_BW_SESSION_FILE',
  'WORKATOMCP_BW_SESSION_FILE',
  'MOKUTAB_BW_APPDATA',
  'WORKATOMCP_BW_APPDATA',
  'MOKUTAB_DEFAULT_PROFILE',
  'WORKATOMCP_DEFAULT_PROFILE',
]) {
  delete process.env[name];
}
