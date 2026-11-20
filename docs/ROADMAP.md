# Roadmap

What's planned, what was considered and rejected, and why. Nothing here is a commitment to a date.

Most items come from real recipe-building sessions: the pattern that repeats often enough to deserve a tool. That's the bar. A tool should absorb a _frequent narrow edit_, not a one-off architectural change.

## Planned

### 3.0: the 1.x names go

2.0 keeps a 1.x machine working while it moves over. 3.0 removes what only that needs: the old names of the four renamed core tools, the 1.x command aliases of the bridge, the fallback to the 1.x environment variable names, and the empty flow-list answer for bridges older than 2.0. The function registry keeps counting the 1.x commit identity as the machine for good: the vault gate depends on it.

### 3.0: one spelling per parameter

A client that runs tools from a script refuses an argument the schema does not declare, so a guessed name fails the whole script. The schemas mix `timeout_ms` (24 tools), `timeoutMs` (6) and `timeout` (3); `query` (9) and `text` (5) for a search string; `limit`, `maxResults`, `max_items` and `per_page` for a cap. `tabId` and `windowId` stay as they are (128 and 62 tools). The rest moves to one snake_case spelling with the other names removed, which is a breaking change and belongs with the other 3.0 removals.

### A module filter per registration

`/mcp?modules=...`, so the sessions of one project see fewer modules than the machine has switched on. The filter is the same code as the popup switch; it waits for a project that needs it.

### `workato_recipe_refresh_schema`: delivered as `workato_step_schema`

Shipped in the unreleased changes of 2026-09-08 under the name `workato_step_schema`, because the tool turned out to be about writing a NEW step's schemas at least as much as refreshing an old one. It wraps `POST /connections/<id or adapter slug>/extended_schema.json`, returns `input_schema` / `output_schema`, and `apply_to: {recipe_id, step}` writes both into a step in one version. The earlier "returned empty for `execute_suiteql`" worry was a driver problem, not an endpoint one: the endpoint returns two empty arrays whenever an input field flagged `extends_schema` is unset, and the tool now names the missing drivers. Verified across a connectionless adapter, the clock trigger, a standard connector through a connection and a custom SDK connector. Still open: a "refresh every step of this recipe" convenience that walks the tree and calls it per step, the way the editor's Refresh button does (minus the save that button performs).

### `workato_lookup_table_get_row`

Single-row lookup by key column and value, without paging through the whole table. Spot-checking a value before referencing it in a formula is currently more expensive than it should be.

### `workato_create_connection`

