/**
 * Everything the app is allowed to know about where it is pointed.
 *
 * All of it is `NEXT_PUBLIC_`, which is the honest shape: this app has no private configuration
 * because it has no privileged read. A judge with the same four values in their own `.env` sees
 * exactly the same pages, and can point them at a local anvil fork instead.
 *
 * Next inlines `process.env.NEXT_PUBLIC_*` at build time only when the property is written out
 * literally, so every read below is spelled in full rather than looked up by key.
 */

/** 0G mainnet. */
export const MAINNET_CHAIN_ID = 16661
/** 0G Galileo testnet. */
export const GALILEO_CHAIN_ID = 16602

type NetworkDefaults = {
  name: string
  rpcUrl: string
  indexerRpc: string
  explorer: string
  inferenceServing: string
}

const NETWORKS: Record<number, NetworkDefaults> = {
  [MAINNET_CHAIN_ID]: {
    name: '0G mainnet',
    rpcUrl: 'https://evmrpc.0g.ai',
    indexerRpc: 'https://indexer-storage-turbo.0g.ai',
    explorer: 'https://chainscan.0g.ai',
    inferenceServing: '0x47340d900bdFec2BD393c626E12ea0656F938d84',
  },
  [GALILEO_CHAIN_ID]: {
    name: '0G Galileo testnet',
    rpcUrl: 'https://evmrpc-testnet.0g.ai',
    indexerRpc: 'https://indexer-storage-testnet-turbo.0g.ai',
    explorer: 'https://chainscan-galileo.0g.ai',
    inferenceServing: '0xa79F4c8311FF93C06b8CfB403690cc987c93F91E',
  },
}

function clean(v: string | undefined): string {
  return typeof v === 'string' ? v.trim() : ''
}

const CHAIN_ID = (() => {
  const raw = clean(process.env.NEXT_PUBLIC_CHAIN_ID)
  const n = raw ? Number(raw) : MAINNET_CHAIN_ID
  return Number.isFinite(n) && n > 0 ? n : MAINNET_CHAIN_ID
})()

const defaults = NETWORKS[CHAIN_ID]

export type AppConfig = {
  chainId: number
  networkName: string
  rpcUrl: string
  /** `WritRegistry`. Empty until the contracts are deployed; every view says so rather than guessing. */
  registry: string
  /** `PolicyGateFactory`. Empty means Studio can compose and preview but not deploy. */
  factory: string
  inferenceServing: string
  indexerRpc: string
  explorer: string
  /**
   * Block to start `queryFilter` from. Public 0G RPCs cap a log range, and scanning from genesis
   * on every page load is both slow and rude. Set this to the registry's deployment block.
   */
  fromBlock: number
}

export const config: AppConfig = {
  chainId: CHAIN_ID,
  networkName: defaults?.name ?? `chain ${CHAIN_ID}`,
  rpcUrl: clean(process.env.NEXT_PUBLIC_RPC_URL) || defaults?.rpcUrl || 'https://evmrpc.0g.ai',
  registry: clean(process.env.NEXT_PUBLIC_WRIT_REGISTRY),
  factory: clean(process.env.NEXT_PUBLIC_POLICY_GATE_FACTORY),
  inferenceServing:
    clean(process.env.NEXT_PUBLIC_INFERENCE_SERVING) ||
    defaults?.inferenceServing ||
    NETWORKS[MAINNET_CHAIN_ID]!.inferenceServing,
  indexerRpc:
    clean(process.env.NEXT_PUBLIC_STORAGE_INDEXER) ||
    defaults?.indexerRpc ||
    NETWORKS[MAINNET_CHAIN_ID]!.indexerRpc,
  explorer: clean(process.env.NEXT_PUBLIC_EXPLORER) || defaults?.explorer || '',
  fromBlock: (() => {
    const n = Number(clean(process.env.NEXT_PUBLIC_FROM_BLOCK) || '0')
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  })(),
}

export function txUrl(hash: string): string | null {
  return config.explorer ? `${config.explorer}/tx/${hash}` : null
}

export function addressUrl(address: string): string | null {
  return config.explorer ? `${config.explorer}/address/${address}` : null
}

export function blockUrl(block: number | bigint): string | null {
  return config.explorer ? `${config.explorer}/block/${block.toString()}` : null
}

/**
 * The one place that decides whether a page can read anything at all.
 *
 * Returned as a reason string rather than a boolean, because every view that cannot read is
 * required to say *why* instead of rendering an empty state that looks like "no activity yet".
 */
export function missingRegistryReason(): string | null {
  if (!config.registry) {
    return 'NEXT_PUBLIC_WRIT_REGISTRY is not set, so there is no registry to read. Nothing below is a claim about the chain.'
  }
  return null
}

export function missingFactoryReason(): string | null {
  if (!config.factory) {
    return 'NEXT_PUBLIC_POLICY_GATE_FACTORY is not set, so there is no factory to deploy through.'
  }
  return null
}
