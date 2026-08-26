import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** `writ/contracts` — the Foundry project the SDK talks to. */
export const CONTRACTS_DIR = join(here, '..', '..', '..', 'contracts')

/**
 * Resolves a Foundry binary.
 *
 * `foundryup` installs shell wrappers on Windows that only a POSIX shell can run, so prefer
 * the real executable when it is where the installer puts it.
 */
export function foundryBin(name: 'forge' | 'anvil' | 'cast'): string {
  const dirs = [process.env['FOUNDRY_BIN_DIR'], join(homedir(), '.foundry', 'bin')].filter(Boolean) as string[]
  for (const dir of dirs) {
    for (const candidate of [join(dir, `${name}.exe`), join(dir, name)]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return name
}

export type Artifact = {
  abi: ReadonlyArray<Record<string, unknown>>
  bytecode: { object: string }
}

let built: boolean | null = null

/**
 * Compiles the contract suite so the SDK's hand-written ABIs can be checked against the real
 * thing. Returns false when Foundry is unavailable, so the suites that need it can skip
 * loudly rather than assert nothing.
 */
export function ensureBuilt(): boolean {
  if (built !== null) return built
  try {
    execFileSync(foundryBin('forge'), ['build'], { cwd: CONTRACTS_DIR, stdio: 'pipe' })
    built = true
  } catch {
    built = false
  }
  return built
}

export function loadArtifact(name: string, sourceFile = `${name}.sol`): Artifact {
  const path = join(CONTRACTS_DIR, 'out', sourceFile, `${name}.json`)
  if (!existsSync(path)) throw new Error(`missing Foundry artifact ${path}; run \`forge build\` in ${CONTRACTS_DIR}`)
  return JSON.parse(readFileSync(path, 'utf8')) as Artifact
}
