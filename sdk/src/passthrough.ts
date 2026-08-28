import { parseSignedText, sha256Hex, verifyProofLocally, verifyRoutingProofLocally } from './hashes.js'
import { runAttested as defaultRunAttested, type AttestedRun, type InferenceBrokerLike } from './inference.js'
import { fetchProof as defaultFetchProof, type TeeProof } from './proof.js'

/**
 * Whether a provider's broker forwards a request body unmodified.
 *
 * This exists because of a live-mainnet result, not a hypothetical. 0G's broker accepts a
 * portable OpenAI-schema request and, per `0gfoundation/0g-serving-broker`
 * `docs/design/request-translation.md`, rewrites certain fields into the third-party schema the
 * target model actually understands before forwarding: `max_tokens` <-> `max_completion_tokens`,
 * `reasoning_effort` into one of five upstream dialects, and the `model` field to the upstream
 * id. It then signs the TRANSLATED body. The same document says a model that "advertises nothing
 * translatable" gets its body passed through untouched.
 *
 * Writ's prompt-swap defence depends on the second case. `TreasuryGate.execute` rebuilds the
 * exact request bytes on chain and derives the writ id from `sha256` of them, so where the broker
 * translates, the enclave signed a hash of bytes no contract can reproduce and the decision can
 * never settle. Response binding is unaffected either way — the response is hashed exactly as
 * delivered — which is why the two halves are reported separately here.
 *
 * Which case a given provider is in is a property to MEASURE. That is all this module does:
 * one cheap request, one proof, and a verdict that never reads better than the evidence.
 */

/** The registry entry for a provider — the only authority on which key its enclave signs with. */
export type ServiceView = {
  model: string
  verifiability: string
  teeSignerAddress: string
  teeSignerAcknowledged: boolean
}

/** The slice of the 0G Compute broker this check needs. */
export type PassthroughBrokerLike = InferenceBrokerLike & {
  inference: {
    getRequestHeaders(providerAddress: string): Promise<unknown>
    getServiceMetadata(providerAddress: string): Promise<{ endpoint: string; model: string }>
  }
}

export type PassthroughStatus = 'passthrough' | 'response-only' | 'unusable'

/** The measurement itself, kept whole so a reader can check the verdict rather than believe it. */
export type PassthroughEvidence = {
  chatId: string
  /** Which signed-text format the provider used. */
  kind: 'chat' | 'routing'
  /** The exact text the enclave signed. */
  signedText: string
  /** `sha256` of the bytes we posted. */
  sentRequestHash: string
  /** `sha256` of the bytes we received. */
  receivedResponseHash: string
  /** The request half of the signed text. */
  signedRequestHash: string
  /** The response half of the signed text. */
  signedResponseHash: string
  requestMatches: boolean
  responseMatches: boolean
  /** Whether the signature recovers to the TEE signer the registry publishes for this provider. */
  signatureVerified: boolean
}

type Common = {
  provider: string
  /** The model the broker resolved, which is not always the one the registry advertises. */
  model: string
  /** ISO 8601. A measurement without a date is a rumour. */
  measuredAt: string
  /** What was measured and what follows from it, in one paragraph. */
  detail: string
}

export type PassthroughReport = Common &
  (
    | { status: 'passthrough'; evidence: PassthroughEvidence }
    | { status: 'response-only'; evidence: PassthroughEvidence }
    | { status: 'unusable'; evidence?: PassthroughEvidence }
  )

export type CheckProviderOptions = {
  broker: PassthroughBrokerLike
  provider: string
  /** Straight from `InferenceServing.getService(provider)`. Never from the provider itself. */
  service: ServiceView
  /** The user message in the probe. Kept tiny on purpose: this costs real tokens. */
  probe?: string
  /** Injected for tests. Defaults to the SDK's own. */
  runAttested?: (o: {
    broker: InferenceBrokerLike
    provider: string
    endpoint: string
    bodyBytes: Uint8Array
  }) => Promise<AttestedRun>
  fetchProof?: (endpoint: string, chatId: string, model: string) => Promise<TeeProof>
  now?: () => Date
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEFAULT_PROBE = 'ping'

/**
 * The smallest request that still produces a signed proof.
 *
 * Deliberately nothing but `model` and `messages`. Every other field the broker is documented to
 * rewrite is absent, so a `response-only` verdict here cannot be blamed on the probe having
 * asked for translation — the body advertises nothing translatable, and a broker that still
 * changed it changes everything.
 */
export function probeRequestBody(model: string, probe: string = DEFAULT_PROBE): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ model, messages: [{ role: 'user', content: probe }] }))
}

/** The body fields `docs/design/request-translation.md` names as rewritable. */
const TRANSLATABLE = ['max_tokens', 'max_completion_tokens', 'reasoning_effort'] as const

/**
 * Which documented-translatable fields a request body carries.
 *
 * `model` is excluded even though it is also rewritten, because every request has one and
 * flagging it on every body would say nothing. A `passthrough` verdict is a measurement of the
 * body that was actually sent: it does not license adding one of these fields to a gate's prompt
 * afterwards, and this is the cheap way to notice that a gate is about to do exactly that.
 */
