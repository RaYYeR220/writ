import type { ethers } from 'ethers'
import { sha256Hex, signedText, signedTextRouting, type RoutingFields } from './hashes.js'

/**
 * Everything a stranger needs to re-derive the on-chain proof from public data alone.
 *
 * `request` and `response` are the exact wire bodies. Re-hashing them with sha256 must
 * reproduce `reqHash` and `respHash`, rebuilding `signedText` from those hashes (plus
 * `routing`, for a centralized provider) must reproduce the text the TEE signed, and
 * recovering `signature` over it must reproduce the provider's registered TEE signer.
 */
export type Transcript = {
  chatId: string
  provider: string
  model: string
  request: string
  response: string
  reqHash: string
  respHash: string
  /** The exact text the TEE signed — the artifact everything else is checked against. */
  signedText: string
  signature: string
  signingAddress: string
  capturedAt: string
  /** Upstream attribution, present only for a centralized provider's routing proof. */
  routing?: RoutingFields
}

export type ArchiveResult = {
  /** 0G Storage merkle root — this is what goes on chain as `transcriptRoot`. */
  rootHash: string
  /** The storage transaction, or `''` when the exact bytes were already stored. */
  txHash: string
  txSeq: number
  /** True when 0G Storage already held these bytes and charged nothing to say so. */
  alreadyStored: boolean
}

/** Minimal shape of `Indexer`, so the upload rules can be tested without a chain. */
export type IndexerLike = {
  upload(
    file: unknown,
    blockchainRpc: string,
    signer: unknown,
    uploadOpts?: unknown,
  ): Promise<[unknown, Error | null]>
}

export type ArchiveOptions = {
  /** Inject an indexer; otherwise one is built for `indexerRpc`. */
  indexer?: IndexerLike
  /** 0G Storage indexer. Turbo only — both `standard` indexers are dead. */
  indexerRpc?: string
  /** Chain the storage submission transaction is sent to. */
  chainRpc?: string
  /** Give up after this long. `Uploader.waitForLogEntry` retries forever otherwise. */
  timeoutMs?: number
}

/** Mainnet turbo indexer (chain 16661). */
export const INDEXER_RPC_MAINNET = 'https://indexer-storage-turbo.0g.ai'
/** Galileo testnet turbo indexer (chain 16602). */
export const INDEXER_RPC_GALILEO = 'https://indexer-storage-testnet-turbo.0g.ai'
export const CHAIN_RPC_MAINNET = 'https://evmrpc.0g.ai'

const BYTES32 = /^0x[0-9a-f]{64}$/

/**
 * The canonical bytes of an archived transcript.
 *
 * Stable key order and stable indentation, because the merkle root is content-addressed:
 * re-archiving the same run must land on the same root so 0G Storage can dedupe it.
 */
export function serializeTranscript(t: Transcript): Uint8Array {
  const ordered = {
    chatId: t.chatId,
    provider: t.provider,
    model: t.model,
    request: t.request,
    response: t.response,
    reqHash: t.reqHash,
    respHash: t.respHash,
    signedText: t.signedText,
    signature: t.signature,
    signingAddress: t.signingAddress,
    // Omitted entirely on the chat path, so those roots stay what they always were.
    ...(t.routing ? { routing: t.routing } : {}),
    capturedAt: t.capturedAt,
  }
  return new TextEncoder().encode(JSON.stringify(ordered, null, 2))
}

/** An archive nobody can re-derive the proof from is worse than no archive. */
function assertSelfConsistent(t: Transcript): void {
  const enc = new TextEncoder()
  const req = '0x' + sha256Hex(enc.encode(t.request))
  const resp = '0x' + sha256Hex(enc.encode(t.response))
  if (req !== t.reqHash.toLowerCase()) {
    throw new Error(`transcript reqHash ${t.reqHash} does not match its own request text (${req})`)
  }
  if (resp !== t.respHash.toLowerCase()) {
    throw new Error(`transcript respHash ${t.respHash} does not match its own response text (${resp})`)
  }
  const rebuilt = t.routing ? signedTextRouting(req, resp, t.routing) : signedText(req, resp)
  if (rebuilt !== t.signedText) {
    throw new Error(
      `transcript signedText ${JSON.stringify(t.signedText)} is not what its own fields rebuild to (${JSON.stringify(rebuilt)})`,
    )
  }
}

