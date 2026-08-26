import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { keccak256, toUtf8Bytes } from 'ethers'
import * as z from 'zod/v4'
import type { WritDeps } from '../deps.js'
import { fail, runTool } from '../errors.js'
import { verifyArchivedTranscript } from '../rehydrate.js'
import { parseVerdict } from '../verdict.js'
import { addressField, bytes32Field } from './shared.js'

const MAX_TEXT = 8000

const inputSchema = {
  writId: bytes32Field('The writ id to look up.'),
  registry: addressField('WritRegistry to read. Defaults to the server’s configured registry.').optional(),
}

const outputSchema = {
  writId: z.string(),
  registry: z.string(),
  chainId: z.string(),
  verified: z
    .literal(true)
    .describe('Only ever present on success: every check below passed. A failed re-verification is a tool error.'),
  checks: z
    .object({
      onChainRecordExists: z.boolean(),
      writIdMatchesItsContents: z.boolean(),
      transcriptRetrievedFrom0gStorage: z.boolean(),
      transcriptMerkleRootMatches: z.boolean(),
      requestRehashesToOnChainHash: z.boolean(),
      responseRehashesToOnChainHash: z.boolean(),
      signedTextRebuildsFromThoseHashes: z.boolean(),
      signatureRecoversToRegisteredTeeSigner: z.boolean(),
    })
    .describe('Each step of the independent re-derivation from public data.'),
  provider: z.string(),
  recordedModelHash: z.string().describe('The model hash WritRegistry recorded at notarization time.'),
  currentModel: z.string().describe("The model 0G's InferenceServing lists for this provider now."),
  modelHashMatchesCurrentRegistration: z
    .boolean()
    .describe('False simply means the provider re-registered since; the writ still records what was served then.'),
  teeSigner: z.string(),
  verifiability: z.string(),
  teeSignerAcknowledged: z.boolean(),
  reqHash: z.string(),
  respHash: z.string(),
  transcriptRoot: z.string(),
  notarizedAt: z.string().describe('ISO-8601 timestamp of the notarizing block.'),
  notarizedAtUnix: z.string(),
  notarizedBy: z.string(),
  kind: z.enum(['chat', 'routing']),
  routing: z
    .object({ providerType: z.string(), providerIdentity: z.string(), tlsFingerprint: z.string() })
    .nullable(),
  chatId: z.string(),
  capturedAt: z.string(),
  question: z.string().describe('The exact request bytes, as archived.'),
  answer: z.string().describe('The exact response bytes, as archived.'),
  verdict: z.enum(['ALLOW', 'DENY', 'UNPARSEABLE']),
  risk: z.number().int().min(0).max(100).nullable(),
  notes: z.array(z.string()),
}

function clip(text: string): { text: string; clipped: boolean } {
  return text.length <= MAX_TEXT
    ? { text, clipped: false }
    : { text: `${text.slice(0, MAX_TEXT)}…[truncated, ${text.length} bytes total]`, clipped: true }
}

/**
 * The on-chain record, plus a full re-derivation of it from public data.
 *
 * The chain already verified this proof when it was notarized. This tool does not take that on
 * trust either: it pulls the archived transcript out of 0G Storage, re-hashes the request and
 * the response, rebuilds the text the TEE signed from those hashes alone, and recovers the
 * signature to see whose key produced it — comparing the result against the TEE address 0G's
 * `InferenceServing` registry lists for that provider today.
 *
 * A success from this tool therefore means every one of those steps passed. If any of them
 * fails, or the transcript cannot be retrieved at all, this returns an MCP tool error carrying
 * the on-chain record and the exact step that failed. It never reports a writ as verified on
 * the strength of it merely being recorded.
 */
