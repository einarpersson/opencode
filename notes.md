# User context

I have cloned this repo in order to understand the internals of opencode better. I am not a maintainer. I might want to make little tweaks or forks for personal needs, but I'd prefer to as much extent as possible to use the official version and add extra/custom functionality via the Plugins/SDK in place.

The main branch is `dev` and currently the origin is the offical repo. I have a local branch `personal` where this document is tracked.

You may add small bits of information to a cheat sheet below in this document.

- You MUST be minimal in your approach and only add high value insights/lessons learned/facts
- You MUST ONLY add stuff you are sure about. Adding inaccurate information is not allowed as the cost can be high
- You SHOULD add the date and commit for when the fact was added or reviewed so that we at a later stage can understand if something is recent or old
- You MUST NOT remove information if not approved
- You SHOULD prompt me if you spot inaccurate information so that it can be reviewed and edited

The main goal of this document and these work sessions is to understand more about how opencode works so that I can adapt it to my needs either through my workflows, via plugins/SDK or via forking (last resort).

## Cheat sheet

### Instance state model (2026-04-16, 11b26a9)

- All ephemeral registries (skills, commands, tools, plugin hooks) use `InstanceState` → `ScopedCache` keyed by directory. Lazy-built, cached, disposable. Sources: `src/effect/instance-state.ts`, `src/project/instance.ts`
- `instance.dispose()` (SDK) = full reset. Invalidates all ScopedCache entries → next access rebuilds everything from disk/config. Same mechanism `Config.update` uses internally. Source: `src/project/instance.ts` → `disposeInstance()`
- `InstanceState.invalidate()` exists (selective single-registry invalidation) but is unused. Fine-grained reload is blocked by cross-registry deps (e.g. commands depend on skills). Source: `src/effect/instance-state.ts:78-81`
- Persistent (survives restart): SQLite (sessions, messages, todos, permissions, auth). Disk (config, SKILL.md, tool files, plugins). Ephemeral: everything else.
- `SessionTable.directory` is metadata/display-only, not runtime state. Runtime CWD = `Instance.directory`.

### Extension registration paths (2026-04-16, 11b26a9)

- Skills: SKILL.md files scanned from multiple paths. Source: `src/skill/skill.ts`
- Commands: from `config.command` in opencode.json + MCP + skills. Source: `src/command/command.ts`
- Tools: built-in + `{tool,tools}/*.{js,ts}` from config dirs + plugin hooks (`hooks.tool{}`). Source: `src/tool/registry.ts`
- Plugins: internal (Codex, Copilot, Gitlab, etc.) + external from `config.plugin_origins`. Source: `src/plugin/index.ts`

### Reasoning (2026-04-17, dev)

- Reasoning effort is abstracted as **variants** — named presets (`"low"`, `"medium"`, `"high"`, etc.) mapped per-provider to the correct API params. Not standardised; each provider gets different options. Source: `src/provider/transform.ts:402` → `variants()`
- Variant is set **per-agent** (config `variant` field) or per-session (TUI `Ctrl+T`, CLI `--variant`). Source: `src/config/agent.ts:19`, `src/session/llm.ts:126-141`
- `variants()` returns `{}` for models matching `deepseek|minimax|glm|mistral|kimi|qwen|big-pickle` — no effort control. Source: `transform.ts:408-417`
- For zai/zhipu providers, thinking is hardcoded always-on (`{ type: "enabled", clear_thinking: false }`). Source: `transform.ts:820-828`
- User-defined variants in `opencode.json` (under `provider.<id>.models.<model>.variants`) are merged on top of the computed ones via `mergeDeep`. Can override the `{}` for excluded models if the underlying API supports effort params. Source: `src/provider/provider.ts:1183`
- Thinking visibility: `/thinking` toggles `thinking_visibility` in persistent KV (`kv.json`). Default: `true` (shown). Keybind `display_thinking` defaults to `"none"` (no shortcut). Source: `src/cli/cmd/tui/routes/session/index.tsx:159`, `src/config/keybinds.ts:161`

