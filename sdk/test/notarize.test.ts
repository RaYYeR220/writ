import { describe, it, expect, vi } from 'vitest'
import { notarize, notarizeProof, notarizeRoutingProof } from '../src/notarize.js'
import { signedText, signedTextRouting } from '../src/hashes.js'
import type { AttestedRun } from '../src/inference.js'

const run: AttestedRun = {
  chatId: 'chat-1',
  rawRequest: new Uint8Array([1]),
  rawResponse: new Uint8Array([2]),
  reqHash: '0x' + 'aa'.repeat(32),
  respHash: '0x' + 'bb'.repeat(32),
}

const WRIT_ID = '0x' + 'ee'.repeat(32)
const ROUTING_ID = '0x' + 'dd'.repeat(32)
const ROUTING = { providerType: 'centralized', providerIdentity: 'openai', tlsFingerprint: '0x' + 'cc'.repeat(32) }
const ROOT = '0x' + 'cd'.repeat(32)

function registryStub(over: Partial<Record<string, unknown>> = {}) {
  return {
    writId: vi.fn(async () => WRIT_ID),
    routingWritId: vi.fn(async () => ROUTING_ID),
    isNotarized: vi.fn(async () => false),
    notarize: vi.fn(async () => ({ wait: async () => ({ hash: '0xtx', status: 1 }) })),
    notarizeRoutingProof: vi.fn(async () => ({ wait: async () => ({ hash: '0xrtx', status: 1 }) })),
    ...over,
  }
}

describe('notarize', () => {
  it('sends the proof and reports the writ id and tx hash', async () => {
    const registry = registryStub()
    const res = await notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)
    expect(res).toEqual({ writId: WRIT_ID, txHash: '0xtx', alreadyNotarized: false, kind: 'chat' })
    expect(registry.notarize).toHaveBeenCalledWith('0xBEEF', run.reqHash, run.respHash, '0xsig', ROOT)
  })

  /**
   * Settling can no longer notarize on the way past — the gate reverts `WritNotNotarized`
   * unless the record already exists — so this is the only thing that puts a writ on chain and
   * it goes out unconditionally. `AlreadyNotarized` is then the success case, not a failure.
   */
  it('treats AlreadyNotarized as success, because the record is what was wanted', async () => {
    const registry = registryStub({
      isNotarized: vi.fn(async () => true),
      notarize: vi.fn(async () => {
        throw Object.assign(new Error('execution reverted'), { revert: { name: 'AlreadyNotarized' } })
      }),
    })

    const res = await notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)
    expect(res).toEqual({ writId: WRIT_ID, txHash: '', alreadyNotarized: true, kind: 'chat' })
    // It still tried: a read-then-skip loses the race it looks like it wins.
    expect(registry.notarize).toHaveBeenCalled()
  })

  it('does not claim success on an AlreadyNotarized revert the registry will not confirm', async () => {
    // The word in an error string is a string. The record is the fact, so it gets asked.
    const registry = registryStub({
      isNotarized: vi.fn(async () => false),
      notarize: vi.fn(async () => {
        throw Object.assign(new Error('execution reverted'), { revert: { name: 'AlreadyNotarized' } })
      }),
    })

    await expect(notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)).rejects.toThrow(/execution reverted/)
  })

  it('reports success when someone else notarizes the same proof mid-flight', async () => {
    // The exact race a pre-check cannot close: nothing on record when we start, someone else's
    // identical proof lands first, our transaction reverts on chain with no reason string —
    // and the writ is nonetheless exactly where the pipeline needs it.
    const registry = registryStub({
      isNotarized: vi.fn(async () => true),
      notarize: vi.fn(async () => ({ wait: async () => ({ hash: '0xtx', status: 0 }) })),
    })

    const res = await notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)
    expect(res.alreadyNotarized).toBe(true)
    expect(res.writId).toBe(WRIT_ID)
  })

  it('propagates a rejected notarization rather than reporting a writ that does not exist', async () => {
    const registry = registryStub({
      notarize: vi.fn(async () => {
        throw new Error('execution reverted: BadSignature')
      }),
    })
    await expect(notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)).rejects.toThrow(/BadSignature/)
  })

  it('refuses to report success when the receipt never arrives', async () => {
    const registry = registryStub({
      notarize: vi.fn(async () => ({ wait: async () => null })),
    })
    await expect(notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)).rejects.toThrow(/receipt/i)
  })

  it('refuses to report success when the transaction reverted', async () => {
    const registry = registryStub({
      notarize: vi.fn(async () => ({ wait: async () => ({ hash: '0xtx', status: 0 }) })),
    })
    await expect(notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)).rejects.toThrow(/reverted/i)
  })

  it('rejects a transcript root that is not a bytes32', async () => {
    const registry = registryStub()
    await expect(notarize(registry as never, run, '0xBEEF', '0xsig', '0xnope')).rejects.toThrow(
      /32-byte hex/i,
    )
    expect(registry.notarize).not.toHaveBeenCalled()
  })
})