export function translatableFields(bodyBytes: Uint8Array): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyBytes))
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const body = parsed as Record<string, unknown>
  return TRANSLATABLE.filter((f) => body[f] !== undefined)
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * One cheap request against a provider, and a verdict on whether a contract could bind it.
 *
 * Never throws for an operational failure — an unreachable provider, an unfunded ledger, an
 * expired chat id and an unparseable signed text all come back as `unusable` with the reason,
 * because a caller needs to tell "it failed" from "it passed" and an exception collapses the two.
 * The one thing this function will not do is report `passthrough` on incomplete evidence.
 */
export async function checkProviderPassthrough(o: CheckProviderOptions): Promise<PassthroughReport> {
  const measuredAt = (o.now?.() ?? new Date()).toISOString()
  // `model` starts as the registry's and is replaced by whatever the broker resolves, so an
  // `unusable` verdict names the same model as a measured one.
  const base = { provider: o.provider, model: o.service.model, measuredAt }
  const unusable = (detail: string, evidence?: PassthroughEvidence): PassthroughReport => ({
    ...base,
    status: 'unusable',
    detail,
    ...(evidence ? { evidence } : {}),
  })

  // The registry already answers these, so answering them here costs nothing. Sending a request
  // first would be money spent to learn something a free `eth_call` had already said.
  if (o.service.verifiability !== 'TeeML') {
    return unusable(
      `The registry publishes verifiability "${o.service.verifiability || 'unset'}" for this provider, not "TeeML". Nothing it returns is signed by an enclave, so there is no proof to bind either half of.`,
    )
  }
  if (!o.service.teeSignerAcknowledged) {
    return unusable(
      'The provider has not acknowledged its TEE signer on chain, so the registry publishes no key a contract could check a signature against.',
    )
  }
  if (!o.service.teeSignerAddress || o.service.teeSignerAddress.toLowerCase() === ZERO_ADDRESS) {
    return unusable('The registry publishes the zero address as this provider’s TEE signer, which nothing can recover to.')
  }

  let endpoint: string
  let model: string
  try {
    ;({ endpoint, model } = await o.broker.inference.getServiceMetadata(o.provider))
    base.model = model
  } catch (e) {
    return unusable(`The broker could not resolve this provider’s endpoint: ${message(e)}`)
  }

  const bodyBytes = probeRequestBody(model, o.probe ?? DEFAULT_PROBE)

  let run: AttestedRun
  try {
    run = await (o.runAttested ?? defaultRunAttested)({
      broker: o.broker,
      provider: o.provider,
      endpoint,
      bodyBytes,
    })
  } catch (e) {
    return unusable(`The probe request did not complete, so nothing was measured: ${message(e)}`)
  }

  let proof: TeeProof
  try {
    proof = await (o.fetchProof ?? defaultFetchProof)(endpoint, run.chatId, model)
  } catch (e) {
    return unusable(
      `The request went through but its proof could not be fetched, so whether the body was forwarded unmodified is unknown: ${message(e)}`,
    )
  }

  let parsed: ReturnType<typeof parseSignedText>
  try {
    parsed = parseSignedText(proof.text)
  } catch (e) {
    return unusable(`The provider returned a signed text this SDK does not understand: ${message(e)}`)
  }

  const signatureVerified =
    parsed.kind === 'routing'
      ? verifyRoutingProofLocally(
          parsed.reqHash,
          parsed.respHash,
          parsed.routing,
          proof.signature,
          o.service.teeSignerAddress,
        )
      : verifyProofLocally(parsed.reqHash, parsed.respHash, proof.signature, o.service.teeSignerAddress)

  const evidence: PassthroughEvidence = {
    chatId: run.chatId,
    kind: parsed.kind,
    signedText: proof.text,
    sentRequestHash: run.reqHash.toLowerCase(),
    receivedResponseHash: run.respHash.toLowerCase(),
    signedRequestHash: parsed.reqHash,
    signedResponseHash: parsed.respHash,
    requestMatches: parsed.reqHash === run.reqHash.toLowerCase(),
    responseMatches: parsed.respHash === run.respHash.toLowerCase(),
    signatureVerified,
  }

  // Verified first, and separately. Matching hashes signed by an unknown key prove nothing
  // about whose enclave did the hashing, so this can never be folded into the comparison below.
  if (!signatureVerified) {
    return unusable(
      `The proof does not recover to ${o.service.teeSignerAddress}, the TEE signer the registry publishes for this provider, so nothing it says can be used.`,
      evidence,
    )
  }

  if (evidence.requestMatches && evidence.responseMatches) {
    return {
      ...base,
      status: 'passthrough',
      evidence,
      detail:
        'The enclave signed the exact bytes that were sent and the exact bytes that came back. The broker forwarded this body unmodified, so a contract that rebuilds it computes the same hash the enclave signed, and on-chain request binding works against this provider.',
    }
  }

  if (evidence.responseMatches) {
    return {
      ...base,
      status: 'response-only',
      evidence,
      detail:
        'The response half matches byte for byte; the request half does not. The broker rewrote the body before forwarding it and signed what it forwarded, so no contract can reproduce that hash — a gate pinned to this provider can never settle. The answer is still bound to whatever question the enclave saw; the chain just cannot be shown which question that was.',
    }
  }

  return unusable(
    'Neither half of the signed text is over the bytes on this wire. The proof is genuine and belongs to something else, so it binds nothing here.',
    evidence,
  )
}

/** `sha256` of a body, `0x`-prefixed — the hash a contract would compute for the same bytes. */
export function requestHash(bodyBytes: Uint8Array): string {
  return '0x' + sha256Hex(bodyBytes)
}
