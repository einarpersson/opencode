# LSP.env plugin hook (personal fork modification)

## TL;DR

Added a new plugin hook `lsp.env` that lets plugins inject environment variables into LSP server process spawns, mirroring the existing `shell.env` hook. Fixes the case where opencode runs as a long-lived daemon (e.g. systemd `opencode serve`) and LSP servers inherit the daemon's frozen process env — missing project-local vars like `VIRTUAL_ENV` / venv-on-`PATH` that `.envrc` would normally provide.

Generalized: no Python/venv/direnv mentions in opencode source. The Python fix lives entirely in the user's `direnv.ts` plugin (one extra hook key).

## Why

Observed in `hello-uv-lsp` (a uv + polars project): a trivial edit to `main.py` surfaced `Import "polars" could not be resolved` from opencode's LSP, while `uv run python main.py` and `uv run pyright main.py` both ran clean. TypeScript LSP in the same project had no equivalent problem.

Root cause (confirmed in source): every builtin LSP server in `packages/opencode/src/lsp/server.ts` calls `launch.ts`'s `spawn` with `env: { ...process.env, ... }` (or omits env, letting cross-spawn inherit the daemon's env). The daemon's `process.env` is whatever the launching unit had — under systemd, no `VIRTUAL_ENV`, no venv `bin` on `PATH`. The existing `shell.env` plugin hook fires per-call for bash/PTY tools and patches their env, but LSP spawns bypass that hook entirely, so they got the bare daemon env.

Direct (non-systemd) `opencode` worked because the interactive shell had already sourced `.envrc` before launching opencode, so the daemon's `process.env` already had `VIRTUAL_ENV`/venv-PATH — purely accidental.

## How (the diff)

Five touched files, one new:

```
new  packages/opencode/src/lsp/env-delta.ts        (~16 lines)
edit packages/opencode/src/lsp/launch.ts          (+2 lines)
edit packages/opencode/src/lsp/lsp.ts             (~24 net lines)
edit packages/plugin/src/index.ts                 (+4 lines)
edit packages/opencode/test/lsp/index.test.ts     (+2 lines)
```

1. **`packages/plugin/src/index.ts`** — added `"lsp.env"` to the `Hooks` interface, identical signature to `"shell.env"`:
   ```ts
   "lsp.env"?: (
     input: { cwd: string; sessionID?: string; callID?: string },
     output: { env: Record<string, string> },
   ) => Promise<void>
   ```

2. **`packages/opencode/src/lsp/env-delta.ts`** (NEW) — pure helpers, no Effect, no Plugin import:
   - `envDeltaByCwd: Map<string, Record<string,string>>` keyed by `cwd`.
   - `setEnvDelta(cwd, delta)` — write.
   - `applyEnvDelta(cfg)` — if `cfg.cwd` is in the map, return `{ ...cfg, env: { ...delta, ...cfg.env } }` else return `cfg` unchanged.
   - No `clearEnvDelta` — see "Why no clear" below.

3. **`packages/opencode/src/lsp/launch.ts`** — the chokepoint: every builtin server AND the custom-LSP branch (`lspspawn`) route through here. Two-line change:
   ```ts
   import { applyEnvDelta } from "./env-delta"
   // ...
   const cfg = applyEnvDelta(Array.isArray(argsOrOpts) ? opts : argsOrOpts)
   ```
   Precedence is preserved by the existing `Process.spawn` merge at `src/util/process.ts:66` (`env: opts.env ? { ...process.env, ...opts.env } : undefined`): **daemon env < delta < server-author explicit env** (the delta's keys win over daemon env, the server author's explicit `cfg.env` keys win over the delta). That's the right ordering — the plugin provides project env, but a server that knows better still wins on keys it sets.

4. **`packages/opencode/src/lsp/lsp.ts`** —
   - New imports: `setEnvDelta` from `./env-delta`, `Plugin` from `@/plugin`.
   - At the `layer`'s `Effect.gen` top: `const plugin = yield* Plugin.Service` right after the other service captures.
   - `defaultLayer` and `node` LayerNode deps both append `Plugin` (`.defaultLayer` / `.node`) so `Plugin.Service` resolves when the LSP layer runs.
   - In `getClients = Effect.fnUntraced(function*(file))`, **before** the `Effect.promise(async () => {...})` scheduling block: precompute the set of roots that will spawn next (filter extensions, call `await server.root(file, ctx)`, skip entries already in `s.broken` / `s.clients` / `s.spawning`), then for each unique root `yield* plugin.trigger("lsp.env", { cwd: root }, { env: {} })` and `setEnvDelta(root, result.env)`.

### Why the trigger is fired in two phases

`plugin.trigger(...)` returns an `Effect`. The spawn itself (including the warm/broken/inflight scheduling) happens inside `Effect.promise(async () => {...})` — plain async, where `yield*` does not work. So the trigger MUST run in the Effect-typed body of `getClients` *before* entering the async block.

The precompute also serves a second purpose: it discovers each server's `root` (each builtin computes root from its own marker files — `pyproject.toml`, `bun.lock`, etc. — not from `ctx.directory` or the file's own dir). That root becomes both the trigger's `cwd` argument AND the envDelta map key (matched by `launch.ts` via `cfg.cwd`). The root collection is therefore mandatory, not an optimization.

### Why the warm/broken/inflight filter

