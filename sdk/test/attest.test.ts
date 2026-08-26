import { describe, it, expect, vi } from 'vitest'
import { ethers } from 'ethers'
import { signedText, signedTextRouting, sha256Hex } from '../src/hashes.js'
import { attest } from '../src/attest.js'
import type { AttestedRun } from '../src/inference.js'

const enc = new TextEncoder()
const REQUEST = '{"model":"m","messages":[{"role":"user","content":"pinned"}]}'
const RESPONSE = '{"id":"chat-1","choices":[{"message":{"content":"ALLOW:12"}}]}'

const run: AttestedRun = {
  chatId: 'chat-1',
  rawRequest: enc.encode(REQUEST),
  rawResponse: enc.encode(RESPONSE),
  reqHash: '0x' + sha256Hex(enc.encode(REQUEST)),
  respHash: '0x' + sha256Hex(enc.encode(RESPONSE)),
}

const TEE_KEY = '0x' + '11'.repeat(32)
const TEE = new ethers.Wallet(TEE_KEY)
const ROOT = '0x' + 'cd'.repeat(32)
const ROUTING = { providerType: 'centralized', providerIdentity: 'openai', tlsFingerprint: '0x' + 'cc'.repeat(32) }

function proofFrom(key: string, text = signedText(run.reqHash, run.respHash)) {
  const wallet = new ethers.Wallet(key)
  return {
    text,
    signature: wallet.signingKey.sign(ethers.hashMessage(text)).serialized,
    signingAddress: wallet.address,
  }
}

function baseOpts(over: Record<string, unknown> = {}) {
  return {
    runAttested: vi.fn(async () => run),
    fetchProof: vi.fn(async () => proofFrom(TEE_KEY)),
    archiveTranscript: vi.fn(async () => ROOT),
    notarize: vi.fn(async () => ({ writId: '0x' + 'ee'.repeat(32), txHash: '0xtx' })),
    expectedSigner: TEE.address,
    provider: '0xBEEF',
    model: 'm',
    endpoint: 'https://x.invalid/v1/proxy',
    bodyBytes: enc.encode(REQUEST),
    broker: {} as never,
    ...over,
  }
}

