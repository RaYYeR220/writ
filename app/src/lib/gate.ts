import type { EventLog } from 'ethers'
import { gateContract, provider, registryContract } from './chain'
import { blockTimes, headRange, queryChunked, type Range } from './logs'
import { fromUtf8 } from './hashes'

/** One treasury, and everything it has done. */
export type GateDetail = {
  address: string
  agent: string
  owner: string
  registry: string
  balance: bigint
  nonce: bigint
  approvedCount: number
  refusedCount: number
  lastAttestationAt: number
  recoveryAvailableAt: number
  recoveryDelay: number
  policy: {
    promptHead: string
    promptTail: string
    allowedModelHash: string
    allowedProvider: string
    maxRisk: number
  }
  ledger: LedgerLine[]
  range: Range
  problems: string[]
}

/**
 * One line of the double-entry ledger.
 *
 * Every decision posts to exactly one of two columns and never to neither. That is the accounting
 * claim this page makes about the product: a refusal is not the absence of an entry, it is an
 * entry in the other column, and the two columns are footed the same way.
 */
export type LedgerLine = {
  key: string
  side: 'held' | 'released'
  writId: string
  to: string
  amount: bigint
  risk: number
  refusedBy: number
  blockNumber: number
  txHash: string
  timestamp: number | null
  model: string | null
  /** Running totals after this line, oldest first — the sums a ledger carries forward. */
  heldSoFar: bigint
  releasedSoFar: bigint
}

export async function loadGate(address: string, signal?: AbortSignal): Promise<GateDetail> {
  const problems: string[] = []
  const gate = gateContract(address)
  const range = await headRange()

  const [agent, owner, registryAddress, balance, nonce, approvedCount, refusedCount, lastAttestationAt, recoveryAvailableAt, recoveryDelay, policyRaw] =
    await Promise.all([
      gate.agent(),
      gate.owner(),
      gate.registry(),
      provider().getBalance(address),
      gate.nonce(),
      gate.approvedCount(),
      gate.refusedCount(),
      gate.lastAttestationAt(),
      gate.recoveryAvailableAt(),
      gate.RECOVERY_DELAY(),
      gate.getPolicy(1n),
    ])

  const models = new Map<string, string>()
  try {
    const registry = registryContract()
    const logs = (await queryChunked(registry, registry.filters.Notarized(), range, signal)) as EventLog[]
    for (const log of logs) {
      if (log.args) models.set(String(log.args[0]).toLowerCase(), String(log.args[3]))
    }
  } catch (e) {
    problems.push(`Model names could not be joined from the registry log: ${msg(e)}`)
  }

  const lines: Omit<LedgerLine, 'heldSoFar' | 'releasedSoFar'>[] = []
  try {
    const [approved, refused] = await Promise.all([
      queryChunked(gate, gate.filters.TransferApproved(), range, signal),
      queryChunked(gate, gate.filters.TransferRefused(), range, signal),
    ])

    for (const log of approved as EventLog[]) {
      if (!log.args) continue
      lines.push({
        key: `${log.transactionHash}:${log.index}`,
        side: 'released',
        writId: String(log.args[3]),
        to: String(log.args[0]),
        amount: BigInt(log.args[1]),
        risk: Number(log.args[2]),
        refusedBy: 0,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        timestamp: null,
        model: models.get(String(log.args[3]).toLowerCase()) ?? null,
      })
    }
    for (const log of refused as EventLog[]) {
      if (!log.args) continue
      lines.push({
        key: `${log.transactionHash}:${log.index}`,
        side: 'held',
        writId: String(log.args[4]),
        to: String(log.args[0]),
        amount: BigInt(log.args[1]),
        risk: Number(log.args[2]),
        refusedBy: Number(log.args[3]),
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        timestamp: null,
        model: models.get(String(log.args[4]).toLowerCase()) ?? null,
      })
    }
  } catch (e) {
    problems.push(`This gate's decisions could not be read: ${msg(e)}`)
  }

  // Oldest first, so the running sums accumulate the way a ledger reads.
  lines.sort((a, b) => a.blockNumber - b.blockNumber || a.key.localeCompare(b.key))

  const times = await blockTimes(
    lines.map((l) => l.blockNumber),
    signal,
  )

  let heldSoFar = 0n
  let releasedSoFar = 0n
  const ledger: LedgerLine[] = lines.map((l) => {
    if (l.side === 'held') heldSoFar += l.amount
    else releasedSoFar += l.amount
    return { ...l, timestamp: times.get(l.blockNumber) ?? null, heldSoFar, releasedSoFar }
  })

  return {
    address,
    agent,
    owner,
    registry: registryAddress,
    balance,
    nonce,
    approvedCount: Number(approvedCount),
    refusedCount: Number(refusedCount),
    lastAttestationAt: Number(lastAttestationAt),
    recoveryAvailableAt: Number(recoveryAvailableAt),
    recoveryDelay: Number(recoveryDelay),
    policy: {
      promptHead: safeUtf8(policyRaw[0]),
      promptTail: safeUtf8(policyRaw[1]),
      allowedModelHash: String(policyRaw[2]),
      allowedProvider: String(policyRaw[3]),
      maxRisk: Number(policyRaw[4]),
    },
    ledger,
    range,
    problems,
  }
}

/** Policy prompts are stored as `bytes`, and nothing guarantees they decode. Say so if they do not. */
function safeUtf8(value: unknown): string {
  try {
    const hex = String(value)
    if (!/^0x[0-9a-fA-F]*$/.test(hex)) return String(value)
    const bytes = new Uint8Array((hex.length - 2) / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16)
    return fromUtf8(bytes)
  } catch {
    return '(these bytes are not valid UTF-8; the gate stores them regardless)'
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
