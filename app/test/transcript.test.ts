import { describe, expect, it } from 'vitest'
import { extractAnswer, extractPrompt, parseTranscript, parseVerdict } from '@/lib/transcript'
import { buildFixture } from './helpers/fixture'

function bytes(o: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(o, null, 2))
}

describe('parsing an archived transcript', () => {
  it('accepts a well-formed one', async () => {
    const { transcript } = await buildFixture()
    expect(parseTranscript(bytes(transcript))).toEqual(transcript)
  })

  it('keeps routing attribution when it is present', async () => {
    const { transcript } = await buildFixture()
    const routing = {
      providerType: 'centralized',
      providerIdentity: 'upstream-a',
      tlsFingerprint: '0x' + '33'.repeat(32),
    }
    expect(parseTranscript(bytes({ ...transcript, routing })).routing).toEqual(routing)
  })

  it('refuses anything that is not a transcript rather than filling in blanks', async () => {
    const { transcript } = await buildFixture()
    const { signature, ...missingSignature } = transcript
    expect(signature).toBeTruthy()

    expect(() => parseTranscript(bytes(missingSignature))).toThrow(/signature/)
    expect(() => parseTranscript(new TextEncoder().encode('not json'))).toThrow(/not JSON/)
    expect(() => parseTranscript(bytes([1, 2, 3]))).toThrow(/not a transcript object/)
    expect(() => parseTranscript(bytes({ ...transcript, routing: 'yes' }))).toThrow(/not an object/)
  })
})

describe('the verdict is read the way the contract reads it', () => {
  const wrap = (content: string) => JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })

  it('reads ALLOW and DENY with their risk', () => {
    expect(parseVerdict(wrap('ALLOW:12'))).toEqual({ allowed: true, risk: 12 })
    expect(parseVerdict(wrap('DENY:87'))).toEqual({ allowed: false, risk: 87 })
    expect(parseVerdict(wrap('ALLOW:0'))).toEqual({ allowed: true, risk: 0 })
    expect(parseVerdict(wrap('DENY:100'))).toEqual({ allowed: false, risk: 100 })
  })

  it('refuses anything outside the grammar, exactly as VerdictLib does', () => {
    // VerdictLib reverts on each of these; the page must not render a verdict the gate rejected.
    expect(parseVerdict(wrap('ALLOW'))).toBeNull()
    expect(parseVerdict(wrap('allow:12'))).toBeNull()
    expect(parseVerdict(wrap('ALLOW: 12'))).toBeNull()
    expect(parseVerdict(wrap('MAYBE:12'))).toBeNull()
    expect(parseVerdict(wrap('ALLOW:101'))).toBeNull()
    expect(parseVerdict(wrap('ALLOW:1234'))).toBeNull()
    expect(parseVerdict(wrap('Sure! ALLOW:12'))).toBeNull()
    expect(parseVerdict('{"no_content_here":true}')).toBeNull()
  })

  it('caps the scan at 32 bytes, as MAX_CONTENT_LEN does', () => {
    expect(parseVerdict(wrap('ALLOW:12' + ' '.repeat(40)))).toBeNull()
  })
})

describe('display helpers never invent text', () => {
  it('lifts the prompt out of the messages array', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: 'be strict' },
        { role: 'user', content: 'transfer 250' },
      ],
    })
    expect(extractPrompt(body)).toBe('be strict\n\ntransfer 250')
  })

  it('falls back to the raw body when the request is not a chat body', () => {
    expect(extractPrompt('not json at all')).toBe('not json at all')
    expect(extractPrompt('{"messages":[]}')).toBe('{"messages":[]}')
  })

  it('lifts the answer out of the response, and falls back to the body', () => {
    expect(extractAnswer(JSON.stringify({ choices: [{ message: { content: 'DENY:87' } }] }))).toBe('DENY:87')
    expect(extractAnswer('opaque')).toBe('opaque')
  })
})
