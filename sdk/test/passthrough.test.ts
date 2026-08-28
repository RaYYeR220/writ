import { describe, it, expect, vi, afterEach } from 'vitest'
import { ethers } from 'ethers'
import {
  checkProviderPassthrough,
  probeRequestBody,
  translatableFields,
  type ServiceView,
} from '../src/passthrough.js'
import { sha256Hex, signedTextRouting, type RoutingFields } from '../src/hashes.js'

afterEach(() => vi.unstubAllGlobals())

const enc = new TextEncoder()
const TEE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const teeWallet = new ethers.Wallet(TEE_KEY)

const PROVIDER = '0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D'
const ENDPOINT = 'https://provider.invalid/v1/proxy'
const MODEL = 'glm-5.2'
const RESPONSE = '{"id":"chat-1","choices":[{"message":{"content":"pong"}}]}'
const MEASURED_AT = new Date('2026-08-28T09:00:00.000Z')

function service(over: Partial<ServiceView> = {}): ServiceView {
  return {
    model: MODEL,
    verifiability: 'TeeML',
    teeSignerAddress: teeWallet.address,
    teeSignerAcknowledged: true,
    ...over,
  }
}

const broker = {
  inference: {
    getRequestHeaders: async () => ({ Authorization: 'Bearer app-sk-test' }),
    getServiceMetadata: async () => ({ endpoint: ENDPOINT, model: MODEL }),
  },
}

type Wire = {
  /** What the provider's TEE claims to have hashed as the request. Defaults to what we sent. */
  signedRequest?: Uint8Array
  /** Same for the response half. */
  signedResponse?: Uint8Array
  /** Sign with somebody else's key. */
  signer?: ethers.Wallet
  routing?: RoutingFields
  /** Fail the chat call with this status. */
  chatStatus?: number
  /** Fail the signature call with this status. */
  proofStatus?: number
}

/**
 * A provider on the wire, with the request-translation behaviour dialled in.
 *
 * `signedRequest` is the whole point: a translating broker rewrites the body before forwarding
 * it upstream and signs what it forwarded, so the hash in the signed text is over bytes the
 * client never sent and cannot reconstruct.
 */
function stubProvider(wire: Wire = {}) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url)
      if (url.endsWith('/chat/completions')) {
        if (wire.chatStatus) return new Response('{"error":"nope"}', { status: wire.chatStatus })
        const sent = new Uint8Array(init!.body as Uint8Array)
        const responseBytes = enc.encode(RESPONSE)
        const reqHash = sha256Hex(wire.signedRequest ?? sent)
        const respHash = sha256Hex(wire.signedResponse ?? responseBytes)
        const text = wire.routing
          ? signedTextRouting(reqHash, respHash, wire.routing)
          : `${reqHash}:${respHash}`
        stubbedProof = {
          text,
          signature: await (wire.signer ?? teeWallet).signMessage(text),
        }
        return new Response(RESPONSE, { status: 200, headers: { 'ZG-Res-Key': 'chat-1' } })
      }
      if (wire.proofStatus) return new Response('{"error":"chat_id_not_found"}', { status: wire.proofStatus })
      return new Response(JSON.stringify(stubbedProof), { status: 200 })
    }),
  )
  return calls
}

let stubbedProof: { text: string; signature: string } = { text: '', signature: '' }

function check(over: Partial<Parameters<typeof checkProviderPassthrough>[0]> = {}) {
  return checkProviderPassthrough({
    broker,
    provider: PROVIDER,
    service: service(),
    now: () => MEASURED_AT,
    ...over,
  })
}

describe('the probe body', () => {
  it('carries nothing the broker is documented to translate', () => {
    const body = new TextDecoder().decode(probeRequestBody(MODEL, 'ping'))
    expect(body).toBe('{"model":"glm-5.2","messages":[{"role":"user","content":"ping"}]}')
    expect(translatableFields(probeRequestBody(MODEL, 'ping'))).toEqual([])
  })

  it('names the fields a broker rewrites when a body carries them', () => {
    const body = enc.encode('{"model":"m","max_tokens":16,"reasoning_effort":"low","messages":[]}')
    expect(translatableFields(body)).toEqual(['max_tokens', 'reasoning_effort'])
  })

  it('says nothing about a body it cannot parse rather than guessing', () => {
    expect(translatableFields(enc.encode('not json'))).toEqual([])
  })
})

