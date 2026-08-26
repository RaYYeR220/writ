import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { WritDeps } from './deps.js'
import { registerAttest } from './tools/attest.js'
import { registerExecute } from './tools/execute.js'
import { registerLookup } from './tools/lookup.js'
import { registerPreviewQuestion } from './tools/preview.js'

export const SERVER_NAME = 'writ'
export const SERVER_VERSION = '0.1.0'

const INSTRUCTIONS = `Writ turns an AI decision into something a smart contract can verify and act on.

A 0G Compute provider runs a model inside an Intel TDX enclave and signs
sha256(exact request bytes):sha256(exact response bytes) with a hardware key registered on chain
in 0G's InferenceServing contract. Writ verifies that signature inside a contract, records it
permanently in WritRegistry, and lets a gate act on the verified decision. Because the signature
binds the request as well as the response, the gate can prove which question was asked — so a
prompt cannot be swapped for a friendlier one.

Normal order of use:
  1. writ_preview_question - see the exact bytes the gate will pin, before anything is asked.
  2. writ_attest          - ask the gate's provider that question, capture and verify the TEE
                            proof, archive the transcript to 0G Storage, notarize on chain.
  3. writ_execute         - settle the writ at the gate.
  4. writ_lookup          - read any writ back and re-verify it from public data.

A refusal is a successful outcome. writ_execute returns outcome "refused" with refusedBy "model"
(the model answered DENY) or "policy" (it allowed the action above the gate's risk ceiling); no
funds move and the refusal becomes a permanent public record.

These tools never synthesise a result. If a proof is unavailable, expired, or does not verify,
the tool returns an error rather than a value. Nothing reports success without a signature that
recovers to the provider's registered TEE signer.`

/**
 * Builds the server with its four tools bound to a set of dependencies.
 *
 * Everything that touches the chain, 0G Compute or 0G Storage arrives through `deps`, so the
 * whole surface — schema validation, verification, refusal handling, error shaping — can be
 * driven in tests against fakes, exactly as a client drives it over a transport.
 */
export function createWritServer(deps: WritDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  )

  registerPreviewQuestion(server, deps)
  registerAttest(server, deps)
  registerExecute(server, deps)
  registerLookup(server, deps)

  return server
}
