import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAddress } from 'ethers'
import * as z from 'zod/v4'
import { refusalName, sha256Hex, type RoutingFields } from '@writ/sdk'
import type { DecodedEvent, GateHandle, SettleArgs, WritDeps } from '../deps.js'
import { fail, runTool } from '../errors.js'
import { verifyArchivedTranscript } from '../rehydrate.js'
import { addressField, amountOut, bytes32Field, explorerTx } from './shared.js'

const inputSchema = {
  gate: addressField('Address of the Writ gate that pinned the question.'),
  writId: bytes32Field('The writ id returned by writ_attest.'),
}

const outputSchema = {
  writId: z.string(),
  gate: z.string(),
  outcome: z.enum(['approved', 'refused']).describe('A refusal is a successful settlement, not an error.'),
  refusedBy: z
    .enum(['none', 'model', 'policy'])
    .describe('model = the model answered DENY. policy = it answered ALLOW above the gate’s risk ceiling.'),
  reason: z.string().describe('One line explaining the outcome.'),
  risk: z.number().int().min(0).max(100).describe('The risk score the attested answer carried.'),
  to: z.string(),
  amount: z.string(),
  amountWei: z.string(),
  provider: z.string(),
  kind: z.enum(['chat', 'routing']),
  txHash: z.string(),
  explorerTx: z.string(),
  eventWritId: z.string().describe('The writ the gate recorded the decision under.'),
  source: z
    .enum(['session', 'reconstructed'])
    .describe('Whether the settlement material came from this session or was rebuilt from 0G Storage.'),
}

type Material = SettleArgs & {
  writId: string
  kind: 'chat' | 'routing'
  routing?: RoutingFields
  reqHash: string
  respHash: string
  source: 'session' | 'reconstructed'
}

const PARAMS = /recipient=(0x[0-9a-fA-F]{40}) amount=(\d+) nonce=(\d+)/

/**
 * Recovers the recipient and amount from the question the TEE actually signed.
 *
 * These values are not on chain — only the hash of the question is — so they have to come out
 * of the archived request body. The parse is never trusted on its own: the caller re-asks the
 * gate to build the same question from them and compares the hash.
 */
function paramsFromRequest(rawRequest: Uint8Array): { to: string; amountWei: bigint } {
  const m = PARAMS.exec(new TextDecoder().decode(rawRequest))
  if (!m) {
    fail(
      'could not find the recipient and amount in the archived question; this writ does not answer a TreasuryGate transfer',
    )
  }
  return { to: getAddress(m[1]!), amountWei: BigInt(m[2]!) }
}

/**
 * Rebuilds a writ's settlement material from public data alone.
 *
 * Used when the server did not produce the writ itself — a restart, or another agent's writ.
 * Every step is a check: the archived bytes must hash to what the chain pinned, the signed text
 * must rebuild from those hashes, and the signature must recover to the provider's registered
 * TEE signer. If any of that fails there is no material, and no transaction is sent.
 */
async function reconstruct(deps: WritDeps, gate: GateHandle, writId: string): Promise<Material> {
  const registry = deps.registry(await gate.registryAddress())
  const w = await registry.getWrit(writId)

  const routing = (await registry.isRoutingProof(writId))
    ? await registry.getRoutingProof(writId)
    : undefined

  if (/^0x0{64}$/i.test(w.transcriptRoot)) {
    fail(
      `writ ${writId} was notarized with an empty transcript root, so there is no archived response to settle with`,
    )
  }

  const svc = await deps.getService(w.provider)
  const bytes = await deps.downloadTranscript(w.transcriptRoot)
  const verified = verifyArchivedTranscript(bytes, svc.teeSignerAddress, {
    reqHash: w.reqHash,
    respHash: w.respHash,
  })

  const { to, amountWei } = paramsFromRequest(verified.rawRequest)

  return {
    writId,
    to,
    amountWei,
    rawResponse: verified.rawResponse,
    provider: w.provider,
    signature: verified.signature,
    transcriptRoot: w.transcriptRoot,
    kind: verified.kind,
    ...(verified.routing ? { routing: verified.routing } : routing ? { routing } : {}),
    reqHash: verified.reqHash,
    respHash: verified.respHash,
    source: 'reconstructed',
  }
}

/**
 * Confirms the gate would ask exactly this question, right now.
 *
 * The gate rebuilds its question from the recipient, the amount and its own current nonce, so a
 * proof that answered an earlier nonce cannot settle. Checking here turns a wasted revert into
 * a readable explanation.
 */
async function assertQuestionStillPinned(gate: GateHandle, m: Material): Promise<void> {
  const body = await gate.previewRequestBody(m.to, m.amountWei)
  const rebuilt = '0x' + sha256Hex(body)
  if (rebuilt.toLowerCase() !== m.reqHash.toLowerCase()) {
    fail(
      `gate ${gate.address} would now ask a different question than this writ answers (it pins ${m.reqHash}, the gate builds ${rebuilt}); the nonce has moved on or this writ belongs to another gate`,
    )
  }
}

function decisionFrom(gate: GateHandle, logs: readonly unknown[]): DecodedEvent | null {
  for (const log of logs) {
    const ev = gate.parseLog(log)
    if (ev && (ev.name === 'TransferApproved' || ev.name === 'TransferRefused')) return ev
  }
  return null
}

