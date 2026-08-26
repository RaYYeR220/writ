import { ethers } from 'ethers'
import {
  archiveTranscript,
  fetchProof,
  runAttested,
  INFERENCE_SERVING_ABI,
  TREASURY_GATE_ABI,
  WRIT_REGISTRY_ABI,
  type InferenceBrokerLike,
  type RoutingFields,
  type Transcript,
} from '@writ/sdk'
import { MAINNET_CHAIN_ID, type WritConfig } from './config.js'
import type {
  ComputeSession,
  DecodedEvent,
  GateHandle,
  RegistryHandle,
  ServiceInfo,
  SettleArgs,
  TxHandle,
  WritDeps,
  WritRecord,
} from './deps.js'
import { fail } from './errors.js'
import { WritStore } from './store.js'

const BYTES32 = /^0x[0-9a-fA-F]{64}$/

function decodeArgs(d: ethers.LogDescription): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  d.fragment.inputs.forEach((input, i) => {
    out[input.name] = d.args[i]
  })
  return out
}

function wrapTx(tx: ethers.ContractTransactionResponse): TxHandle {
  return {
    hash: tx.hash,
    wait: async () => {
      const r = await tx.wait()
      return r ? { hash: r.hash, status: r.status, logs: r.logs } : null
    },
  }
}

/**
 * The live implementation of everything the tools need.
 *
 * Every expensive object is built lazily and cached: the JSON-RPC provider on first read, the
 * wallet on first write, the compute broker on the first attestation. A server started without
 * a key is therefore fully usable for `writ_preview_question` and `writ_lookup`, and only says
 * so when a tool actually needs to sign.
 */
