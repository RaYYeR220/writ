import { spawn, type ChildProcess } from 'node:child_process'
import { foundryBin } from './contracts.js'

export type Anvil = {
  url: string
  /** True when anvil is forking 0G mainnet, so `InferenceServing` carries real state. */
  forked: boolean
  stop: () => void
}

/** anvil's first pre-funded account. */
export const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const FORK_RPC = process.env['WRIT_FORK_RPC'] ?? 'https://evmrpc.0g.ai'

async function reachable(url: string, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
        signal: AbortSignal.timeout(1500),
      })
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/**
 * Boots a local anvil.
 *
 * Prefers a fork of 0G mainnet so the live `InferenceServing` registry is present; falls back
 * to a bare chain when there is no network, because the pipeline itself must be testable
 * offline. Reports which one it got so the tests can say what they proved.
 */
export async function startAnvil(): Promise<Anvil | null> {
  const port = 9545 + Math.floor(Math.random() * 400)
  const url = `http://127.0.0.1:${port}`

  const attempt = async (args: string[]): Promise<ChildProcess | null> => {
    const child = spawn(foundryBin('anvil'), ['--port', String(port), '--silent', ...args], {
      stdio: 'ignore',
      windowsHide: true,
    })
    let spawnFailed = false
    child.on('error', () => {
      spawnFailed = true
    })
    if (await reachable(url, 60)) return child
    if (!spawnFailed) child.kill()
    return null
  }

  let child = await attempt(['--fork-url', FORK_RPC])
  let forked = child !== null
  if (!child) child = await attempt([])
  if (!child) return null

  return {
    url,
    forked,
    stop: () => {
      child.kill()
    },
  }
}
