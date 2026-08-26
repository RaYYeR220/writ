import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import {
  assertRoutingFields,
  parseSignedText,
  signedText,
  signedTextRouting,
  verifyProofLocally,
  verifyRoutingProofLocally,
} from '../src/index.js'

const REQ = '0x' + 'aa'.repeat(32)
const RESP = '0x' + 'bb'.repeat(32)
const FP = '0x' + 'cc'.repeat(32)
const ROUTING = { providerType: 'centralized', providerIdentity: 'openai', tlsFingerprint: FP }

describe('routing proof text', () => {
  it('joins the five fields the broker joins', () => {
    expect(signedTextRouting(REQ, RESP, ROUTING)).toBe(
      `${'aa'.repeat(32)}:${'bb'.repeat(32)}:centralized:openai:${'cc'.repeat(32)}`,
    )
  })

  it('rejects a label containing the field delimiter', () => {
    // "x" + ":y" and "x:" + "y" sign identical bytes, so the split has to be unambiguous.
    expect(() => assertRoutingFields({ ...ROUTING, providerIdentity: 'open:ai' })).toThrow(/delimiter|":"/)
  })

  it('rejects an empty or over-long label, matching the contract', () => {
    expect(() => assertRoutingFields({ ...ROUTING, providerType: '' })).toThrow(/empty/i)
    expect(() => assertRoutingFields({ ...ROUTING, providerIdentity: 'x'.repeat(33) })).toThrow(/32/)
    expect(() => assertRoutingFields({ ...ROUTING, providerIdentity: 'x'.repeat(32) })).not.toThrow()
  })

  it('counts label length in bytes, not code points', () => {
    // 17 three-byte characters is 51 bytes: the contract measures `bytes(label).length`.
    expect(() => assertRoutingFields({ ...ROUTING, providerIdentity: '中'.repeat(17) })).toThrow(/32/)
  })

  it('rejects a fingerprint that is not 32 bytes', () => {
    expect(() => assertRoutingFields({ ...ROUTING, tlsFingerprint: '0xdead' })).toThrow(/32-byte hex/i)
  })
})

describe('parseSignedText', () => {
  it('recognises the two-field chat format', () => {
    expect(parseSignedText(signedText(REQ, RESP))).toEqual({ kind: 'chat', reqHash: REQ, respHash: RESP })
  })

  it('recognises the five-field routing format', () => {
    expect(parseSignedText(signedTextRouting(REQ, RESP, ROUTING))).toEqual({
      kind: 'routing',
      reqHash: REQ,
      respHash: RESP,
      routing: ROUTING,
    })
  })

  it('refuses the image format rather than guessing at it', () => {
    // `sha256hex(req):sha256hex(img0),sha256hex(img1)` splits into two fields but the second
    // is a comma-joined list, not a hash. Verifying it would attest a text we have not pinned.
    const images = `${'aa'.repeat(32)}:${'bb'.repeat(32)},${'cc'.repeat(32)}`
    expect(() => parseSignedText(images)).toThrow(/unsupported|32-byte hex/i)
  })

  it('refuses a text with an unexpected number of fields', () => {
    expect(() => parseSignedText(`${'aa'.repeat(32)}:${'bb'.repeat(32)}:x`)).toThrow(/unsupported/i)
    expect(() => parseSignedText('')).toThrow(/unsupported/i)
  })
})

describe('verifyRoutingProofLocally', () => {
  const wallet = new ethers.Wallet('0x' + '11'.repeat(32))

  it('accepts a signature over the five-field text', async () => {
    const sig = await wallet.signMessage(signedTextRouting(REQ, RESP, ROUTING))
    expect(verifyRoutingProofLocally(REQ, RESP, ROUTING, sig, wallet.address)).toBe(true)
  })

  it('rejects it when any bound field differs', async () => {
    const sig = await wallet.signMessage(signedTextRouting(REQ, RESP, ROUTING))
    expect(verifyRoutingProofLocally(REQ, RESP, { ...ROUTING, providerIdentity: 'anyone' }, sig, wallet.address)).toBe(
      false,
    )
    expect(
      verifyRoutingProofLocally(REQ, RESP, { ...ROUTING, tlsFingerprint: '0x' + 'dd'.repeat(32) }, sig, wallet.address),
    ).toBe(false)
    expect(verifyRoutingProofLocally(REQ, '0x' + 'ee'.repeat(32), ROUTING, sig, wallet.address)).toBe(false)
  })

  it('does not accept a routing proof through the chat verifier, or the reverse', async () => {
    const routingSig = await wallet.signMessage(signedTextRouting(REQ, RESP, ROUTING))
    expect(verifyProofLocally(REQ, RESP, routingSig, wallet.address)).toBe(false)

    const chatSig = await wallet.signMessage(signedText(REQ, RESP))
    expect(verifyRoutingProofLocally(REQ, RESP, ROUTING, chatSig, wallet.address)).toBe(false)
  })
})
