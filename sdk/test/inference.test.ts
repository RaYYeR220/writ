import { describe, it, expect, vi, afterEach } from 'vitest'
import { runAttested } from '../src/inference.js'
import { sha256Hex } from '../src/hashes.js'

afterEach(() => vi.unstubAllGlobals())

const enc = new TextEncoder()
const broker = { inference: { getRequestHeaders: async () => ({ Authorization: 'Bearer app-sk-test' }) } }

type Call = { url: string; init: RequestInit }

function stubFetch(body: string, init: ResponseInit = { status: 200 }) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, i: RequestInit) => {
      calls.push({ url, init: i })
      return new Response(body, init)
    }),
  )
  return calls
}

describe('runAttested', () => {
  it('posts the contract-built bytes verbatim and hashes exactly what went out', async () => {
    const bodyBytes = enc.encode('{"model":"m","messages":[{"role":"user","content":"pinned"}]}')
    const calls = stubFetch('{"id":"chat-1","choices":[]}')

    const run = await runAttested({ broker, provider: '0xBEEF', endpoint: 'https://p.invalid/v1/proxy', bodyBytes })

    expect(calls[0]!.url).toBe('https://p.invalid/v1/proxy/chat/completions')
    expect(calls[0]!.init.method).toBe('POST')
    expect(new Uint8Array(calls[0]!.init.body as Uint8Array)).toEqual(bodyBytes)
    expect(run.reqHash).toBe('0x' + sha256Hex(bodyBytes))
    expect(run.rawRequest).toBe(bodyBytes)
  })

  it('carries the broker auth header through', async () => {
    const calls = stubFetch('{"id":"chat-1"}')
    await runAttested({ broker, provider: '0xBEEF', endpoint: 'https://p.invalid/v1/proxy', bodyBytes: enc.encode('{}') })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer app-sk-test')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('hashes the exact response bytes, whitespace and key order included', async () => {
    // Deliberately odd formatting: a parse-then-rehash would silently normalise this away.
    const wire = '{ "id" : "chat-9" ,  "choices" : [ ] }'
    stubFetch(wire)
    const run = await runAttested({
      broker,
      provider: '0xBEEF',
      endpoint: 'https://p.invalid/v1/proxy',
      bodyBytes: enc.encode('{}'),
    })
    expect(run.respHash).toBe('0x' + sha256Hex(enc.encode(wire)))
    expect(new TextDecoder().decode(run.rawResponse)).toBe(wire)
    expect(run.respHash).not.toBe('0x' + sha256Hex(enc.encode(JSON.stringify(JSON.parse(wire)))))
  })

  it('prefers the ZG-Res-Key header for the chat id', async () => {
    stubFetch('{"id":"body-id"}', { status: 200, headers: { 'ZG-Res-Key': 'header-id' } })
    const run = await runAttested({
      broker,
      provider: '0xBEEF',
      endpoint: 'https://p.invalid/v1/proxy',
      bodyBytes: enc.encode('{}'),
    })
    expect(run.chatId).toBe('header-id')
  })

  it('falls back to the response body id when the header is absent', async () => {
    stubFetch('{"id":"body-id"}')
    const run = await runAttested({
      broker,
      provider: '0xBEEF',
      endpoint: 'https://p.invalid/v1/proxy',
      bodyBytes: enc.encode('{}'),
    })
    expect(run.chatId).toBe('body-id')
  })

  it('throws when there is no chat id anywhere, rather than inventing one', async () => {
    stubFetch('{"choices":[]}')
    await expect(
      runAttested({ broker, provider: '0xBEEF', endpoint: 'https://p.invalid/v1/proxy', bodyBytes: enc.encode('{}') }),
    ).rejects.toThrow(/chat id/i)
  })

  it('surfaces a provider error with its status and body', async () => {
    stubFetch('{"error":"insufficient balance"}', { status: 402 })
    await expect(
      runAttested({ broker, provider: '0xBEEF', endpoint: 'https://p.invalid/v1/proxy', bodyBytes: enc.encode('{}') }),
    ).rejects.toThrow(/402.*insufficient balance/s)
  })

  it('refuses a streaming request because there is no single response body to sign', async () => {
    stubFetch('{"id":"c"}')
    await expect(
      runAttested({
        broker,
        provider: '0xBEEF',
        endpoint: 'https://p.invalid/v1/proxy',
        bodyBytes: enc.encode('{"model":"m","stream":true,"messages":[]}'),
      }),
    ).rejects.toThrow(/stream/i)
  })

  it('refuses an empty request body', async () => {
    stubFetch('{"id":"c"}')
    await expect(
      runAttested({ broker, provider: '0xBEEF', endpoint: 'https://p.invalid/v1/proxy', bodyBytes: new Uint8Array() }),
    ).rejects.toThrow(/empty/i)
  })

  it('tolerates a trailing slash on the endpoint', async () => {
    const calls = stubFetch('{"id":"c"}')
    await runAttested({
      broker,
      provider: '0xBEEF',
      endpoint: 'https://p.invalid/v1/proxy/',
      bodyBytes: enc.encode('{}'),
    })
    expect(calls[0]!.url).toBe('https://p.invalid/v1/proxy/chat/completions')
  })
})
