import { describe, it, expect, vi } from 'vitest'
import { MemData } from '@0gfoundation/0g-storage-ts-sdk'
import { archiveTranscript, serializeTranscript, uploadTranscript, type Transcript } from '../src/archive.js'
import { sha256Hex } from '../src/hashes.js'

const enc = new TextEncoder()
const RESPONSE = '{"id":"chat-1","choices":[{"message":{"content":"ALLOW:12"}}]}'
const REQUEST = '{"model":"m","messages":[{"role":"user","content":"pinned"}]}'

const transcript: Transcript = {
  chatId: 'chat-1',
  provider: '0xBEEF',
  model: '0GM-1.0-35B-A3B',
  request: REQUEST,
  response: RESPONSE,
  reqHash: '0x' + sha256Hex(enc.encode(REQUEST)),
  respHash: '0x' + sha256Hex(enc.encode(RESPONSE)),
  signature: '0x' + '11'.repeat(65),
  signingAddress: '0x0000000000000000000000000000000000000001',
  capturedAt: '2026-08-26T00:00:00.000Z',
}

/** The root the SDK will derive for this transcript, computed locally with no network. */
async function expectedRoot(t: Transcript): Promise<string> {
  const [tree, err] = await new MemData(serializeTranscript(t)).merkleTree()
  if (err) throw err
  return tree!.rootHash()!
}

function indexerStub(result: unknown, err: Error | null = null) {
  return { upload: vi.fn(async () => [result, err] as never) }
}

describe('archiveTranscript', () => {
  it('uploads the serialized transcript and returns its merkle root', async () => {
    const root = await expectedRoot(transcript)
    const indexer = indexerStub({ rootHash: root, txHash: '0xtx', txSeq: 42 })

    const res = await uploadTranscript(transcript, {} as never, { indexer })
    expect(res).toEqual({ rootHash: root, txHash: '0xtx', txSeq: 42, alreadyStored: false })
    expect(await archiveTranscript(transcript, {} as never, { indexer })).toBe(root)
  })

  it('treats a duplicate upload as success, not an error', async () => {
    // skipIfFinalized defaults to true, so identical bytes come back with err === null and an
    // EMPTY txHash. That is the dedupe signal, and the transcript is stored either way.
    const root = await expectedRoot(transcript)
    const indexer = indexerStub({ rootHash: root, txHash: '', txSeq: 7 })

    const res = await uploadTranscript(transcript, {} as never, { indexer })
    expect(res).toEqual({ rootHash: root, txHash: '', txSeq: 7, alreadyStored: true })
  })

  it('handles the batched return shape', async () => {
    const root = await expectedRoot(transcript)
    const indexer = indexerStub({ rootHashes: [root], txHashes: ['0xtx'], txSeqs: [3] })
    expect(await archiveTranscript(transcript, {} as never, { indexer })).toBe(root)
  })

  it('throws when the indexer reports an error', async () => {
    const indexer = indexerStub(null, new Error('storage node unreachable'))
    await expect(archiveTranscript(transcript, {} as never, { indexer })).rejects.toThrow(
      /storage node unreachable/,
    )
  })

  it('throws when the indexer throws instead of returning an error tuple', async () => {
    // The SDK's [result, error] convention leaks: some paths throw a JsonRpcError instead.
    const indexer = {
      upload: vi.fn(async () => {
        throw new Error('JsonRpcError: file not found')
      }),
    }
    await expect(archiveTranscript(transcript, {} as never, { indexer } as never)).rejects.toThrow(
      /file not found/,
    )
  })

  it('refuses a root that does not match the bytes it uploaded', async () => {
    const indexer = indexerStub({ rootHash: '0x' + 'ff'.repeat(32), txHash: '0xtx', txSeq: 1 })
    await expect(archiveTranscript(transcript, {} as never, { indexer })).rejects.toThrow(
      /root .* does not match/i,
    )
  })

  it('refuses to archive a transcript whose text does not hash to its own recorded hashes', async () => {
    const tampered = { ...transcript, response: RESPONSE.replace('ALLOW:12', 'ALLOW:99') }
    const indexer = indexerStub({ rootHash: '0x' + 'ff'.repeat(32), txHash: '0xtx', txSeq: 1 })
    await expect(archiveTranscript(tampered, {} as never, { indexer })).rejects.toThrow(/respHash/)
    expect(indexer.upload).not.toHaveBeenCalled()
  })

  it('serializes deterministically so the same transcript always yields the same root', async () => {
    const a = serializeTranscript(transcript)
    const b = serializeTranscript({ ...transcript })
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('archives a transcript that anyone can re-derive both hashes from', async () => {
    const bytes = serializeTranscript(transcript)
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Transcript
    expect('0x' + sha256Hex(enc.encode(parsed.request))).toBe(transcript.reqHash)
    expect('0x' + sha256Hex(enc.encode(parsed.response))).toBe(transcript.respHash)
  })
})
