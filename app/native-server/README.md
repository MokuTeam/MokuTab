# @mokuhub/mokutab-bridge

The local bridge half of [MokuTab](https://github.com/MokuTeam/MokuTab), published to npm as [`@mokuhub/mokutab-bridge`](https://www.npmjs.com/package/@mokuhub/mokutab-bridge). The command is `mokutab-bridge`.

A Fastify server on `127.0.0.1:12306` that terminates MCP transports and forwards tool calls to the Chrome extension over native messaging. Chrome launches it on demand, so there is nothing to start by hand. It also keeps the module switch, the tab leases, the watches and the browser function registry.

## Install

The bridge works together with the MokuTab Chrome extension. Download the extension zip from the [latest release](https://github.com/MokuTeam/MokuTab/releases/latest) and load it unpacked, then install the bridge:

```bash
npm install -g @mokuhub/mokutab-bridge
```

Postinstall attempts user-level native-messaging registration for detected browsers. The full setup, including registering in an MCP client, is in the [quick start](https://github.com/MokuTeam/MokuTab#quick-start). Upgrading from 1.x: remove the old package first, as the [upgrade steps](https://github.com/MokuTeam/MokuTab#upgrade-from-workatomcp-1x) say.

## CLI

```bash
mokutab-bridge doctor              # diagnose registration, ports, permissions, 1.x leftovers
mokutab-bridge doctor --fix        # repair what it can
mokutab-bridge register --detect   # (re)register for detected browsers
mokutab-bridge register --system   # system-level install (needs admin/sudo)
mokutab-bridge fix-permissions     # repair wrapper-script permissions
mokutab-bridge update-port 12307   # move off a conflicting port
mokutab-bridge report --copy       # redacted diagnostic report for bug reports
mokutab-bridge watch-wait --id <id> --cursor <n>   # wait for chrome_watch_* events (agents run it)
```

The 1.x command names stay as aliases of `mokutab-bridge` and `mokutab-stdio` until 3.0.

## Endpoints

| Route                         | Purpose                                   |
| ----------------------------- | ----------------------------------------- |
| `POST/GET/DELETE /mcp`        | Streamable HTTP transport                 |
| `GET /sse` + `POST /messages` | Legacy SSE transport                      |
| `GET /ws-client`              | Per-Chrome-profile WebSocket registration |
| `GET /ping`                   | Liveness check                            |

`mokutab-stdio` is also installed, for MCP clients that require a spawned stdio process.

## Files

| What         | Where                                                                                                                                                                                           | Override                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Data dir     | `~/.mokutab`: `functions/` (the browser function registry, a git repository) and `config.json` (the module switch)                                                                              | `MOKUTAB_DATA_DIR`, `MOKUTAB_FN_DIR`                                         |
| State dir    | `%LOCALAPPDATA%\mcp-chrome-bridge` (Windows), `~/Library/Logs/mcp-chrome-bridge` (macOS), `$XDG_STATE_HOME/mcp-chrome-bridge` or `~/.local/state/mcp-chrome-bridge` (Linux); keeps its 1.x name | `MOKUTAB_UPDATE_STATE_DIR`, `MOKUTAB_FN_STATE_DIR`, `MOKUTAB_OPERATIONS_DIR` |
| Wrapper logs | `%LOCALAPPDATA%\mokutab-bridge\logs` (Windows), `~/Library/Logs/mokutab-bridge` (macOS), `$XDG_STATE_HOME/mokutab-bridge/logs` or `~/.local/state/mokutab-bridge/logs` (Linux)                  | none                                                                         |
| Temp         | `<tmpdir>/mokutab-results`, `<tmpdir>/mokutab-operations`                                                                                                                                       | none                                                                         |

Also read: `MOKUTAB_BW_PATH` (the Bitwarden CLI) `MOKUTAB_STRICT_TABS=1` (refuse tab-targeting calls without a lease or `tabId`) and `MOKUTAB_LEASE_IDLE_MINUTES` (how long an unused lease lasts, 30 by default). The first 2.x start moves a 1.x data dir into `~/.mokutab`; `doctor` reports a move that has not happened.

## Development

```bash
pnpm --filter @mokuhub/mokutab-bridge build
pnpm --filter @mokuhub/mokutab-bridge test --coverage=false
pnpm --filter @mokuhub/mokutab-bridge dev     # rebuild + re-register on change
```

## Layout

```text
src/
├── server/
│   ├── index.ts             # Fastify routes and MCP transports
│   ├── profile-registry.ts  # per-profile WebSocket connections
│   └── module-sync.ts       # module switch over the extension connection
├── native-messaging-host.ts # stdio framing to/from Chrome
├── file-handler.ts          # local file read/write for the recipe & CSV round-trips
├── data-dir.ts              # ~/.mokutab and the 1.x data dir move
├── startup-migration.ts     # first start: the move, fresh install or upgrade
├── env.ts                   # MOKUTAB_* overrides
├── mcp/                     # MCP server, router, module switch, leases, watches, browser functions
├── modules/workato/         # the Workato module's bridge hooks and orchestrators
├── cli.ts                   # doctor / register / report commands
└── scripts/                 # build, postinstall, registration, doctor checks
```

`src/scripts/run_host.sh` must ship with LF line endings or the host fails to execute on macOS and Linux; `.gitattributes` enforces this.

Architecture details: [docs/ARCHITECTURE.md](https://github.com/MokuTeam/MokuTab/blob/master/docs/ARCHITECTURE.md).