Those three checks (`s.broken.has(key)`, `s.clients.find(...)`, `s.spawning.get(key)`) make the trigger fire **only** for roots that will actually spawn a *new* client on this call. Effect: the plugin's env-delta computation runs at most once per LSP server lifetime per project, never on warm/broken/inflight roots. This keeps the plugin author free of any caching responsibility — every call to `"lsp.env"` corresponds to a real first-spawn moment. The user explicitly asked for this behavior after seeing an iteration that pushed caching onto the plugin.

### Why no `clearEnvDelta`

The originally-planned `clearEnvDelta(root)` in `task.finally` was dropped as unsafe. Builtin servers like Pyright run `await Filesystem.exists(potentialPythonPath)` (server.ts:500-514) *between* `setEnvDelta` and the `spawn()` call that triggers `applyEnvDelta`. A concurrent `clear` on the same root mid-await would wipe the entry before `applyEnvDelta` reads it, causing a silent miss. Since the map entry is only consulted at first-spawn (the only moment Process.spawn reads `cfg.env`) and later spawns for the same `(root, serverID)` are deduped by `s.spawning` / `s.clients` anyway, leaving entries in the map indefinitely is harmless — the cost is a few hundred KB of env strings at most across all LSP servers ever spawned in a daemon's lifetime. Nothing reads stale entries.

### Staleness edge (acceptable)

Env vars are applied via `Process.spawn` at the spawn moment only; a running LSP server keeps its original env forever. So between an `.envrc` change and the *next* (re)spawn of an LSP server for that root, the running server uses the old env. That's the same staleness window VS Code has for "reload window to pick up new env" and is consistent with opencode's existing model. Not fixing it here.

## Why a plugin hook and not something bigger

Considered a unified cached "project env" concept (one hook computed once per project, consumed by every spawning concern — bash, PTY, LSP, MCP, apply_patch). Rejected as out of scope: it's a real refactor that would deprecate `shell.env`, add a `ProjectEnv` service/layer, and need upstream-maintainer buy-in. The per-tool hook pattern (`shell.env` → `lsp.env`) is what the maintainers already picked; mirroring it is the consistent, minimal, PR-likely-acceptable move. The "right long-term answer" remains a separate discussion with upstream.

## Why the chokepoint in `launch.ts` and not per-server

Initial design A threaded env via `InstanceContext.lspEnv` + per-call shallow clone `await server.spawn(root, { ...ctx, lspEnv: delta }, flags)`. That required ~14 explicit `env: { ...process.env }` → `env: { ...process.env, ...ctx.lspEnv }` multiline edits in `server.ts`, and — critically — would have left the ~24 builtin servers that *don't* spread `process.env` (they rely on cross-spawn inheriting the daemon env) without any delta at all. Partial coverage.

Design B (the chosen one) keys the map by `cfg.cwd` in `launch.ts`, the single function every LSP spawn routes through. Touches zero server `spawn` implementations, gives full coverage automatically, including the custom-LSP branch (which uses `lspspawn` = `launch.ts spawn`).

## Why the import cycle is safe

`lsp.ts → @/plugin → @/session/session/prompt.ts → @/lsp/lsp` is a deferred cycle: Plugin only references `Session.Event.Error` (a constant) inside runtime callbacks, not at module-eval time; Session's prompt.ts only imports `LSP` for use at call time. ESM handles deferred cycles fine; the layer graph is acyclic (Plugin.node doesn't depend on LSP.node; LSP.node now depends on Plugin.node).

## Verification

- `bun typecheck` from `packages/opencode`: clean.
- `bun typecheck` from `packages/plugin`: clean.
- `bun test test/lsp/` in `packages/opencode`: 58 pass, 0 fail, 71 expects.
- Full `turbo typecheck`: only `@opencode-ai/console-support` fails (`resource.node.ts:38,58` implicit-any), confirmed pre-existing on a clean tree at `87f8c5a0d` via `git stash`.

End-to-end (user-side, after extending `~/.config/opencode/plugin/direnv.ts` with the same `lsp.env` body as `shell.env`, rebuilding opencode, and `systemctl --user restart opencode.service`):
- `Import "polars" could not be resolved` cleared on a trivial edit to `/home/einar/Projects/local/hello-uv-lsp/main.py`.
- TypeScript LSP in the same project still resolves `zod` and catches real type errors (no regression).

## Alternatives considered (rejected)

- **A. ctx.lspEnv per-call clone + per-spawn-site edits.** Thread delta via `InstanceContext`. Rejected: partial coverage (Group-2 servers without an explicit `env` spread would still miss the delta), and larger git-conflict surface across 14 multiline `env: { ...process.env }` blocks.
- **Unified `project.env` cached hook.** Rejected as out of scope (see "Why a plugin hook and not something bigger").
- **Pyright-specific `venvPath`/`venv` init option.** Rejected: Python-specific, doesn't fix gopls/rust-analyzer/etc., and pyright's `pythonPath` init already gets set despite the failure (the env-SIDE is what's actually missing).
- **touchFile-time env injection.** Rejected: would have required touching every server's spawn impl since touchFile→getClients doesn't pass env down by itself; the launch.ts chokepoint is structurally cleaner.

## User-side direnv.ts (outside this repo)

The plugin at `~/.config/opencode/plugin/direnv.ts` now exports both `shell.env` and `lsp.env` with the same body (run `direnv export json` with `cwd: input.cwd`, filter `DIRENV_*` and non-strings, write to `output.env`). The opencode-side code contains nothing direnv- or Python-specific.
