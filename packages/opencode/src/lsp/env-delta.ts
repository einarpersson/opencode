import { Process } from "@/util/process"

const envDeltaByCwd = new Map<string, Record<string, string>>()

export function setEnvDelta(cwd: string, delta: Record<string, string>) {
  envDeltaByCwd.set(cwd, delta)
}

export function applyEnvDelta(cfg: Process.Options | undefined) {
  const cwd = cfg?.cwd
  if (!cwd) return cfg
  const delta = envDeltaByCwd.get(cwd)
  if (!delta) {
    process.stderr.write(`[lsp.env-fix] apply cwd=${cwd} hasDelta=false\n`)
    return cfg
  }
  const merged = { ...delta, ...cfg.env }
  process.stderr.write(
    `[lsp.env-fix] apply cwd=${cwd} hasDelta=true deltaKeys=${Object.keys(delta).join(",") || "(empty)"} mergedVenv=${merged.VIRTUAL_ENV ?? "undefined"} mergedPathHead=${(merged.PATH ?? "").split(":")[0] || "(empty)"}\n`,
  )
  return { ...cfg, env: merged }
}