/**
 * Settles an attested decision at the gate.
 *
 * A refusal is a successful outcome, not an error. The gate notarizes, emits `TransferRefused`,
 * spends the nonce and returns — the refusal is a permanent public record rather than something
 * a revert erases — so this tool returns it as a normal result and says who refused. Only a
 * failure to *verify* is an error, because that means no decision was shown at all.
 *
 * The outcome is read from the emitted event, never assumed from the fact the transaction
 * mined: `execute` returns a bool, and a return value is not readable from a mined transaction.
 * If no decision event is present, this reports an error rather than guessing.
 */
export function registerExecute(server: McpServer, deps: WritDeps): void {
  server.registerTool(
    'writ_execute',
    {
      title: 'Settle an attested decision at its gate',
      description:
        'Calls the gate to act on a writ produced by writ_attest. Returns the transaction hash ' +
        'and the outcome: approved, or refused with who refused — "model" when the model ' +
        'answered DENY, "policy" when it answered ALLOW above the gate’s risk ceiling. A ' +
        'refusal is a successful result, not an error. Sends a transaction.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ gate, writId }) =>
      runTool('writ_execute', async () => {
        const g = deps.gate(gate)

        // `TreasuryGate.execute` reverts `NotAgent(msg.sender)` for anyone else, so check the
        // key this server holds against the gate's appointed agent before spending a proof on a
        // transaction that cannot succeed. This is also where a missing key is reported.
        const [appointedAgent, signingAs] = await Promise.all([g.agent(), deps.agentAddress()])
        if (appointedAgent.toLowerCase() !== signingAs.toLowerCase()) {
          fail(
            `gate ${g.address} only accepts calls from its agent ${appointedAgent}, and this server signs as ${signingAs}`,
          )
        }

        const held = deps.store.get(writId)

        if (held && held.gate.toLowerCase() !== g.address.toLowerCase()) {
          fail(`writ ${writId} was attested against gate ${held.gate}, not ${g.address}`)
        }

        const material: Material = held
          ? {
              writId: held.writId,
              to: held.to,
              amountWei: held.amountWei,
              rawResponse: held.rawResponse,
              provider: held.provider,
              signature: held.signature,
              transcriptRoot: held.transcriptRoot,
              kind: held.kind,
              ...(held.routing ? { routing: held.routing } : {}),
              reqHash: held.reqHash,
              respHash: held.respHash,
              source: 'session',
            }
          : await reconstruct(deps, g, writId)

        await assertQuestionStillPinned(g, material)

        const key = await g.decisionKey(material.provider, material.reqHash, material.respHash)
        if (await g.consumed(key)) {
          fail(
            `this decision has already been acted on (decision key ${key}); ask the question again rather than replaying the answer`,
          )
        }

        const args: SettleArgs = {
          to: material.to,
          amountWei: material.amountWei,
          rawResponse: material.rawResponse,
          provider: material.provider,
          signature: material.signature,
          transcriptRoot: material.transcriptRoot,
        }

        const tx =
          material.kind === 'routing'
            ? await g.executeRoutingProof({
                ...args,
                routing: material.routing ?? fail('a routing proof arrived without its routing fields'),
              })
            : await g.execute(args)

        const receipt = await tx.wait()
        if (!receipt) fail(`settlement ${tx.hash} produced no receipt; the outcome is unknown`)
        if (receipt.status !== 1) fail(`settlement ${receipt.hash} reverted; nothing was settled`)

        const event = decisionFrom(g, receipt.logs)
        if (!event) {
          fail(
            `settlement ${receipt.hash} emitted no TransferApproved or TransferRefused event; refusing to claim an outcome`,
          )
        }

        const approved = event.name === 'TransferApproved'
        const refusedBy = approved ? 'none' : refusalName(event.args['refusedBy'] as bigint)
        // `TransferRefused` names the refuser. An unrecognised value means this build does not
        // understand the gate it just called, which is not something to paper over.
        if (!approved && (refusedBy === 'unknown' || refusedBy === 'none')) {
          fail(
            `settlement ${receipt.hash} refused with an unrecognised reason code ${String(event.args['refusedBy'])}; refusing to describe an outcome this build does not understand`,
          )
        }

        const risk = Number(event.args['risk'] ?? 0)
        const eventWritId = String(event.args['writId'] ?? material.writId)

        const reason = approved
          ? `the model allowed it at risk ${risk}, within the gate's ceiling`
          : refusedBy === 'model'
            ? `the model answered DENY at risk ${risk}; no funds moved`
            : `the model allowed it at risk ${risk}, above the gate's ceiling; no funds moved`

        return {
          writId: material.writId,
          gate: g.address,
          outcome: approved ? ('approved' as const) : ('refused' as const),
          refusedBy,
          reason,
          risk,
          to: material.to,
          ...amountOut(material.amountWei),
          provider: material.provider,
          kind: material.kind,
          txHash: receipt.hash,
          explorerTx: explorerTx(deps, receipt.hash),
          eventWritId,
          source: material.source,
        }
      }),
  )
}
