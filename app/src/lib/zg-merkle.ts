import { concat, keccak256 } from 'ethers'

/**
 * 0G Storage's merkle root, recomputed in the browser.
 *
 * The root recorded on chain as `transcriptRoot` is content-addressed, which is the only reason
 * a transcript can be fetched from an untrusted place. Whoever hands you the bytes — an
 * indexer, a gateway, a mirror, a file on a USB stick — you rebuild this root locally and it
 * either equals the one the chain recorded or it does not. That check is what keeps the byte
 * source out of the trust path, so it has to run here rather than on a server.
 *
 * Ported from `@0gfoundation/0g-storage-ts-sdk` (`AbstractFile.merkleTree`, `MerkleTree.build`,
 * `file/utils.ts`), which is the definition the uploader used. `test/zg-merkle.test.ts` pins this
 * port against 12 vectors captured from that package and committed as constants — so a regression
 * in this file fails the test, but a change upstream in the SDK would not, because nothing here
 * re-reads it. Re-capture the vectors when the SDK's version moves.
 */

const CHUNK_SIZE = 256
const SEGMENT_MAX_CHUNKS = 1024
const SEGMENT_SIZE = CHUNK_SIZE * SEGMENT_MAX_CHUNKS
const ZERO_ROOT = '0x' + '00'.repeat(32)

function numSplits(total: number, unit: number): number {
  return Math.floor((total - 1) / unit) + 1
}

function nextPow2(input: number): number {
  if (input <= 1) return 1
  return 2 ** Math.ceil(Math.log2(input))
}

/**
 * How many chunks the flow pads a file up to.
 *
 * Not simply the next power of two: above 16 chunks the padding granularity is a sixteenth of
 * that power of two, which means most files are padded far less than a naive reading suggests.
 * Getting this wrong produces a root that is wrong only for some file sizes, which is exactly
 * the sort of bug that survives a single happy-path test.
 */
export function computePaddedChunks(chunks: number): number {
  const pow2 = nextPow2(chunks)
  if (pow2 === chunks) return chunks
  const minChunk = pow2 >= 16 ? Math.floor(pow2 / 16) : 1
  return numSplits(chunks, minChunk) * minChunk
}

/** The zero-padded length the merkle tree is actually built over. */
export function paddedSize(dataSize: number): number {
  return computePaddedChunks(numSplits(dataSize, CHUNK_SIZE)) * CHUNK_SIZE
}

/** Bottom-up pairing, carrying an odd node forward — `MerkleTree.build` in the storage SDK. */
function buildRoot(leafHashes: string[]): string | null {
  if (leafHashes.length === 0) return null
  if (leafHashes.length === 1) return leafHashes[0]!

  let queue: string[] = []
  for (let i = 0; i < leafHashes.length; i += 2) {
    if (i === leafHashes.length - 1) {
      queue.push(leafHashes[i]!)
      continue
    }
    queue.push(keccak256(concat([leafHashes[i]!, leafHashes[i + 1]!])))
  }

  while (queue.length > 1) {
    const n = queue.length
    const next: string[] = []
    let i = 0
    for (; i + 1 < n; i += 2) {
      next.push(keccak256(concat([queue[i]!, queue[i + 1]!])))
    }
    // An odd trailing node is carried, not duplicated, and lands at the END of the next level.
    if (i < n) next.push(queue[i]!)
    queue = next
  }
  return queue[0]!
}

/** The root of one segment: keccak over each 256-byte chunk, paired bottom-up. */
export function segmentRoot(segment: Uint8Array): string {
  const leaves: string[] = []
  for (let offset = 0; offset < segment.length; offset += CHUNK_SIZE) {
    leaves.push(keccak256(segment.subarray(offset, offset + CHUNK_SIZE)))
  }
  return buildRoot(leaves) ?? ZERO_ROOT
}

/**
 * The 0G Storage merkle root of these exact bytes.
 *
 * Zero-pads to the flow's padded size, splits into 256 KB segments, roots each, then roots the
 * segment roots. Empty input has no root at all — reported as `null` rather than as a zero hash,
 * because a zero hash is a value a caller might compare successfully against something.
 */
export function zgMerkleRoot(data: Uint8Array): string | null {
  if (data.length === 0) return null

  const padded = new Uint8Array(paddedSize(data.length))
  padded.set(data)

  const segmentRoots: string[] = []
  for (let offset = 0; offset < padded.length; offset += SEGMENT_SIZE) {
    segmentRoots.push(segmentRoot(padded.subarray(offset, offset + SEGMENT_SIZE)))
  }
  return buildRoot(segmentRoots)
}

export function isZeroRoot(root: string): boolean {
  return /^0x0{64}$/i.test(root)
}
