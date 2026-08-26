import type { EventLog } from 'ethers'
import { registryContract, servingContract } from './chain'
import { fetchTranscriptBytes } from './storage'
import type { ServiceRecord, VerifySources, WritRecord } from './verify'

/**
 * The verifier, wired to public sources and nothing else.
 *
 * Three reads, three public endpoints: the chain over its own RPC, 0G's `InferenceServing` over
 * the same RPC, 0G Storage over its indexer. All three answer a browser directly, which is why
 * the page can say our backend is not in the trust path without an asterisk.
 */
export function chainSources(signal?: AbortSignal): VerifySources {
  return {
    async getWrit(id: string): Promise<WritRecord> {
      const registry = registryContract()
      const w = await registry.getWrit(id)
      const isRouting: boolean = await registry.isRoutingProof(id)

      const record: WritRecord = {
        id,
        provider: String(w[0]),
        modelHash: String(w[1]),
        reqHash: String(w[2]),
        respHash: String(w[3]),
        transcriptRoot: String(w[4]),
        notarizedAt: Number(w[5]),
        notarizedBy: String(w[6]),
        isRouting,
      }

      if (isRouting) {
        const r = await registry.getRoutingProof(id)
        record.routing = {
          providerType: String(r[0]),
          providerIdentity: String(r[1]),
          tlsFingerprint: String(r[2]),
        }
      }
      return record
    },

    async getService(provider: string): Promise<ServiceRecord> {
      const s = await servingContract().getService(provider)
      return {
        provider: String(s[0]),
        serviceType: String(s[1]),
        url: String(s[2]),
        updatedAt: Number(s[5]),
        model: String(s[6]),
        verifiability: String(s[7]),
        teeSignerAddress: String(s[9]),
        teeSignerAcknowledged: Boolean(s[10]),
      }
    },

    async getTranscript(root: string) {
      const fetched = await fetchTranscriptBytes(root, signal ? { signal } : {})
      return { bytes: fetched.bytes, source: fetched.source }
    },
  }
}

/**
 * The transaction a writ was recorded in, found by its indexed id.
 *
 * A convenience only — the writ is real whether or not this lookup succeeds, so a failure here
 * costs the page an explorer link and nothing else.
 */
export async function notarizingTx(
  id: string,
  fromBlock: number,
  toBlock: number,
): Promise<{ txHash: string; blockNumber: number; model: string } | null> {
  try {
    const registry = registryContract()
    const logs = (await registry.queryFilter(registry.filters.Notarized(id), fromBlock, toBlock)) as EventLog[]
    const log = logs[0]
    if (!log?.args) return null
    return { txHash: log.transactionHash, blockNumber: log.blockNumber, model: String(log.args[3]) }
  } catch {
    return null
  }
}

/**
 * What a gate did with a writ, if any gate did anything with it.
 *
 * Read from the gate's own events rather than inferred, because the registry has no opinion on
 * whether a recorded proof was ever spent — and a page that guessed would be inventing the one
 * fact this whole product exists to make unguessable.
 */
export type GateOutcome = {
  gate: string
  approved: boolean
  to: string
  amount: bigint
  risk: number
  refusedBy: number
  txHash: string
  blockNumber: number
}
