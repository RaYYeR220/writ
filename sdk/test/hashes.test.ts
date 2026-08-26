import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { sha256Hex, signedText, verifyProofLocally } from '../src/index.js'

const enc = new TextEncoder()

describe('hash and proof primitives', () => {
  it('hashes raw bytes the way the 0G broker does', () => {
    const req = enc.encode(
      JSON.stringify({ model: '0GM-1.0-35B-A3B', messages: [{ role: 'user', content: 'POLICY-TEST' }] }),
    )
    expect(sha256Hex(req)).toBe('ccdfb98dd427a783eb317f4d7a5170c4677d7c3f8f087b5413ca0f0eade91c88')
  })

  it('builds the 129-byte signed text', () => {
    const t = signedText('0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32))
    expect(t.length).toBe(129)
    expect(t).toBe('aa'.repeat(32) + ':' + 'bb'.repeat(32))
  })

  it('accepts hashes with or without the 0x prefix and normalises case', () => {
    expect(signedText('AA'.repeat(32), '0x' + 'BB'.repeat(32))).toBe(
      'aa'.repeat(32) + ':' + 'bb'.repeat(32),
    )
  })

  it('refuses to build a signed text from something that is not a 32-byte hash', () => {
    expect(() => signedText('0xdeadbeef', '0x' + 'bb'.repeat(32))).toThrow(/32-byte hex hash/i)
    expect(() => signedText('0x' + 'zz'.repeat(32), '0x' + 'bb'.repeat(32))).toThrow(/32-byte hex hash/i)
  })

  it('verifies a proof against the expected signer', () => {
    const wallet = new ethers.Wallet('0x' + '11'.repeat(32))
    const reqHash = '0x' + 'aa'.repeat(32)
    const respHash = '0x' + 'bb'.repeat(32)
    const sig = wallet.signingKey.sign(ethers.hashMessage(signedText(reqHash, respHash))).serialized
    expect(verifyProofLocally(reqHash, respHash, sig, wallet.address)).toBe(true)
    expect(verifyProofLocally(reqHash, '0x' + 'cc'.repeat(32), sig, wallet.address)).toBe(false)
  })

  it('reports false rather than throwing when the proof is unusable', () => {
    const wallet = new ethers.Wallet('0x' + '11'.repeat(32))
    const reqHash = '0x' + 'aa'.repeat(32)
    const respHash = '0x' + 'bb'.repeat(32)
    expect(verifyProofLocally(reqHash, respHash, '0xnotasignature', wallet.address)).toBe(false)
    expect(verifyProofLocally(reqHash, respHash, '0x', wallet.address)).toBe(false)
    expect(verifyProofLocally('nonsense', respHash, '0x' + '11'.repeat(65), wallet.address)).toBe(false)
  })

  it('rejects a re-serialized body that differs byte-for-byte', () => {
    const original = '{"a":1,"b":2}'
    const reserialized = JSON.stringify(JSON.parse('{"b":2,"a":1}'))
    expect(sha256Hex(enc.encode(original))).not.toBe(sha256Hex(enc.encode(reserialized)))
  })

  it('rejects a semantically identical body that was pretty-printed on the way through', () => {
    // The TEE signs wire bytes. `JSON.parse` then `JSON.stringify` is the classic way to
    // destroy a proof while believing nothing changed.
    const wire = '{"model":"m","messages":[{"role":"user","content":"hi"}]}'
    const rebuilt = JSON.stringify(JSON.parse(wire), null, 2)
    expect(sha256Hex(enc.encode(wire))).not.toBe(sha256Hex(enc.encode(rebuilt)))
  })
})
