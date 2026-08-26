import type { EventLog } from 'ethers'
import { factoryContract, gateContract, provider, registryContract } from './chain'
import { config } from './config'
import { blockTimes, headRange, queryChunked, type Range } from './logs'

/**
 * The docket: every decision the gates made, both halves of it.
 *
 * Three sources are joined here, and the join is the point:
 *
 *   `Notarized`         — a proof was verified and recorded. This is the permanent fact.
 *   `TransferApproved`  — a gate acted on one, and money moved.
 *   `TransferRefused`   — a gate acted on one, and money did not.
 *
 * The last two are the same kind of event with the same standing. A refusal is not an error
 * path, a missing approval, or a log line nobody reads; it is a settled transaction that a gate
 * paid gas to record, and this feed gives it the identical shape. That is why refusals are not
 * filtered, not greyed, and not counted separately from "successes" anywhere below.
 *
 * A `Notarized` with no gate decision against it is kept as well, as `unspent`. Someone verified
 * a proof and put it on the record without spending it — a real state, and one the page renders
 * on the seam rather than pushing to a side it does not belong on.
 */

export type Side = 'held' | 'released' | 'unspent'

export type DocketEntry = {
  key: string
  side: Side
  writId: string
  /** The gate that acted, absent for an unspent record. */
  gate: string | null
  /** That gate's own risk ceiling, which is what `risk` is measured against. */
  ceiling: number | null
  to: string | null
  amount: bigint | null
  risk: number | null
  /** `PolicyGate.Refusal`: 1 the model declined, 2 the ceiling declined. */
  refusedBy: number | null
  model: string | null
  provider: string | null
  /** Who put the proof on the record. Not who acted on it — that is `gate`. */
  notarizedBy: string | null
  blockNumber: number
  txHash: string
  timestamp: number | null
}

export type GateSummary = {
  address: string
  owner: string
  ceiling: number | null
  held: number
  released: number
  heldAmount: bigint
  releasedAmount: bigint
}

export type Docket = {
  entries: DocketEntry[]
  gates: GateSummary[]
  range: Range
  /** Totals over the scanned range, not over all time. The page says which. */
  totals: { held: number; released: number; unspent: number; heldAmount: bigint; releasedAmount: bigint }
  /** Sources that could not be read, so the page can show a gap instead of a smaller number. */
  problems: string[]
}

type NotarizedRow = {
  id: string
  provider: string
  model: string
  notarizedBy: string
  blockNumber: number
  txHash: string
}