The endpoint, body shape and safety rules are written down in Task 9 of the [v1.1 plan](design/plans/2026-05-12-workatomcp-v11.md#task-9-stub-future-write-tool-create-connection). Held back deliberately: creating a connection means handling auth material, which every other tool in this project is built to never touch. It needs a provider allowlist and a clear story on where credentials come from before it ships.

### Follow-ups the 2026-09-07 release left open

Each of these is a gap a shipped package named for itself rather than hid.

| Item                                               | Why it matters                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A continuation cursor for `workato_recipe_callers` | A workspace-wide scan can list up to `max_recipes` candidates and read each one's code sequentially. When the time budget runs out the response says so (`completeness: partial`, with the unread count), but there is no cursor to resume from, so the next attempt starts over                                                                       |
| Auto-file cleanup                                  | Files written by `auto_file` accumulate under `<tmpdir>/mokutab-results/session-<pid>-<stamp>/` for the life of the machine's temp directory. No TTL, no size cap                                                                                                                                                                                      |
| `windowId` coverage                                | `findWorkatoTab` takes a `windowId` now, but `resolveTabId` still falls THROUGH to global discovery when the named window holds no Workato tab, and several tools (`workato_test_recipe` among them) expose no `windowId` at all. Unifying the two would change behaviour for every `workato_ui`, lookup and data-table tool, so it needs its own pass |
| A transitive write gate for `workato_test_recipe`  | The gate reads only the recipe under test. A connectionless recipe whose step calls a callee that does touch Salesforce runs without `allow_writes`. The callee index from `workato_recipe_callers` is the natural input                                                                                                                               |
| Job `title` matching                               | `match` on the `title` field is implemented and unit-tested but was never validated live: the probe found no job anywhere in the workspace with a non-empty title, and whether the server `query` matches a title is likewise unverified                                                                                                               |
| `mergeFieldSchemas` has no tool surface            | It merges adapter meta with a step's own schema and reports provenance and a strict `complete` flag. Wiring it needs one `workato_adapter_meta` call per provider set, which would put a network call inside an otherwise network-free validator. An opt-in flag on `workato_recipe_validate` is the obvious home                                      |
| Orchestrator-internal auto-file                    | The nested `callExtension` inside the orchestrators is deliberately not hooked, because a spilled pull would hand the orchestrator a summary instead of the payload. Spilling there needs a per-call opt-in                                                                                                                                            |
| Bridge coverage thresholds                         | 70/80/80/80 configured, actual 69.15/59.5/70.5/75.4, and now formally non-gating in CI                                                                                                                                                                                                                                                                 |

## Known debt

**The extension does not typecheck cleanly.** `pnpm typecheck` reports 14 errors. Removing the unused upstream features (record-replay, the element marker, the userscript manager) took it down from 119, as measured on master before the pruning. What remains: five in inherited browser code (`gif-recorder`, the offscreen GIF encoder and keepalive, network capture), one in `workato/properties.ts` (an error code missing from its union), and eight in two Workato test files that read `.text` off an MCP content block without narrowing it. The build is unaffected (WXT/Vite transpiles without typechecking).

All of them are small, local fixes. Once they are done, the extension typecheck can gate CI like the bridge and shared ones.

**CI now runs both test suites.** The extension vitest suite and the bridge jest suite gate the build after Lint, alongside the typecheck of `@mokuhub/mokutab-shared` and `@mokuhub/mokutab-bridge`. The extension typecheck is still reported without failing the run. Bridge coverage thresholds are explicitly non-gating: a red test should fail the build, a percentage should not.

## Considered and rejected

Some things are better left as code the agent writes, not tools:

- **Bulk structural refactors.** Wrapping twenty steps in `if` / `try` / `catch` branches is naturally a script over the pulled tree, not an API. `workato_recipe_apply`'s structural ops cover the narrow, addressable cases (insert, remove, move, loop source, connection binding); a sweeping re-shape is still a tree rewrite plus one save.
- **Cross-step regex sweeps.** File-edit territory. `workato_recipe_grep` finds the places; pull with `out_file`, edit, push.
- **Complex formula construction.** A ten-line SuiteQL formula interleaving four datapills is authoring work, not a parameterized call. The [`workato-recipes` skill](../skills/workato-recipes/) exists to make that authoring correct.
- **`workato_publish_message`.** There is no publish endpoint. `POST /web_api/pub_sub/topics/<id>/messages.json` is a 404 and the topics UI has no publish action, probed live on 2026-09-07. The supported path is documented instead: a `workato_pub_sub` / `publish_to_topic` step run under `workato_test_recipe`. Adding a tool that wrapped a workaround would have made an unsupported path look supported.
- **Splitting the tool catalogue behind a gateway.** The measured 38.9k reference tokens describe the serialized catalogue, not a charge on every request, and Claude Code defers MCP tool definitions by default: names and server instructions arrive first, schemas on demand. Lazy discovery already addresses the upfront cost, so reducing the tool count is not a prerequisite for anything. The effort went into better names, a task-to-tool table in the server instructions and the skill, and a 2 KB budget test on descriptions.
- **Automatic formula-template deduplication.** Collapsing near-identical formulas obscures the real differences between them, and a lossless design was never found. Projection and targeted search give a clearer first benefit at no risk of hiding a divergence that matters.

## Superseded

| Idea                                  | Superseded by                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workato_recipe_apply_to_steps`       | `workato_recipe_apply`, which takes up to 50 arbitrary operations across any steps in one pull, validate, save, readback cycle rather than one operation replayed over a step list                                                                                                                                                                                                                |
| Server-side `workato_recipe_validate` | `workato_recipe_validate` as LOCAL validation. Workato has no validate-without-save endpoint (`validate.json` and `ready.json` are both 404, probed live), so the tool runs structure, binding, datapill and schema checks in the bridge and states its `coverage` explicitly: formulas are Ruby and are not parsed, and nothing is executed                                                      |
| Raw step view                         | `workato_pull_recipe(step, paths: [...])` and `include: ["schemas","code"]`, which return the exact `_dp(...)` JSON and the verbatim extended schemas without a second view mode                                                                                                                                                                                                                  |
| Better `code_errors` hints            | Partly shipped: a save now reports `persisted_invalid` (a version exists and Workato rejects it) separately from `persisted_incomplete` (a version exists and input keys were dropped, with the paths named), and `workato_recipe_validate` predicts the binding and datapill breaks before a version is created. Mapping Workato's own error tuples back onto a step and field is still not done |
| `workato_push_recipe`                 | `workato_ui_save_recipe_code`, which does the same PUT with version locking, restart handling, and timeout verification                                                                                                                                                                                                                                                                           |
| `workato_run_soql`                    | `workato_run_query`, generic across SOQL, SuiteQL, and SQL                                                                                                                                                                                                                                                                                                                                        |
| `workato_schema_derive`               | `workato_recipe_set_extended_schema`, and since 2026-09-07 the engine's own `auto_schema` derivation                                                                                                                                                                                                                                                                                              |
| Nested-path Python round-trips        | `workato_recipe_set_input_path` / `delete_input_path` / `set_py_eval_code`                                                                                                                                                                                                                                                                                                                        |
| "Active tab isn't Workato" failures   | Unified tab resolution: explicit `tabId`, pinned session tab, or any Workato app tab, with the pinned workspace verified before every write                                                                                                                                                                                                                                                       |

The stub files for the superseded tools are gone from the source tree; their notes on the endpoint shapes stay in [`docs/design/plans/`](design/plans/).

## Design notes

Specs and implementation plans for shipped work live in [`docs/design/`](design/). They record the reverse-engineered endpoints, request shapes, headers and gotchas, and are the first place to look before adding a tool that touches an unfamiliar part of the Workato API. The live-verified endpoint captures are also distributed with the skill, in [`skills/workato-recipes/platform-endpoints.md`](../skills/workato-recipes/platform-endpoints.md).
