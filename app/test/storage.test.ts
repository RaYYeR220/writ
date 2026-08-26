import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptLocalBytes, fetchTranscriptBytes, TranscriptUnavailable, transcriptUrl } from '@/lib/storage'
import { zgMerkleRoot } from '@/lib/zg-merkle'

const PAYLOAD = new TextEncoder().encode(JSON.stringify({ hello: 'writ', padding: 'x'.repeat(600) }, null, 2))
const ROOT = zgMerkleRoot(PAYLOAD)!

function respondWith(body: Uint8Array, ok = true, status = 200) {
  vi.stubGlobal('fetch', async () => ({
    ok,
    status,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetching a transcript by its root', () => {
  it('accepts bytes that rebuild the root', async () => {
    respondWith(PAYLOAD)
    const fetched = await fetchTranscriptBytes(ROOT)
    expect(fetched.bytes).toEqual(PAYLOAD)
    expect(fetched.source).toMatch(/this browser/)
    expect(fetched.url).toBe(transcriptUrl(ROOT))
  })

  it('rejects bytes that do not, however they were served', async () => {
    const tampered = new Uint8Array(PAYLOAD)
    tampered[40] = tampered[40]! ^ 0x01
    respondWith(tampered)

    await expect(fetchTranscriptBytes(ROOT)).rejects.toThrow(TranscriptUnavailable)
    await expect(fetchTranscriptBytes(ROOT)).rejects.toThrow(/not this transcript/)
  })

  it('turns the indexer’s not-found envelope into a sentence', async () => {
    respondWith(new TextEncoder().encode(JSON.stringify({ code: 101, message: 'File not found', data: null })))
    await expect(fetchTranscriptBytes(ROOT)).rejects.toThrow(/File not found \(code 101\)/)
  })

  it('says so when the indexer answers with an HTTP error', async () => {
    respondWith(new Uint8Array(0), false, 502)
    await expect(fetchTranscriptBytes(ROOT)).rejects.toThrow(/HTTP 502/)
  })

  it('says so when the browser cannot reach the indexer at all', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(fetchTranscriptBytes(ROOT)).rejects.toThrow(/Could not reach the 0G Storage indexer/)
  })

  it('refuses to ask for a root that is not a root', async () => {
    const called = vi.fn()
    vi.stubGlobal('fetch', called)

    await expect(fetchTranscriptBytes('0xnope')).rejects.toThrow(/is not a 32-byte transcript root/)
    // The indexer answers a typo and a genuinely missing file identically, so it is not asked.
    expect(called).not.toHaveBeenCalled()
  })

  it('refuses an empty root, and explains what that means', async () => {
    await expect(fetchTranscriptBytes('0x' + '00'.repeat(32))).rejects.toThrow(/Nothing was archived/)
  })
})

describe('bytes the reader supplies themselves', () => {
  it('get exactly the same content-addressed check', () => {
    expect(acceptLocalBytes(ROOT, PAYLOAD).source).toMatch(/a file you supplied/)

    const wrong = new Uint8Array(PAYLOAD)
    wrong[0] = wrong[0]! ^ 0xff
    expect(() => acceptLocalBytes(ROOT, wrong)).toThrow(TranscriptUnavailable)
  })
})

describe('the URL the page will actually hit', () => {
  it('is the indexer’s public file endpoint, with no path juggling', () => {
    expect(transcriptUrl(ROOT, 'https://indexer-storage-turbo.0g.ai')).toBe(
      `https://indexer-storage-turbo.0g.ai/file?root=${encodeURIComponent(ROOT)}`,
    )
    expect(transcriptUrl(ROOT, 'https://indexer-storage-turbo.0g.ai/')).not.toContain('//file')
  })
})