export function createLiveDeps(cfg: WritConfig): WritDeps {
  const store = new WritStore()

  let provider: ethers.JsonRpcProvider | undefined
  let wallet: ethers.Wallet | undefined
  let brokerPromise: Promise<InferenceBrokerLike> | undefined
  const sessions = new Map<string, Promise<ComputeSession>>()

  function rpc(): ethers.JsonRpcProvider {
    if (!provider) {
      // ethers v6 caches every RPC response for 250ms, `eth_getTransactionCount` included.
      // Notarizing and settling go out back to back, which is well inside that window, so a
      // cached nonce would put both transactions on the same number.
      provider = new ethers.JsonRpcProvider(cfg.rpcUrl, undefined, { cacheTimeout: -1 })
    }
    return provider
  }

  function signer(): ethers.Wallet {
    if (!wallet) {
      if (!cfg.privateKey) {
        fail('this tool signs a transaction, but WRIT_PRIVATE_KEY is not set in the server environment')
      }
      try {
        wallet = new ethers.Wallet(cfg.privateKey, rpc())
      } catch {
        fail('WRIT_PRIVATE_KEY is not a valid private key')
      }
    }
    return wallet
  }

  /** Reads are fine unsigned; writes are not, so only take the key when one is needed. */
  function runner(write: boolean): ethers.ContractRunner {
    return write ? signer() : (wallet ?? rpc())
  }

  async function chainId(): Promise<bigint> {
    return (await rpc().getNetwork()).chainId
  }

  function gate(address: string): GateHandle {
    const at = ethers.getAddress(address)
    const read = new ethers.Contract(at, TREASURY_GATE_ABI, rpc())

    const call = <T,>(name: string, ...args: unknown[]): Promise<T> => {
      const fn = read[name] as unknown as ((...a: unknown[]) => Promise<T>) | undefined
      if (!fn) throw new Error(`gate ${at} exposes no ${name}()`)
      return fn(...args)
    }

    const settle = async (name: string, args: unknown[]): Promise<TxHandle> => {
      const write = new ethers.Contract(at, TREASURY_GATE_ABI, runner(true))
      const fn = write[name] as (...a: unknown[]) => Promise<ethers.ContractTransactionResponse>
      return wrapTx(await fn(...args))
    }

    return {
      address: at,
      registryAddress: () => call<string>('registry'),
      agent: () => call<string>('agent'),
      nonce: () => call<bigint>('nonce'),
      policy: async () => {
        const policyId = await call<bigint>('POLICY_ID')
        const p = await call<{
          promptHead: string
          promptTail: string
          allowedModelHash: string
          allowedProvider: string
          maxRisk: bigint
        }>('getPolicy', policyId)
        return {
          promptHead: p.promptHead,
          promptTail: p.promptTail,
          allowedModelHash: p.allowedModelHash,
          allowedProvider: ethers.getAddress(p.allowedProvider),
          maxRisk: Number(p.maxRisk),
        }
      },
      treasuryState: async (recipient) => {
        const [balance, nonce, approvedCount, refusedCount, history] = await Promise.all([
          rpc().getBalance(at),
          call<bigint>('nonce'),
          call<bigint>('approvedCount'),
          call<bigint>('refusedCount'),
          call<[bigint, bigint]>('recipientHistory', recipient),
        ])
        return {
          balance,
          nonce,
          approvedCount,
          refusedCount,
          recipient: { payments: history[0], total: history[1] },
        }
      },
      previewRequestBody: async (to, amountWei) =>
        ethers.getBytes(await call<string>('previewRequestBody', to, amountWei)),
      decisionKey: (p, r, s) => call<string>('decisionKey', p, r, s),
      consumed: (k) => call<boolean>('consumed', k),
      // Neither carries a signature or a root: the gate reads a record, it does not make one.
      execute: (a: SettleArgs) => settle('execute', [a.to, a.amountWei, a.rawResponse, a.provider]),
      executeRoutingProof: (a: SettleArgs & { routing: RoutingFields }) =>
        settle('executeRoutingProof', [
          a.to,
          a.amountWei,
          a.rawResponse,
          a.provider,
          [a.routing.providerType, a.routing.providerIdentity, a.routing.tlsFingerprint],
        ]),
      parseLog: (log): DecodedEvent | null => {
        try {
          const d = read.interface.parseLog(log as { topics: string[]; data: string })
          return d ? { name: d.name, args: decodeArgs(d) } : null
        } catch {
          return null
        }
      },
    }
  }

  function registry(address: string): RegistryHandle {
    const at = ethers.getAddress(address)
    const read = new ethers.Contract(at, WRIT_REGISTRY_ABI, rpc())
    const call = <T,>(name: string, ...args: unknown[]): Promise<T> => {
      const fn = read[name] as unknown as ((...a: unknown[]) => Promise<T>) | undefined
      if (!fn) throw new Error(`registry ${at} exposes no ${name}()`)
      return fn(...args)
    }

    const write = (name: string, args: unknown[]): Promise<ethers.ContractTransactionResponse> => {
      const c = new ethers.Contract(at, WRIT_REGISTRY_ABI, runner(true))
      return (c[name] as (...a: unknown[]) => Promise<ethers.ContractTransactionResponse>)(...args)
    }

    return {
      address: at,
      writId: (p, r, s) => call<string>('writId', p, r, s),
      routingWritId: (p, r, s, t, i, f) => call<string>('routingWritId', p, r, s, t, i, f),
      isNotarized: (id) => call<boolean>('isNotarized', id),
      isRoutingProof: (id) => call<boolean>('isRoutingProof', id),
      getWrit: async (id): Promise<WritRecord> => {
        const w = await call<{
          provider: string
          modelHash: string
          reqHash: string
          respHash: string
          notarizedAt: bigint
          notarizedBy: string
        }>('getWrit', id)
        return {
          provider: ethers.getAddress(w.provider),
          modelHash: w.modelHash,
          reqHash: w.reqHash,
          respHash: w.respHash,
          notarizedAt: w.notarizedAt,
          notarizedBy: ethers.getAddress(w.notarizedBy),
        }
      },
      transcriptRoots: async (id) => [...(await call<readonly string[]>('transcriptRoots', id))],
      transcriptSubmitter: async (id, root) =>
        ethers.getAddress(await call<string>('transcriptSubmitter', id, root)),
      addTranscript: (id, root) => write('addTranscript', [id, root]),
      getRoutingProof: async (id): Promise<RoutingFields> => {
        const p = await call<RoutingFields>('getRoutingProof', id)
        return {
          providerType: p.providerType,
          providerIdentity: p.providerIdentity,
          tlsFingerprint: p.tlsFingerprint,
        }
      },
      notarize: (p, r, s, sig, root) => write('notarize', [p, r, s, sig, root]),
      notarizeRoutingProof: (p, r, s, t, i, f, sig, root) =>
        write('notarizeRoutingProof', [p, r, s, t, i, f, sig, root]),
    }
  }

  async function getService(providerAddress: string): Promise<ServiceInfo> {
    const serving = new ethers.Contract(cfg.inferenceServing, INFERENCE_SERVING_ABI, rpc())
    const s = (await (serving['getService'] as (a: string) => Promise<unknown>)(providerAddress)) as {
      url: string
      model: string
      verifiability: string
      teeSignerAddress: string
      teeSignerAcknowledged: boolean
    }
    return {
      provider: ethers.getAddress(providerAddress),
      url: s.url,
      model: s.model,
      verifiability: s.verifiability,
      teeSignerAddress: ethers.getAddress(s.teeSignerAddress),
      teeSignerAcknowledged: s.teeSignerAcknowledged,
    }
  }

  /**
   * `createZGComputeNetworkBroker` reads the signer's chain and silently falls back to TESTNET
   * contract addresses when it does not recognise it, warning through a `console.warn` this
   * server has already pointed at stderr. Assert the chain here rather than discover later that
   * a ledger was funded on the wrong network.
   */
  async function broker(): Promise<InferenceBrokerLike> {
    if (!brokerPromise) {
      brokerPromise = (async () => {
        const w = signer()
        const net = await rpc().getNetwork()
        if (net.chainId !== MAINNET_CHAIN_ID) {
          fail(
            `0G Compute inference requires chain ${MAINNET_CHAIN_ID}, but WRIT_RPC_URL reports ${net.chainId}; the compute broker would silently use testnet contract addresses`,
          )
        }
        const { createZGComputeNetworkBroker } = await import('@0gfoundation/0g-compute-ts-sdk')
        // ethers resolves to a second copy through the compute SDK's CJS types, so the Wallet
        // is nominally a different class. Runtime-compatible; the same cast the 0G starter kits
        // carry for exactly this reason.
        return (await createZGComputeNetworkBroker(w as never)) as unknown as InferenceBrokerLike
      })()
      brokerPromise.catch(() => {
        brokerPromise = undefined
      })
    }
    return brokerPromise
  }

  function computeSession(providerAddress: string): Promise<ComputeSession> {
    const key = providerAddress.toLowerCase()
    let session = sessions.get(key)
    if (!session) {
      session = (async () => {
        const b = (await broker()) as InferenceBrokerLike & {
          inference: {
            acknowledgeProviderSigner(p: string): Promise<unknown>
            getServiceMetadata(p: string): Promise<{ endpoint: string; model: string }>
          }
        }
        await b.inference.acknowledgeProviderSigner(providerAddress).catch((e: Error) => {
          if (!/already acknowledged/i.test(e.message)) throw e
        })
        const { endpoint, model } = await b.inference.getServiceMetadata(providerAddress)
        return { broker: b, endpoint, model }
      })()
      sessions.set(key, session)
      session.catch(() => sessions.delete(key))
    }
    return session
  }

  /**
   * Pulls an archived transcript back out of 0G Storage and proves it is the right one.
   *
   * The storage SDK's `proof: true` flag is a no-op — `Downloader.downloadTask` takes it as an
   * unread `_proof` parameter — so integrity is established here instead, by recomputing the
   * merkle root of the bytes that came back and comparing it with the root that was asked for.
   * The root is content-addressed, so that is the real check.
   */
  async function downloadTranscript(root: string): Promise<Uint8Array> {
    if (!BYTES32.test(root)) {
      // The indexer does not validate the hash format and answers a typo and a genuinely
      // missing object with the identical error, so reject malformed roots before asking.
      fail(`transcript root ${JSON.stringify(root)} is not a 32-byte hex value`)
    }

    const { Indexer, MemData } = await import('@0gfoundation/0g-storage-ts-sdk')
    const indexer = new Indexer(cfg.indexerRpc)

    let blob: Blob
    try {
      // The tuple convention leaks: an unknown root throws JsonRpcError instead of returning one.
      const [b, err] = await indexer.downloadToBlob(root)
      if (err !== null) fail(`0G Storage could not return transcript ${root}: ${String(err)}`)
      blob = b
    } catch (e) {
      fail(`0G Storage could not return transcript ${root}: ${e instanceof Error ? e.message : String(e)}`)
    }

    const bytes = new Uint8Array(await blob.arrayBuffer())
    const [tree, treeErr] = await new MemData(bytes).merkleTree()
    if (treeErr !== null) fail(`could not recompute the merkle root of transcript ${root}: ${String(treeErr)}`)

    const recomputed = tree?.rootHash()
    if (!recomputed || recomputed.toLowerCase() !== root.toLowerCase()) {
      fail(`0G Storage returned bytes whose merkle root is ${String(recomputed)}, not the requested ${root}`)
    }
    return bytes
  }

  return {
    chainId,
    explorer: cfg.explorer,
    agentAddress: async () => signer().address,
    gate,
    registry,
    configuredRegistry: () => {
      if (!cfg.registry) fail('no registry to read: set WRIT_REGISTRY, or pass one explicitly')
      return cfg.registry
    },
    getService,
    computeSession,
    fallbackProvider: () => cfg.provider,
    downloadTranscript,
    pipeline: {
      runAttested,
      fetchProof,
      archiveTranscript: (t: Transcript, s: unknown) =>
        archiveTranscript(t, s as ethers.Signer, {
          indexerRpc: cfg.indexerRpc,
          chainRpc: cfg.rpcUrl,
          timeoutMs: cfg.storageTimeoutMs,
        }),
      storageSigner: async () => signer(),
    },
    store,
  }
}
