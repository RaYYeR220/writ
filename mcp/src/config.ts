import { INFERENCE_SERVING_GALILEO, INFERENCE_SERVING_MAINNET, INDEXER_RPC_GALILEO, INDEXER_RPC_MAINNET } from '@writ/sdk'

/** 0G mainnet. The only chain 0G Compute's broker resolves mainnet contract addresses for. */
export const MAINNET_CHAIN_ID = 16661n
/** 0G Galileo testnet. Gates and the registry deploy here; the compute ledger minimum does not. */
export const GALILEO_CHAIN_ID = 16602n

type NetworkDefaults = {
  rpcUrl: string
  indexerRpc: string
  explorer: string
  inferenceServing: string
}

const NETWORKS: Record<string, NetworkDefaults> = {
  [MAINNET_CHAIN_ID.toString()]: {
    rpcUrl: 'https://evmrpc.0g.ai',
    indexerRpc: INDEXER_RPC_MAINNET,
    explorer: 'https://chainscan.0g.ai',
    inferenceServing: INFERENCE_SERVING_MAINNET,
  },
  [GALILEO_CHAIN_ID.toString()]: {
    rpcUrl: 'https://evmrpc-testnet.0g.ai',
    indexerRpc: INDEXER_RPC_GALILEO,
    explorer: 'https://chainscan-galileo.0g.ai',
    inferenceServing: INFERENCE_SERVING_GALILEO,
  },
}

export type WritConfig = {
  chainId: bigint
  rpcUrl: string
  indexerRpc: string
  explorer: string
  inferenceServing: string
  /** Default `WritRegistry`, used by `writ_lookup` when no gate names one. */
  registry?: string
  /** Used only when a gate's policy accepts any acknowledged TeeML provider. */
  provider?: string
  /** The agent's key. Absent means the read-only tools still work and the others say why. */
  privateKey?: string
  storageTimeoutMs: number
}

function trimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = trimmed(env, key)
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number of milliseconds, got ${raw}`)
  return Math.floor(n)
}

/**
 * Reads the server's configuration from the environment.
 *
 * Nothing here is required to start. A missing key or registry surfaces later as a tool error
 * naming the variable, which is far more useful to an agent than a server that refuses to
 * connect — `writ_preview_question` and `writ_lookup` work with no key at all.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WritConfig {
  const chainRaw = trimmed(env, 'WRIT_CHAIN_ID') ?? MAINNET_CHAIN_ID.toString()
  let chainId: bigint
  try {
    chainId = BigInt(chainRaw)
  } catch {
    throw new Error(`WRIT_CHAIN_ID must be an integer chain id, got ${chainRaw}`)
  }

  const defaults = NETWORKS[chainId.toString()]
  const rpcUrl = trimmed(env, 'WRIT_RPC_URL') ?? defaults?.rpcUrl
  if (!rpcUrl) throw new Error(`no default RPC for chain ${chainId}; set WRIT_RPC_URL`)

  const indexerRpc = trimmed(env, 'WRIT_INDEXER') ?? defaults?.indexerRpc
  if (!indexerRpc) throw new Error(`no default 0G Storage indexer for chain ${chainId}; set WRIT_INDEXER`)

  const inferenceServing = trimmed(env, 'WRIT_INFERENCE_SERVING') ?? defaults?.inferenceServing
  if (!inferenceServing) {
    throw new Error(`no default InferenceServing address for chain ${chainId}; set WRIT_INFERENCE_SERVING`)
  }

  return {
    chainId,
    rpcUrl,
    indexerRpc,
    inferenceServing,
    explorer: trimmed(env, 'WRIT_EXPLORER') ?? defaults?.explorer ?? '',
    ...(trimmed(env, 'WRIT_REGISTRY') ? { registry: trimmed(env, 'WRIT_REGISTRY')! } : {}),
    ...(trimmed(env, 'WRIT_PROVIDER') ? { provider: trimmed(env, 'WRIT_PROVIDER')! } : {}),
    ...(trimmed(env, 'WRIT_PRIVATE_KEY') ? { privateKey: trimmed(env, 'WRIT_PRIVATE_KEY')! } : {}),
    storageTimeoutMs: positiveInt(env, 'WRIT_STORAGE_TIMEOUT_MS', 300_000),
  }
}
