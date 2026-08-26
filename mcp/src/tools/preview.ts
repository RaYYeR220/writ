import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod/v4'
import { sha256Hex } from '@writ/sdk'
import type { TreasuryState, WritDeps } from '../deps.js'
import { runTool } from '../errors.js'
import { factNotes, parseQuestionFacts, reportFacts } from '../question.js'
import { addressField, amountField, amountOut, parseAmount, utf8 } from './shared.js'

const inputSchema = {
  gate: addressField('Address of the deployed Writ gate (TreasuryGate / PolicyGate) to ask.'),
  to: addressField('Recipient the transfer would go to.'),
  amount: amountField,
}

const factsSchema = z
  .object({
    recipient: z.string(),
    amount: z.string().describe('Wei, exactly as the question renders it.'),
    amountOg: z.string(),
    nonce: z.string(),
    treasuryBalance: z.string().describe('Wei held by the gate before this transfer.'),
    treasuryBalanceOg: z.string(),
    amountPctOfBalance: z
      .number()
      .int()
      .describe('Floored percentage of the pre-transfer balance, capped at 999. Over 100 means the treasury cannot cover it.'),
    priorApprovals: z.string(),
    priorRefusals: z.string(),
    recipientPriorPayments: z.string().describe('Approvals to this recipient. Refusals are not counted.'),
    recipientPriorTotal: z.string(),
    recipientPriorTotalOg: z.string(),
    treasuryCoversAmount: z.boolean(),
    recipientIsNew: z.boolean(),
  })
  .nullable()
  .describe('The nine facts the gate pins, parsed from the exact bytes. Null for a gate that pins a different question.')

const treasurySchema = z
  .object({
    balance: z.string(),
    balanceOg: z.string(),
    nonce: z.string(),
    approvedCount: z.string(),
    refusedCount: z.string(),
    recipientPayments: z.string(),
    recipientTotal: z.string(),
    recipientTotalOg: z.string(),
  })
  .nullable()
  .describe("The same state read from the gate's own getters. Null for a gate that does not expose them.")

const outputSchema = {
  chainId: z.string().describe('Chain the gate was read on.'),
  gate: z.string(),
  to: z.string(),
  amount: z.string().describe('Amount in whole 0G.'),
  amountWei: z.string().describe('The exact wei value the question pins.'),
  nonce: z.string().describe("The gate's current nonce, which is one of the facts in the question."),
  question: z.string().describe('The exact UTF-8 request body the contract will pin, verbatim.'),
  questionHex: z.string().describe('The same bytes as hex, for byte-exact comparison.'),
  questionBytes: z.number().int().describe('Length of the request body in bytes.'),
  requestHash: z
    .string()
    .describe('sha256 of those exact bytes — half of what the provider TEE will sign.'),
  facts: factsSchema,
  treasury: treasurySchema,
  allowedProvider: z
    .string()
    .describe('The only provider this gate accepts, or the zero address for any acknowledged TeeML provider.'),
  allowedModelHash: z.string().describe('keccak256 of the model name the gate requires.'),
  maxRisk: z.number().int().describe('Risk ceiling: an ALLOW above this is still refused.'),
  notes: z.array(z.string()).describe('Readings of these facts that the raw numbers do not carry.'),
}

const STATE_BOUND_NOTE =
  'every fact here is live treasury state, so this question — and any proof answering it — stops being valid the moment the balance, the decision counts or this recipient’s payment history change'

/**
 * Shows the agent the question before it is asked.
 *
 * The point of Writ is that the contract writes the question, so an agent cannot swap in a
 * friendlier one. This tool exists so that constraint is inspectable rather than merely true:
 * the bytes returned here are the bytes `writ_attest` posts to the provider and the bytes the
 * gate re-derives when it settles. Read-only — it sends no transaction and spends nothing.
 *
 * The facts are parsed out and reported field by field, because the question now carries the
 * treasury's live state as well as the proposed transfer, and an agent about to be judged on
 * nine numbers is entitled to read them without picking a string apart.
 */
export function registerPreviewQuestion(server: McpServer, deps: WritDeps): void {
  server.registerTool(
    'writ_preview_question',
    {
      title: 'Preview the question a Writ gate will pin',
      description:
        'Returns the exact request bytes a Writ gate will pin for this recipient and amount, ' +
        'their sha256, the nine facts they carry, and the policy that constrains the answer. ' +
        'Read-only: no inference, no transaction, no spend. The question embeds the treasury’s ' +
        'live state — balance, decision counts, what this recipient has already been paid — so ' +
        'it changes whenever that state changes. Use it to see what the contract is about to ask ' +
        'before calling writ_attest.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ gate, to, amount }) =>
      runTool('writ_preview_question', async () => {
        const amountWei = parseAmount(amount)
        const g = deps.gate(gate)

        const [chainId, nonce, policy, body, state] = await Promise.all([
          deps.chainId(),
          g.nonce(),
          g.policy(),
          g.previewRequestBody(to, amountWei),
          // A gate that is not a TreasuryGate has no such getters; that is not an error here.
          g.treasuryState(to).then(
            (s): TreasuryState | null => s,
            () => null,
          ),
        ])

        const facts = parseQuestionFacts(body)
        const notes = facts ? [...factNotes(facts), STATE_BOUND_NOTE] : []
        if (!facts) {
          notes.push(
            'this gate does not pin the nine TreasuryGate facts, so only the raw question bytes are reported',
          )
        }

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
          facts: facts ? reportFacts(facts) : null,
          treasury: state
            ? {
                balance: state.balance.toString(),
                balanceOg: amountOut(state.balance).amount,
                nonce: state.nonce.toString(),
                approvedCount: state.approvedCount.toString(),
                refusedCount: state.refusedCount.toString(),
                recipientPayments: state.recipient.payments.toString(),
                recipientTotal: state.recipient.total.toString(),
                recipientTotalOg: amountOut(state.recipient.total).amount,
              }
            : null,
          allowedProvider: policy.allowedProvider,
          allowedModelHash: policy.allowedModelHash,
          maxRisk: policy.maxRisk,
          notes,
        }
      }),
  )
}