describe('checkProviderPassthrough', () => {
  it('reports passthrough when the enclave signed the bytes we actually sent', async () => {
    const calls = stubProvider()
    const report = await check()

    expect(report.status).toBe('passthrough')
    expect(report.provider).toBe(PROVIDER)
    expect(report.model).toBe(MODEL)
    expect(report.measuredAt).toBe('2026-08-28T09:00:00.000Z')
    expect(report.evidence?.requestMatches).toBe(true)
    expect(report.evidence?.responseMatches).toBe(true)
    expect(report.evidence?.signatureVerified).toBe(true)
    expect(report.evidence?.kind).toBe('chat')
    expect(report.evidence?.sentRequestHash).toBe(report.evidence?.signedRequestHash)
    expect(calls).toEqual([`${ENDPOINT}/chat/completions`, expect.stringContaining('/signature/chat-1')])
  })

  it('reports response-only when the broker signed a translated request', async () => {
    // Exactly the live case: max_tokens folded into max_completion_tokens upstream, so the
    // signed request hash is over bytes no contract can rebuild.
    stubProvider({ signedRequest: enc.encode('{"model":"0GM-1.0-35B-A3B-0427","max_completion_tokens":1}') })
    const report = await check()

    expect(report.status).toBe('response-only')
    expect(report.evidence?.requestMatches).toBe(false)
    expect(report.evidence?.responseMatches).toBe(true)
    expect(report.evidence?.signatureVerified).toBe(true)
    expect(report.detail).toContain('never settle')
  })

  it('keeps both hashes so the divergence can be shown rather than asserted', async () => {
    const translated = enc.encode('{"translated":true}')
    stubProvider({ signedRequest: translated })
    const report = await check()

    expect(report.evidence?.signedRequestHash).toBe('0x' + sha256Hex(translated))
    expect(report.evidence?.sentRequestHash).toBe('0x' + sha256Hex(probeRequestBody(MODEL, 'ping')))
    expect(report.evidence?.sentRequestHash).not.toBe(report.evidence?.signedRequestHash)
  })

  it('handles a centralized provider signing the five-field routing text', async () => {
    stubProvider({
      routing: {
        providerType: 'openai',
        providerIdentity: 'api.openai.com',
        tlsFingerprint: '0x' + 'ab'.repeat(32),
      },
    })
    const report = await check()

    expect(report.status).toBe('passthrough')
    expect(report.evidence?.kind).toBe('routing')
  })
})

describe('what it refuses to call passthrough', () => {
  it('will not spend anything on a provider that is not TeeML', async () => {
    const calls = stubProvider()
    const report = await check({ service: service({ verifiability: 'standard' }) })

    expect(report.status).toBe('unusable')
    expect(report.detail).toContain('standard')
    // The registry already answers this; a request would be money burnt to learn nothing.
    expect(calls).toEqual([])
  })

  it('will not spend anything on a provider whose signer is not acknowledged', async () => {
    const calls = stubProvider()
    const report = await check({ service: service({ teeSignerAcknowledged: false }) })

    expect(report.status).toBe('unusable')
    expect(report.detail).toContain('acknowledged')
    expect(calls).toEqual([])
  })

  it('will not spend anything on a provider registered with the zero signer', async () => {
    const calls = stubProvider()
    const report = await check({ service: service({ teeSignerAddress: ethers.ZeroAddress }) })

    expect(report.status).toBe('unusable')
    expect(calls).toEqual([])
  })

  it('reports the provider being unreachable as unusable, never as a pass', async () => {
    stubProvider({ chatStatus: 402 })
    const report = await check()

    expect(report.status).toBe('unusable')
    expect(report.detail).toContain('402')
    expect(report.evidence).toBeUndefined()
  })

  it('reports a proof that could not be fetched as unusable', async () => {
    stubProvider({ proofStatus: 404 })
    const report = await check()

    expect(report.status).toBe('unusable')
    expect(report.detail).toContain('proof')
    // The request may well have passed through untouched — we simply do not know, and this
    // function never reports a verdict it did not measure.
    expect(report.evidence).toBeUndefined()
  })

  it('refuses a proof signed by anyone other than the registered TEE signer', async () => {
    const stranger = new ethers.Wallet('0x' + '11'.repeat(32))
    stubProvider({ signer: stranger })
    const report = await check()

    expect(report.status).toBe('unusable')
    expect(report.detail).toContain(teeWallet.address)
    expect(report.evidence?.signatureVerified).toBe(false)
    // Both halves match the bytes on the wire, and it is still not a pass: an unverified
    // signature says nothing about who did the hashing.
    expect(report.evidence?.requestMatches).toBe(true)
  })

  it('refuses when neither half of the signed text is ours', async () => {
    stubProvider({
      signedRequest: enc.encode('{"other":"request"}'),
      signedResponse: enc.encode('{"other":"response"}'),
    })
    const report = await check()

    expect(report.status).toBe('unusable')
    expect(report.evidence?.requestMatches).toBe(false)
    expect(report.evidence?.responseMatches).toBe(false)
  })

  it('reports a signed text in a format it does not understand as unusable', async () => {
    stubProvider()
    // Three fields: neither the chat text nor the routing text. Fail closed.
    stubbedProof = { text: 'a:b:c', signature: '0x' + '00'.repeat(65) }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/chat/completions')
          ? new Response(RESPONSE, { status: 200, headers: { 'ZG-Res-Key': 'chat-1' } })
          : new Response(JSON.stringify(stubbedProof), { status: 200 }),
      ),
    )

    const report = await check()
    expect(report.status).toBe('unusable')
    expect(report.detail).toContain('signed text')
  })

  it('reports a broker that cannot resolve the endpoint as unusable', async () => {
    const calls = stubProvider()
    const report = await check({
      broker: {
        inference: {
          getRequestHeaders: async () => ({ Authorization: 'x' }),
          getServiceMetadata: async () => {
            throw new Error('ledger not found')
          },
        },
      },
    })

    expect(report.status).toBe('unusable')
    expect(report.detail).toContain('ledger not found')
    expect(calls).toEqual([])
  })
})
