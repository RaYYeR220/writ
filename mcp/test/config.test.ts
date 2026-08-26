import { describe, expect, it } from 'vitest'
import { INDEXER_RPC_GALILEO, INDEXER_RPC_MAINNET, INFERENCE_SERVING_MAINNET } from '@writ/sdk'
import { GALILEO_CHAIN_ID, MAINNET_CHAIN_ID, loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('defaults to 0G mainnet on the turbo indexer', () => {
    const cfg = loadConfig({})

    expect(cfg.chainId).toBe(MAINNET_CHAIN_ID)
    expect(cfg.rpcUrl).toBe('https://evmrpc.0g.ai')
    expect(cfg.indexerRpc).toBe(INDEXER_RPC_MAINNET)
    expect(cfg.inferenceServing).toBe(INFERENCE_SERVING_MAINNET)
    expect(cfg.explorer).toBe('https://chainscan.0g.ai')
  })

  it('switches every default together when the chain changes', () => {
    const cfg = loadConfig({ WRIT_CHAIN_ID: GALILEO_CHAIN_ID.toString() })

    expect(cfg.chainId).toBe(GALILEO_CHAIN_ID)
    expect(cfg.rpcUrl).toBe('https://evmrpc-testnet.0g.ai')
    expect(cfg.indexerRpc).toBe(INDEXER_RPC_GALILEO)
  })

  it('starts with no key and no registry, so the read-only tools still work', () => {
    const cfg = loadConfig({})

    expect(cfg.privateKey).toBeUndefined()
    expect(cfg.registry).toBeUndefined()
    expect(cfg.provider).toBeUndefined()
  })

  it('lets a local fork override the RPC while keeping the mainnet chain id', () => {
    const cfg = loadConfig({ WRIT_RPC_URL: 'http://127.0.0.1:8545' })

    expect(cfg.chainId).toBe(MAINNET_CHAIN_ID)
    expect(cfg.rpcUrl).toBe('http://127.0.0.1:8545')
  })

  it('ignores blank environment values rather than treating them as set', () => {
    const cfg = loadConfig({ WRIT_PRIVATE_KEY: '   ', WRIT_REGISTRY: '' })

    expect(cfg.privateKey).toBeUndefined()
    expect(cfg.registry).toBeUndefined()
  })

  it('demands the endpoints it cannot guess for an unknown chain', () => {
    expect(() => loadConfig({ WRIT_CHAIN_ID: '1' })).toThrow(/WRIT_RPC_URL/)
    expect(() => loadConfig({ WRIT_CHAIN_ID: '1', WRIT_RPC_URL: 'http://x' })).toThrow(/WRIT_INDEXER/)
  })

  it('rejects a chain id that is not an integer', () => {
    expect(() => loadConfig({ WRIT_CHAIN_ID: 'mainnet' })).toThrow(/WRIT_CHAIN_ID/)
  })

  it('rejects a nonsense timeout', () => {
    expect(() => loadConfig({ WRIT_STORAGE_TIMEOUT_MS: '-5' })).toThrow(/positive number of milliseconds/)
  })
})