### Server & client architecture (2026-04-20, dev)

- **One server = multiple directories/projects.** `WorkspaceRouterMiddleware` resolves directory from `?directory=` / `x-opencode-directory` header / `process.cwd()` fallback. Lazily boots an `Instance` per directory, cached in a `Map<string, Promise<InstanceContext>>`. Source: `src/server/instance/middleware.ts`, `src/project/instance.ts`
- **TUI is bound to one directory for its lifetime.** `SDKProvider` sets directory once at startup from `--dir`. All requests use that same directory. No "switch project" command exists. Web UI can switch because it sets directory per-request. Source: `src/cli/cmd/tui/context/sdk.tsx`, `src/cli/cmd/tui/app.tsx`
- **`opencode attach` attaches to the server, NOT to a session.** `--dir` determines which project instance the TUI talks to. Without `--dir`, falls back to server's `process.cwd()`. Session selection is separate: `--continue` (most recent), `--session <id>`, or home screen. Source: `src/cli/cmd/tui/attach.ts`, `src/server/instance/middleware.ts:54`
- **Sessions are persistent records, not "running processes".** They can be *busy* (processing LLM call) or *idle*. A session can be busy with zero clients attached (e.g. `prompt_async` returns 204, processing continues server-side). `SessionRunState` tracks busy/idle per session — ephemeral in-memory state. Source: `src/session/run-state.ts`, `src/server/instance/session.ts:906-941`
- **SSE events are global** — `/event` streams ALL bus events regardless of directory. Client-side filters as needed. Source: `src/server/instance/event.ts`
- **TUI control routes** (`/tui/*`) let web UI remote-control an attached TUI via `TuiEvent` bus events (select-session, append-prompt, execute-command). Source: `src/server/instance/tui.ts`
- **Systemd single-service pattern works:** `opencode serve` as user service, then `opencode attach http://localhost:4096 --dir .` from any project. No env var for directory — use shell alias. Source: analysis of attach.ts + middleware.ts

### HTTP API (2026-04-21, dev)