describe('notarizeRoutingProof', () => {
  it('records the upstream attribution the centralized TEE bound', async () => {
    const registry = registryStub()
    const res = await notarizeRoutingProof(registry as never, run, '0xBEEF', ROUTING, '0xsig', ROOT)
    expect(res).toEqual({ writId: ROUTING_ID, txHash: '0xrtx', alreadyNotarized: false, kind: 'routing' })
    expect(registry.notarizeRoutingProof).toHaveBeenCalledWith(
      '0xBEEF',
      run.reqHash,
      run.respHash,
      'centralized',
      'openai',
      ROUTING.tlsFingerprint,
      '0xsig',
      ROOT,
    )
  })

  it('refuses a label the contract would reject, before spending gas to find out', async () => {
    const registry = registryStub()
    await expect(
      notarizeRoutingProof(
        registry as never,
        run,
        '0xBEEF',
        { ...ROUTING, providerIdentity: 'open:ai' },
        '0xsig',
        ROOT,
      ),
    ).rejects.toThrow(/delimiter/)
    expect(registry.notarizeRoutingProof).not.toHaveBeenCalled()
  })
})

describe('notarizeProof', () => {
  it('routes a two-field signed text to the chat registry call', async () => {
    const registry = registryStub()
    const proof = { text: signedText(run.reqHash, run.respHash), signature: '0xsig' }
    expect((await notarizeProof(registry as never, run, '0xBEEF', proof, ROOT)).kind).toBe('chat')
    expect(registry.notarize).toHaveBeenCalled()
    expect(registry.notarizeRoutingProof).not.toHaveBeenCalled()
  })

  it('routes a five-field signed text to the routing registry call', async () => {
    const registry = registryStub()
    const proof = { text: signedTextRouting(run.reqHash, run.respHash, ROUTING), signature: '0xsig' }
    expect((await notarizeProof(registry as never, run, '0xBEEF', proof, ROOT)).kind).toBe('routing')
    expect(registry.notarizeRoutingProof).toHaveBeenCalled()
    expect(registry.notarize).not.toHaveBeenCalled()
  })

  it('reads the format off the signed text, not off a loose field the provider reported', async () => {
    const registry = registryStub()
    const proof = {
      text: signedText(run.reqHash, run.respHash),
      signature: '0xsig',
      routing: ROUTING, // provider says centralized; the signature says otherwise
    }
    expect((await notarizeProof(registry as never, run, '0xBEEF', proof, ROOT)).kind).toBe('chat')
  })

  it('refuses a signed text in a format it cannot bind', async () => {
    const registry = registryStub()
    const images = `${'aa'.repeat(32)}:${'bb'.repeat(32)},${'cc'.repeat(32)}`
    await expect(
      notarizeProof(registry as never, run, '0xBEEF', { text: images, signature: '0xsig' }, ROOT),
    ).rejects.toThrow()
    expect(registry.notarize).not.toHaveBeenCalled()
    expect(registry.notarizeRoutingProof).not.toHaveBeenCalled()
  })
})
