import type { DeferredTopicFilter, EventLog, Log } from 'ethers'
import { provider } from './chain'
import { config } from './config'
import type { Queryable } from './contracts'

/**
 * `queryFilter`, but survivable on a public RPC.
 *
 * Public 0G endpoints cap the block span of a single `eth_getLogs`, and the cap is not
 * advertised. So the range is walked in chunks, and a chunk that is refused is halved and tried
 * again rather than abandoned. The alternative — an indexer — would put a database we control
 * between the reader and the chain, which is exactly the arrangement this product argues against.
 */

const MAX_CHUNK = 10_000
const MIN_CHUNK = 250

/** How far back to look when no deployment block is configured. */
export const DEFAULT_LOOKBACK = 120_000

export type Range = { fromBlock: number; toBlock: number }

export async function headRange(): Promise<Range> {
  const head = await provider().getBlockNumber()
  const from = config.fromBlock > 0 ? config.fromBlock : Math.max(0, head - DEFAULT_LOOKBACK)
  return { fromBlock: from, toBlock: head }
}

function isRangeComplaint(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return (
    msg.includes('range') ||
    msg.includes('too many') ||
    msg.includes('limit') ||
    msg.includes('exceed') ||
    msg.includes('block height') ||
    msg.includes('query returned more than')
  )
}

export async function queryChunked(
  contract: Queryable,
  filter: DeferredTopicFilter,
  range: Range,
  signal?: AbortSignal,
): Promise<(Log | EventLog)[]> {
  const out: (Log | EventLog)[] = []
  let cursor = range.fromBlock
  let chunk = MAX_CHUNK

  while (cursor <= range.toBlock) {
    if (signal?.aborted) throw new Error('cancelled')
    const to = Math.min(cursor + chunk - 1, range.toBlock)
    try {
      out.push(...(await contract.queryFilter(filter, cursor, to)))
      cursor = to + 1
      if (chunk < MAX_CHUNK) chunk = Math.min(MAX_CHUNK, chunk * 2)
    } catch (e) {
      if (chunk > MIN_CHUNK && isRangeComplaint(e)) {
        chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2))
        continue
      }
      throw e
    }
  }
  return out
}

/**
 * Block timestamps for the entries actually on screen.
 *
 * Deliberately not fetched for every log: a docket of a thousand decisions would mean a thousand
 * `eth_getBlockByNumber` calls to render forty rows. Anything without a timestamp shows its block
 * number instead of inventing a time.
 */
export async function blockTimes(blocks: number[], signal?: AbortSignal): Promise<Map<number, number>> {
  const unique = [...new Set(blocks)]
  const out = new Map<number, number>()
  const batches = 8

  for (let i = 0; i < unique.length; i += batches) {
    if (signal?.aborted) return out
    const slice = unique.slice(i, i + batches)
    const blocksOut = await Promise.all(
      slice.map((n) => provider().getBlock(n).catch(() => null)),
    )
    blocksOut.forEach((b, j) => {
      if (b) out.set(slice[j]!, Number(b.timestamp))
    })
  }
  return out
}
