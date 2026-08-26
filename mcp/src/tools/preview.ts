import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod/v4'
import { sha256Hex } from '@writ/sdk'
import type { WritDeps } from '../deps.js'
import { runTool } from '../errors.js'
import { addressField, amountField, amountOut, parseAmount, utf8 } from './shared.js'

const inputSchema = {
  gate: addressField('Address of the deployed Writ gate (TreasuryGate / PolicyGate) to ask.'),
  to: addressField('Recipient the transfer would go to.'),
  amount: amountField,
}

const outputSchema = {
  chainId: z.string().describe('Chain the gate was read on.'),
  gate: z.string(),
  to: z.string(),
  amount: z.string().describe('Amount in whole 0G.'),
  amountWei: z.string().describe('The exact wei value the question pins.'),
  nonce: z.string().describe("The gate's current nonce, which is part of the question."),
  question: z.string().describe('The exact UTF-8 request body the contract will pin, verbatim.'),
  questionHex: z.string().describe('The same bytes as hex, for byte-exact comparison.'),
  questionBytes: z.number().int().describe('Length of the request body in bytes.'),
  requestHash: z
    .string()
    .describe('sha256 of those exact bytes — half of what the provider TEE will sign.'),
  allowedProvider: z
    .string()
    .describe('The only provider this gate accepts, or the zero address for any acknowledged TeeML provider.'),
  allowedModelHash: z.string().describe('keccak256 of the model name the gate requires.'),
  maxRisk: z.number().int().describe('Risk ceiling: an ALLOW above this is still refused.'),
}

/**
 * Shows the agent the question before it is asked.
 *
 * The point of Writ is that the contract writes the question, so an agent cannot swap in a
 * friendlier one. This tool exists so that constraint is inspectable rather than merely true:
 * the bytes returned here are the bytes `writ_attest` posts to the provider and the bytes the
 * gate re-derives when it settles. Read-only — it sends no transaction and spends nothing.
 */
export function registerPreviewQuestion(server: McpServer, deps: WritDeps): void {
  server.registerTool(
    'writ_preview_question',
    {
      title: 'Preview the question a Writ gate will pin',
      description:
        'Returns the exact request bytes a Writ gate will pin for this recipient and amount, ' +
        'plus their sha256 and the policy that constrains the answer. Read-only: no inference, ' +
        'no transaction, no spend. Use it to see what the contract is about to ask before ' +
        'calling writ_attest.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ gate, to, amount }) =>
      runTool('writ_preview_question', async () => {
        const amountWei = parseAmount(amount)
        const g = deps.gate(gate)

        const [chainId, nonce, policy, body] = await Promise.all([
          deps.chainId(),
          g.nonce(),
          g.policy(),
          g.previewRequestBody(to, amountWei),
        ])

        return {
          chainId: chainId.toString(),
          gate: g.address,
          to,
          ...amountOut(amountWei),
          nonce: nonce.toString(),
          question: utf8(body),
          questionHex: '0x' + Buffer.from(body).toString('hex'),
          questionBytes: body.length,
          requestHash: '0x' + sha256Hex(body),
          allowedProvider: policy.allowedProvider,
          allowedModelHash: policy.allowedModelHash,
          maxRisk: policy.maxRisk,
        }
      }),
  )
}
