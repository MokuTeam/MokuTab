/**
 * What this MCP server calls itself, and how it tells a client to pick a tool.
 *
 * The handshake used to say `ChromeMcpServer 1.0.0`, which matched no release
 * of anything, and it passed no `instructions`, so a client with lazy tool
 * discovery saw ~120 tool NAMES and no guidance about which one answers which
 * question. Both are fixed here, in one place shared by the HTTP and stdio
 * servers.
 */

import { readPackageVersion, bridgePackageCandidates, UNKNOWN_VERSION } from './bridge-info';

export const SERVER_NAME = 'MokuTab';

/**
 * Concise task-to-tool guidance, sent once at initialize: the core snippet,
 * then the snippet of each module that is on, then one line naming the
 * installed modules that are off.
 *
 * Documented limit is 2 KB; every on/off combination is deliberately kept
 * under 1800 bytes (1500 until the NetSuite module joined Workato) so it
 * survives a client that budgets instructions alongside tool descriptions. It names tools only, never repeats their parameters: the
 * schema is the documentation, and duplicating it here is how the two drift
 * apart.
 */
export const CORE_INSTRUCTIONS = [
  'Tools for a logged-in browser.',
  'JSON results are one object (context: the tab, error: {code, message}).',
  'Large ones go to a file: saved_to (auto_file, out_file).',
  "Writes need their own flag; read a tool's description before first use.",
  'Pick by task: which build answers -> chrome_bridge_info;',
  'parallel agents -> each takes chrome_lease_tab, passes its lease;',
  'wait for a page change -> chrome_watch_start, wait_command in background.',
].join(' ');

export interface InstructionModule {
  id: string;
  title: string;
  instructions: string;
}

/** The instructions for a session, given the installed modules and which are on. */
export function buildServerInstructions(
  installed: readonly InstructionModule[],
  isEnabled: (id: string) => boolean,
): string {
  const parts = [CORE_INSTRUCTIONS];
  const off: string[] = [];
  for (const module of installed) {
    if (isEnabled(module.id)) parts.push(module.instructions);
    else off.push(module.title);
  }
  if (off.length > 0) {
    parts.push(
      `Switched off on this machine: ${off.join(', ')} (turn on in the MokuTab popup, Modules).`,
    );
  }
  return parts.join(' ');
}

/** The bridge version, read once from the package.json that ships with dist. */
export function serverVersion(): string {
  const read = readPackageVersion(bridgePackageCandidates());
  return read.version === UNKNOWN_VERSION ? '0.0.0-unknown' : read.version;
}
