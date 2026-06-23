import { Process } from "@/util/process"

const envDeltaByCwd = new Map<string, Record<string, string>>()

export function setEnvDelta(cwd: string, delta: Record<string, string>) {
  envDeltaByCwd.set(cwd, delta)
}

export function applyEnvDelta(cfg: Process.Options | undefined) {
  const cwd = cfg?.cwd
  if (!cwd) return cfg
  const delta = envDeltaByCwd.get(cwd)
  if (!delta) return cfg
  return { ...cfg, env: { ...delta, ...cfg.env } }
}