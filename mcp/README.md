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

## Contents

- [Quick start](#quick-start) · [Configuration](#configuration) · [Client setup](#client-setup)
- [The four tools](#the-four-tools)
- [The question is nine facts, and it is alive](#the-question-is-nine-facts-and-it-is-alive)
- [How a failure surfaces](#how-a-failure-surfaces)
- [A note on stdout](#a-note-on-stdout) · [Development](#development)

## Quick start

The server speaks MCP over stdio. Build it — which also builds the SDK it wraps — and run it:

```bash
pnpm install
pnpm build
node build/index.js
```

That is the whole interface. Any MCP client that can spawn a process and speak JSON-RPC over its
stdin and stdout can drive it; configuration is entirely environment variables.

## Configuration

Nothing is required to start. A server with no key still serves `writ_preview_question` and
`writ_lookup`, and the tools that need a key say so by name when they are called.

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

**Keep `WRIT_PRIVATE_KEY` out of any committed configuration file.** The server reads it from the
ambient environment, so export it in the shell that launches the client:

```bash
export WRIT_PRIVATE_KEY=0x...
```

### Trying it without spending anything

Run a local fork of 0G mainnet. It carries the real `InferenceServing` state and the real
provider registrations, and it keeps chain id `16661`:

```bash
anvil --fork-url https://evmrpc.0g.ai
export WRIT_RPC_URL=http://127.0.0.1:8545
```

`writ_preview_question` and `writ_lookup` work against the fork immediately. `writ_attest`
additionally needs a funded 0G Compute ledger, which a fork cannot provide — inference itself
happens off chain.

## Client setup

### Generic stdio configuration

Most MCP clients configure a stdio server with the same three fields: the command, its arguments,
and its environment. In JSON that is:

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

Use an absolute path to `build/index.js`; the client's working directory is not yours. The file
carries a `#!/usr/bin/env node` shebang, so on a Unix-like system `command` can also be the script
itself once it is marked executable, and `npx writ-mcp` works from an install.

Clients that take a command line rather than JSON want the equivalent:

```
node /absolute/path/to/writ/mcp/build/index.js
```

### Client-specific notes

<details>
<summary><strong>Claude Code</strong></summary>

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
session. Project-scoped servers prompt for approval on first use.

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add the generic JSON block above to `claude_desktop_config.json`, then restart the app:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

</details>

<details>
<summary><strong>Cursor, Windsurf, Zed and other editors</strong></summary>

These read the same `mcpServers` shape from their own settings file — `.cursor/mcp.json`,
`~/.codeium/windsurf/mcp_config.json`, and Zed's `context_servers` block respectively. Paste the
generic JSON block and adjust the wrapper key if the client uses a different one.

</details>

<details>
<summary><strong>Your own agent, over the MCP SDK</strong></summary>

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['/absolute/path/to/writ/mcp/build/index.js'],
  env: { ...process.env, WRIT_REGISTRY: '0xYourRegistry' },
})

const client = new Client({ name: 'my-agent', version: '1.0.0' })
await client.connect(transport)
```

</details>

## The four tools

### `writ_preview_question`

Read-only. Returns the exact bytes the gate will pin, and the facts they carry, so the agent can
see what it is about to be asked before anything is asked. No inference, no transaction, no spend.

| Input | Type | Meaning |
|---|---|---|
| `gate` | address | The deployed `TreasuryGate` / `PolicyGate`. |
| `to` | address | The recipient the transfer would go to. |
| `amount` | string | Amount in whole 0G, as a decimal string (`"0.01"`). Not wei — a double cannot carry 18 significant decimals, so this is a string on purpose. |

Output: `chainId`, `gate`, `to`, `amount`, `amountWei`, `nonce`, `question` (the exact UTF-8
request body), `questionHex`, `questionBytes`, `requestHash` (its sha256 — half of what the TEE
will sign), `facts`, `treasury`, `allowedProvider`, `allowedModelHash`, `maxRisk`, `notes`.

`facts` is the nine-fact block parsed out of those exact bytes, with wei rendered in 0G alongside
and two readings added — `treasuryCoversAmount` and `recipientIsNew`. It is `null` for a
`PolicyGate` that pins some other question. `treasury` is the same state read independently from
the gate's own `nonce()`, `approvedCount()`, `refusedCount()` and `recipientHistory()` getters,
and is `null` for a gate that does not expose them.

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

The writ must already be notarized. The gate does not put the record on chain on the way past
and reverts `WritNotNotarized` if it is missing — which is what keeps an approval whose payout
reverts from rolling the decision back with it, so that approved, refused and
approved-but-unpayable are all equally permanent. `writ_attest` does the notarizing, in its own
transaction, and treats "someone else got there first" as the success it is.

If the server did not produce the writ itself (a restart, or another agent's writ), the response
bytes are rebuilt from public data: every archive pointer published for the writ is walked in
submission order, and the first whose bytes survive the full re-derivation — merkle root
recomputed, hashes checked against what the chain pinned, signature recovered against the
provider's registered TEE signer — is the one used. A junk pointer from a front-runner costs a
fetch; a list where none re-derive is an error and no transaction is sent. Then `source` is
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
aPublishedTranscriptCandidateReDerivesTheWrit
transcriptRetrievedFrom0gStorage
transcriptMerkleRootMatches
requestRehashesToOnChainHash
responseRehashesToOnChainHash
signedTextRebuildsFromThoseHashes
signatureRecoversToRegisteredTeeSigner
```

plus `provider`, `recordedModelHash`, `currentModel`,
`modelHashMatchesCurrentRegistration`, `teeSigner`, `verifiability`, `teeSignerAcknowledged`,
`reqHash`, `respHash`, `transcriptRoot`, `transcriptSubmitter`, `transcriptCandidates`,
`notarizedAt`, `notarizedAtUnix`, `notarizedBy`, `kind`, `routing`, `chatId`, `capturedAt`,
`question`, `facts`, `answer`, `verdict`, `risk`, `notes`.

`transcriptRoot` is not a field of the record — a writ has no root. The TEE signs the request and
response hashes and never a pointer to an archive, and notarizing is permissionless, so whoever
got there first would otherwise fix the archive pointer forever. `WritRegistry` keeps an
append-only list of candidates instead, each attributed to its submitter and each bounded by a
per-address quota of four. This tool walks that list in submission order and reports the first
candidate whose bytes survive the full re-derivation; `transcriptCandidates` shows every one that
was published and what became of it. A candidate that does not re-derive says something about
whoever published it and nothing about the proof, which was verified by signature recovery at
notarization time. If none of them re-derive, that is an error carrying the reasons — never a
pass, and never a quiet fall back to the first one.

`facts` here is parsed from the archived question, so it reports the treasury **as it stood when
the model was asked**, not as it stands today.

A success from this tool means every one of those checks passed. If the transcript cannot be
retrieved, or any check fails, the tool returns an error carrying the reason — it never reports a
writ as verified on the strength of it merely being recorded.

## The question is nine facts, and it is alive

A `TreasuryGate` does not just ask "may I send X to Y". It builds the whole question itself, out
of its own state, as nine space-separated `key=value` pairs:

```
recipient=0x…d1 amount=1000000000000000000 nonce=0 treasuryBalance=10000000000000000000
amountPctOfBalance=10 priorApprovals=0 priorRefusals=0 recipientPriorPayments=0
recipientPriorTotal=0
```

(rendered on one line, with no quoting or escaping). Amounts are wei. Every field is the
contract's own reading of its state, so a caller cannot understate the balance, hide a refusal
history, or pass off an unfamiliar recipient as a familiar one.

Three of them are easy to misread, and both `writ_preview_question` and `writ_lookup` say so in
`notes` when they apply:

- **`amountPctOfBalance`** is measured against the balance *before* the transfer, so anything over
  100 means the treasury cannot cover it. It is a floored integer capped at 999, so 25× and 1000×
  are indistinguishable, and anything under 1% reports `0` rather than a small fraction. An empty
  treasury reports 999 rather than dividing by zero.
- **`recipientPriorPayments` / `recipientPriorTotal`** count approvals only. A recipient this
  treasury has refused ten times still shows `recipientPriorPayments=0`.
- **`recipient`** is lowercase and not checksummed, because that is what the contract renders and
  therefore what the TEE signs. The `facts` block returns it checksummed for convenience; the
  question keeps the lowercase form.

### The consequence: a writ expires when the treasury moves

Because the question pins live state, a proof is bound to the treasury as it stood when the
question was built. If the balance changes, another transfer settles, or this recipient is paid
again before the proof is submitted, it is no longer the same question and the old proof does not
answer it. **An unrelated deposit by a stranger is enough to invalidate a perfectly good
approval.** This is the discipline the nonce already imposed per action, widened to the treasury
as a whole; it buys the guarantee that the model judged the treasury as it actually stood.

`writ_execute` checks for this before it spends any gas, and again if the settlement reverts, and
it names what moved rather than returning a bare revert:

```
writ_execute failed: this writ no longer answers gate 0x…6A7e's question: the treasury's
balance moved without this gate settling anything, so someone else deposited into it or it
paid out elsewhere (treasuryBalance 10000000000000000000 -> 15000000000000000000,
amountPctOfBalance 10 -> 6). Nothing about the transfer changed, but the question did, and the
proof answers the old one. Ask the question again: run writ_preview_question and writ_attest
against the current state. Re-submitting this writ cannot work, because the proof answers a
question the gate no longer asks.
```

When the gate itself settled something in between, the same check says so instead — "this gate
settled another decision in the meantime (nonce 0 -> 1, priorApprovals 0 -> 1)". Either way the
remedy is to re-attest, never to retry, and the message says which happened so an agent does not
have to guess.

Practically: keep the gap between `writ_attest` and `writ_execute` short, and treat a stale-state
error as a signal to loop back to `writ_preview_question` rather than as a failure.

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
| The treasury moved after the proof was obtained | error naming every fact that changed, and saying to re-attest |
| The gate call reverted | error carrying the decoded custom error, e.g. `reverted with BadSignature(0x…, 0x…)` |
| The settlement mined but emitted no decision event | error: `refusing to claim an outcome` |

There is no code path that reports success without a signature that recovers to the provider's
registered TEE signer.

## A note on stdout

A stdio MCP server speaks JSON-RPC over stdout, and both 0G SDKs write progress lines to
`console.log` — 15 calls in the storage indexer, 21 in its uploader, one on every compute broker
construction. A single stray line desynchronises the framing and the client drops the connection.
`src/stdio-guard.ts` points `console.log`, `console.info` and `console.debug` at stderr, and the
entrypoint imports it before any other module in the graph is evaluated. `console.warn` and
`console.error` are left alone; Node already sends those to stderr.

## Development

```bash
pnpm test        # 138 tests, no chain, no funds, no provider
pnpm typecheck
pnpm build
```

The tests drive the real server through a real MCP client over a linked in-memory transport, so
tool registration, input schema validation, output schema validation and the `isError` shaping are
all exercised the way a hosted client exercises them. Everything that touches the chain, 0G
Compute or 0G Storage arrives through one injected `WritDeps`, and the test double is faithful
where it matters: the stand-in TEE signs with a real secp256k1 key, the stand-in registry recovers
that signature and refuses a proof that does not match, and the stand-in gate builds its nine-fact
question from its own live balance, decision counts and recipient history — and rebuilds it at
settlement time, which is what makes the stale-state path testable at all.
