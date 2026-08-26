import {
  parseSignedText,
  sha256Hex,
  signedText as buildSignedText,
  signedTextRouting,
  verifyProofLocally,
  verifyRoutingProofLocally,
  type RoutingFields,
} from '@writ/sdk'
import { fail } from './errors.js'

/**
 * An archived transcript that has been checked against itself and against the TEE signer, with
 * nothing taken on trust.
 */
export type VerifiedTranscript = {
  chatId: string
  provider: string
  model: string
  rawRequest: Uint8Array
  rawResponse: Uint8Array
  reqHash: string
  respHash: string
  signedText: string
  signature: string
  kind: 'chat' | 'routing'
  routing?: RoutingFields
  capturedAt: string
  /** Every check that had to pass to get here, for reporting. */
  checks: Record<string, boolean>
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  if (typeof v !== 'string' || v.length === 0) {
    fail(`archived transcript is missing the "${key}" field`)
  }
  return v
}

function routingOf(o: Record<string, unknown>): RoutingFields | undefined {
  const r = o['routing']
  if (r === undefined || r === null) return undefined
  if (typeof r !== 'object') fail('archived transcript has a "routing" field that is not an object')
  const rec = r as Record<string, unknown>
  return {
    providerType: str(rec, 'providerType'),
    providerIdentity: str(rec, 'providerIdentity'),
    tlsFingerprint: str(rec, 'tlsFingerprint'),
  }
}

/**
 * Re-derives a proof from an archived transcript, from scratch.
 *
 * This is the check a stranger would run: take the bytes 0G Storage holds, re-hash the request
 * and the response, rebuild the text the TEE signed from those hashes alone, and recover the
 * signature to see whose key produced it. Nothing in the transcript's own metadata is believed
 * — `signingAddress` in the file is ignored entirely in favour of `expectedSigner`, which must
 * come from 0G's on-chain `InferenceServing` registry.
 *
 * Any mismatch throws. There is no partial pass and no "probably fine": a transcript that does
 * not re-derive is a transcript that proves nothing.
 */
export function verifyArchivedTranscript(
  bytes: Uint8Array,
  expectedSigner: string,
  expected?: { reqHash?: string; respHash?: string },
): VerifiedTranscript {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    fail('archived transcript is not JSON; it cannot be re-derived')
  }
  if (parsedJson === null || typeof parsedJson !== 'object') {
    fail('archived transcript is not a JSON object; it cannot be re-derived')
  }
  const t = parsedJson as Record<string, unknown>

  const enc = new TextEncoder()
  const rawRequest = enc.encode(str(t, 'request'))
  const rawResponse = enc.encode(str(t, 'response'))

  const reqHash = '0x' + sha256Hex(rawRequest)
  const respHash = '0x' + sha256Hex(rawResponse)

  const claimedReq = str(t, 'reqHash').toLowerCase()
  const claimedResp = str(t, 'respHash').toLowerCase()
  if (reqHash !== claimedReq) {
    fail(`archived request bytes hash to ${reqHash}, but the transcript claims ${claimedReq}`)
  }
  if (respHash !== claimedResp) {
    fail(`archived response bytes hash to ${respHash}, but the transcript claims ${claimedResp}`)
  }

  if (expected?.reqHash && expected.reqHash.toLowerCase() !== reqHash) {
    fail(`archived request hashes to ${reqHash}, but the on-chain writ pins ${expected.reqHash}`)
  }
  if (expected?.respHash && expected.respHash.toLowerCase() !== respHash) {
    fail(`archived response hashes to ${respHash}, but the on-chain writ pins ${expected.respHash}`)
  }

  const storedText = str(t, 'signedText')
  const signature = str(t, 'signature')
  const routing = routingOf(t)

  // The signed text is the artifact everything else is checked against, so rebuild it from the
  // hashes we just computed rather than trusting the copy in the file.
  const rebuilt = routing ? signedTextRouting(reqHash, respHash, routing) : buildSignedText(reqHash, respHash)
  if (rebuilt !== storedText) {
    fail(
      `the archived signed text ${JSON.stringify(storedText)} is not what the archived bytes rebuild to (${JSON.stringify(rebuilt)})`,
    )
  }

  const parsedText = parseSignedText(storedText)
  if (routing && parsedText.kind !== 'routing') fail('transcript carries routing fields but a two-field signed text')
  if (!routing && parsedText.kind === 'routing') fail('transcript signed a routing text but carries no routing fields')

  const verified = routing
    ? verifyRoutingProofLocally(reqHash, respHash, routing, signature, expectedSigner)
    : verifyProofLocally(reqHash, respHash, signature, expectedSigner)

  if (!verified) {
    fail(
      `the archived signature does not recover to the provider's registered TEE signer ${expectedSigner}; this transcript proves nothing`,
    )
  }

  return {
    chatId: str(t, 'chatId'),
    provider: str(t, 'provider'),
    model: str(t, 'model'),
    rawRequest,
    rawResponse,
    reqHash,
    respHash,
    signedText: storedText,
    signature,
    kind: parsedText.kind,
    ...(routing ? { routing } : {}),
    capturedAt: typeof t['capturedAt'] === 'string' ? t['capturedAt'] : '',
    checks: {
      transcriptParses: true,
      requestRehashes: true,
      responseRehashes: true,
      signedTextRebuilds: true,
      signatureRecoversToRegisteredSigner: true,
    },
  }
}
