import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchProof, signatureUrl } from '../src/proof.js'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(body: string, init: ResponseInit = { status: 200 }) {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(body, init)
    }),
  )
  return urls
}

describe('signatureUrl', () => {
  it('appends to a broker endpoint that already ends in /v1/proxy', () => {
    expect(signatureUrl('https://p.invalid/v1/proxy', 'chat-1', 'm')).toBe(
      'https://p.invalid/v1/proxy/signature/chat-1?model=m',
    )
  })

  it('adds /v1/proxy when handed the bare service url from the registry', () => {
    expect(signatureUrl('https://p.invalid', 'chat-1', 'm')).toBe(
      'https://p.invalid/v1/proxy/signature/chat-1?model=m',
    )
  })

  it('percent-encodes the chat id and the model', () => {
    expect(signatureUrl('https://p.invalid/v1/proxy/', 'a/b c', '0GM-1.0/x')).toBe(
      'https://p.invalid/v1/proxy/signature/a%2Fb%20c?model=0GM-1.0%2Fx',
    )
  })
})

describe('fetchProof', () => {
  it('returns the text and signature the provider signed', async () => {
    const urls = stubFetch(JSON.stringify({ text: 'aa:bb', signature: '0xdead' }))
    await expect(fetchProof('https://p.invalid/v1/proxy', 'chat-1', 'm')).resolves.toEqual({
      text: 'aa:bb',
      signature: '0xdead',
      signingAddress: undefined,
      routing: undefined,
    })
    expect(urls[0]).toBe('https://p.invalid/v1/proxy/signature/chat-1?model=m')
  })

  it('passes through a signing address when the provider volunteers one', async () => {
    stubFetch(JSON.stringify({ text: 'aa:bb', signature: '0xdead', signing_address: '0xabc' }))
    await expect(fetchProof('https://p.invalid/v1/proxy', 'chat-1', 'm')).resolves.toMatchObject({
      signingAddress: '0xabc',
    })
  })

  it('picks up the routing fields a centralized provider reports', async () => {
    stubFetch(
      JSON.stringify({
        text: 'aa:bb:centralized:openai:cc',
        signature: '0xdead',
        provider_type: 'centralized',
        provider_identity: 'openai',
        tls_cert_fingerprint: 'cc'.repeat(32),
      }),
    )
    await expect(fetchProof('https://p.invalid/v1/proxy', 'chat-1', 'm')).resolves.toMatchObject({
      routing: { providerType: 'centralized', providerIdentity: 'openai', tlsFingerprint: '0x' + 'cc'.repeat(32) },
    })
  })

  it('leaves routing unset when the provider reports only part of it', async () => {
    stubFetch(JSON.stringify({ text: 'aa:bb', signature: '0xdead', provider_type: 'centralized' }))
    await expect(fetchProof('https://p.invalid/v1/proxy', 'chat-1', 'm')).resolves.toMatchObject({
      routing: undefined,
    })
  })

  it('surfaces an expired chat id as an error rather than a silent null', async () => {
    stubFetch(JSON.stringify({ error: 'Chat id not found or expired, chat_id_not_found' }), { status: 404 })
    await expect(fetchProof('https://p.invalid/v1/proxy', 'gone', 'm')).rejects.toThrow(/chat_id_not_found/)
  })

  it('refuses a 200 that carries no signature instead of returning a blank one', async () => {
    stubFetch(JSON.stringify({ text: 'aa:bb' }))
    await expect(fetchProof('https://p.invalid/v1/proxy', 'chat-1', 'm')).rejects.toThrow(/signature/i)
  })

  it('refuses a 200 that carries no signed text', async () => {
    stubFetch(JSON.stringify({ signature: '0xdead' }))
    await expect(fetchProof('https://p.invalid/v1/proxy', 'chat-1', 'm')).rejects.toThrow(/text/i)
  })

  it('reports a non-JSON body instead of throwing a parser error', async () => {
    stubFetch('<html>502 Bad Gateway</html>')
    await expect(fetchProof('https://p.invalid/v1/proxy', 'chat-1', 'm')).rejects.toThrow(/not JSON/i)
  })

  it('propagates a transport failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    await expect(fetchProof('https://p.invalid/v1/proxy', 'chat-1', 'm')).rejects.toThrow(/ECONNREFUSED/)
  })
})