- **Known bug:** `GET /doc` (live endpoint) only shows 7 global/control-plane routes, NOT the ~96 instance-scoped routes. This is a confirmed bug: [issue #20295](https://github.com/anomalyco/opencode/issues/20295), PR [#20519](https://github.com/anomalyco/opencode/pull/20519) open. Root cause: `/doc` uses `openAPIRouteHandler(app)` where `app` is the control-plane sub-app only; `WorkspaceRouterMiddleware` handles instance routes dynamically at runtime.
- **`/doc` still useful for schemas:** `components.schemas` has 130+ types (Session, Message, all Part types, 47 Event types, etc.) because `GlobalEvent.payload` references them transitively. So `curl -s http://localhost:4096/doc | jq '.components.schemas.Session'` works.
- **Full spec exists at `packages/sdk/openapi.json`:** 96 paths, generated at build-time via `Server.openapi()` which builds a dummy app with `InstanceRoutes` directly mounted. Use this file (or `jq`) as the authoritative route reference: `jq '.paths | keys[]' packages/sdk/openapi.json`.
- **Directory targeting:** instance-scoped routes use `?directory=<path>` or `x-opencode-directory` header. Example: `curl http://localhost:4096/session?directory=$PWD`.
- **Quick discovery endpoints:** `GET /global/health` (version check), `GET /project` (list all known projects), `GET /session` (list sessions for a directory), `GET /agent`, `GET /skill`, `GET /command`, `GET /path`, `GET /vcs`.
- **Instance route source:** `src/server/instance/index.ts` — registers sub-routers for session, agent, skill, command, path, vcs, project, pty, config, permission, question, provider, mcp, tui, sync, experimental, lsp, formatter, file.

### Task tool & subagents (2026-04-29, dev)

- **Task tool** (`src/tool/task.ts`) is a built-in tool that spawns a child session running a subagent. Parameters: `subagent_type` (agent name), `prompt` (instructions for subagent), `description` (3-5 word label → becomes session title), optional `task_id` (resume existing subagent session). Source: `src/tool/task.ts`
- **Agent mode** determines role: `"primary"` (TUI-facing only), `"subagent"` (invoked via task tool only), `"all"` (both). Source: `src/config/agent.ts:29`, `src/agent/agent.ts:31`
- **Subagent discovery:** the task tool's description is dynamically built at runtime — `describeTask()` (registry.ts:254) lists all agents where `mode !== "primary"` and not denied by the calling agent's permissions. The LLM sees them as `- name: description` entries appended to the static tool description. Source: `src/tool/registry.ts:254-267,294-300`
- **Permission model for subagents:** flat ruleset evaluated with `findLast` (last match wins). Default action if no rule matches: `"ask"`. `Permission.merge` just concatenates arrays. Source: `src/permission/evaluate.ts`, `src/permission/index.ts:292-308`
- **Built-in subagents:** `explore` (read-only codebase search, prompt in `src/agent/prompt/explore.txt`) and `general` (full tools minus todowrite, no custom prompt). Source: `src/agent/agent.ts:147-186`
- **Permission hierarchy per built-in agent:** `Permission.merge(defaults, agent_specific, user_config)`. `defaults` has `"*": "allow"`. `explore` overrides with `"*": "deny"` then selectively allows read-only tools. `general` only denies `todowrite`. `user_config` (global `permission` from opencode.json) is always the final layer = highest priority. Source: `src/agent/agent.ts:87-106,147-186`
- **New custom tools:** automatically allowed for `general` (inherits `"*": "allow"`), automatically denied for `explore` (blanket `"*": "deny"`). No manual config needed. Source: analysis of permission rulesets in agent.ts
- **Subagent restrictions at invocation time:** task tool also adds session-level deny rules — denies `task` if subagent lacks task permission, denies `todowrite` if subagent lacks it, strips `experimental.primary_tools`. Source: `src/tool/task.ts:60-96`
- **User-defined subagents:** `{agent,agents}/**/*.md` files with `mode: subagent` in frontmatter. Automatically appear in task tool description. Source: `src/config/agent.ts:101-136`

### Plugin & SDK cheat sheet (2026-04-29, dev)

- **Plugin config:** `~/.config/opencode.jsonc` (global) or `opencode.json` in project root. Plugin origins go in `plugin_origins` array.
- **Local plugins:** `~/.config/opencode/plugin/*.ts` (or `plugins/`). Auto-discovered, no config needed. Also `{plugin,plugins}/*.{ts,js}` in project config dirs.
- **Plugin types:** `import type { Plugin } from "@opencode-ai/plugin"`. The `Plugin` type is `(input: PluginInput) => Promise<Hooks>`.
- **Plugin `client` is v1 SDK:** plugins receive `client` from `createOpencodeClient()` imported from `@opencode-ai/sdk` (NOT `/v2`). API surface: `client.tool.ids()`, `client.tui.showToast()`, `client.config.get()`, `client.instance.dispose()`, etc. Source: `packages/opencode/src/plugin/index.ts:11,122`
- **v1 vs v2 SDK:** `@opencode-ai/sdk` (v1) has flat namespaces (`client.tool`, `client.tui`). `@opencode-ai/sdk/v2` has `client.experimental.tool` etc. Internally opencode uses v2 in some places (CLI run.ts, acp.ts). Plugins always get v1.
- **SDK API reference:** for plugins, check `packages/sdk/js/src/gen/sdk.gen.ts` (v1 classes). For internal opencode code, check `packages/sdk/js/src/v2/gen/sdk.gen.ts`.
- **Registering commands:** in `config` hook, set `opencodeConfig.command["name"] = { template: "", description: "..." }`. Hook into execution via `command.execute.before`.
- **Toast API (v1):** `client.tui.showToast({ body: { title, message, variant, duration } })`.
- **Tools ≠ permissions:** tools are registered capabilities. Permissions are rules (allow/deny/ask) that gate tool usage per-agent. `client.tool.ids()` returns all registered tools, NOT filtered by agent permissions.
