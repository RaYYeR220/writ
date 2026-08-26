import type { ethers } from 'ethers'
import { signedText, verifyProofLocally } from './hashes.js'
import type { AttestedRun, InferenceBrokerLike } from './inference.js'
import type { ArchiveOptions, Transcript } from './archive.js'
import type { NotarizeResult } from './notarize.js'
import type { TeeProof } from './proof.js'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * The four steps `attest` orchestrates, injectable so the ordering rules can be tested without
 * a chain, a funded ledger, or a provider.
 */
export type AttestDeps = {
  runAttested: (o: {
    broker: InferenceBrokerLike
    provider: string
    endpoint: string
    bodyBytes: Uint8Array
  }) => Promise<AttestedRun>
  fetchProof: (endpoint: string, chatId: string, model: string) => Promise<TeeProof>
  archiveTranscript: (t: Transcript, signer: ethers.Signer, opts?: ArchiveOptions) => Promise<string>
  notarize: (
    run: AttestedRun,
    provider: string,
    signature: string,
    root: string,
  ) => Promise<Pick<NotarizeResult, 'writId' | 'txHash'> & Partial<NotarizeResult>>
}

export type AttestOpts = AttestDeps & {
  broker: InferenceBrokerLike
  provider: string
  /** `broker.inference.getServiceMetadata(provider).endpoint`. */
  endpoint: string
  model: string
  /** The exact request body, straight from the gate. Never rebuild it client-side. */
  bodyBytes: Uint8Array
  /**
   * The provider's TEE signer, read from 0G's on-chain `InferenceServing` registry. The
   * provider's own claim about who signed is not acceptable here.
   */
  expectedSigner: string
  /** Signer that pays for the 0G Storage upload. */
  signer?: ethers.Signer
  archiveOptions?: ArchiveOptions
}

export type AttestResult = {
  writId: string
  /** The notarizing transaction, or `''` if the writ was already on chain. */
  txHash: string
  transcriptRoot: string
  run: AttestedRun
  proof: TeeProof
  signature: string
  transcript: Transcript
}

/**
 * Inference, proof, verification, archive, notarize — in the only order that is safe.
 *
 * The proof is claimed before anything slow happens, because provider signature endpoints
 * expire chat ids and a missed proof is unrecoverable. Verification happens before the archive
 * and before any transaction, so a run that cannot be proved costs nothing and produces
 * nothing: there is no path through this function that returns a result without a signature
 * that recovers to the provider's registered TEE signer.
 *
 * This function stops at the notarization. Executing the decision is a separate transaction on
 * purpose — see `notarize`.
 */
export async function attest(o: AttestOpts): Promise<AttestResult> {
  if (!o.expectedSigner || o.expectedSigner.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      `expectedSigner must be the provider's registered TEE address from InferenceServing, got ${String(o.expectedSigner)}`,
    )
  }

  const run = await o.runAttested({
    broker: o.broker,
    provider: o.provider,
    endpoint: o.endpoint,
    bodyBytes: o.bodyBytes,
  })

  // Claim the proof first: it expires.
  const proof = await o.fetchProof(o.endpoint, run.chatId, o.model)

  const expectedText = signedText(run.reqHash, run.respHash)
  if (proof.text !== expectedText) {
    throw new Error(
      `provider signed text ${JSON.stringify(proof.text)} but this run is ${JSON.stringify(expectedText)} (chat ${run.chatId})`,
    )
  }

  if (!verifyProofLocally(run.reqHash, run.respHash, proof.signature, o.expectedSigner)) {
    throw new Error(
      `proof does not verify against the registered TEE signer ${o.expectedSigner} (chat ${run.chatId})`,
    )
  }

  const transcript: Transcript = {
    chatId: run.chatId,
    provider: o.provider,
    model: o.model,
    request: new TextDecoder().decode(run.rawRequest),
    response: new TextDecoder().decode(run.rawResponse),
    reqHash: run.reqHash,
    respHash: run.respHash,
    signature: proof.signature,
    // The verified signer, not whatever the provider volunteered about itself.
    signingAddress: o.expectedSigner,
    capturedAt: new Date().toISOString(),
  }

  const transcriptRoot = await o.archiveTranscript(transcript, o.signer as ethers.Signer, o.archiveOptions)
  const { writId, txHash } = await o.notarize(run, o.provider, proof.signature, transcriptRoot)

  return { writId, txHash, transcriptRoot, run, proof, signature: proof.signature, transcript }
}
