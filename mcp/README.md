# Writ MCP server

An MCP server that lets any AI agent produce and settle its own TEE-attested decisions on 0G.

A 0G Compute provider runs a model inside an Intel TDX enclave and signs
`sha256(exact request bytes):sha256(exact response bytes)` with a hardware key registered on chain
in 0G's official `InferenceServing` contract. Writ verifies that signature **inside a smart
contract**, records it permanently in `WritRegistry`, and lets a gate act on the verified decision
text. Because the signature binds the request as well as the response, the gate can prove which
question was asked — so a prompt cannot be swapped for a friendlier one.

This server is the platform layer. An agent asks Writ for the question it is about to be judged
on, gets an attested verdict, and settles it on chain — without writing any Solidity or touching
a private key itself.

## The four tools

### `writ_preview_question`

Read-only. Returns the exact bytes the gate will pin, so the agent can see what it is about to
be asked before anything is asked. No inference, no transaction, no spend.

| Input | Type | Meaning |
|---|---|---|
| `gate` | address | The deployed `TreasuryGate` / `PolicyGate`. |
| `to` | address | The recipient the transfer would go to. |
| `amount` | string | Amount in whole 0G, as a decimal string (`"0.01"`). Not wei — a double cannot carry 18 significant decimals, so this is a string on purpose. |

Output: `chainId`, `gate`, `to`, `amount`, `amountWei`, `nonce`, `question` (the exact UTF-8
request body), `questionHex`, `questionBytes`, `requestHash` (its sha256 — half of what the TEE
will sign), `allowedProvider`, `allowedModelHash`, `maxRisk`.

### `writ_attest`

Runs inference on 0G Compute against the gate's configured provider, claims the TEE proof,
verifies it, archives the transcript to 0G Storage and notarizes the proof on chain. Spends gas
and 0G Compute credit.

| Input | Type | Meaning |
|---|---|---|
| `gate` | address | The gate whose question should be answered. |
| `to` | address | The recipient. |
| `amount` | string | Amount in whole 0G. |

Output: `writId`, `txHash` (`""` when the writ was already on chain), `alreadyNotarized`,
`transcriptRoot`, `verdict` (`ALLOW` / `DENY` / `UNPARSEABLE`), `risk` (0-100, or `null`),
`kind` (`chat` / `routing`), `provider`, `model`, `teeSigner`, `chatId`, `requestHash`,
`responseHash`, `answer`, `maxRisk`, `expectedOutcome`
(`approve` / `refuse-model` / `refuse-policy` / `revert-malformed`), `routing`, `gate`, `to`,
`amount`, `amountWei`, `explorerTx`.

The order of operations is not negotiable. The proof is claimed immediately after inference,
because provider signature endpoints expire chat ids and a missed proof is unrecoverable. The
signature is verified against the provider's **registered** TEE address — read from 0G's
`InferenceServing`, never from the provider's own claim about itself — before the transcript is
archived and before any transaction is sent. A run that cannot be proved costs nothing and
produces nothing.

### `writ_execute`

Settles a writ at its gate. Sends a transaction.

| Input | Type | Meaning |
|---|---|---|
| `gate` | address | The gate that pinned the question. |
| `writId` | bytes32 | The writ id from `writ_attest`. |

Output: `writId`, `gate`, `outcome` (`approved` / `refused`), `refusedBy`
(`none` / `model` / `policy`), `reason`, `risk`, `to`, `amount`, `amountWei`, `provider`, `kind`,
`txHash`, `explorerTx`, `eventWritId`, `source` (`session` / `reconstructed`).

**A refusal is a successful outcome, not an error.** `refusedBy: "model"` means the model
answered `DENY`; `refusedBy: "policy"` means it answered `ALLOW` above the gate's risk ceiling.
Either way no funds move, the nonce is spent, and the refusal becomes a permanent public record.
Only a failure to *verify* is an error, because that means no decision was shown at all.

The outcome is read from the emitted `TransferApproved` / `TransferRefused` event, never inferred
from the fact that the transaction mined. `execute` returns a bool, and a return value is not
readable from a mined transaction — so if no decision event is present, this tool errors rather
than guessing.