export async function loadDocket(signal?: AbortSignal): Promise<Docket> {
  const problems: string[] = []
  const range = await headRange()

  const registry = registryContract()
  const notarized = new Map<string, NotarizedRow>()

  try {
    const logs = (await queryChunked(registry, registry.filters.Notarized(), range, signal)) as EventLog[]
    for (const log of logs) {
      if (!log.args) continue
      // Positional, so the order is load-bearing:
      // Notarized(id, provider, modelHash, model, reqHash, respHash, notarizedBy).
      // `transcriptRoot` used to sit at index 6 and is gone — a root is a claim rather than
      // part of the record, so it is published separately through `TranscriptAdded` and the
      // docket does not repeat one. Index 6 is `notarizedBy` now.
      notarized.set(String(log.args[0]).toLowerCase(), {
        id: String(log.args[0]),
        provider: String(log.args[1]),
        model: String(log.args[3]),
        notarizedBy: String(log.args[6]),
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      })
    }
  } catch (e) {
    problems.push(`The registry's Notarized log could not be read: ${msg(e)}`)
  }

  const gates = await discoverGates(range, problems, signal)
  const entries: DocketEntry[] = []
  const spent = new Set<string>()
  const summaries: GateSummary[] = []

  for (const g of gates) {
    const contract = gateContract(g.address)
    let ceiling: number | null = null
    try {
      const policy = await contract.getPolicy(1n)
      ceiling = Number(policy[4])
    } catch (e) {
      problems.push(`Gate ${g.address} would not report its policy, so its ceiling is unknown: ${msg(e)}`)
    }

    const summary: GateSummary = {
      address: g.address,
      owner: g.owner,
      ceiling,
      held: 0,
      released: 0,
      heldAmount: 0n,
      releasedAmount: 0n,
    }

    try {
      const [approved, refused] = await Promise.all([
        queryChunked(contract, contract.filters.TransferApproved(), range, signal),
        queryChunked(contract, contract.filters.TransferRefused(), range, signal),
      ])

      for (const log of approved as EventLog[]) {
        if (!log.args) continue
        const id = String(log.args[3]).toLowerCase()
        spent.add(id)
        const meta = notarized.get(id)
        summary.released += 1
        summary.releasedAmount += BigInt(log.args[1])
        entries.push({
          key: `${log.transactionHash}:${log.index}`,
          side: 'released',
          writId: String(log.args[3]),
          gate: g.address,
          ceiling,
          to: String(log.args[0]),
          amount: BigInt(log.args[1]),
          risk: Number(log.args[2]),
          refusedBy: null,
          model: meta?.model ?? null,
          provider: meta?.provider ?? null,
          notarizedBy: meta?.notarizedBy ?? null,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          timestamp: null,
        })
      }

      for (const log of refused as EventLog[]) {
        if (!log.args) continue
        const id = String(log.args[4]).toLowerCase()
        spent.add(id)
        const meta = notarized.get(id)
        summary.held += 1
        summary.heldAmount += BigInt(log.args[1])
        entries.push({
          key: `${log.transactionHash}:${log.index}`,
          side: 'held',
          writId: String(log.args[4]),
          gate: g.address,
          ceiling,
          to: String(log.args[0]),
          amount: BigInt(log.args[1]),
          risk: Number(log.args[2]),
          refusedBy: Number(log.args[3]),
          model: meta?.model ?? null,
          provider: meta?.provider ?? null,
          notarizedBy: meta?.notarizedBy ?? null,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          timestamp: null,
        })
      }
    } catch (e) {
      problems.push(`Gate ${g.address} decisions could not be read: ${msg(e)}`)
    }

    summaries.push(summary)
  }

  for (const [id, row] of notarized) {
    if (spent.has(id)) continue
    entries.push({
      key: `${row.txHash}:notarized:${id.slice(0, 10)}`,
      side: 'unspent',
      writId: row.id,
      gate: null,
      ceiling: null,
      to: null,
      amount: null,
      risk: null,
      refusedBy: null,
      model: row.model,
      provider: row.provider,
      notarizedBy: row.notarizedBy,
      blockNumber: row.blockNumber,
      txHash: row.txHash,
      timestamp: null,
    })
  }

  entries.sort((a, b) => b.blockNumber - a.blockNumber || b.key.localeCompare(a.key))

  const times = await blockTimes(
    entries.slice(0, 60).map((e) => e.blockNumber),
    signal,
  )
  for (const entry of entries) {
    entry.timestamp = times.get(entry.blockNumber) ?? null
  }

  return {
    entries,
    gates: summaries,
    range,
    totals: {
      held: entries.filter((e) => e.side === 'held').length,
      released: entries.filter((e) => e.side === 'released').length,
      unspent: entries.filter((e) => e.side === 'unspent').length,
      heldAmount: entries.reduce((s, e) => (e.side === 'held' ? s + (e.amount ?? 0n) : s), 0n),
      releasedAmount: entries.reduce((s, e) => (e.side === 'released' ? s + (e.amount ?? 0n) : s), 0n),
    },
    problems,
  }
}

/**
 * Every gate the factory has deployed.
 *
 * Read from `GateDeployed` rather than by walking `allGates(i)`, because one filtered log query
 * beats N round trips and gives the owner for free. If the factory address is not configured the
 * docket still renders the registry's records; it just cannot say what any of them authorised.
 */
async function discoverGates(
  range: Range,
  problems: string[],
  signal?: AbortSignal,
): Promise<{ address: string; owner: string }[]> {
  if (!config.factory) {
    problems.push('NEXT_PUBLIC_POLICY_GATE_FACTORY is not set, so no gate decisions are included below.')
    return []
  }
  try {
    const factory = factoryContract()
    const logs = (await queryChunked(factory, factory.filters.GateDeployed(), range, signal)) as EventLog[]
    const seen = new Map<string, { address: string; owner: string }>()
    for (const log of logs) {
      if (!log.args) continue
      const address = String(log.args[0])
      seen.set(address.toLowerCase(), { address, owner: String(log.args[1]) })
    }
    return [...seen.values()]
  } catch (e) {
    problems.push(`The factory's gate list could not be read: ${msg(e)}`)
    return []
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Are we pointed at a chain that answers at all? Used to tell "empty" from "unreachable". */
export async function chainReachable(): Promise<{ ok: true; block: number } | { ok: false; reason: string }> {
  try {
    return { ok: true, block: await provider().getBlockNumber() }
  } catch (e) {
    return { ok: false, reason: `${config.rpcUrl} did not answer: ${msg(e)}` }
  }
}
