import { BrowserProvider, Contract, JsonRpcProvider, type Signer } from 'ethers'
import {
  INFERENCE_SERVING_ABI,
  POLICY_GATE_FACTORY_ABI,
  TREASURY_GATE_ABI,
  WRIT_REGISTRY_ABI,
} from './abi'
import { config } from './config'
import type { FactoryContract, GateContract, RegistryContract, ServingContract } from './contracts'

/**
 * The public read provider.
 *
 * `cacheTimeout: -1` disables ethers' 250 ms response cache. It is off for reads because a
 * docket that quietly serves a quarter-second-old head is confusing to debug, and it is off for
 * writes because the cache covers `eth_getTransactionCount` — two transactions sent in the same
 * tick would otherwise be handed the same nonce and the second would be dropped.
 */
let readProvider: JsonRpcProvider | null = null

export function provider(): JsonRpcProvider {
  if (!readProvider) {
    readProvider = new JsonRpcProvider(
      config.rpcUrl,
      { chainId: config.chainId, name: config.networkName },
      { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 8 },
    )
  }
  return readProvider
}

export function registryContract(runner: Signer | JsonRpcProvider = provider()): RegistryContract {
  if (!config.registry) throw new Error('NEXT_PUBLIC_WRIT_REGISTRY is not set')
  return new Contract(config.registry, WRIT_REGISTRY_ABI, runner) as unknown as RegistryContract
}

export function factoryContract(runner: Signer | JsonRpcProvider = provider()): FactoryContract {
  if (!config.factory) throw new Error('NEXT_PUBLIC_POLICY_GATE_FACTORY is not set')
  return new Contract(config.factory, POLICY_GATE_FACTORY_ABI, runner) as unknown as FactoryContract
}

export function gateContract(address: string, runner: Signer | JsonRpcProvider = provider()): GateContract {
  return new Contract(address, TREASURY_GATE_ABI, runner) as unknown as GateContract
}

export function servingContract(runner: Signer | JsonRpcProvider = provider()): ServingContract {
  return new Contract(config.inferenceServing, INFERENCE_SERVING_ABI, runner) as unknown as ServingContract
}

/** Injected EIP-1193 wallet, if the visitor happens to have one. Read-only views never call this. */
type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> }

export function injectedWallet(): Eip1193 | null {
  if (typeof window === 'undefined') return null
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum
  return eth ?? null
}

export type WalletConnection = {
  signer: Signer
  address: string
  chainId: number
}

/**
 * Connects a wallet, and switches it to the configured chain first.
 *
 * A signer on the wrong chain would send a perfectly valid transaction to somewhere the gate
 * does not exist, so the chain check happens before anything is signed rather than after.
 */
export async function connectWallet(): Promise<WalletConnection> {
  const eth = injectedWallet()
  if (!eth) {
    throw new Error('No injected wallet found. Read-only views need none; deploying one does.')
  }

  await eth.request({ method: 'eth_requestAccounts' })

  const hexChain = '0x' + config.chainId.toString(16)
  const current = (await eth.request({ method: 'eth_chainId' })) as string
  if (current?.toLowerCase() !== hexChain.toLowerCase()) {
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChain }] })
    } catch {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hexChain,
            chainName: config.networkName,
            nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
            rpcUrls: [config.rpcUrl],
            ...(config.explorer ? { blockExplorerUrls: [config.explorer] } : {}),
          },
        ],
      })
    }
  }

  const browser = new BrowserProvider(eth as never, undefined, { cacheTimeout: -1 })
  const signer = await browser.getSigner()
  const net = await browser.getNetwork()
  return { signer, address: await signer.getAddress(), chainId: Number(net.chainId) }
}

/**
 * Turns whatever ethers threw into a sentence a person can act on.
 *
 * Custom errors decode to their name and arguments because the ABIs above declare them, so a
 * revert reads as `ProviderNotAllowed(0x…, 0x…)` rather than an opaque 4-byte blob.
 */
export function explain(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as {
      shortMessage?: string
      reason?: string
      revert?: { name?: string; args?: unknown[] } | null
      info?: { error?: { message?: string } }
      message?: string
      code?: string
    }
    if (e.revert?.name) {
      const args = (e.revert.args ?? []).map((a) => String(a)).join(', ')
      return args ? `${e.revert.name}(${args})` : `${e.revert.name}()`
    }
    if (e.code === 'ACTION_REJECTED') return 'You rejected the transaction in your wallet.'
    if (e.info?.error?.message) return e.info.error.message
    if (e.shortMessage) return e.shortMessage
    if (e.reason) return e.reason
    if (e.message) return e.message
  }
  return String(err)
}
