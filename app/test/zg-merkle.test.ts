import { describe, expect, it } from 'vitest'
import { computePaddedChunks, isZeroRoot, paddedSize, zgMerkleRoot } from '@/lib/zg-merkle'

/**
 * Vectors produced by `@0gfoundation/0g-storage-ts-sdk@1.2.11` — the same package the uploader
 * used to compute the root that went on chain — via `new MemData(bytes).merkleTree()`.
 *
 * They are committed rather than recomputed at test time so this app does not have to carry the
 * storage SDK (and its Node-only dependencies) into a browser bundle just to prove a hash. The
 * sizes are chosen to straddle every branch of the padding rule: under one chunk, exactly one
 * chunk, one byte over, an odd count that forces a carried node, a count that crosses the
 * "16 chunks" threshold where the padding granularity changes, and a file long enough to need
 * two 256 KB segments.
 */
const VECTORS: { name: string; bytes: Uint8Array; root: string }[] = [
  { name: 'one byte', bytes: new Uint8Array([0x41]), root: '0x659cc333be8127ed8d332192d33779f06c77d74a33703cba5e237acdaf673182' },
  {
    name: 'exactly one chunk',
    bytes: new Uint8Array(256).fill(7),
    root: '0xb392910b77370a8b3a66e1579282840d77cb8c06292390db06738566c3695203',
  },
  {
    name: 'one byte past a chunk',
    bytes: new Uint8Array(257).fill(9),
    root: '0xf0c43073e8b199733f53018985aa12f49b8928f64b41ca7d7fbe848ebf755cd9',
  },
  {
    name: 'nine chunks — odd count, carried node',
    bytes: new Uint8Array(2140).map((_, i) => i % 251),
    root: '0xccc0f95e4f6882d5cf5551c4ecc16ffd1e73d3f31418bcf2ea7d79cb2ef41606',
  },
  {
    name: 'three chunks',
    bytes: new Uint8Array(700).map((_, i) => (i * 13) % 255),
    root: '0xcbfd544d8f1c356101e41788af7b67f9183e1dd9d7e343771e5bb779d522fcfc',
  },
  {
    name: 'seventeen chunks — past the sixteen-chunk padding threshold',
    bytes: new Uint8Array(4300).map((_, i) => (i * 31) % 253),
    root: '0x954b6b5fc91edf371606e062d44759910d469777ce666b1eba40905d37bdd7dd',
  },
  {
    name: 'a transcript-sized JSON document',
    bytes: new TextEncoder().encode(JSON.stringify({ a: 1, b: 'x'.repeat(900) }, null, 2)),
    root: '0xc0ced5b4d8c7806a01607d3979824c8618cc9f670ca10c5b3e93e61ce07c7ce2',
  },
  {
    name: 'two segments',
    bytes: new Uint8Array(600_000).map((_, i) => (i * 7) % 251),
    root: '0x6782e44b51dca231605ece37720615e3cf7d2075015aca092e6bd84faae2b1cf',
  },
]

describe('0G Storage merkle root, ported to the browser', () => {
  for (const v of VECTORS) {
    it(`matches the storage SDK for ${v.name} (${v.bytes.length} bytes)`, () => {
      expect(zgMerkleRoot(v.bytes)).toBe(v.root)
    })
  }

  it('changes completely when one byte changes', () => {
    const a = new Uint8Array(2140).map((_, i) => i % 251)
    const b = new Uint8Array(a)
    b[1000] = (b[1000]! + 1) % 256

    const rootA = zgMerkleRoot(a)
    const rootB = zgMerkleRoot(b)
    expect(rootB).not.toBe(rootA)
    // Which is the whole reason a transcript can be fetched from an untrusted place.
  })

  it('reports no root for empty input rather than a zero hash', () => {
    // A zero hash is a value someone could accidentally compare successfully against.
    expect(zgMerkleRoot(new Uint8Array(0))).toBeNull()
  })

  it('pads the way the flow does, not to the next power of two', () => {
    expect(computePaddedChunks(1)).toBe(1)
    expect(computePaddedChunks(9)).toBe(9)
    expect(computePaddedChunks(16)).toBe(16)
    // 17 chunks: next pow2 is 32, granularity is 32/16 = 2, so it pads to 18 and not to 32.
    expect(computePaddedChunks(17)).toBe(18)
    expect(paddedSize(4300)).toBe(18 * 256)
  })

  it('knows a zero root when it sees one', () => {
    expect(isZeroRoot('0x' + '00'.repeat(32))).toBe(true)
    expect(isZeroRoot('0x' + '00'.repeat(31) + '01')).toBe(false)
  })
})