export function registerLookup(server: McpServer, deps: WritDeps): void {
  server.registerTool(
    'writ_lookup',
    {
      title: 'Read a writ and re-verify it independently',
      description:
        "Returns WritRegistry's record for a writ id and independently re-derives the proof " +
        'from public data: the transcript is fetched from 0G Storage, re-hashed, and its TEE ' +
        "signature recovered against the provider's registered signer. Read-only. Succeeds " +
        'only if every check passes; a proof that is missing or does not verify is an error.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ writId, registry }) =>
      runTool('writ_lookup', async () => {
        const notes: string[] = []
        const registryAddress = registry ?? deps.configuredRegistry()
        const reg = deps.registry(registryAddress)

        const [chainId, w] = await Promise.all([deps.chainId(), reg.getWrit(writId)])

        const isRouting = await reg.isRoutingProof(writId)
        const routing = isRouting ? await reg.getRoutingProof(writId) : null

        // The id is content-addressed, so recomputing it from the record proves the record is
        // filed under a key that actually describes it.
        const recomputedId = isRouting
          ? await reg.routingWritId(
              w.provider,
              w.reqHash,
              w.respHash,
              routing!.providerType,
              routing!.providerIdentity,
              routing!.tlsFingerprint,
            )
          : await reg.writId(w.provider, w.reqHash, w.respHash)

        if (recomputedId.toLowerCase() !== writId.toLowerCase()) {
          fail(
            `writ ${writId} is recorded under a key that does not describe its own contents (recomputes to ${recomputedId})`,
          )
        }

        const svc = await deps.getService(w.provider)
        if (svc.verifiability !== 'TeeML') {
          notes.push(
            `provider ${w.provider} now advertises verifiability "${svc.verifiability}"; it was TeeML when this writ was notarized`,
          )
        }
        if (!svc.teeSignerAcknowledged) {
          notes.push(`provider ${w.provider} has since un-acknowledged its TEE signer`)
        }

        if (/^0x0{64}$/i.test(w.transcriptRoot)) {
          fail(`writ ${writId} carries an empty transcript root, so nothing can be re-derived from it`)
        }

        // Throws on a download failure or a merkle root that does not match what was asked for.
        const bytes = await deps.downloadTranscript(w.transcriptRoot)

        const verified = verifyArchivedTranscript(bytes, svc.teeSignerAddress, {
          reqHash: w.reqHash,
          respHash: w.respHash,
        })

        if (isRouting !== (verified.kind === 'routing')) {
          fail(
            `the registry recorded this as a ${isRouting ? 'routing' : 'chat'} proof but the archived transcript is a ${verified.kind} proof`,
          )
        }
        if (routing && verified.routing) {
          const same =
            routing.providerType === verified.routing.providerType &&
            routing.providerIdentity === verified.routing.providerIdentity &&
            routing.tlsFingerprint.toLowerCase() === verified.routing.tlsFingerprint.toLowerCase()
          if (!same) {
            fail('the routing attribution on chain does not match the routing attribution the TEE signed')
          }
        }

        const currentModelHash = keccak256(toUtf8Bytes(svc.model))
        const modelMatches = currentModelHash.toLowerCase() === w.modelHash.toLowerCase()
        if (!modelMatches) {
          notes.push(
            `the recorded model hash ${w.modelHash} is not keccak256 of the model this provider serves today ("${svc.model}"); the provider re-registered after this writ was notarized`,
          )
        }

        const parsed = parseVerdict(verified.rawResponse)
        const question = clip(new TextDecoder().decode(verified.rawRequest))
        const answer = clip(new TextDecoder().decode(verified.rawResponse))
        if (question.clipped || answer.clipped) notes.push('question or answer was truncated for display')

        return {
          writId,
          registry: reg.address,
          chainId: chainId.toString(),
          verified: true as const,
          checks: {
            onChainRecordExists: true,
            writIdMatchesItsContents: true,
            transcriptRetrievedFrom0gStorage: true,
            transcriptMerkleRootMatches: true,
            requestRehashesToOnChainHash: true,
            responseRehashesToOnChainHash: true,
            signedTextRebuildsFromThoseHashes: true,
            signatureRecoversToRegisteredTeeSigner: true,
          },
          provider: w.provider,
          recordedModelHash: w.modelHash,
          currentModel: svc.model,
          modelHashMatchesCurrentRegistration: modelMatches,
          teeSigner: svc.teeSignerAddress,
          verifiability: svc.verifiability,
          teeSignerAcknowledged: svc.teeSignerAcknowledged,
          reqHash: w.reqHash,
          respHash: w.respHash,
          transcriptRoot: w.transcriptRoot,
          notarizedAt: new Date(Number(w.notarizedAt) * 1000).toISOString(),
          notarizedAtUnix: w.notarizedAt.toString(),
          notarizedBy: w.notarizedBy,
          kind: verified.kind,
          routing: verified.routing ?? null,
          chatId: verified.chatId,
          capturedAt: verified.capturedAt,
          question: question.text,
          answer: answer.text,
          verdict: parsed.ok ? (parsed.allowed ? ('ALLOW' as const) : ('DENY' as const)) : ('UNPARSEABLE' as const),
          risk: parsed.ok ? parsed.risk : null,
          notes,
        }
      }),
  )
}