function narrowUpload(tx: unknown): { rootHash: string; txHash: string; txSeq: number } {
  const t = (tx ?? {}) as Record<string, unknown>
  if (typeof t['rootHash'] === 'string') {
    return {
      rootHash: t['rootHash'],
      txHash: typeof t['txHash'] === 'string' ? t['txHash'] : '',
      txSeq: typeof t['txSeq'] === 'number' ? t['txSeq'] : -1,
    }
  }
  const roots = t['rootHashes']
  if (Array.isArray(roots) && typeof roots[0] === 'string') {
    const hashes = t['txHashes']
    const seqs = t['txSeqs']
    return {
      rootHash: roots[0],
      txHash: Array.isArray(hashes) && typeof hashes[0] === 'string' ? hashes[0] : '',
      txSeq: Array.isArray(seqs) && typeof seqs[0] === 'number' ? seqs[0] : -1,
    }
  }
  throw new Error(`0G Storage upload returned no root hash: ${JSON.stringify(tx)}`)
}

/**
 * Uploads the transcript to 0G Storage and returns the merkle root plus how it got there.
 *
 * The root is what lets a third party re-derive both sha256 values years later and confirm the
 * on-chain proof without trusting anyone. It is computed locally first and compared with what
 * the indexer reports, so a wrong root is an error rather than something that quietly ends up
 * notarized.
 */
export async function uploadTranscript(
  transcript: Transcript,
  signer: ethers.Signer,
  opts: ArchiveOptions = {},
): Promise<ArchiveResult> {
  assertSelfConsistent(transcript)

  const bytes = serializeTranscript(transcript)
  if (bytes.length === 0) throw new Error('refusing to archive an empty transcript')

  const { MemData, Indexer } = await import('@0gfoundation/0g-storage-ts-sdk')

  const data = new MemData(bytes)
  const [tree, treeErr] = await data.merkleTree()
  if (treeErr) throw new Error(`merkle tree generation failed: ${treeErr}`)
  const localRoot = tree?.rootHash()
  if (!localRoot || !BYTES32.test(localRoot)) {
    throw new Error(`merkle tree produced no usable root hash: ${String(localRoot)}`)
  }

  const chainRpc = opts.chainRpc ?? CHAIN_RPC_MAINNET
  const indexer: IndexerLike = opts.indexer ?? (new Indexer(opts.indexerRpc ?? INDEXER_RPC_MAINNET) as IndexerLike)

  const upload = indexer.upload(data, chainRpc, signer, { finalityRequired: true })
  const [tx, uploadErr] = await withTimeout(upload, opts.timeoutMs ?? 300_000, '0G Storage upload')
  if (uploadErr) throw new Error(`0G Storage upload failed: ${uploadErr}`)

  const { rootHash, txHash, txSeq } = narrowUpload(tx)
  if (rootHash.toLowerCase() !== localRoot.toLowerCase()) {
    throw new Error(`0G Storage root ${rootHash} does not match the locally derived root ${localRoot}`)
  }

  // `skipIfFinalized` defaults to true: identical bytes short-circuit with err === null and an
  // empty txHash. Nothing was paid and nothing is missing — the transcript is stored.
  return { rootHash, txHash, txSeq, alreadyStored: txHash === '' }
}

/** `uploadTranscript`, reduced to the one value the registry needs. */
export async function archiveTranscript(
  transcript: Transcript,
  signer: ethers.Signer,
  opts: ArchiveOptions = {},
): Promise<string> {
  return (await uploadTranscript(transcript, signer, opts)).rootHash
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