describe('attest pipeline', () => {
  it('refuses to notarize when the proof does not match the registered TEE signer', async () => {
    const opts = baseOpts({ fetchProof: vi.fn(async () => proofFrom('0x' + '22'.repeat(32))) })
    await expect(attest(opts as never)).rejects.toThrow(/proof does not verify/i)
    expect(opts.notarize).not.toHaveBeenCalled()
    expect(opts.archiveTranscript).not.toHaveBeenCalled()
  })

  it('refuses when the provider signed a different question and answer than the ones we hold', async () => {
    const other = signedText('0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32))
    const opts = baseOpts({ fetchProof: vi.fn(async () => proofFrom(TEE_KEY, other)) })
    await expect(attest(opts as never)).rejects.toThrow(/not this request and response/i)
    expect(opts.notarize).not.toHaveBeenCalled()
  })

  it('refuses a signed text in a format it cannot bind', async () => {
    const images = `${sha256Hex(enc.encode(REQUEST))}:${'bb'.repeat(32)},${'cc'.repeat(32)}`
    const opts = baseOpts({ fetchProof: vi.fn(async () => proofFrom(TEE_KEY, images)) })
    await expect(attest(opts as never)).rejects.toThrow()
    expect(opts.notarize).not.toHaveBeenCalled()
  })

  it('refuses a zero expected signer instead of accepting anything', async () => {
    const opts = baseOpts({ expectedSigner: ethers.ZeroAddress })
    await expect(attest(opts as never)).rejects.toThrow(/expectedSigner/i)
    expect(opts.runAttested).not.toHaveBeenCalled()
  })

  it('claims the proof before archiving, because the proof is the part that expires', async () => {
    const order: string[] = []
    const opts = baseOpts({
      fetchProof: vi.fn(async () => {
        order.push('proof')
        return proofFrom(TEE_KEY)
      }),
      archiveTranscript: vi.fn(async () => {
        order.push('archive')
        return ROOT
      }),
      notarize: vi.fn(async () => {
        order.push('notarize')
        return { writId: '0x' + 'ee'.repeat(32), txHash: '0xtx' }
      }),
    })
    const result = await attest(opts as never)
    expect(order).toEqual(['proof', 'archive', 'notarize'])
    expect(result.transcriptRoot).toBe(ROOT)
    expect(result.writId).toBe('0x' + 'ee'.repeat(32))
    expect(result.txHash).toBe('0xtx')
    expect(result.run).toBe(run)
    expect(result.kind).toBe('chat')
    expect(result.routing).toBeUndefined()
  })

  it('archives a transcript carrying the exact wire bytes', async () => {
    const opts = baseOpts()
    await attest(opts as never)
    const [transcript] = opts.archiveTranscript.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(transcript['request']).toBe(REQUEST)
    expect(transcript['response']).toBe(RESPONSE)
    expect(transcript['reqHash']).toBe(run.reqHash)
    expect(transcript['respHash']).toBe(run.respHash)
    expect(transcript['signedText']).toBe(signedText(run.reqHash, run.respHash))
    expect(transcript['chatId']).toBe('chat-1')
    expect(transcript['provider']).toBe('0xBEEF')
    expect(transcript['signingAddress']).toBe(TEE.address)
    expect(transcript['routing']).toBeUndefined()
  })

  it('notarizes the same proof it verified', async () => {
    const proof = proofFrom(TEE_KEY)
    const opts = baseOpts({ fetchProof: vi.fn(async () => proof) })
    const result = await attest(opts as never)
    expect(result.signature).toBe(proof.signature)
    expect(opts.notarize).toHaveBeenCalledWith(run, '0xBEEF', proof, ROOT)
  })

  it('does not notarize with a made-up root when archiving fails', async () => {
    const opts = baseOpts({
      archiveTranscript: vi.fn(async () => {
        throw new Error('indexer unreachable')
      }),
    })
    await expect(attest(opts as never)).rejects.toThrow(/indexer unreachable/)
    expect(opts.notarize).not.toHaveBeenCalled()
  })

  it('propagates a missing proof rather than continuing without one', async () => {
    const opts = baseOpts({
      fetchProof: vi.fn(async () => {
        throw new Error('proof unavailable (404): chat_id_not_found')
      }),
    })
    await expect(attest(opts as never)).rejects.toThrow(/chat_id_not_found/)
    expect(opts.archiveTranscript).not.toHaveBeenCalled()
    expect(opts.notarize).not.toHaveBeenCalled()
  })
})

describe('attest against a centralized provider', () => {
  const routingText = signedTextRouting(run.reqHash, run.respHash, ROUTING)

  it('verifies the five-field text and carries the attribution through', async () => {
    const opts = baseOpts({ fetchProof: vi.fn(async () => proofFrom(TEE_KEY, routingText)) })
    const result = await attest(opts as never)
    expect(result.kind).toBe('routing')
    expect(result.routing).toEqual(ROUTING)

    const [transcript] = opts.archiveTranscript.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(transcript['signedText']).toBe(routingText)
    expect(transcript['routing']).toEqual(ROUTING)
  })

  it('refuses when the routing text is signed by the wrong key', async () => {
    const opts = baseOpts({ fetchProof: vi.fn(async () => proofFrom('0x' + '22'.repeat(32), routingText)) })
    await expect(attest(opts as never)).rejects.toThrow(/proof does not verify.*routing/is)
    expect(opts.notarize).not.toHaveBeenCalled()
  })

  it('refuses a routing text whose hashes are not the ones we sent and received', async () => {
    const wrong = signedTextRouting('0x' + 'aa'.repeat(32), run.respHash, ROUTING)
    const opts = baseOpts({ fetchProof: vi.fn(async () => proofFrom(TEE_KEY, wrong)) })
    await expect(attest(opts as never)).rejects.toThrow(/not this request and response/i)
    expect(opts.notarize).not.toHaveBeenCalled()
  })
})
