import { config } from './config'
import { fromUtf8 } from './hashes'
import { zgMerkleRoot } from './zg-merkle'

/**
 * Pulling an archived transcript out of 0G Storage, from the browser, with nobody in between.
 *
 * The 0G turbo indexer answers `GET /file?root=…` with `Access-Control-Allow-Origin: *`, so the
 * page fetches the bytes itself. That is not a convenience — it is the reason this app can say
 * its backend is not in the trust path and mean it.
 *
 * Even so, the source is never taken on faith. The root is content-addressed, so the bytes are
 * accepted only if they rebuild it locally. Which makes the byte source interchangeable: the
 * indexer, a mirror, or a file the reader drags in from disk all get the identical check.
 */

export type FetchedBytes = {
  bytes: Uint8Array
  /** Where these bytes came from, said plainly so the page can print it. */
  source: string
  url: string | null
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/

export function transcriptUrl(root: string, indexer = config.indexerRpc): string {
  return `${indexer.replace(/\/+$/, '')}/file?root=${encodeURIComponent(root)}`
}

/**
 * The indexer answers a missing file with a JSON envelope rather than a 404, and our transcripts
 * are themselves JSON, so the two are told apart by the root check rather than by content type.
 * This only exists to turn `{"code":101}` into a sentence worth reading.
 */
function indexerComplaint(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > 4096) return null
  try {
    const parsed = JSON.parse(fromUtf8(bytes)) as Record<string, unknown>
    if (typeof parsed?.['code'] === 'number' && typeof parsed?.['message'] === 'string') {
      return `0G Storage indexer answered: ${parsed['message']} (code ${parsed['code']})`
    }
  } catch {
    /* not an envelope; fall through */
  }
  return null
}

export class TranscriptUnavailable extends Error {}

/**
 * Fetches the bytes behind a transcript root and proves they are the right ones.
 *
 * Throws `TranscriptUnavailable` with the actual reason on every failure path. There is no
 * branch that returns a placeholder, because a placeholder here would be a page inventing
 * evidence, which is the one thing this product exists to make impossible.
 */
export async function fetchTranscriptBytes(
  root: string,
  opts: { signal?: AbortSignal; indexer?: string } = {},
): Promise<FetchedBytes> {
  if (!BYTES32.test(root)) {
    throw new TranscriptUnavailable(`"${root}" is not a 32-byte transcript root, so there is nothing to ask for.`)
  }
  if (/^0x0{64}$/i.test(root)) {
    throw new TranscriptUnavailable('This writ was notarized with an empty transcript root. Nothing was archived.')
  }

  const url = transcriptUrl(root, opts.indexer ?? config.indexerRpc)

  let res: Response
  try {
    res = await fetch(url, { signal: opts.signal ?? null, cache: 'no-store' })
  } catch (e) {
    throw new TranscriptUnavailable(
      `Could not reach the 0G Storage indexer at ${url} from this browser: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  if (!res.ok) {
    throw new TranscriptUnavailable(`0G Storage indexer returned HTTP ${res.status} for ${url}.`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  const recomputed = zgMerkleRoot(bytes)

  if (!recomputed || recomputed.toLowerCase() !== root.toLowerCase()) {
    const complaint = indexerComplaint(bytes)
    if (complaint) throw new TranscriptUnavailable(complaint)
    throw new TranscriptUnavailable(
      `The bytes returned rebuild to merkle root ${recomputed ?? 'nothing'}, not the ${root} this writ recorded. They are not this transcript.`,
    )
  }

  return { bytes, source: '0G Storage, fetched by this browser', url }
}

/**
 * The same check against bytes the reader supplied themselves.
 *
 * Offered because a judge who does not trust the indexer either should still be able to finish
 * the verification: drop the archived file in and every remaining check runs unchanged.
 */
export function acceptLocalBytes(root: string, bytes: Uint8Array): FetchedBytes {
  const recomputed = zgMerkleRoot(bytes)
  if (!recomputed || recomputed.toLowerCase() !== root.toLowerCase()) {
    throw new TranscriptUnavailable(
      `That file rebuilds to merkle root ${recomputed ?? 'nothing'}, not the ${root} this writ recorded.`,
    )
  }
  return { bytes, source: 'a file you supplied, checked against the on-chain root', url: null }
}