If the server did not produce the writ itself (a restart, or another agent's writ), the response
bytes and signature are rebuilt from public data: the archived transcript is pulled from 0G
Storage, its merkle root recomputed, its hashes checked against what the chain pinned, and its
signature recovered against the provider's registered TEE signer. Then `source` is
`"reconstructed"`. Any step failing is an error, not a fallback.

### `writ_lookup`

Read-only. Returns `WritRegistry`'s record **plus an independent re-derivation of it from public
data**.

| Input | Type | Meaning |
|---|---|---|
| `writId` | bytes32 | The writ to look up. |
| `registry` | address, optional | Defaults to `WRIT_REGISTRY`. |

Output includes `verified: true` and a `checks` object naming every step:

```
onChainRecordExists
writIdMatchesItsContents
transcriptRetrievedFrom0gStorage
transcriptMerkleRootMatches
requestRehashesToOnChainHash
responseRehashesToOnChainHash
signedTextRebuildsFromThoseHashes
signatureRecoversToRegisteredTeeSigner
```

plus `provider`, `recordedModelHash`, `currentModel`,
`modelHashMatchesCurrentRegistration`, `teeSigner`, `verifiability`, `teeSignerAcknowledged`,
`reqHash`, `respHash`, `transcriptRoot`, `notarizedAt`, `notarizedAtUnix`, `notarizedBy`, `kind`,
`routing`, `chatId`, `capturedAt`, `question`, `answer`, `verdict`, `risk`, `notes`.

A success from this tool means every one of those checks passed. If the transcript cannot be
retrieved, or any check fails, the tool returns an error carrying the reason — it never reports a
writ as verified on the strength of it merely being recorded.

## How a failure surfaces

Every failure is an MCP tool error: `isError: true`, a plain-language explanation in the text
content, and **no `structuredContent` at all**. Because each tool declares an `outputSchema`, and
the MCP server exempts error results from output validation while requiring structured content on
success, there is no shape in which a failed tool can hand back a populated, schema-valid answer.

The failures worth knowing about:

| Situation | What you get |
|---|---|
| The provider's signature endpoint has expired the chat id | error: `proof unavailable (404 …) chat_id_not_found` — nothing archived, nothing notarized |
| The signature is by a key that is not the registered TEE signer | error: `does not verify against the registered TEE signer 0x…` |
| The TEE signed a different question | error: `provider signed "…", which is not this request and response` |
| The provider is not a TeeML service, or has not acknowledged its signer | error, before inference is even attempted |
| The gate requires a model the provider no longer serves | error, before anything is spent |
| The archived transcript cannot be fetched from 0G Storage | error: `0G Storage could not return transcript 0x…` |
| The archived bytes do not hash to what the chain pinned | error naming both hashes |
| The gate's nonce moved on | error: `would now ask a different question than this writ answers` |
| The gate call reverted | error carrying the decoded custom error, e.g. `reverted with BadSignature(0x…, 0x…)` |
| The settlement mined but emitted no decision event | error: `refusing to claim an outcome` |

There is no code path that reports success without a signature that recovers to the provider's
registered TEE signer.

## Configuration

All configuration is environment variables. Nothing is required to start: a server with no key
still serves `writ_preview_question` and `writ_lookup`, and the tools that need a key say so by
name when called.

| Variable | Default | Used for |
|---|---|---|
| `WRIT_PRIVATE_KEY` | — | The agent's key. Signs notarizations, gate calls and the 0G Storage upload. `writ_execute` requires it to be the gate's appointed `agent()`, and says so if it is not. |
| `WRIT_REGISTRY` | — | Default `WritRegistry` for `writ_lookup`. The other tools read it off the gate. |
| `WRIT_CHAIN_ID` | `16661` | Chain id. Selects every default below. |
| `WRIT_RPC_URL` | `https://evmrpc.0g.ai` | 0G EVM RPC. Point at a local anvil fork to test without spending. |
| `WRIT_INDEXER` | `https://indexer-storage-turbo.0g.ai` | 0G Storage indexer. Turbo only — both `standard` indexers are down. |
| `WRIT_EXPLORER` | `https://chainscan.0g.ai` | Base URL for the explorer links in tool output. |
| `WRIT_INFERENCE_SERVING` | `0x47340d900bdFec2BD393c626E12ea0656F938d84` | 0G's `InferenceServing`. |
| `WRIT_PROVIDER` | — | Only used when a gate's policy accepts any acknowledged TeeML provider. |
| `WRIT_STORAGE_TIMEOUT_MS` | `300000` | Cap on the 0G Storage upload, which otherwise retries forever. |

Chain `16602` (Galileo testnet) switches the RPC, indexer, explorer and `InferenceServing`
defaults together. Note that `writ_attest` still requires chain `16661`: 0G Compute's broker
silently falls back to **testnet** contract addresses on any chain it does not recognise, so this
server asserts the chain id before constructing it rather than transacting against the wrong
network.

## Registering the server with a client

Build it first — the server runs from `build/`, and building it also builds the SDK it wraps:

```bash
pnpm install
pnpm build
```

### Claude Code

```bash
# Project scope: writes ./.mcp.json, shared with the team through version control.
claude mcp add writ --scope project \
  --env WRIT_REGISTRY=0xYourRegistry \
  -- node /absolute/path/to/writ/mcp/build/index.js

# User scope: available in all your projects.
claude mcp add writ --scope user -- node /absolute/path/to/writ/mcp/build/index.js
```

The `--` is required: everything after it is passed to the server untouched, and without it the
CLI tries to parse the server's own arguments as its own. Keep at least one other option between
`--env` and the server name, or the CLI reads the name as another `KEY=value` pair.

Manage with `claude mcp list`, `claude mcp get writ`, `claude mcp remove writ`, or `/mcp` inside a
session.

### Raw JSON

`.mcp.json` in a project root, or the `mcpServers` object in `~/.claude.json` for user scope:

```json
{
  "mcpServers": {
    "writ": {
      "command": "node",
      "args": ["/absolute/path/to/writ/mcp/build/index.js"],
      "env": {
        "WRIT_REGISTRY": "0xYourRegistry",
        "WRIT_RPC_URL": "https://evmrpc.0g.ai"
      }
    }
  }
}
```

Any MCP client that speaks stdio works the same way: run `node build/index.js`, speak JSON-RPC
over stdin/stdout.

**Do not put `WRIT_PRIVATE_KEY` in a committed `.mcp.json`.** The server reads it from the
ambient environment, so export it in the shell that launches the client instead:

```bash
export WRIT_PRIVATE_KEY=0x...
```

### Trying it without spending anything

Run a local fork of 0G mainnet. It carries the real `InferenceServing` state and the real
provider registrations, and it keeps chain id `16661`:

```bash
anvil --fork-url https://evmrpc.0g.ai
# then
export WRIT_RPC_URL=http://127.0.0.1:8545
```

`writ_preview_question` and `writ_lookup` work against the fork immediately. `writ_attest`
additionally needs a funded 0G Compute ledger, which a fork cannot provide — inference itself
happens off chain.

## A note on stdout

A stdio MCP server speaks JSON-RPC over stdout, and both 0G SDKs write progress lines to
`console.log` — 15 calls in the storage indexer, 21 in its uploader, one on every compute broker
construction. A single stray line desynchronises the framing and the client drops the connection.
`src/stdio-guard.ts` points `console.log`, `console.info` and `console.debug` at stderr, and the
entrypoint imports it before any other module in the graph is evaluated. `console.warn` and
`console.error` are left alone; Node already sends those to stderr.

## Development

```bash
pnpm test        # 95 tests, no chain, no funds, no provider
pnpm typecheck
pnpm build
```

The tests drive the real server through a real MCP client over a linked in-memory transport, so
tool registration, input schema validation, output schema validation and the `isError` shaping are
all exercised the way a hosted client exercises them. Everything that touches the chain, 0G
Compute or 0G Storage arrives through one injected `WritDeps`, and the test double is faithful
where it matters: the stand-in TEE signs with a real secp256k1 key, the stand-in registry recovers
that signature and refuses a proof that does not match, and the stand-in gate re-derives its own
question from the recipient, the amount and its own nonce before it will settle.
