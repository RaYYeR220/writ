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

/**
 * Build into a private artifact directory nested inside the already-ignored `out/`.
 *
 * Sharing `out/` with whoever is working in `contracts/` means racing their `forge` runs, and
 * an incremental build that skips a contract leaves an ABI-only artifact with no bytecode to
 * deploy. Own the directory and the problem goes away.
 */
const BUILD_ENV = {
  ...process.env,
  FOUNDRY_OUT: 'out/sdk-test',
  FOUNDRY_CACHE_PATH: 'cache/sdk-test',
}
const OUT_DIR = join(CONTRACTS_DIR, 'out', 'sdk-test')

export type Artifact = {
  abi: ReadonlyArray<Record<string, unknown>>
  bytecode?: { object: string }
}

let built: boolean | null = null
/** Why the last `ensureBuilt()` gave up, for suites that want to explain a skip. */
export let buildFailure = ''

const PROBE = join(OUT_DIR, 'WritRegistry.sol', 'WritRegistry.json')

/**
 * Compiles the contract suite so the SDK's hand-written ABIs can be checked against the real
 * thing.
 *
 * Returns false only when there is nothing to compare against at all, so the suites that need
 * artifacts skip rather than assert nothing instead of failing for reasons that are not the
 * SDK's: `contracts/` may simply not compile at that moment.
 */
export function ensureBuilt(): boolean {
  if (built !== null) return built
  try {
    execFileSync(foundryBin('forge'), ['build'], {
      cwd: CONTRACTS_DIR,
      stdio: 'pipe',
      timeout: 300_000,
      env: BUILD_ENV,
    })
    built = true
  } catch (e) {
    buildFailure = e instanceof Error ? e.message : String(e)
    built = existsSync(PROBE)
  }
  return built
}

let forced = false

export function loadArtifact(name: string, sourceFile = `${name}.sol`): Artifact {
  const path = join(OUT_DIR, sourceFile, `${name}.json`)
  const read = (): Artifact => {
    if (!existsSync(path)) {
      throw new Error(`missing Foundry artifact ${path}; run \`forge build\` in ${CONTRACTS_DIR}`)
    }
    return JSON.parse(readFileSync(path, 'utf8')) as Artifact
  }

  let art = read()
  // An incremental `forge build` emits ABI-only artifacts for contracts it did not have to
  // recompile. Deployment needs the bytecode, so ask for it properly, once.
  if (!art.bytecode?.object && !forced) {
    forced = true
    execFileSync(foundryBin('forge'), ['build', '--force'], {
      cwd: CONTRACTS_DIR,
      stdio: 'pipe',
      timeout: 600_000,
      env: BUILD_ENV,
    })
    art = read()
  }
  return art
}
