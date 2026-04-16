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
- Plugins: internal (Codex, Copilot, Gitlab, etc.) + external from `config.plugin_origins`. Source: `src/plugin/plugin.ts`, `src/plugin/index.ts`
