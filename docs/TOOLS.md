# Tool reference

MokuTab serves 52 **core** tools on every machine, and the 97 tools of the **Workato module** while that module is switched on. With Workato on, `tools/list` also carries the old names of the four renamed core tools, 153 entries in all; with it off, 52.

The authoritative definitions live in [`packages/shared/src/tools.ts`](../packages/shared/src/tools.ts) (core) and [`packages/shared/src/modules/workato/schemas.ts`](../packages/shared/src/modules/workato/schemas.ts) (Workato). This document is written from them. If the two ever disagree, the schema wins. `chrome_bridge_info` reports the `tool_count` and `schema_revision` the running build actually serves, which is the way to tell a stale install from a documentation error.

- [Core](#core)
  - [Profiles, routing and build identity](#profiles-routing-and-build-identity)
  - [Browser tools](#browser-tools)
  - [Parallel agents and watches](#parallel-agents-and-watches)
  - [Browser functions](#browser-functions)
  - [Large results: out_file and auto-file](#large-results-out_file-and-auto-file)
- [Workato module](#workato-module)
  - [The module switch](#the-module-switch)
  - [Conventions](#conventions)
  - [Recipes and versions](#recipes-and-versions)
  - [Reading a recipe](#reading-a-recipe)
  - [Lifecycle, health, and long operations](#lifecycle-health-and-long-operations)
  - [Jobs](#jobs)
  - [Search and connections](#search-and-connections)
  - [Connector execution and discovery](#connector-execution-and-discovery)
  - [Projects and folders](#projects-and-folders)
  - [Properties](#properties)
  - [Code-side recipe editing](#code-side-recipe-editing)
  - [Recipe editor UI](#recipe-editor-ui)
  - [Lookup tables](#lookup-tables)
  - [Data tables](#data-tables)
  - [Workflow app pages](#workflow-app-pages)
  - [Session and environment](#session-and-environment)
  - [Common workflows](#common-workflows)

---

## Core

Core tools need no module and work on any page Chrome can open. Every tool that targets a tab accepts `tabId`; the bridge adds `profile` (route this one call to another Chrome profile) and `lease` (a leased tab, see [Parallel agents](#parallel-agents-and-watches)) to the served schemas. They are omitted from the tables below.

### Profiles, routing and build identity

| Tool                      | Old name, kept until 3.0   | Required  | Optional                              | Description                                                                                  |
| ------------------------- | -------------------------- | --------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `chrome_list_profiles`    | `workato_list_profiles`    | none      | none                                  | Connected Chrome profiles plus the pinned session tuple                                      |
| `chrome_switch_profile`   | `workato_switch_profile`   | `profile` | `tabId`                               | Route this session's calls to a profile, optionally pinning a tab                            |
| `chrome_bridge_info`      | `workato_bridge_info`      | none      | none                                  | Which build is answering: versions, tool count, schema revision                              |
| `chrome_reload_extension` | `workato_reload_extension` | none      | `profile`, `check_only`, `timeout_ms` | Dev: reload the unpacked extension in every profile, bridge owner last (restarts the bridge) |

**The old names.** These four tools carried the `workato_` prefix until 2.0. Their old names are aliases kept by the Workato module. While Workato is on, `tools/list` carries each old name after every other tool, as a copy of the new tool's served schema described as "Old name of <tool>, kept until 3.0.", and a call runs the new tool: the router swaps the name before routing, so the pin, strict mode, leases and auto-file treat both names alike. While Workato is off the old names are not listed, and a call is refused naming the new tool; nothing is sent.

Chrome runs one extension instance per profile, and each connects to the one bridge. `chrome_switch_profile` routes the rest of the session to a profile; with a `tabId` it pins that tab too. With the Workato module on, pinning a tab also probes its Workato workspace and environment and pins them with it (see [Conventions](#conventions)); with Workato off it pins profile and tab only, and `session_context` has no workspace fields. A pinned profile is never routed around: a failure is reported naming the pinned profile and the connected ones, and the stdio native-messaging host is reached only when no Chrome profile is connected at all, with the response saying so. `chrome_list_profiles` returns the tuple as `session_context` with a `routing_note`.

`chrome_bridge_info` runs entirely in the local bridge, so it still answers when the extension is disconnected. It returns `{bridge_version, shared_version, tool_count, schema_revision, connected_profiles, session_context, default_profile, node_version, platform, versions_read}`. `tool_count` counts what is actually served: 52 with Workato off, 153 with it on (52 core, 97 Workato and the four old names). `schema_revision` is a stable 12-hex hash of the served catalogue, canonicalized so array order and key order cannot move it. Call it first when a tool is missing or a parameter is rejected as unknown: that is deployment drift, usually a bridge or an unpacked extension that was not reloaded. The revision excludes the injected `profile` property, so a release that changed only that text would not move it.

`chrome_reload_extension` reloads the unpacked extension in every connected Chrome profile, one at a time: each profile is asked for its build stamp, reloaded, and awaited until it reconnects. The profile that owns the bridge goes last; its reload restarts the bridge, so a rebuilt bridge goes live too. `check_only: true` reports the stale profiles without reloading anything. Builds from before this tool existed need one manual reload at `chrome://extensions`.

### Browser tools

| Area                    | Tools                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs and navigation     | `get_windows_and_tabs`, `chrome_navigate`, `chrome_switch_tab`, `chrome_close_tabs`                                                                                     |
| Snapshots and actions   | `chrome_snapshot`, `chrome_snapshot_click`, `chrome_snapshot_fill`, `chrome_snapshot_fill_form`, `chrome_snapshot_hover`, `chrome_snapshot_wait_for`, `chrome_act`      |
| Reading the page        | `chrome_read_page`, `chrome_get_web_content`, `chrome_search_page`, `chrome_find_elements`, `chrome_javascript`, `chrome_console`                                       |
| Input                   | `chrome_click_element`, `chrome_fill_or_select`, `chrome_keyboard`, `chrome_computer`, `chrome_request_element_selection`, `chrome_upload_file`, `chrome_handle_dialog` |
| Network and files       | `chrome_network_request`, `chrome_network_capture`, `chrome_fetch_to_file`, `chrome_handle_download`                                                                    |
| Capture and performance | `chrome_screenshot`, `chrome_gif_recorder`, `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`                                          |
| History and bookmarks   | `chrome_history`, `chrome_bookmark_search`, `chrome_bookmark_add`, `chrome_bookmark_delete`                                                                             |

The tools started from [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) and have been reworked since. What is worth knowing before calling them:

- **Snapshots first.** `chrome_snapshot` returns the accessibility tree with a `[uid=N]` marker on every element worth acting on, and its state (value, checked, expanded, selected, disabled, required, url, select options), same-process iframes included. A uid stays valid as long as its element exists; a gone element, or a uid from before a navigation, is refused rather than guessed. Prefer `chrome_snapshot` plus `chrome_snapshot_click` over screenshots for navigation: snapshots are cheaper and give stable element refs.
- **Actions wait and report.** Clicks, fills, keys, `chrome_computer` and `chrome_navigate` wait for any navigation they started and for the DOM to go quiet, then report the final URL and title, whether it navigated, an open JS dialog, and the tabs the action opened. A dialog an action opens is reported at once; answer it with `chrome_handle_dialog`. `chrome_act` runs several uid actions in one call and stops at the first that fails or changes the page.
- **`chrome_fetch_to_file`** fetches a URL inside the tab's page with its session cookies and writes the body straight to a local file (up to 40 MB). The bytes never enter the reply or the output redaction, so a PDF from a print URL or a CSV export arrives intact; the reply is a summary with the size, sha256, status, content type and first bytes.
- **`chrome_javascript`** runs code in the page. `async_job: true` starts it and returns a `job_id` at once, and `job_id` with `wait_ms` polls it. A timeout abandons the wait, not the script. Results are redacted; an explicit `out_file` writes the returned value unredacted.
- **`get_windows_and_tabs(filter: "...")`** returns only the tabs whose URL or title contains the substring, so unrelated personal tabs never enter the context.

### Parallel agents and watches

| Tool                  | Required | Optional                                                       | Description                                                            |
| --------------------- | -------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `chrome_lease_tab`    | none     | `url`, `own_window`, `adopt_tab_id`                            | A tab of this agent's own; returns `{lease, tabId, windowId, profile}` |
| `chrome_release_tab`  | `lease`  | `keep_tab`                                                     | End a lease and close its tab                                          |
| `chrome_watch_start`  | `script` | `tabIds`, `url`, `name`, `every_seconds`, `key`, `ttl_minutes` | Run a script in tabs every N seconds and record changes                |
| `chrome_watch_list`   | none     | none                                                           | The running watches                                                    |
| `chrome_watch_events` | none     | `watch_ids`, `cursor`, `wait_seconds`                          | Events recorded since a cursor                                         |
| `chrome_watch_stop`   | none     | `watch_id`, `all`                                              | Stop one watch, or all of them                                         |

**Leases.** Several agents sharing one MCP server and one Chrome profile each lease a tab and pass `lease` on every call; the bridge turns it into the right profile and `tabId` and never activates or focuses the tab. The tab opens in an unfocused agents window, or in a window of its own with `own_window: true` (the choice for `chrome_computer` mouse and keyboard input, which a hidden tab drops). While a session holds a lease, a tab-targeting call that carries neither `lease` nor `tabId` is refused; `MOKUTAB_STRICT_TABS=1` makes that permanent. Calls on the same tab run one at a time. A lease ends with `chrome_release_tab`, when its tab closes, when its MCP session ends, or after 30 minutes unused (`MOKUTAB_LEASE_IDLE_MINUTES` changes the limit). A call that names the leased tab by `tabId`, from any session, counts as use. When a session ends or a lease expires, the bridge closes the tab the lease opened and leaves an adopted tab (`adopt_tab_id`) open. Leases are saved in the bridge state dir (`leases.json`): after a bridge restart, the tabs of the leases nobody can release any more are closed when their profile reconnects, but only if Chrome has not restarted in between, since tab ids start over then.

**Watches.** `chrome_watch_start` runs an agent-written script (the body of an async function returning JSON, `null` while the page is not ready) in the chosen tabs, by tab id or URL pattern and in any profile, every `every_seconds`, and records an event when the result changes: an array wakes only on items not seen before (identified by `key`), any other value when it differs. The reply carries a `wait_command` (`mokutab-bridge watch-wait ...`) that an agent runs in the background: it long-polls the bridge and exits with the events, so a quiet page costs no tokens. One wait can cover several watches. Watches survive bridge restarts and expire after `ttl_minutes`. Readings run through `chrome.userScripts` when "Allow User Scripts" is on for the extension (no debugging banner, page CSP does not apply), otherwise through the debugger.

### Browser functions

Saved, versioned browser flows: open a page, wait for it, run JS, check, commit. An agent runs one by name with parameters instead of re-deriving the same `chrome_javascript` sequence every session, and saves a fixed version when a run fails. Design notes: [`docs/design/specs/2026-10-19-browser-functions.md`](design/specs/2026-10-19-browser-functions.md).

| Tool             | Required            | Optional                                                                            | Description                                                       |
| ---------------- | ------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `chrome_fn_list` | none                | `query`, `tag`, `include_drafts`                                                    | Functions with kind, version, draft flag and last success         |
| `chrome_fn_get`  | `name`              | `version`, `history`, `out_file`                                                    | A definition, an old version, the version history, or a YAML file |
| `chrome_fn_run`  | `name` or `run_id`  | `params`, `confirm`, `cancel`, `allow_duplicate`, `keep_open`, `caller`, `out_file` | Run in a window of its own; preview, pause, commit                |
| `chrome_fn_save` | `name`, `changelog` | `definition` or `source_path` or `from_version`, `base_version`, `caller`           | New function, new version, or rollback; each save a git commit    |
| `chrome_fn_runs` | none                | `name`, `limit`                                                                     | The run log, newest first                                         |

**Where they live.** One YAML file per function in a private git repository, `~/.mokutab/functions` by default (`MOKUTAB_FN_DIR` overrides it): `acme.case.read` is `acme/case.read.yaml`, helper `_helpers.dom` is `_helpers/dom.yaml`. Each save commits with the subject `<name> v<N>: <changelog>`, so diffs, history and rollback are git's. A save names the version it built on (`base_version`) and is refused on top of a newer one; a file with uncommitted hand edits is never overwritten. Client functions belong in this private registry, never in this repository.

**What a definition holds.** `name`, `description`, `tags`, `kind` (`read`, `write` or `send`), `params` (a JSON Schema subset: type, enum, pattern, minimum, maximum, items, properties, required, default, additionalProperties), `target` (`url` template, `profile`, `host`, `own_window`; `host` is required for `write` and `send`), `helpers`, `steps`, and optionally `preview`, `result`, `dedupe_key`, `verify_hint`, `notes`, `vault`. Every object is closed: an unknown key (`comit`, `dedup_key`, `target.hots`, an unsupported schema keyword) is a validation error, because a key nobody reads would silently drop a safeguard. Step types:

| Step       | Does                                                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate` | Loads a URL template in the function's tab through the tabs API and waits for the load                                                                                                                                                 |
| `wait_for` | `until` (a JS expression or one condition) or `any` (named conditions; the matched name is the step value)                                                                                                                             |
| `js`       | Body of an async function with `args`, `prev` (earlier step values by id) and `h` (helpers); returns JSON                                                                                                                              |
| `verify`   | Like `js`, but must return `true`; a string or anything else is the failure message                                                                                                                                                    |
| `tool`     | Calls an allowlisted browser tool in the tab (`chrome_computer`, `chrome_click_element`, `chrome_find_elements`, `chrome_fill_or_select`, `chrome_keyboard`, `chrome_snapshot_wait_for`, `chrome_handle_dialog`, `chrome_search_page`) |
| `pause`    | Stops the run until the caller resumes it with the named params                                                                                                                                                                        |
| `finish`   | Ends the run with a value                                                                                                                                                                                                              |
| `fail`     | Ends the run with a message                                                                                                                                                                                                            |

Conditions (`when` on any step, and in `wait_for`) are one of `url` (regex on the tab URL), `exists` / `missing` (a CSS selector, through `chrome_find_elements`), `js` (an expression in the page), or `step` with `equals` / `in` (an earlier step's value). `url`, `exists` and `missing` never need the debugger, so they work on pages CDP cannot attach to. Templates use `{param}` and `{prev.step.path}`, with filters `url`, `raw`, `lower`, `upper`, `json`, `ns_host`; values in URLs are URL-encoded unless filtered, a missing value is an error, and values reach page code only as one JSON literal, never spliced into the code text.

**Runs.** A run opens its own unfocused window (the shared agents window with `own_window: false`), so it can only touch the tab it opened, and closes it when the run ends. Outcomes:

| `status`  | Meaning                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| `ok`      | Finished; `result` is the `result` step's value, or the last `js` / `tool` / `finish` value                         |
| `preview` | A `write` or `send` without `confirm` stopped before its first `commit` step; nothing changed; `run_id` returned    |
| `paused`  | A `pause` step needs `needs`; resume with `run_id` and those params                                                 |
| `failed`  | A step failed before any commit; nothing changed; `error.step` names it                                             |
| `unknown` | A commit step failed or timed out, or a later step did: the change MAY have landed; `verify_hint` says how to check |

A preview or a pause keeps its window for 10 minutes, so `chrome_fn_run({run_id, confirm: true})` commits exactly what was previewed; `cancel: true` drops it and reports `window_closed` as checked, not assumed (a leave-page prompt can keep a tab open). A `write` may also run in one call with `confirm: true` (the preview comes back with the result); a `send` always needs the preview first, also when it paused before reaching it. The approval stays with the calling agent. Before a commit step the page host is checked against `target.host`, which catches a logged-out redirect as `failed`, not `unknown`. A `dedupe_key` (a template over params) refuses a second commit of the same key within 24 hours unless `allow_duplicate: true`. Runs load only http(s) pages and never logout, sign-out or role-change pages. A `verify` or `fail` step that stops a run before any commit marks it `refused: true`: the function's own check caught bad input, which is not counted as a failure. Results are redacted like `chrome_javascript` output; `out_file` writes a large result unredacted (its directory is checked before the window opens). `keep_open: true` leaves the window open after the run to inspect a failure.

**Vault values (logins).** A function can type a value from the user's Bitwarden vault without any model seeing it: it declares `vault: {password: {item: "{bw_item}", field: password}}` (fields `username`, `password`, `totp`) and uses `"{vault.password}"` as the whole `value` of a fill step (`chrome_computer` with `action: fill`, or `chrome_fill_or_select`), and nowhere else. The bridge reads the value with the `bw` CLI at that step, so a TOTP code is fetched only when its input is on the page, and only after checking that the page is one of the item's own URIs (Bitwarden's match rules: base domain by default, host, starts with, exact; regex and never do not match). Values are scrubbed from step values, errors, the reply and the run log, which records only the item ids. The session key comes from `BW_SESSION` in the Windows user environment (the registry, so a key set after Chrome started is seen), then from the process environment. Such a function is kind `read`, runs in its own window, loads no helpers and has no pause step; `keep_open` is ignored, the page must be https, and the site match is checked again right before typing. It is never saved or replaced by `chrome_fn_save`: a person writes the file and commits it, and the bridge runs it only while the file is exactly as committed and its last commit is not a `chrome_fn_save` one. This is a personal tool: these rules keep values out of replies and stop vault functions arriving through `chrome_fn_save`, but they are no sandbox against an agent that can write arbitrary files (other tools' `out_file` can) or anything else running as the user.

**Drafts and the run log.** Every phase of a run appends a line to `<state dir>/fn-runs/YYYY-MM.jsonl` (the bridge state dir, `%LOCALAPPDATA%\mcp-chrome-bridge` on Windows, a directory that keeps its 1.x name; `MOKUTAB_FN_STATE_DIR` overrides it): time, run id, function and version, phase, status, whether a commit ran, caller, profile, failed step, `refused`, vault item ids, duration, and a keyed hash of the params (an HMAC with a per-machine key), never their values. A `commit_start` line is written right before each commit step, so a bridge that dies mid-commit still leaves a record that blocks a duplicate. A run log that cannot be written comes back as `log_warning` in the reply instead of hiding the outcome. A function that never ran successfully at all is hidden from `chrome_fn_list` unless `include_drafts: true`; one whose write never committed successfully is listed with `draft: true`.

### Large results: out_file and auto-file

The bridge serves three extra properties to every tool whose result can grow large, injected at `tools/list` time rather than repeated per schema:

| Property                    | Effect                                                                |
| --------------------------- | --------------------------------------------------------------------- |
| `out_file`                  | Absolute path to write the full result to (its directory must exist)  |
| `auto_file`                 | Spill an oversized result to a temp file and return a summary instead |
| `auto_file_threshold_chars` | Character count above which `auto_file` spills. Default **60000**     |

Which tools get them:

- **Core reads that grow with the page**, `auto_file` on by default: `chrome_snapshot`, `chrome_get_web_content`, `chrome_javascript`, `chrome_search_page`, `chrome_find_elements`. `chrome_act` is deliberately absent: its step results and page report must reach the agent inline.
- **`chrome_screenshot`** is served the properties with `auto_file` off by default; it spills only when asked.
- **The Workato module's read tools**, `auto_file` on by default: `workato_list_jobs`, `workato_job_trace`, `workato_search_recipes`, `workato_recipe_step_search`, `workato_recipe_callers`, `workato_recipe_grep`, `workato_recipe_connections`, `workato_recipe_version_diff`, `workato_recipe_status`, `workato_apps_list`, `workato_pick_list`, `workato_step_schema` (when called without `apply_to`), `workato_run_query`, `workato_call_action`, `workato_lookup_tables_list`, `workato_lookup_table_get`, `workato_lookup_table_row_search`, `workato_data_tables_list`, `workato_data_table_get`, `workato_data_table_row_list`, `workato_deployments_list` and `workato_deploy_plan`. Four Workato tools own a hand-written file hook and keep it: `workato_pull_recipe`, `workato_lcap_page_get`, `workato_api_request` and `workato_adapter_meta`.

What comes back instead of the payload is a summary: `saved_to`, `bytes`, `content_type`, `version_no`, the top-level keys, the item count of each depth-1 array, and any truncation flags the payload carried (`truncated`, `truncated_fields`, `total_bytes`, `total_items`, `total_count`, `has_more`, `next_page`, `next_cursor`, `limit`, `coverage`, `search_mode`, `warning`), copied verbatim so a partial result cannot read as complete. Nothing is written for a failed call.

Auto-mode files accumulate under `<tmpdir>/mokutab-results/session-<pid>-<stamp>/`. There is no TTL or size cap yet. Inline results and automatic spills are redacted; `chrome_javascript` with an explicit `out_file` writes the returned value itself, unredacted.

`chrome_bridge_info`, `workato_recipe_apply`, `workato_recipe_validate`, `workato_operation_status` and `workato_datapill` answer inside the bridge and never reach the post-processor, so they take none of these properties.

#### `chrome_screenshot`

`storeBase64: true` now returns an MCP **image** block plus a small metadata text block (`tabId`, `url`, `name`, `width`, `height`, `mimeType`, `bytes`, `fileSaved`, `fullPath`). The base64 payload never appears in a text block. `storeBase64` and `savePng` compose, where `storeBase64` used to return before the save branch; `fullPage` defaults to false, as the handler always did. `chrome_computer` returns the same envelope for `zoom`, and its `screenshot` action delegates with `savePng: false` so a look at the page does not write a download.

`out_file` writes the decoded bytes to a path of your choosing, unlike `savePng`, which can only reach Chrome's Downloads folder. It writes the COMPRESSED JPEG the image block carries (scale 0.7, quality 0.8); `savePng` remains the way to get the uncompressed capture. `no_inline: true` leaves the image block out of the response.

---

## Workato module

97 tools for Workato, served while the module is switched on. Each one runs inside a signed-in Workato tab, with that tab's cookies, CSRF token, permissions and environment.

**Evidence.** The Workato endpoint shapes quoted below (jobs search and retention, the dependency graph, `state.json`, `test.json`, connection health, pub/sub) were captured live on 2026-09-07 against a Development environment and are recorded in [`skills/workato-recipes/platform-endpoints.md`](../skills/workato-recipes/platform-endpoints.md).

A live smoke test on 2026-09-07 exercised, end to end against a real workspace: the `add_step` audit reproduction; `workato_recipe_apply` batching, `dry_run`, idempotency, the stale-lock refusal and the `remove_step` datapill guard; the file version lock, the recipe id mismatch refusal and `ignore_file_version`; start-failure diagnosis with `config_errors` and the connections summary; `workato_recipe_status` `activation`; `workato_recipe_connections`; `workato_recipe_callers` (three callers of 76902508); `workato_recipe_grep`; `workato_list_jobs` `query`, `match`, the date range, `timezone`, the erased boundary and report labels; `workato_job_trace` on an erased job and its projection; `workato_search_recipes` in `fulltext` and `name_substring`; `workato_test_recipe` in `input` and `unsupported` modes; `workato_recipe_save_with_dependents` with its journal; `workato_operation_status` `list`, `refresh` and `resume`; the `chrome_screenshot` image block and `out_file`; `workato_session_context` and the context block; and `chrome_bridge_info`.

Everything else is covered by unit tests only. Where a specific claim was not reachable live, this page says **live verification pending** rather than asserting it.

### The module switch

The extension popup has a **Modules** section with one switch per module. It is one switch per machine, kept in the bridge (`~/.mokutab/config.json`, `{"modules": {"workato": true}}`), so every Chrome profile sees the same value. A fresh install starts with Workato off; an upgrade from 1.x keeps it on. While Workato is off, `tools/list` serves the core tools only, the server instructions say the module is off, and a call to a Workato tool (from a session that still has the old list) is refused with `Error: <tool> belongs to the Workato module, which is switched off on this machine. Nothing was sent. Turn it on in the MokuTab popup (Modules).` A change sends `notifications/tools/list_changed` to open MCP sessions; a client that ignores it sees the change in its next session. `chrome_bridge_info` counts and hashes what is actually served, so `tool_count` is 52 with Workato off and 153 with it on.

### Conventions

**Every Workato tool needs a signed-in Workato tab.** Requests are executed inside that tab's origin, using its cookies and CSRF token. Nothing works without one.

**Tab resolution.** A tool targets, in order: an explicit `tabId`, the tab pinned by `chrome_switch_profile`, a Workato tab in the same window (`windowId` where the tool accepts it), then any open Workato app tab. It never targets "whatever tab happens to be focused". Two different Workato hosts open at once (say US and EU) is ambiguous and fails with `MultipleWorkatoHosts`. An explicit `tabId` that no longer resolves to a signed-in Workato app tab now throws instead of falling through to another tab.

**Every successful `workato_*` response carries a context block.** One extra text block, under 200 bytes, appended last:

```json
{
  "context": {
    "tab_id": 42,
    "host": "app.workato.com",
    "workspace_id": 51923,
    "workspace_name": "Power Factors",
    "environment": "Development",
    "profile": "personal"
  }
}
```

`profile` is added by the bridge on the top-level routed response. Workato resolves the workspace from the tab's own session, so this is the only thing in a response that distinguishes "recipe 123 in production" from "recipe 123 in the sandbox". Resolving it can never fail a call: when it cannot be read, the block is simply absent. It is also absent when a call targets `windowId` rather than a tab, and on the `out_file` responses of `workato_pull_recipe` and `workato_lcap_page_get` (the file's own `origin` block carries the same facts). Response parsers should keep reading the FIRST text block; the context block is always last.

**A pinned session pins the workspace, not just the tab.** `chrome_switch_profile(profile, tabId)` reads that tab's workspace and environment once and keeps the whole tuple. Every later call, top-level and nested, carries the pinned tab and an `expected_context`. Writes verify it before acting and fail with `ContextMismatch`. A profile that disconnects and reconnects bumps a registry generation, the pinned tab is re-read, and a workspace or environment that moved fails the call with `ContextChanged`.

**Slim by default.** Read tools return a compact, agent-shaped payload. Pass `full: true` where offered to get Workato's raw response instead.

**Large results spill to a file.** Every Workato read tool serves `out_file`, `auto_file` and `auto_file_threshold_chars`; auto-file is on by default above 60,000 characters. See [Large results](#large-results-out_file-and-auto-file).

**Timeouts.** `timeout_ms` is accepted on the long reads (`pull_recipe`, `recipe_grep`, `list_jobs`, `job_trace`, `recipe_version_diff`, `recipe_callers`, `recipe_step_search`, `search_recipes`, `run_query`, `adapter_meta`, `apps_list`, `pick_list`, `api_request`, the LCAP family). Default 30 s (40 s for diffs, 60 s for caller discovery), clamped to 10 s to 110 s. The bridge's own ceiling is 120 s, and most MCP clients cut off around 60 s, so values above roughly 55 s also disable the automatic single retry.

**Writes are verified, never blind-retried.** If a write times out, the tool re-reads state to determine whether it actually landed and reports `save_status: "succeeded_after_timeout"` rather than a false failure. `workato_call_action` passes `retryOnTimeout: false` whenever its own gate does not classify the action as read-only.

**Error codes**

| Code                    | Meaning                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `TabNotFound`           | No signed-in Workato app tab, or the given `tabId` is not one (any more)                   |
| `MultipleWorkatoHosts`  | Several Workato regions open simultaneously; close all but one                             |
| `ContextMismatch`       | The target tab is not the workspace or environment this call expects. Nothing was changed  |
| `ContextChanged`        | A pinned session's tab moved to another workspace or environment since it was pinned       |
| `WorkatoUnsafeAction`   | `workato_call_action` blocked a write-shaped action; pass `allow_writes: true` if intended |
| `WorkatoConnectorError` | The connector itself rejected the call (bad input shape, unsupported dialect, auth)        |
| `ScriptExecutionFailed` | The in-tab script could not run (page navigating, tab closed)                              |
| `UnexpectedShape`       | Workato returned a payload the tool could not parse                                        |

The lookup-table, data-table and workflow-app families report a context mismatch as `<tool> failed: Tab N is not the Workato context this call expects (...) Nothing was changed`, without the literal `ContextMismatch` token.

Every tool also accepts `tabId` (and most accept `windowId`); they are omitted from the tables below.

### Recipes and versions

| Tool                          | Required                                  | Optional                                                                                                                                            | Description                                                       |
| ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `workato_pull_recipe`         | `recipe_id`                               | `view`, `step`, `steps`, `include`, `paths`, `fields`, `field_query`, `max_items`, `budget_chars`, `cursor`, `if_version`, `out_file`, `timeout_ms` | Fetch a recipe's code tree plus version metadata, with projection |
| `workato_recipe_grep`         | `recipe_id`, `query`                      | `match`, `scope`, `max_matches`, `cursor`, `snippet_chars`, `timeout_ms`                                                                            | Find a string inside one recipe without pulling the recipe        |
| `workato_recipe_validate`     | one of `recipe_id` / `code_path` / `code` | `config`                                                                                                                                            | Local structure, binding, datapill and schema checks; never saves |
| `workato_rename_recipe`       | `recipe_id`, `name`                       | none                                                                                                                                                | Rename a recipe (`PUT /recipes/<id>.json`)                        |
| `workato_copy_recipe`         | `recipe_id`, `folder_id`                  | none                                                                                                                                                | Copy a recipe into a folder; returns the new recipe id            |
| `workato_delete_recipe`       | `recipe_id`                               | none                                                                                                                                                | Permanently delete a recipe (refused while it is running)         |
| `workato_recipe_version_diff` | `recipe_id`, `from`, `to`                 | `value_excerpt_chars`, `timeout_ms`                                                                                                                 | Changed steps only, between any two saved versions                |
| `workato_set_version_comment` | `recipe_id`, `version`, `comment`         | none                                                                                                                                                | Annotate a version (empty string clears it)                       |

`workato_recipe_version_diff` returns `{summary, added, removed, changed}` with field-level `{path, from, to}` excerpts. Steps that merely got renumbered by an insertion above them count in `summary.moved` and are not listed. Step headers now carry `uuid`; a node with no `as` is keyed by its uuid (reported as `as: "uuid:<uuid>"`) rather than by walk order, so inserting one anonymous node no longer invents added and removed steps.

#### `workato_recipe_validate`

Workato has no validate-without-save endpoint (`validate.json` and `ready.json` are both 404), so the only way to learn a tree was wrong used to be to save it and read `code_errors`, at the cost of a version. This runs every check that needs nobody's permission, in the bridge, without a save:

| Check     | What it covers                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| structure | Globally sequential numbering including nested blocks, unique `as`, `uuid` present, `else`/`elsif` last in an `if` block, `catch` last in `try`, `while_condition` first in `repeat`, `foreach` source at the node root               |
| bindings  | Every connection-backed provider has a `config` entry carrying an `account_id`, the gap Workato reports only later in `state.json` as `account_id can't be blank`. A `config` entry no step uses is reported as `config_entry_unused` |
| datapills | Every `_dp` pill and every Variables `<uuid>:<as>` composite names a step that exists and runs earlier in document order, reported with the step and the exact path                                                                   |
| schemas   | The two silent-strip rules, plus a dry-run preview of what `auto_schema` would derive                                                                                                                                                 |

Three rules are deliberately softer than the authoring guidance, because Workato itself is:

- **A non-hex `as` on an existing step is a WARNING, not an error.** Workato does accept anchors such as `tjcall01`. New anchors are still minted as 8 lowercase hex, and duplication is still an error, but an existing recipe with a hand-written anchor stays valid.
- **A `catch` step reading its own `catch.<as>.message` is not a forward reference.** The catch node's own error output is available inside it, so the upstream check exempts it instead of reporting a broken pill.
- **A `catch` never needs an `extended_output_schema`.** Its output shape comes from the runtime, so `datapill_target_no_output_schema` does not fire on one.

Sources are exclusive by precedence: `code`, then `code_path`, then `recipe_id` (the only one that pulls). A `code_path` file holding another recipe's id is refused before any read. Finding codes: `structure`, `config_absent`, `config_unparseable`, `config_entry_missing`, `account_id_missing`, `config_entry_unused`, `broken_datapill`, `broken_variable_reference`, `datapill_not_upstream`, `declaration_missing`, `missing_extended_schema`, `structured_input_no_schema`, `datapill_target_no_output_schema`.

Response: `{ok, source, recipe_id, version_no, valid, errors[], warnings[], coverage, derived_schemas, step_count, providers, saved: false, note}`. `coverage` reports `formulas: false` and `runtime: false`, because formulas are Ruby and are not parsed and nothing is executed. `valid: true` means the local checks passed, not that the recipe runs. Every structural rule is graded as an error here, where the mutation engine grades a pre-existing quirk on an untouched node as a warning: a caller comparing the two outputs will see that difference.

### Reading a recipe

#### Views

| `view`                 | Returns                                                                                                                                                          | Use for                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `compact` (default)    | Full step tree with UI metadata stripped and `_dp(...)` datapills shortened to a readable `datapill(...)` form                                                   | Understanding a whole recipe             |
| `outline`              | Step tree, descriptions and `input_keys` per step, no input values                                                                                               | Very large recipes that overflow compact |
| `step: "<as\|number>"` | One step: inputs classified as datapill / formula / interpolated / literal / code, the settable `fields`, and (with `include: ["datapills"]`) the upstream pills | Working on a single step                 |
| `full`                 | The lossless raw tree with exact `_dp(...)` references                                                                                                           | Wholesale tree rewrites                  |

Every view now carries `version_no`, including a step view, which had none.

#### Projection parameters

They are independent of each other and can be combined.

| Parameter      | Effect                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`      | Sections of a step view: `mappings`, `fields`, `datapills`, `schemas`, `code`. Default `["mappings","fields"]`, so upstream datapills are now opt-in. `include: []` falls back to the default rather than meaning "nothing" |
| `paths`        | Exact values, returned losslessly and exempt from every cap                                                                                                                                                                 |
| `fields`       | Filter `fields` and `available_datapills` by field name or label (`field_query` is a same-behaviour alias). Fields match name and label; a datapill matches ref and label                                                   |
| `steps`        | Several step refs read against ONE snapshot                                                                                                                                                                                 |
| `max_items`    | Per-list item cap, default 60, hard maximum 500                                                                                                                                                                             |
| `budget_chars` | Overall response budget: default 12,000 for a step view, 60,000 for compact and outline, clamped 500 to 400,000                                                                                                             |
| `cursor`       | Continue a list cut by `max_items` or the budget, without repeats                                                                                                                                                           |
| `if_version`   | Answers `{unchanged: true, version_no}` without transferring the recipe again                                                                                                                                               |

A filter no longer lifts a limit: `fields` narrows the lists inside `max_items` and the budget. A list cut by either is cut at an item boundary, says `truncated: true`, and carries `next_cursor`. Totals (`total_mappings`, `total_fields`, `total_datapills`) report the counts AFTER a `fields` filter, not the unfiltered totals.

#### Execution semantics and preview markers

Compact and outline used to copy `input` and drop every other node-root key, which silently lost what a loop actually did. They now keep `source`, `repeat_mode`, `clear_scope`, `batch_size` and `comment`, and the loop source appears in the step header.

Any value over 240 characters is replaced by a marker that names the way back, followed by the first 240 characters:

```
<<preview 240 of 9021 chars; path=input.code; read with step:"py01", paths:["input.code"]>>
```

`paths: [...]`, `include: ["code"]` and `view: "full"` all return the value verbatim.

#### Adapter fields on a schema-less step

A step view that includes `fields` used to return `fields: []` whenever the step's `extended_input_schema` was empty or absent, which reads as "this step takes nothing". It now merges in the adapter's own input fields for that exact operation, read once per call from `/integrations/meta` and only for the steps that need it. Each merged field carries `provenance` (`static`, `dynamic` or `both`, present only when a merge happened), and the view carries `fields_complete`. `fields_complete` is false when nothing could be read for the operation, and false when the operation declares `extends_input_schema` (a per-connection floor is not a whole set). The merge fires only for a step view, never for compact, outline or `view: "full"`.

#### Snapshot cache

Metadata is fetched first and the code is then requested for that exact version (`code.json?mode=view&version_no=<n>`), so both halves of the answer describe the same snapshot. A repeat read of the same version skips the code fetch and reports `cache_hit: true`. The cache is bounded (32 entries, 20 MB), keyed by tab host, recipe and version, and dropped eagerly by every extension write path. `workato_list_jobs`, `workato_test_recipe` and `workato_recipe_callers` read through the same cache.

#### `workato_recipe_grep`

Searches the snapshot in the service worker and returns only the matches, so a broad question costs the price of the answers rather than the price of the recipe.

| Parameter       | Values                                                   |
| --------------- | -------------------------------------------------------- |
| `match`         | `substring` (default, case-insensitive), `word`, `regex` |
| `scope`         | `input` (the configured input only) or `all`             |
| `max_matches`   | Default 50, maximum 500                                  |
| `snippet_chars` | Default 160, range 20 to 2000                            |
| `cursor`        | Continue a truncated result                              |

Returns `matches[{step{number, as, keyword, provider, name, title}, path, snippet, value_chars, input_capped?}]`, `total_matches`, `truncated`, `next_cursor`, `steps_scanned`, `values_scanned`, `version_no`, `cache_hit`. The reported `path` is exactly what `workato_pull_recipe(step, paths: [...])` reads back losslessly.

Two bounds worth knowing. `total_matches` counts matching VALUES, one per value, not occurrences inside them: it means "places", not "hits". A regex is limited to 200 characters, refused when a quantifier is applied to a group that already contains one (the `(a+)+` shape behind every real hang), and run against the first 20,000 characters of each value, because a service worker has no RegExp timeout. `scope: "all"` covers input, conditions, titles, descriptions, comments, the foreach source, both extended schemas, `dynamicPickListSelection` and the trigger's job-report columns; `visible_config_fields` and `toggleCfg` are not searched.

### Lifecycle, health, and long operations

| Tool                                  | Required    | Optional                                                                                                                                                                                                               | Description                                                         |
| ------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `workato_start_recipe`                | `recipe_id` | `wait`, `wait_timeout_ms`                                                                                                                                                                                              | Start a recipe; a start that does not take is diagnosed             |
| `workato_stop_recipe`                 | `recipe_id` | `force`, `wait`, `wait_timeout_ms`                                                                                                                                                                                     | Stop a recipe; `force: true` enqueues despite active dependents     |
| `workato_recipe_status`               | `recipe_id` | none                                                                                                                                                                                                                   | Cheap live-state read plus the last activation attempt              |
| `workato_recipe_connections`          | `recipe_id` | none                                                                                                                                                                                                                   | Which connections the recipe binds, and whether they authenticate   |
| `workato_recipe_callers`              | `recipe_id` | `sources`, `folder_ids`, `project_id`, `scope`, `max_recipes`, `max_pages`, `include_transitive`, `include_callees`, `refresh`, `jobs_limit`, `timeout_ms`                                                             | Who calls this recipe, with the evidence labelled                   |
| `workato_recipe_save_with_dependents` | `recipe_id` | `code`, `code_path`, `config`, `dependent_recipe_ids`, `scan_folder_id`, `scan_folder_ids`, `scan_project_id`, `scan_scope`, `expected_base_version_no`, `preflight_connections`, `async`, `ensure_running`, `comment` | Stop callers, save a callable, put them back                        |
| `workato_operation_status`            | none        | `operation_id`, `list`, `limit`, `refresh`, `resume`                                                                                                                                                                   | Read back or finish a journalled multi-recipe operation             |
| `workato_test_recipe`                 | `recipe_id` | `action`, `trigger_input`, `allow_writes`, `wait`, `wait_timeout_ms`                                                                                                                                                   | Run the recipe's Test, with trigger input where Workato supports it |

#### Start and stop outcomes

Both tools report `outcome`:

| `outcome`       | Meaning                                                    |
| --------------- | ---------------------------------------------------------- |
| `state_reached` | The recipe reports the state that was asked for            |
| `accepted`      | Workato took the request and the end state is NOT verified |
| `failed`        | Workato refused to activate the recipe (start only)        |

`POST start.json` answers `202 {"status":"enqueued"}` whether or not the recipe can start, and `/recipes/<id>.json` afterwards records nothing about the failure. When a `wait: true` window ends without the state flipping, `workato_start_recipe` reads `/web_api/recipes/<id>/state.json` and, if Workato recorded an activation error, returns `isError: true` with:

```
start_error { state, code_errors, config_errors[{line_number, field, value, message}], param_errors, requirements_errors, message? }
```

`config_errors` is normalized from both serializations Workato uses: positional arrays on later reads, objects on the read right after activation. A config error mentioning `account_id` also attaches a compact `connections` summary, so a disconnected connector is diagnosed in the same call. `diagnosis_error` appears when the diagnostic read itself failed. `workato_stop_recipe` never reads `state.json`: that record is written by an activation attempt and survives a later stop, so reading it after a stop would report a stale start failure as a stop failure.

`workato_recipe_status` keeps every existing field (`running`, `state`, `version_no`, `last_run_at`, `stopped_at`, `stop_reason`, `stopped_for_error`, `job_succeeded_count`, `job_failed_count`) and adds `activation {state, error_message?, config_errors?}` from one extra GET, or `activation_unavailable` when that read fails. No error on record is not the same as "this recipe can start": there is no pre-start validation endpoint.

#### `workato_recipe_connections`

Workato publishes no per-recipe connection endpoint, so the tool reads the recipe's `config` bindings, then each bound connection, then `/integrations/meta` for the providers that carry no `account_id`.

Returns `{recipe_id, name, state, running, version_no, connections[], healthy, blocking[], actions[], config_parse_error?, meta_error?}`. Each entry is `{provider, connection_id, connection_name, authorization_status, authorized_at, connection_lost_at, connection_lost_reason, authorization_error, warning, running_recipe_count, status}` with `status` one of:

| `status`       | Meaning                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `ok`           | Bound and authorized                                                                                   |
| `lost`         | Bound, and either not `authorization_status: success` or `connection_lost_at` is set                   |
| `missing`      | The provider needs a connection and the config carries no `account_id`                                 |
| `not_required` | The adapter needs no connection                                                                        |
| `unused`       | The `config` entry exists but no step in the recipe uses that provider: left-over binding, not a break |
| `unknown`      | The connection read or the meta lookup failed: a diagnostic gap                                        |

`healthy` is false when any binding is `lost`, `missing` OR `unknown`. `unused` and `not_required` never block. `blocking[]` is `{provider, connection_id, status, reason}` and `actions[]` carries the sentences: a broken connection is named by id to re-authorize, never replaced by a request for a new one. Credentials and the provider input bag never leave the tool.

The tool itself was verified live on 2026-09-07. The `lost` branch was not: no disconnected connection existed in the probed workspace, so any `authorization_status` other than `success`, or a non-null `connection_lost_at`, is treated as lost on field names alone. Live verification of that one branch is pending.

#### `workato_recipe_callers`

Three labelled evidence sources, `graph` and `code` by default:

| Source  | What it is                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph` | `GET /dependency_graphs/<id>.json?asset_type=recipe`, one request, workspace-wide, the Flow to Flow edges behind the Operations hub dependency page |
| `code`  | A fully paged code scan matching `call_recipe` / `call_recipe_async` `input.flow_id`; the only source that names the calling STEP                   |
| `jobs`  | `calling_recipe_id` off recent jobs: observed EXECUTION HISTORY, never a complete dependency list                                                   |

Scope is the recipe's own folder by default, or `folder_ids`, a project (`project_id` with `scope: "project"`, expanded to every folder under the project root) or `scope: "workspace"`.

**Folder membership does not come from the search endpoint.** `GET /web_api/mixed_assets.json` ignores `folder_id` outright (re-probed 2026-09-07 with four parameter variants, each returning the workspace-wide list across four folders). A folder scope is therefore resolved through `GET /dependency_graphs.json?asset_type=recipe&folder_id=<fid>`, the only exact membership list, or by walking the search endpoint and filtering client-side on each item's own `folder_id`; the response says which under `scope`. Membership is per folder and exact, so a subfolder is a separate id: enumerate them with `workato_list_folders`.

Returns `{recipe_id, sources, callers[{recipe_id, name, running, folder_id, step{as, number, async}, sources, observed_at}], callees, connections, lookup_tables, lcap_pages, unresolved_dynamic_targets, failed_reads, scope{mode, folder_ids, recipes_listed, recipes_read, pages, complete}, freshness{index_hits, index_misses, snapshot_reads, graph_fetched_at}, limits, truncated?, jobs_evidence?, transitive{edges, cycles, indirect_callers}?, completeness, completeness_reasons}`.

Take `completeness: "partial"` literally: it means other callers may exist. A caller's `running` is `null`, not `false`, when neither the listing nor the graph saw the recipe. A version-aware index keyed on the listing's `updated_at`, held in memory and in `chrome.storage.session`, makes a repeated call re-read only what changed; `refresh: true` forces a full re-read. There is no continuation cursor: a scope larger than the time budget reports the unread candidate count and `partial` rather than hiding it.

#### `workato_recipe_save_with_dependents`

Discovery now runs `workato_recipe_callers`. `scan_folder_id` keeps its meaning; `scan_folder_ids`, `scan_project_id` and `scan_scope` (`folders` | `project` | `workspace`) widen it. A partial discovery surfaces as a warning in the save response rather than a dependent list presented as complete.

The whole sequence is journalled to disk before each nested call, so a client timeout cannot lose which production recipes are sitting stopped. Every response carries `operation_id`. `async: true` returns `{operation_id, phase}` immediately and keeps running in the bridge.

Payload additions: `operation_id`, `save_classification`, `expected_base_version_no`, `dropped`, `callee_connections_healthy`, `callee_connections_reason`, `late_discovered_caller_ids`, `discovery_completeness`, `discovery_reasons`. Each `dependents[]` entry gains `restart_outcome`, `blocked_reason`, `connections_healthy`, `discovered_late`.

Behaviour worth knowing before calling it:

- A restart counts only when the start reports `state_reached`. An `accepted` start gets exactly one `workato_recipe_status` re-check and is then reported as FAILED, with the caller left stopped and named.
- `preflight_connections` (default true) runs `workato_recipe_connections` for the callee and every running caller BEFORE anything is stopped. An unhealthy callee is still SAVED (a disconnected connector must not make a recipe uneditable) but is not restarted, and no caller is restarted against it. An unhealthy caller is left stopped with its reason.
- `expected_base_version_no` defaults to the callee's version read during the preflight, so a retry after a timeout re-sends the same base version. This is a behaviour change: a save that previously went through while somebody else had saved in between is now refused.
- After the stops, when discovery was used and something was stopped, discovery runs once more; a caller that appeared in the meantime is stopped, restored and reported as `late_discovered_caller_ids`.
- An interrupted nested call is reported as interrupted, naming the phase, the exact recipe ids whose state is unknown, and the `operation_id`. Nothing is rolled back blindly on a transport that just failed to answer.
- `isError` is true for a `persisted_incomplete` save and false for `persisted_invalid`.

A default save now makes one `recipe_status` for the callee, one per dependent, one `recipe_connections` for the callee and one per running dependent, plus a second discovery when anything was stopped. On a callable with many running callers that is a noticeable increase in call volume. The tool and its journal were exercised live on 2026-09-07.

#### `workato_operation_status`

Reads the journal back locally, with no browser round trip.

| Argument       | Effect                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation_id` | The full record: context, every affected recipe with the running state and version it had BEFORE the operation, phases with timestamps, the save outcome, and the reason anything was left stopped |
| `list`         | The most recent operations (`limit` default 10, maximum 50)                                                                                                                                        |
| `refresh`      | Adds one live `workato_recipe_status` per affected recipe plus a `drift[]` list                                                                                                                    |
| `resume`       | **WRITES.** Finishes an interrupted restore                                                                                                                                                        |

`resume: true` re-reads every affected recipe, restarts ONLY the ones that were running before and only when the callee's saved version is usable and the connections are healthy, leaves previously stopped recipes stopped, and lists exact ids and reasons for anything it will not do. When the save's own outcome is unknown it is re-issued under the journalled `expected_base_version_no`, so Workato answers `already_applied` instead of creating a second version. It never rolls back over another editor's version. A tree passed inline cannot be re-issued: the journal stores a path and a hash, never a tree, and the response says so.

Journals live in the bridge state directory (`%LOCALAPPDATA%\mcp-chrome-bridge\operations` on Windows), one JSON file per operation, written with tmp plus rename, pruned at 200 files or 7 days. They are per bridge installation, not per profile: `list: true` shows every operation this bridge ran, each carrying its own context block. `list`, `refresh` and `resume` were all exercised live on 2026-09-07.

#### `workato_test_recipe`

Drives `PUT /recipes/<id>/test.json`, the editor's Test button. The mode comes from the trigger rather than being promised for everything:

| `mode`        | Trigger                               | Behaviour                                                                                                                                                                |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input`       | `workato_recipe_function`             | `trigger_input` becomes `trigger_event.parameters`, validated against the trigger's declared parameters first, so a typo is refused instead of arriving as an empty pill |
| `immediate`   | `clock`                               | Runs immediately, accepts no `trigger_input`                                                                                                                             |
| `waiting`     | `workato_webhooks`, `workato_pub_sub` | The test arms and waits for a real event; no polling. End it with `action: "stop"`                                                                                       |
| `unsupported` | anything else                         | Nothing is sent                                                                                                                                                          |

`action` is `run` (default), `stop` (`PUT stop_test.json`) or `status` (`status.json` `flow.testing` plus the newest test job). Workato's response carries no job id, so the tool records the test jobs that already exist, sends the PUT, and polls `jobs.json?test_jobs_only=true`. `wait` defaults to true with `wait_timeout_ms` default 60,000, clamped 2,000 to 110,000; a wait that runs out returns status `pending` with the elapsed time and the job as it actually stands, never a guessed outcome. The recipe is not started and stays stopped afterwards with `stop_reason: test_run_stop`.

**A test is execution, so it is gated like one.** `allow_writes: true` is required whenever the recipe binds a connection-backed provider (a `config` entry carrying `account_id`, or a step provider the config does not describe at all). The refusal names the providers under `connection_backed_providers` and happens before any HTTP. A recipe whose providers are all connectionless (logger, Variables, Event Streams, Scheduler, Python) runs without the flag. The gate reads only the recipe under test: a connectionless recipe that calls a callee which does touch Salesforce runs without `allow_writes`.

Run payload: `{recipe_id, action, mode, trigger{provider, name}, status, job{id, status, started_at, completed_at, error?}|null, polls, waited_ms, timed_out, trace_hint, flow{testing, running}, recipe_state_after, parameters_declared, parameters_validated, connection_backed_providers?, latest_test_job?, note?}`.

Trigger parameter validation is top level only, and a parameter with no `optional` flag is read as optional (Workato writes `optional: false` for required). `poll_now` is not exposed as an action: the returned note tells the caller to use `workato_api_request` with `PUT /recipes/<id>/poll_now.json {"id":<id>}`.

### Jobs

| Tool                 | Required               | Optional                                                                                                                                                                                                       | Description                              |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `workato_list_jobs`  | `recipe_id`            | `limit`, `status`, `query`, `match`, `scan_budget`, `stop_on_erased`, `fields`, `report_labels`, `started_at`, `started_from`, `started_to`, `timezone`, `group_by_master_job`, `cursor`, `full`, `timeout_ms` | Search jobs instead of walking pages     |
| `workato_job_trace`  | `recipe_id`, `job_id`  | `lines`, `line_range`, `detail`, `paths`, `empty`, `max_items`, `fields`, `full`, `timeout_ms`                                                                                                                 | Per-step execution trace for one job     |
| `workato_repeat_job` | `recipe_id`, `job_ids` | none                                                                                                                                                                                                           | Re-run one or more jobs by master job id |

#### Searching for jobs

**`query` is Workato's own search and it is narrower than the old documentation claimed.** Measured against a retained job, it matches a contiguous case-insensitive substring of the **job id** or of a **custom job-report column value** only. Not the error text. Not the column labels. Never an erased job. Searching the error text of a retained failed job returns nothing.

`match` is a LOCAL scan applied to every job the walk sees, inside the page, so a 5,000-job scan crosses the page boundary as a handful of matches:

```json
{ "mode": "exact" | "substring" | "regex", "fields": ["id", "title", "error", "report"], "value": "GIRAFFE-4412" }
```

The local regex is always compiled case-insensitive; there is no flags argument. Matching on `title` is implemented and unit-tested but could not be validated live: the probe found no job anywhere in the workspace with a non-empty title. Live verification pending.

The two budgets are separate: `limit` caps matches RETURNED (default 25), `scan_budget` caps jobs SCANNED (default 500, maximum 5,000), alongside the time budget from `timeout_ms`.

#### Date ranges

`started_from` and `started_to` accept ISO-8601 with an offset, a bare `YYYY-MM-DD` (widened to 00:00:00 and 23:59:59) or a local `YYYY-MM-DDTHH:MM(:SS)` resolved in `timezone` (default `UTC`, an offset or an IANA name), and go upstream as Workato's `started_at_from` / `started_at_to`. That makes a November to December interval expressible.

`started_at` accepts only `1.hour`, `24.hours`, `7.days`, `30.days`, `all`, and now REJECTS anything else: Workato ignores an unknown window silently and answers with the unfiltered scope, which reads as "no such jobs". Sending `started_at` together with `started_from`/`started_to` is allowed and both are forwarded, but how Workato combines them was never probed. Prefer one or the other.

#### Coverage: what was actually looked at

Every response carries `coverage` with `search_mode`, `scanned`, `matched`, `erased_seen`, the `started_at` window (`from` / `through`), `complete`, `retention_boundary_reached`, `stopped_reason` and a `next_cursor` taken from the last SCANNED job, so a scan that matched nothing is still resumable. The `summary` sentence refuses to call an incomplete scan an absence: zero matches with a filled budget says so, in words, next to the cursor that continues it.

The walk stops after 3 consecutive erased jobs (`stop_on_erased: false` to continue). The retention sweep is workspace-wide and monotonic, verified across five recipes, so everything older than the boundary is erased too.

**The boundary moves.** The sweep is periodic, not continuous, and it advances between reads: on 2026-09-07 the first probe put it around Jul 16 to Jul 20, and by 19:45 UTC the same day a job from Aug 3 on recipe 72988590 was already erased. `coverage.retention_boundary_reached` and the `from` / `through` window describe THAT scan. Do not carry a boundary date forward into a later call.

#### Erased jobs

A job swept by retention stays in the list. The slim job carries `erased`, `zero_retention`, `is_test`, `calling_recipe_id` and `calling_job_id`, and reports `title` and `report` as `null`, not `''`, when erased, so unavailable data and empty data no longer serialize identically. A `fields` projection answers `null` with `erased: true` for unavailable data.

`workato_job_trace` on an erased job returns `{job_id, erased: true, zero_retention?, note: "job data was erased by retention; line details are unavailable", recipe{id, name, version_no}, status, title?, started_at, completed_at}` instead of a zero-step trace (`/line_details` answers `[]` for such a job). `full: true` is unchanged, being a raw passthrough that already carries `erased` on the job header.

#### Report columns

The slim job used to stop at `custom_column_2` and rename the columns to `col_0..col_2`. Every `custom_column_*` present is now returned, keyed by the label configured on the recipe trigger's `job_report_schema`, read from the version-pinned recipe snapshot. `report_columns` lists the mapping and `report_columns_version` names the version the labels came from; an unlabelled column keeps its `custom_column_N` key. `report_labels: false` skips the lookup. Jobs that ran under an older version are labelled with the current version's schema.

#### `fields` projection on `workato_list_jobs`

For example `['id','started_at','status','report.Marker code']`. Combining `fields` with `full: true` reports `full_ignored` rather than failing. `full: true` returns the raw MATCHED jobs, not the raw scanned pages.

#### Trace projection

`workato_job_trace` strips schema noise from summaries and truncates step input and output to 500 characters. Narrow with `lines: [104, 118]` (exact set) or `line_range: [91, 123]` (inclusive), and add `detail: "full"` for a selected step's exact untruncated payload.

| Parameter   | Effect                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths`     | Keep only these paths inside each step's input and output: dots, `[N]`, `[]` for every element, `['a.b']` for a key that contains a dot                                                                                   |
| `empty`     | `keep` (default) or `drop`. `drop` removes `undefined`, `null`, `''`, `{}` and `[]` and nothing else: `0` and `false` always survive, and arrays are mapped rather than filtered so every index still means what it meant |
| `max_items` | Preview long arrays as `{_array_preview, total, shown, items}`, default 20                                                                                                                                                |
| `fields`    | Keep only these keys per step                                                                                                                                                                                             |

Projection runs before the summary is truncated, so the 500-character budget is spent on the data that was asked for, and outside the schema re-stringification, so a step's serialized input is never rewritten. The response echoes what it did under `projection`. `full: true` stays unprojected.

### Search and connections

| Tool                         | Required        | Optional                                                                                                                               | Description                                                 |
| ---------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `workato_search_recipes`     | none            | `text`, `match`, `app`, `running`, `folder_id`, `page`, `max_pages`, `limit`, `sort`, `timeout_ms`, `full`                             | Search recipes across the workspace                         |
| `workato_search_connections` | none            | `text`, `provider`, `folder_id`, `page`, `sort`, `full`                                                                                | Search connections by name, optionally filtered by provider |
| `workato_get_connection`     | `connection_id` | `full`                                                                                                                                 | One connection, with secrets stripped                       |
| `workato_recipe_step_search` | `provider`      | `action`, `folder_ids`, `recipe_ids`, `input_query`, `input_match`, `preview_chars`, `limit`, `max_recipes`, `max_pages`, `timeout_ms` | Find live examples of a step across recipes                 |

**`text` is a full-text search, not a name substring.** It covers the recipe name, its description AND its own action and trigger titles, which is why `ECO` answers with recipes whose steps say "New/updated records". In the default `fulltext` mode each hit carries `matched`: the highlighted name, description or action title, with Workato's `<span class="text-highlight">` markup removed, so it is visible WHY a recipe came back.

`match` narrows client-side over the walked pages: `fulltext` (default), `name_substring`, `name_word`, `name_exact`, `name_regex`. `app` takes adapter technical names (one uses the server's `adapters=` filter, several are ANDed client-side). `running` is applied client-side because Workato ignores the server parameter. `max_pages` defaults to 5 (maximum 50) and `limit` to 20, so a broad scan can return only the first 20 matches: `coverage` reports `pages_scanned`, `recipes_scanned`, `matched`, `complete` and `next_page`, and the drop is visible there. `sort` gains `relevance`.

`workato_recipe_step_search` gains scope and an input filter: `folder_ids` scans exactly those folders, `recipe_ids` reads exactly those recipes and skips the listing entirely, `input_query` with `input_match` (`substring` | `regex`) keeps only steps whose serialized input matches, and `preview_chars` (default 2000) returns an oversized input as `input_preview` plus `input_chars`. The response carries `scope` and `coverage`, and a mid-walk page failure now sets `incomplete` with the reason instead of ending the walk as though the workspace held nothing more.

**`folder_id` on `workato_search_recipes` and `folder_ids` on `workato_recipe_step_search` are resolved by the tool, not by Workato.** The search endpoint ignores every folder parameter it is given and answers with the whole workspace, so a folder scope goes through the dependency-graph membership list (`GET /dependency_graphs.json?asset_type=recipe&folder_id=<fid>`) or a client-side filter on each item's `folder_id`, and `coverage` / `scope` reports which. Folder membership is exact: a subfolder needs its own id.

Workato caps pagination at 20 items per page server-side. `text` on `workato_search_connections` matches connection **names**, not the `provider` field; `provider` is applied client-side by walking up to five pages.

**`workato_get_connection` always strips auth material, including under `full: true`,** and `workato_search_connections(full: true)` now runs the same strip on the raw items. An agent that needs to reach the SaaS should go through the connection itself (`workato_run_query` or `workato_call_action`), not extract a token.

### Connector execution and discovery

| Tool                   | Required                                | Optional                                                                                                | Description                                                          |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `workato_apps_list`    | none                                    | `query`, `category`, `only_connected`, `include_deprecated`, `include_certified`, `limit`, `timeout_ms` | The connector catalogue, merged with this workspace's connections    |
| `workato_adapter_meta` | `adapter`                               | `operation`, `field_grep`, `include_help`, `include_deprecated`, `raw`, `out_file`, `timeout_ms`        | A connector's operations and their field surface                     |
| `workato_pick_list`    | `connection_id`, `field`                | `adapter`, `operation`, `pick_list_params`, `flow_id`, `query`, `limit`, `timeout_ms`                   | Resolve a dynamic pick list against a connection                     |
| `workato_step_schema`  | `adapter`, `operation`                  | `connection_id`, `input`, `dynamic_pick_list_selection`, `flow_id`, `only`, `apply_to`, `timeout_ms`    | Generate a step's `extended_input_schema` / `extended_output_schema` |
| `workato_datapill`     | none                                    | `kind`, `mode`, `shorthand`, `provider`, `line`, `pill_type`, `widget_id`, `variable_id`, `path`        | Build or parse a `_dp(...)` payload, in the bridge                   |
| `workato_run_query`    | `connection_id`, `query`, `type`        | `schema_only`, `full`, `timeout_ms`                                                                     | Run SOQL / SuiteQL / SQL through a connection                        |
| `workato_call_action`  | `connection_id`, `action_name`, `input` | `allow_writes`, `full`                                                                                  | Invoke any connector action (gated)                                  |
| `workato_api_request`  | `path`                                  | `method`, `query`, `body`, `headers`, `allow_writes`, `out_file`, `max_bytes`, `timeout_ms`             | Escape hatch for endpoints no tool covers                            |

`workato_apps_list` is the way to resolve a display name: Workato's own connectors are named nothing like they are called (HTTP is `rest`, Event Streams is `workato_pub_sub`, Scheduler is `clock`, Python is `py_eval`, Workflow apps is `workato_workflow_task`). It reads Workato's own connector catalogue, the `providers` map that every app page preloads from `/web_api/dynamic_app_config/<sha256>.js` (338 standard connectors on 2026-09-08, per deployment, cached in the bridge by its hash), plus the certified community catalogue (178), this workspace's SDK connectors and its connections, and tags each app with every source it was seen in: `connection`, `recipes`, `custom`, `builtin` (Workato's own tools), `standard`, `certified`. `query` matches name, title, aliases and categories; `category` filters on one; `only_connected` keeps the apps a step can authenticate as now; deprecated catalogue entries are hidden unless `include_deprecated` or this workspace still uses them. A bare call returns a summary (`connected`, `custom`, `used_in_recipes`, `catalogue: {standard, builtin, certified, deprecated_hidden, categories}`) rather than the whole catalogue. An app absent from both catalogues is not available as a connector: the honest options are the HTTP connector or an SDK connector, and the response says so instead of inviting a guess. A `pick_list` STRING on a field means the values live on the connection, so resolve them with `workato_pick_list`.

`workato_adapter_meta` index mode hides operations flagged `deprecated: true`, exactly as the editor's action picker does (Salesforce: 60 actions in meta, 27 deprecated, 33 shown), reports `deprecated_hidden` per adapter, and carries each operation's `title_hint` and `aliases` when the connector sets them. `include_deprecated: true` shows them all; naming a deprecated operation with `operation:` still returns it, marked.

#### `workato_step_schema`

The step's real `extended_input_schema` and `extended_output_schema`, generated by the adapter instead of written by hand. It wraps `POST /connections/<connection_id or adapter slug>/extended_schema.json`, the call the recipe editor's Setup panel makes after every input change, and returns `result.input` and `result.output` as `input_schema` and `output_schema`: the two arrays go into the step verbatim. Workato accepts a step without them, reports `code_errors: []`, and then drops the structured input on readback or fails the downstream datapill with `Unknown data field`, which is the failure this tool exists to remove.

`adapter` and `operation` are required; the tool reads `/integrations/meta` first, refuses an unknown operation naming the closest ones, and refuses before any call when the adapter needs a connection (`connection_required: true`) and none was given. A connectionless adapter (`workato_variable`, `clock`, `logger`) is addressed by slug, as the editor does. `input` is the step input as it would be saved; the response lists the fields that drive the schema as `schema_drivers` (the meta fields flagged `extends_schema: true`) and, when the arrays come back empty because a driver is unset, says which one in `note` rather than reporting an error. `dynamic_pick_list_selection` is derived from `input` for every field whose meta `pick_list` is a string, mirroring the editor, and reported as `dynamic_pick_list_selection_used`. `only` narrows to `["input"]` or `["output"]`; `flow_id` is the recipe id and optional.

`apply_to: {recipe_id, step}` writes both non-empty arrays into that step in ONE version through the same engine as `workato_recipe_set_extended_schema`, with `comment`, `expected_base_version_no`, `dry_run`, `verify_readback`, `restart_if_running` and `ensure_running` forwarded; the mutation summary comes back under `applied`. Without it the response carries `apply_ops`, a ready `workato_recipe_apply` operations array with `step: "<as>"` left to fill.

Verified 2026-09-08: `workato_variable` / `declare_list` with `input: {name: "orders", list_item_schema_json: "[{\"name\":\"order_id\",\"type\":\"string\",\"label\":\"Order ID\"},{\"name\":\"amount\",\"type\":\"number\",\"label\":\"Amount\"}]"}` returned `input_schema: [{name: "list_items", label: "Items", type: "array", of: "object", optional: true, properties: [order_id (string, text), amount (number, float_conversion)]}]` and `output_schema: [{name: "list_items", label: "orders", optional: false, same properties}]`; `clock` / `scheduled_event` with `{time_unit: "minutes"}` returned `trigger_every`, `timezone`, `start_after`; Jira `get_issue` through connection 16580119 with `input: {}` returned the full 14 KB issue schema; a custom SDK connector's `run_suiteql` returned `items`, `count`, `hasMore`, `offset`, `totalResults`, `query_executed`, `error`.

**The endpoint reports failure as HTTP 200 with an `error` key, never a 4xx.** `{"error": "HTTP status code 420"}` means the connection failed the call against the SaaS: seen on both Salesforce connections of the probed workspace, and as `{"error": "invalid_grant"}` on a Google Sheets connection, while all three reported `authorization_status: "success"`. The tool returns that as an error that names the connection to re-authorize and says that `success` does not rule it out. `workato_step_schema(..., input: {})` is therefore the cheap liveness probe for a connection: it saves nothing and answers in under a second. The editor's toolbar Refresh button is not a substitute, because it saves the recipe after the same call.

`workato_datapill` runs entirely in the bridge, with no browser call: it builds or parses the compact `_dp(...)` payload that Workato matches byte for byte.

#### `workato_run_query`

Returns `{type, count, truncated_to_100, schema, rows}` regardless of the underlying SaaS. `connection_id` is the `shared_account_id` from `workato_search_connections` or from a recipe's `version.config`.

- **Hard-capped at roughly 100 rows server-side.** Narrow with a `WHERE` clause.
- **SOQL**: a trailing `LIMIT` is stripped before sending, because Workato appends its own and the two collide.
- **SuiteQL**: works against both NetSuite REST and SOAP connections.
- **SQL**: adapter-dependent; unsupported connectors surface `WorkatoConnectorError`.
- `schema_only: true` returns field metadata without rows.

Read-only. Never treat it as a write path.

#### `workato_call_action`

Backed by `POST /connections/<id>/test_action.json`, the same endpoint the recipe editor's Test button uses. **`connection_id` must be a real connection id**: an adapter name is a 404 there, so a connectionless step can only be executed by test-running a recipe with `workato_test_recipe`.

**Write gate.** By default only read-shaped actions run. An action counts as read-only if any of:

- `action_name` starts with `search_`, `get_`, `list_`, `query_`, `find_`, `describe_`, `read_`, or `fetch_`
- `action_name` is exactly `execute_suiteql`
- `action_name` is `__adhoc_http_action` **and** `input.verb` is `get`, `head`, or `options`

Everything else (`add_record`, `upsert_record`, `delete_record`, `__adhoc_http_action` with `verb: "post"`) is rejected with `WorkatoUnsafeAction` unless the caller passes `allow_writes: true`. The override exists for legitimate writes; it creates, modifies, and deletes real production records. A write is never auto-retried after a timeout.

**Finding `action_name` values.** Every step in a recipe's code tree carries a `name` that is a valid action name. Pull a representative recipe and read its steps. Confirmed examples:

| Action                    | Connector                  | Input notes                                                                                                                                                                                                       |
| ------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__adhoc_http_action`     | Any HTTP-capable connector | `{mnemonic: "Custom action", verb, path, response_type, inspect: true, request_headers?}`. **Both `mnemonic` and `inspect: true` are required**, otherwise Workato replies `'Action name' must be present`        |
| `execute_suiteql`         | NetSuite                   | `{query}`                                                                                                                                                                                                         |
| `search_sobjects_soql_v2` | Salesforce                 | `{query, limit: 100, output_schema: '[{"name":"Id"}]'}`. `output_schema` is required but need not match the selected fields; omitting it makes Workato introspect the whole object and the call usually times out |

Prefer `workato_run_query` when all you need is rows.

#### `workato_api_request`

The escape hatch for endpoints no dedicated tool covers. Same-origin only: `path` is a path on the Workato host, never a URL elsewhere. It sends `x-requested-with: XMLHttpRequest` automatically and attaches `x-csrf-token` from the `XSRF-TOKEN-V2` cookie on writes; the token is never returned. Anything other than GET or HEAD needs `allow_writes: true`, and a non-GET call verifies the pinned workspace before acting. A 404 on a `/web_api/` path usually means the tab is in the wrong workspace or environment, not that the object is missing.

[`skills/workato-recipes/platform-endpoints.md`](../skills/workato-recipes/platform-endpoints.md) carries the live-verified request and response shapes, and a ready-to-paste call for each endpoint that has no tool.

### Projects and folders

| Tool                       | Required                                              | Optional                            | Description                                                          |
| -------------------------- | ----------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `workato_list_folders`     | none                                                  | `project`, `full`                   | The full project and folder tree                                     |
| `workato_create_folder`    | `name`, `parent_id`                                   | none                                | Create a folder                                                      |
| `workato_update_folder`    | `folder_id`                                           | `name`, `parent_id`                 | Rename and/or move a folder                                          |
| `workato_delete_folder`    | `folder_id`                                           | `force`                             | Delete a folder: **cascades to its contents**                        |
| `workato_move_recipe`      | `recipe_id`, `folder_id`                              | none                                | Move a recipe into another folder                                    |
| `workato_create_project`   | `name`                                                | none                                | Create a project                                                     |
| `workato_update_project`   | `folder_id`                                           | `name`, `color`, `icon`             | Rename or restyle a project                                          |
| `workato_deployments_list` | `recipe_id`, `folder_id` or `project`                 | `page`                              | Deployment history and deployable environments                       |
| `workato_deploy_plan`      | `environment`, `recipe_id` or `folder_id` / `project` | `include`, `exclude`, `step_diffs`  | Draft a deployment and diff it against the target, remaps normalised |
| `workato_deploy_run`       | `deployment_id`, `title`, `allow_writes`              | `description`, `allow_stop_running` | Deploy a planned draft; **writes to the target environment**         |

`workato_list_folders` is the source of folder ids: call it before creating or moving anything. Top-level entries are project **root folders**: their `id` is what `parent_id` / `folder_id` want, while `project_id` identifies the owning project. Nodes report `flow_count` / `active_flow_count` plus non-zero asset counts under `counts`.

Note the asymmetry: `workato_update_project` takes the project's **`folder_id`**, not its `project_id` (the endpoint is `/web_api/projects/f<folder_id>.json`).

Deleting a folder removes everything inside it. There is no undo.

### Properties

Account (environment) and project properties: the named configuration values a recipe resolves at job start, under `Recipe data > Properties`.

| Tool                 | Required | Optional                                                                                             | Description                             |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `workato_properties` | none     | `action`, `scope`, `project_id`, `name`, `value`, `rename_to`, `expected_version_no`, `id`, `reveal` | List, set (upsert) or delete a property |

`action` is `list` (default, read-only), `set` or `delete`. `scope` is `account` (the whole environment, default) or `project`, which requires `project_id`.

**`project_id` is the PROJECT id, not the folder id.** `workato_list_folders` reports both on a project root: the `project_id` field is the one this tool wants, while `id` is the folder. A folder id here is not an error on Workato's side; it simply lists nothing, so an empty project scope is worth a second look.

**`set` is an upsert by name.** It lists first, then PUTs `/account_properties/<id>.json` when the name already exists and POSTs `/account_properties.json` when it does not. Retrying a `set` is therefore safe: a second call updates instead of creating a twin. `rename_to` renames the property found under `name`. Rows are append-only, so a successful update issues a **new `id` and `version_no`** and the response carries `previous: {id, version_no}`. The write sends `last_version_no`; pass `expected_version_no` to make that check yours, and a mismatch comes back as a version conflict naming both versions rather than as a silent overwrite.

**Values are stored in the clear.** Workato flags a property `sensitive` when its name contains `password`, `key` or `secret`, but its JSON API returns the value in plain text either way: the `XXXXXXXXXX123` mask in the UI is presentation only. This tool applies the same mask (last three characters kept) and sets `value_masked: true`; `reveal: true` returns the real value.

**`delete` resolves by exact `name`** and refuses when the name matches nothing or more than one; pass `id` instead to be unambiguous. Ids move on every update, so one from an earlier read may already be stale.

Both `set` and `delete` write workspace configuration that running recipes read. A job that has already started keeps the value it resolved; the next one picks up the change.

The endpoints behind this are recorded in [`skills/workato-recipes/platform-endpoints.md`](../skills/workato-recipes/platform-endpoints.md) and in full in [`docs/design/specs/2026-09-08-account-project-properties-endpoints.md`](design/specs/2026-09-08-account-project-properties-endpoints.md).

### Code-side recipe editing

These mutate the recipe's JSON code tree directly, with no editor UI involved, and they are the preferred way to edit recipes. **Every one of them now runs through one guarded engine in the bridge**: pull once with `view: "full"`, deep-clone the tree, apply the operations to the clone, renumber the whole tree when structure changed, derive the extended schemas the tree's declarations imply, validate locally, MERGE the pulled config, save once, and summarize once.

| Tool                                 | Required                                                          | Optional                                                                                                                                                                                | Description                                                    |
| ------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `workato_recipe_apply`               | `recipe_id`, `changes`                                            | `expected_base_version_no`, `dry_run`, `idempotency_key`, `comment`, `restart_if_running`, `ensure_running`, `verify_readback`, `auto_schema`                                           | Several edits, structural ops included, in one version         |
| `workato_recipe_set_input_path`      | `recipe_id`, `step`, `path`, `value`                              | `value_kind`, `restart_if_running`, `ensure_running`, `comment`, `expected_base_version_no`, `verify_readback`                                                                          | Set a **nested** input value                                   |
| `workato_recipe_delete_input_path`   | `recipe_id`, `step`, `path`                                       | `restart_if_running`, `ensure_running`, `comment`, `expected_base_version_no`, `verify_readback`                                                                                        | Delete a nested leaf                                           |
| `workato_recipe_set_py_eval_code`    | `recipe_id`, `step`                                               | `code`, `code_path`, `validate_step`, `restart_if_running`, `ensure_running`, `comment`, `expected_base_version_no`, `verify_readback`, `ignore_file_version`, `allow_context_mismatch` | Replace a Python-by-Workato step's code body                   |
| `workato_recipe_set_extended_schema` | `recipe_id`, `step`, `kind`, `schema`                             | `restart_if_running`, `ensure_running`, `comment`, `expected_base_version_no`, `verify_readback`                                                                                        | Set `extended_input_schema` / `extended_output_schema`         |
| `workato_recipe_add_step`            | `recipe_id`                                                       | `after_step`, `anchor`, `connection_id`, `provider`, `action_name`, `input`, `keyword`, `source`, `expected_base_version_no`, `comment`, `verify_readback`, `dry_run`, `auto_schema`    | Insert a step                                                  |
| `workato_recipe_set_step_input`      | `recipe_id`, `step_number`, `field`, `value`                      | `expected_base_version_no`, `comment`, `verify_readback`, `dry_run`, `auto_schema`                                                                                                      | Set a top-level input field                                    |
| `workato_recipe_map_datapill`        | `recipe_id`, `target_step`, `target_field`, `source_step`, `path` | `expected_base_version_no`, `comment`, `verify_readback`, `dry_run`                                                                                                                     | Build a `_dp(...)` datapill mapping                            |
| `workato_callable_schema_set`        | `recipe_id`                                                       | `parameters`, `results`, `expected_base_version_no`, `restart_if_running`, `ensure_running`, `comment`                                                                                  | Set a callable's trigger parameters and result contract        |
| `workato_caller_bind`                | `recipe_id`                                                       | `callee_recipe_id`, `step`, `expected_base_version_no`, `restart_if_running`, `ensure_running`, `comment`                                                                               | Write a `call_recipe` step's schema from the callee's contract |

`workato_recipe_set_input_path` remains the workhorse for one-field fixes. The step is addressed by number or `as` anchor (nested blocks are searched recursively), and `path` may be a dotted string like `records.item.items[0].amount` or an array of segments. It creates missing intermediate containers, refuses unsafe segments and non-container parents, and leaves every unrelated field untouched. Values can be literals, formula strings, interpolated strings, or datapill shorthand: `datapill(provider.line.list_items[].AssetId)` expresses a current-item pill inside a `foreach`.

`workato_recipe_set_py_eval_code` takes `code_path` so a Python file goes straight from disk into the step without passing through the model's context.

`workato_step_schema(apply_to: {recipe_id, step})` is a fifth way into the same engine: it fetches the step's `extended_input_schema` and `extended_output_schema` from the adapter and writes both in one version, so neither array has to be typed into `workato_recipe_set_extended_schema` by hand. See [Connector execution and discovery](#connector-execution-and-discovery).

#### `workato_recipe_apply`

Up to 50 operations of eleven kinds in one cycle, so five mappings create one version instead of five.

| Op                    | Notes                                                                                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set_input`           | Set a value at an input path                                                                                                                                                                                                                              |
| `delete_input`        | Delete a leaf                                                                                                                                                                                                                                             |
| `set_extended_schema` | Write `extended_input_schema` / `extended_output_schema`                                                                                                                                                                                                  |
| `set_py_eval_code`    | Replace a Python step's body                                                                                                                                                                                                                              |
| `map_datapill`        | Build a `_dp(...)` mapping                                                                                                                                                                                                                                |
| `insert_step`         | Insert a node, anchored by `after` / `before` / `into` with `first` / `last`                                                                                                                                                                              |
| `remove_step`         | Refused when a datapill references it; `force: true` overrides and the refusal names what it found. It also drops the `config` entry of a provider no remaining step uses, but only when that entry carries no `account_id`: a bound entry is always kept |
| `move_step`           | Move a node within the tree                                                                                                                                                                                                                               |
| `set_loop_source`     | `foreach` only. A `repeat` while-condition is edited with `set_input` against its `while_condition` child                                                                                                                                                 |
| `bind_connection`     | Bind an existing connection to a provider                                                                                                                                                                                                                 |
| `derive_schema`       | Derive one step's extended schemas explicitly, replacing even an agreeing schema                                                                                                                                                                          |

Steps are addressed by number, `as` anchor, or uuid. A duplicated number in a tree an older renumbering bug corrupted is refused rather than resolved to the first hit. One invalid operation refuses the WHOLE batch before anything is written, naming the change index, the step and the reason. `dry_run: true` returns the same summary (validation, `changed_paths`, `would_save_version`) without saving. `idempotency_key` makes a retried batch return the stored summary instead of creating a second version; the store is process memory only, bounded at 100 entries, keyed `<recipe_id>:<key>`, and forgotten on a bridge restart.

Structural ops renumber the whole tree, which changes every step number a caller may have cached. `as` anchors are stable and are reported in the response; batch by anchor, or re-read after a structural change.

`insert_step` does not check that `provider` and `action_name` exist in the workspace, or that the input matches the action's schema: a wrong action name saves and comes back as persisted and NOT valid.

#### Save outcomes

Every mutation response distinguishes three separate facts, alongside `changed_paths` and `version_no`:

| Field       | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `persisted` | Workato stored a new version                         |
| `valid`     | Workato reported no `code_errors` on the stored tree |
| `verified`  | The readback matched what was sent                   |

`save_status` values:

| `save_status`             | Meaning                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                      | Saved, valid, verified                                                                                                                                                                 |
| `already_applied`         | The stored tree already equals the one being written: the signature of a retry after a timeout. No second version                                                                      |
| `persisted_invalid`       | A new version exists AND Workato reports validation errors. The automatic restart is skipped (`restart_skipped_invalid: true`, `running_after_save: false`), and `isError` stays false |
| `persisted_incomplete`    | A new version exists AND Workato dropped input keys. The dropped paths are named                                                                                                       |
| `succeeded_after_timeout` | The save timed out and a readback proved it landed                                                                                                                                     |

Neither persisted-but-broken state is ever described as "nothing changed". Only a save that genuinely created no version restores stopped callers.

Local validation covers what Workato accepts silently and then runs wrong: globally sequential numbering including nested blocks, unique 8-hex `as` anchors, a `uuid` on every node the call creates (a node without one is rejected with `code is invalid: line=0, uuid not present`), `else`/`elsif` last inside an `if` block, `catch` last inside `try`, `while_condition` first inside `repeat`, and a `foreach` whose `source` sits at the node root. Those rules are errors on nodes the call created or changed and warnings (in `validation_warnings`) on untouched nodes, so a recipe with a pre-existing quirk stays editable. `as` accepts the 8-hex form, the full-uuid form and a hand-written anchor such as `tjcall01` that Workato itself accepts; a non-hex anchor on an existing step is a warning, never a refusal, and only 8-hex is ever generated.

The config is MERGED, never rebuilt: existing `account_id` and `skip_validation` values survive, and a provider new to the recipe is appended. A new provider gets its `account_id` when `connection_id` is given; otherwise the response says `connection_binding: missing` rather than leaving a recipe that cannot start.

#### `auto_schema`

On by default on `workato_recipe_apply`, `workato_recipe_add_step` and `workato_recipe_set_step_input`, and applied by the engine to every other native mutator (they do not advertise the property, but `auto_schema: false` still works on them).

Before each save, the engine derives the extended schemas the tree's declarations imply, over the WHOLE tree, because a save rewrites the whole tree: an untouched `declare_list` with no schema loses its items on this save just as surely as an edited one. Derivations, and their evidence tier:

| Step               | Derived from                     | Schemas written                                    | Evidence     |
| ------------------ | -------------------------------- | -------------------------------------------------- | ------------ |
| `declare_list`     | `input.list_item_schema_json`    | `extended_input_schema` + `extended_output_schema` | `verified`   |
| clock trigger      | its own `time_unit`              | `extended_input_schema` for `trigger_every`        | `verified`   |
| `insert_to_list`   | the declaring step's declaration | `extended_input_schema`                            | `documented` |
| `declare_variable` | `input.variables.schema`         | `extended_output_schema`                           | `documented` |
| `update_variables` | the declaring step's declaration | `extended_input_schema`                            | `documented` |

The declaration is the ONLY source: a list that happens to hold three strings says nothing about the declared type, so a missing declaration is refused with a reason rather than guessed. A schema that disagrees with its declaration is corrected and the differences listed; one that agrees is left byte for byte alone. Agreement is compared structurally (field names, `type`, `of`, nested property names, types and optionality), not on `label` or `control_type`. Derived nodes are deliberately NOT marked as touched, so filling in a schema cannot promote an unrelated pre-existing quirk into a refusal.

Each write reports `derived_schemas: [{step, step_number, kind, fields, schemas, status, evidence, differences?}]`, and the schema paths join `changed_paths`. `call_recipe`'s `input.parameters` is deliberately not auto-derived: `workato_caller_bind` writes that key from the callee's contract, and two writers on one key would fight.

`workato_recipe_save_with_dependents` and a plain `workato_ui_save_recipe_code` drive the save tool directly, so they do NOT auto-derive. Only the native mutation engine does. The three `documented`-tier derivations have never been observed live: live verification pending.

### Recipe editor UI

Automation of the live editor, for the cases no endpoint covers. `workato_ui_save_recipe_code` is the exception: it is a pure API write and the fastest path for whole-tree saves.

| Tool                          | Required                       | Optional                                                                                                                                                                                                             | Description                                                 |
| ----------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `workato_ui_open_recipe`      | `recipe_id`                    | `mode`                                                                                                                                                                                                               | Open a recipe (view or edit)                                |
| `workato_ui_enter_edit_mode`  | none                           | none                                                                                                                                                                                                                 | Click **Edit**                                              |
| `workato_ui_list_steps`       | none                           | none                                                                                                                                                                                                                 | `{number, label}` for every step on screen                  |
| `workato_ui_focus_step`       | `step_number`                  | none                                                                                                                                                                                                                 | Open a step's config panel                                  |
| `workato_ui_add_step`         | `after_step`, `app`, `action`  | `kind`                                                                                                                                                                                                               | Insert a step through the UI                                |
| `workato_ui_set_field`        | `field`, `value`               | `mode`                                                                                                                                                                                                               | Set a field on the focused step                             |
| `workato_ui_insert_datapill`  | `field`, `source_step`, `path` | none                                                                                                                                                                                                                 | Drop a datapill into a field                                |
| `workato_ui_save_recipe`      | none                           | none                                                                                                                                                                                                                 | Click **Save**, verified by polling the dirty count to zero |
| `workato_ui_exit_edit_mode`   | none                           | `discard`                                                                                                                                                                                                            | Click **Exit**                                              |
| `workato_ui_create_recipe`    | `name`                         | `folder_id`, `project_name`, `description`                                                                                                                                                                           | Create a recipe (`POST /recipes.json`)                      |
| `workato_ui_save_recipe_code` | none                           | `recipe_id`, `code`, `code_path`, `config`, `name`, `description`, `restart_if_running`, `ensure_running`, `comment`, `expected_base_version_no`, `ignore_file_version`, `allow_context_mismatch`, `verify_readback` | Save a complete code tree (`PUT /recipes/<id>.json`)        |

#### `workato_ui_save_recipe_code`

Pair it with `workato_pull_recipe`: fetch, mutate client-side, save. For large recipes use the file round-trip (`out_file` then `code_path`) so the tree never enters context.

- **Verified writes.** The saved tree is read back and compared against what was sent. Workato accepts a save with `code_errors: []` and still drops dynamic input keys on steps that lack a matching `extended_input_schema`; the tool fails with `save_status: "persisted_incomplete"` and lists the dropped paths rather than reporting a clean save of empty data. `verify_readback: false` disables the check.
- **Datapills.** Pill payloads are re-serialized compactly before the save, because Workato matches `#{_dp('<json>')}` byte for byte and a payload with `json.dumps` spacing silently resolves to nothing. `datapills_normalized` reports how many were rewritten.
- **Running recipes.** Workato refuses code saves while a recipe runs. `restart_if_running: true` performs stop, save, verify and restart, and reports `stopped_at` / `restarted`. It restores only what the save stopped: a recipe that was already stopped stays stopped, reported as `was_running: false`. Use `ensure_running: true` when it must be live afterwards either way. A save reporting `code_errors` no longer restarts the recipe.
- **Concurrency.** `expected_base_version_no` refuses to overwrite someone else's edit. **The lock now fails closed**: when the check was requested and the current version cannot be read, the save is refused, instead of skipping the check in exactly the case where a stale tree can overwrite a newer one.
- **A file save defaults to the version it was pulled from.** With `code_path` and no explicit lock, `expected_base_version_no` comes from the file's own `version_no`, so a file edited yesterday cannot overwrite today's version by omission. `ignore_file_version: true` is the deliberate override. A file whose `recipe_id` is not the recipe being saved is refused outright.
- **Workspace check.** The file's `origin` block is turned into an expected context: a save into a different workspace is refused unless `allow_context_mismatch: true`. Neither override ever travels to the extension.
- **Annotation.** `comment` sets the version comment in the same call.
- **Timeouts.** A timed-out save is verified by `version_no` and a tree readback, yielding `save_status: "succeeded_after_timeout"`.
- **Warnings.** `py_eval_warnings` (shadowing warnings computed from a whole-tree file save) now reach the response.

Returns the new `version_no`, the `persisted` / `valid` / `verified` triple, and any validation errors Workato raises about the saved tree.

### Lookup tables

Classic Workato lookup tables. Columns are positional (`col1` to `col10`); rows carry their own `row_id`, distinct from `table_id`.

| Tool                               | Required                              | Optional                                                        | Description                                          |
| ---------------------------------- | ------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| `workato_lookup_tables_list`       | none                                  | none                                                            | Every visible lookup table                           |
| `workato_lookup_table_get`         | `table_id`                            | `page`, `per_page`, `qterm`                                     | Table with columns and rows                          |
| `workato_lookup_table_create`      | none                                  | `name`, `columns`                                               | Create, then optionally rename and apply a schema    |
| `workato_lookup_table_rename`      | `table_id`, `name`                    | none                                                            | Rename                                               |
| `workato_lookup_table_set_columns` | `table_id`, `columns`                 | none                                                            | Replace the column schema                            |
| `workato_lookup_table_delete`      | `table_id`                            | none                                                            | Delete the table                                     |
| `workato_lookup_table_row_create`  | `table_id`, `row`                     | none                                                            | Add a row                                            |
| `workato_lookup_table_row_update`  | `table_id`, `row_id`, `row`           | none                                                            | Update a row                                         |
| `workato_lookup_table_row_delete`  | `table_id`, `row_id`                  | none                                                            | Delete a row                                         |
| `workato_lookup_table_row_upsert`  | `table_id`, `key_column`, `key_value` | `values`                                                        | Update the row whose key column matches, else insert |
| `workato_lookup_table_row_search`  | `table_id`, `qterm`                   | `page`, `per_page`                                              | Server-side text search across rows                  |
| `workato_lookup_table_import_csv`  | `table_id`                            | `csv_path`, `csv_content`, `mode`, `skip_first_row`, `filename` | Bulk import from CSV                                 |

`workato_lookup_table_import_csv` takes either `csv_path` (**preferred**: the bridge streams the file from disk, keeping it out of context) or inline `csv_content`. `mode: "append"` is the default and preserves existing rows; `mode: "replace"` wipes them first. Set `skip_first_row: true` for a header row. CSV column order is positional. Limits: 10 columns, 100,000 rows.

Every write in this family verifies the pinned workspace before acting.

### Data tables

Workato's newer relational Data Tables: a different feature and a different API (`/web_api/workato_db/*`). Records are keyed internally by column UUID; these tools accept and return **label-keyed** rows and resolve the mapping for you. Column operations are full-schema PUTs under the hood.

| Tool                               | Required                       | Optional                                                      | Description                             |
| ---------------------------------- | ------------------------------ | ------------------------------------------------------------- | --------------------------------------- |
| `workato_data_tables_list`         | none                           | `folder_id`, `page`                                           | Data tables in a project folder         |
| `workato_data_table_get`           | `table_id`                     | `include_system`                                              | Table with its columns                  |
| `workato_data_table_create`        | `name`, `folder_id`            | `columns`                                                     | Create a table, optionally with columns |
| `workato_data_table_rename`        | `table_id`, `name`             | none                                                          | Rename                                  |
| `workato_data_table_delete`        | `table_id`                     | none                                                          | Delete                                  |
| `workato_data_table_add_column`    | `table_id`, `name`             | `type`                                                        | Append a column                         |
| `workato_data_table_update_column` | `table_id`                     | `column_name`, `column_id`, `name`, `type`                    | Rename and/or retype a column           |
| `workato_data_table_delete_column` | `table_id`                     | `column_name`, `column_id`                                    | Delete a column                         |
| `workato_data_table_row_list`      | `table_id`                     | `order_by_column`, `direction`, `limit`, `continuation_token` | Query records                           |
| `workato_data_table_row_create`    | `table_id`, `row`              | none                                                          | Insert a record                         |
| `workato_data_table_row_update`    | `table_id`, `record_id`, `row` | none                                                          | Update a record                         |
| `workato_data_table_row_delete`    | `table_id`, `record_ids`       | none                                                          | Delete records (batch)                  |

Every write in this family verifies the pinned workspace before acting.

### Workflow app pages

Workato Workflow Apps (LCAP). The page tree is replaced whole: GET, mutate, PUT. See [`skills/workato-recipes/workflow-apps.md`](../skills/workato-recipes/workflow-apps.md) for the page format.

| Tool                         | Required                        | Optional                                                                                                                                   | Description                      |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `workato_lcap_apps_list`     | none                            | `timeout_ms`                                                                                                                               | Workflow apps and their pages    |
| `workato_lcap_page_get`      | `page_id`                       | `view`, `out_file`, `timeout_ms`                                                                                                           | One page's content               |
| `workato_lcap_page_save`     | `page_id`                       | `content`, `content_path`, `expected_updated_at`, `allow_widget_removal`, `allow_row_collapse`, `force`, `skip_render_check`, `timeout_ms` | Replace a page's content whole   |
| `workato_lcap_page_validate` | none                            | `page_id`, `content`, `content_path`, `timeout_ms`                                                                                         | Check a page tree without saving |
| `workato_lcap_widget_patch`  | `page_id`, `widget_id`, `props` | `expected_updated_at`, `force`, `skip_render_check`, `timeout_ms`                                                                          | Change one widget's props        |
| `workato_lcap_page_create`   | `folder_id`, `name`             | `path`, `content`, `content_path`, `timeout_ms`                                                                                            | Create a page                    |
| `workato_lcap_page_delete`   | `page_id`, `confirm`            | `timeout_ms`                                                                                                                               | Delete a page                    |

`workato_lcap_page_save`, `workato_lcap_widget_patch`, `workato_lcap_page_create` and `workato_lcap_page_delete` verify the pinned workspace before acting.

### Session and environment

| Tool                         | Required      | Optional                          | Description                                                                               |
| ---------------------------- | ------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| `workato_session_context`    | none          | `max_age_ms`, `refresh`           | Which tab, host, workspace, environment and user a call lands in                          |
| `workato_whoami`             | none          | none                              | Workspace, user, role, environments, teams, timezone, tier                                |
| `workato_switch_environment` | `environment` | `workspace`, `return_to`, `tabId` | Switch environment and/or client workspace; moves every Workato tab in the Chrome profile |

`workato_session_context` is the cheap identity check: `{tab_id, host, workspace_id, workspace_name, environment, user_id, age_ms, from_cache}` from `/web_api/auth_user.json` and nothing else, cached per tab for `max_age_ms` (default 60,000, maximum 600,000) and dropped the moment the tab navigates or closes. `refresh: true` bypasses the cache. Prefer it over `workato_whoami` whenever you only need the target workspace: whoami attaches the debugger and returns the full profile.

The tool and the context block were verified live on 2026-09-07. One detail was not: `environment` is normalized to a string from whatever `current_environment` holds (a string, a number, or an object with a name and an id), and comparison is `String(expected) === String(actual)`, so a workspace whose environment arrives as an object could compare an id against a name and read as a mismatch. Only the string form has been observed.

`workato_switch_environment` switches a Chrome profile's Workato session to another environment (`/users/switch_environment`) and/or client workspace (`/users/switch_team`), then confirms with the session context. Every Workato tab in that profile moves, and a session pinned to one of them follows the move instead of failing with `ContextChanged`.

### Common workflows

**Find the jobs that matter, then diagnose one**

```
workato_list_jobs(recipe_id, status: "failed",
                  started_from: "2026-08-01", started_to: "2026-08-31",
                  match: {mode: "substring", fields: ["error"], value: "INVALID_FIELD"})
  # read coverage.complete before concluding "no such jobs"
  -> workato_job_trace(recipe_id, job_id, line_range: [<error line +/- 10>],
                       paths: ["input.records[].Id", "output.error"], empty: "drop")
  -> workato_job_trace(..., lines: [<the step>], detail: "full")   # exact payload
  -> workato_pull_recipe(recipe_id, step: "<as>")                  # what the step maps
```

**Find a field without pulling the recipe**

```
workato_recipe_grep(recipe_id, query: "custbody_status")
  -> workato_pull_recipe(recipe_id, step: "<as>", paths: ["<the reported path>"])
  -> workato_recipe_set_input_path(recipe_id, step: "<as>", path: "<path minus input.>", value: ...)
```

**Fix one field**

```
workato_recipe_set_input_path(
  recipe_id, step: "1616311d",
  path: "records.custbody_status.refName",
  value: "datapill(provider.line.list_items[].Status)",
  restart_if_running: true,
  comment: "map status from line item",
)
  -> workato_recipe_status(recipe_id)                              # verify
  -> workato_recipe_version_diff(recipe_id, from: 46, to: 47)      # confirm what changed
```

**Several edits, one version**

```
workato_recipe_validate(recipe_id)                                 # before touching anything
  -> workato_recipe_apply(recipe_id, dry_run: true, changes: [...])
  -> workato_recipe_apply(recipe_id, changes: [...], comment: "schema refresh")
  -> workato_recipe_version_diff(recipe_id, from: 46, to: 47)
```

**Change a callable that other recipes call**

```
workato_recipe_callers(recipe_id)                                  # read completeness
  -> workato_recipe_connections(recipe_id)                         # can it be restarted at all
  -> workato_recipe_save_with_dependents(recipe_id, code_path: "callable.json",
       scan_scope: "workspace", comment: "schema refresh")
  # if the call times out:
  -> workato_operation_status(operation_id)
  -> workato_operation_status(operation_id, resume: true)
```

**Run a fixture through a recipe**

```
workato_test_recipe(recipe_id, trigger_input: {greeting: "hello"})
  -> workato_job_trace(recipe_id, job_id)
```

**Rewrite a large recipe**

```
workato_pull_recipe(recipe_id, out_file: "recipe.json")            # never hits context
  -> edit recipe.json locally
  -> workato_recipe_validate(code_path: "recipe.json")
  -> workato_ui_save_recipe_code(code_path: "recipe.json", restart_if_running: true)
  -> workato_recipe_version_diff(recipe_id, from: 46, to: 47)
```

**Query a SaaS through an existing connection**

```
workato_search_connections(text: "SFDC Prod")                      # -> shared_account_id
  -> workato_run_query(connection_id, type: "soql",
      query: "SELECT Id, Status FROM Asset WHERE ...")
```
