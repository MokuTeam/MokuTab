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

Also read: `MOKUTAB_BW_PATH` (the Bitwarden CLI), `MOKUTAB_BW_SESSION_FILE` (a file with the Bitwarden session key, a bare key or a `BW_SESSION=` line, re-read on every vault call), `MOKUTAB_BW_APPDATA` (bw's data dir; without it, on Linux, a host that sets `XDG_CONFIG_HOME` per profile gets `~/.config/Bitwarden CLI` when its own dir has no bw data), `MOKUTAB_DEFAULT_PROFILE` (pins the default profile over `default-profile.json` and `chrome_switch_profile`; read once at start, from the environment the bridge inherits from Chrome or its host wrapper; without it, a remembered default that has been away for 7 days of bridge running time gives way to the profile that connects) and `MOKUTAB_STRICT_TABS=1` (refuse tab-targeting calls without a lease or `tabId`). The first 2.x start moves a 1.x data dir into `~/.mokutab`; `doctor` reports a move that has not happened.

## NetSuite session store

The `netsuite` module (off by default, switched on in the popup) is a client of a NetSuite session store: one live session per account and user, shared by every machine, so an agent that lands on a NetSuite login page takes the session another machine already has instead of logging in again (which would end that session).

- Token: `<state dir>/ns-store-token`, written by the store host (line 1 the token; optional line 2 a base URL, default `http://127.0.0.1:12422/api/ns-sessions`; `MOKUTAB_NS_STORE_URL` overrides it). Re-read when it changes. No file: every tool answers `store_unconfigured`.
- Requests carry `X-NS-Store-Token`, `X-Board: 1` and `X-NS-Store-Client`; the bridge logs method, path, status and time, never a body.
- A 503, a timeout, any 5xx or a body that is not JSON is `no_store` (backs off 30 s): callers behave as without a store. `409 store_full` on a publish counts as `no_store`.
- Cookie values move only between the bridge and the extension (typed `ns_cookies_read` / `ns_cookies_write` / `ns_tab_identity` messages, not tools) and between the bridge and the store. Tool results carry names, states and an 8-char fingerprint (sha256 of `JSESSIONID`).
- Which user a profile expects per account is kept in `<state dir>/ns-expected-users.json` (names only). With two live users for one account, `ensure` takes the most recently active one and says so.
- A call that names no profile, with no pinned session and several profiles connected, is refused (`ProfileRequired`): a session never lands in whichever profile is the default.
- `vault_item` is read only when the item is a login for the account's host, and a username read from it is never echoed (`user_source: "vault"`).
- Before `already_live` and before a publish the extension checks that the session is logged in (card.nl with the profile's cookies must not end on a login page). A logged-out session is not published (`no_session`); on `ensure` it is reported dead and the answer is `none`. `partial_import` means Chrome refused some cookies.
- The extension asks for the `cookies` permission for this module (installed with the extension, used only while the module is on and the bridge said so).
- An extension older than the bridge answers an unknown request type at once, and the bridge waits at most 5 s (12 s for the session check) for these requests.
- `netsuite.login` v14 (a vault function in the registry) uses these tools from its steps; it needs this bridge.

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
