// Reproduces the 0G serving broker's signing path in JS, so the Solidity tests can assert
// against values derived exactly the way the network derives them.
//
// Mirrors 0g-serving-broker/api/inference/internal/ctrl/signing.go:
//   text = sha256Hex(reqBody) + ":" + sha256Hex(respData)
//   sig  = sign(accounts.TextHash([]byte(text)))   // EIP-191 personal sign
//
// and api/common/tee/tls.go FormatRoutingProofText, used by centralized providers:
//   text = sha256Hex(req):sha256Hex(resp):providerType:providerIdentity:tlsCertFingerprint
//
// Run with `pnpm fixtures`. Output is deterministic for a given key.
import { ethers } from 'ethers'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

export function makeFixture(reqBody, respBody, privKey) {
  const reqH = sha(reqBody)
  const respH = sha(respBody)
  const text = `${reqH}:${respH}`
  const wallet = new ethers.Wallet(privKey)
  const signature = wallet.signingKey.sign(ethers.hashMessage(text)).serialized
  return {
    reqBody,
    respBody,
    reqHash: '0x' + reqH,
    respHash: '0x' + respH,
    text,
    signature,
    signer: wallet.address,
  }
}

export function makeRoutingFixture(reqBody, respBody, providerType, providerIdentity, tlsFingerprint, privKey) {
  const reqH = sha(reqBody)
  const respH = sha(respBody)
  const text = `${reqH}:${respH}:${providerType}:${providerIdentity}:${tlsFingerprint}`
  const wallet = new ethers.Wallet(privKey)
  const signature = wallet.signingKey.sign(ethers.hashMessage(text)).serialized
  return {
    reqHash: '0x' + reqH,
    respHash: '0x' + respH,
    providerType,
    providerIdentity,
    tlsFingerprint: '0x' + tlsFingerprint,
    text,
    textLength: text.length,
    signature,
    signer: wallet.address,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const req = JSON.stringify({
    model: '0GM-1.0-35B-A3B',
    messages: [{ role: 'user', content: 'POLICY-TEST' }],
  })
  const res = JSON.stringify({ id: 'chat-1', choices: [{ message: { content: 'DENY:87' } }] })
  const key = '0x' + '11'.repeat(32)
  console.log(JSON.stringify(makeFixture(req, res, key), null, 2))
  console.log(
    JSON.stringify(
      makeRoutingFixture(req, res, 'centralized', 'openrouter', sha('writ-tls-fixture'), key),
      null,
      2,
    ),
  )
}
