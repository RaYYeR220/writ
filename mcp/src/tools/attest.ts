import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ethers } from 'ethers'
import { keccak256, toUtf8Bytes } from 'ethers'
import * as z from 'zod/v4'
import { attest as runAttestPipeline, notarizeProof, type NotarizeResult } from '@writ/sdk'
import type { WritDeps } from '../deps.js'
import { fail, runTool } from '../errors.js'
import { expectedOutcome, parseVerdict } from '../verdict.js'
import { addressField, amountField, amountOut, assertAttestable, explorerTx, parseAmount, resolveProvider } from './shared.js'

const inputSchema = {
  gate: addressField('Address of the deployed Writ gate whose question should be answered.'),
  to: addressField('Recipient the transfer would go to.'),
  amount: amountField,
}

const routingSchema = z
  .object({
    providerType: z.string(),
    providerIdentity: z.string(),
    tlsFingerprint: z.string(),
  })
  .nullable()
  .describe('Upstream attribution bound into a centralized provider’s signature; null for a chat proof.')

const outputSchema = {
  writId: z.string().describe('Permanent id of this proof in WritRegistry.'),
  txHash: z.string().describe('Notarizing transaction hash, or "" when the writ was already on chain.'),
  alreadyNotarized: z.boolean().describe('True when this exact proof was already a matter of public record.'),
  transcriptRoot: z.string().describe('0G Storage merkle root of the archived transcript.'),
  verdict: z.enum(['ALLOW', 'DENY', 'UNPARSEABLE']).describe('What the model actually answered.'),
  risk: z.number().int().min(0).max(100).nullable().describe('The 0-100 risk the model reported; null if unparseable.'),
  kind: z.enum(['chat', 'routing']).describe('Which signed-text format the provider TEE used.'),
  provider: z.string(),
  model: z.string(),
  teeSigner: z.string().describe("The TEE address the signature recovered to, per 0G's InferenceServing registry."),
  chatId: z.string(),
  requestHash: z.string(),
  responseHash: z.string(),
  answer: z.string().describe("The model's verdict token, or the raw response when it does not parse."),
  maxRisk: z.number().int().describe("The gate's risk ceiling."),
  expectedOutcome: z
    .enum(['approve', 'refuse-model', 'refuse-policy', 'revert-malformed'])
    .describe('What writ_execute will do with this writ, derived from the answer and the ceiling.'),
  routing: routingSchema,
  gate: z.string(),
  to: z.string(),
  amount: z.string(),
  amountWei: z.string(),
  explorerTx: z.string(),
}

/**
 * Produces an attested decision, end to end.
 *
 * Inference on 0G Compute against the gate's configured provider, the TEE proof claimed
 * immediately (provider signature endpoints expire chat ids and a missed proof is
 * unrecoverable), the signature verified against the provider's registered TEE address before
 * anything is paid for, the transcript archived to 0G Storage, and the proof notarized in
 * `WritRegistry` — which re-verifies it on chain against 0G's own `InferenceServing`.
 *
 * There is no path through this tool that returns a writ without a signature that recovers to
 * the registered signer. Every failure below is an MCP tool error: no default verdict, no
 * assumed risk, no partial success.
 *
 * Settling is deliberately a separate call. See `writ_execute`.
 */
export function registerAttest(server: McpServer, deps: WritDeps): void {
  server.registerTool(
    'writ_attest',
    {
      title: 'Produce a TEE-attested verdict and notarize it on 0G',
      description:
        "Asks the gate's configured 0G Compute provider the gate's own question, captures the " +
        'TEE signature over the exact request and response bytes, verifies it against the ' +
        "provider's registered TEE signer, archives the transcript to 0G Storage and notarizes " +
        'the proof on chain. Returns the writ id and the verdict. Spends gas and compute ' +
        'credit. Fails loudly rather than returning an unverified answer.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ gate, to, amount }) =>
      runTool('writ_attest', async () => {
        const amountWei = parseAmount(amount)
        const g = deps.gate(gate)

        const policy = await g.policy()
        const provider = resolveProvider(policy, deps)

        // 0G's registry, not the provider's own claim, decides who is allowed to sign.
        const svc = await deps.getService(provider)
        assertAttestable(svc)

        // The gate pins a model hash. A proof from a different model is a valid proof of
        // something the gate will never accept, so refuse before spending rather than after.
        const modelHash = keccak256(toUtf8Bytes(svc.model))
        if (modelHash.toLowerCase() !== policy.allowedModelHash.toLowerCase()) {
          fail(
            `gate ${g.address} requires model hash ${policy.allowedModelHash}, but provider ${provider} currently serves "${svc.model}" (${modelHash}); nothing this provider signs can settle at this gate`,
          )
        }

        const session = await deps.computeSession(provider)
        const bodyBytes = await g.previewRequestBody(to, amountWei)
        const registry = deps.registry(await g.registryAddress())
        const storageSigner = await deps.pipeline.storageSigner()

        let notarized: NotarizeResult | undefined
        const result = await runAttestPipeline({
          broker: session.broker,
          provider,
          endpoint: session.endpoint,
          model: session.model,
          bodyBytes,
          expectedSigner: svc.teeSignerAddress,
          signer: storageSigner as ethers.Signer,
          runAttested: deps.pipeline.runAttested,
          fetchProof: deps.pipeline.fetchProof,
          archiveTranscript: (t, s, o) => deps.pipeline.archiveTranscript(t, s, o),
          notarize: async (run, p, proof, root) => {
            notarized = await notarizeProof(registry, run, p, proof, root)
            return notarized
          },
        })

        if (!notarized) fail('notarization produced no result; refusing to report a writ that may not exist')

        const parsed = parseVerdict(result.run.rawResponse)
        const answer = parsed.ok ? parsed.content : new TextDecoder().decode(result.run.rawResponse).slice(0, 400)

        deps.store.put({
          writId: result.writId,
          gate: g.address,
          to,
          amountWei,
          provider,
          reqHash: result.run.reqHash,
          respHash: result.run.respHash,
          rawResponse: result.run.rawResponse,
          signature: result.signature,
          transcriptRoot: result.transcriptRoot,
          kind: result.kind,
          ...(result.routing ? { routing: result.routing } : {}),
          attestedAt: new Date().toISOString(),
        })

        return {
          writId: result.writId,
          txHash: result.txHash,
          alreadyNotarized: notarized.alreadyNotarized,
          transcriptRoot: result.transcriptRoot,
          verdict: parsed.ok ? (parsed.allowed ? ('ALLOW' as const) : ('DENY' as const)) : ('UNPARSEABLE' as const),
          risk: parsed.ok ? parsed.risk : null,
          kind: result.kind,
          provider,
          model: session.model,
          teeSigner: svc.teeSignerAddress,
          chatId: result.run.chatId,
          requestHash: result.run.reqHash,
          responseHash: result.run.respHash,
          answer,
          maxRisk: policy.maxRisk,
          expectedOutcome: expectedOutcome(parsed, policy.maxRisk),
          routing: result.routing ?? null,
          gate: g.address,
          to,
          ...amountOut(amountWei),
          explorerTx: explorerTx(deps, result.txHash),
        }
      }),
  )
}
