import { Interface, type Log } from 'ethers'
import { gateContract, provider } from './chain'
import { TREASURY_GATE_ABI } from './abi'
import { headRange } from './logs'

/**
 * What a gate did with a writ — read from the gate's own events, or admitted to be unknown.
 *
 * Both `TransferApproved` and `TransferRefused` carry `writId` as their second indexed topic, so
 * one `eth_getLogs` with no address filter finds the decision whichever gate made it. The
 * registry knows nothing about whether a proof was ever spent, and guessing would invent
 * precisely the fact this product exists to make unguessable.
 */

const iface = new Interface(TREASURY_GATE_ABI as unknown as string[])
const APPROVED = iface.getEvent('TransferApproved')!.topicHash
const REFUSED = iface.getEvent('TransferRefused')!.topicHash

export type Outcome = {
  gate: string
  approved: boolean
  to: string
  amount: bigint
  risk: number
  /** 0 approved, 1 the model declined, 2 the gate's ceiling declined. */
  refusedBy: number
  txHash: string
  blockNumber: number
  ceiling: number | null
}

export async function findOutcome(writId: string, signal?: AbortSignal): Promise<Outcome | null> {
  const range = await headRange()

  let logs: Log[]
  try {
    logs = await provider().getLogs({
      topics: [[APPROVED, REFUSED], null, writId],
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    })
  } catch {
    // A refused range is not a missing decision. The caller renders "not found in the scanned
    // range" rather than "never spent", because those are different claims.
    return null
  }
  if (signal?.aborted) return null

  const log = logs[0]
  if (!log) return null

  const parsed = iface.parseLog({ topics: [...log.topics], data: log.data })
  if (!parsed) return null

  const approved = parsed.name === 'TransferApproved'
  let ceiling: number | null = null
  try {
    const policy = await gateContract(log.address).getPolicy(1n)
    ceiling = Number(policy[4])
  } catch {
    /* a gate that will not report its policy leaves the ceiling unknown, and it says so */
  }

  return {
    gate: log.address,
    approved,
    to: String(parsed.args[0]),
    amount: BigInt(parsed.args[1]),
    risk: Number(parsed.args[2]),
    refusedBy: approved ? 0 : Number(parsed.args[3]),
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    ceiling,
  }
}
