# CLAIMS — the honesty ledger

Every public claim Writ makes, with the tier of evidence behind it and a pointer to that evidence.
Then everything Writ does **not** claim, stated plainly.

If you find a claim in the README, the demo, the docs or a post that is not in this file, treat the
omission as an error and hold us to this file. If you find a limitation that is not in the
**NOT-CLAIMED** section, we want to know — several of the entries below were found by looking for
exactly that.

Last reviewed: 2026-08-26.

## Tiers

| Tier | Meaning |
|---|---|
| **REPRODUCIBLE** | Anyone can re-run it from this repository and get the same answer. No key, no funds, no network for most of it. |
| **VERIFIED-LIVE** | Proven against 0G mainnet (chain 16661) as it actually stands. Read-only; spends nothing. Dated, because live state changes. |
| **MODELED** | Reasoned or derived, not measured end to end. Say so out loud. |
| **NOT-CLAIMED** | Deliberately not asserted. Listed anyway. |

**Nothing is deployed.** There is no `WritRegistry` on mainnet, no gate, no transaction hash. Every
address in this repository is either 0G's own or is written as
`<UNDEPLOYED — no address exists yet>`. No claim below depends on a deployment.

---

## 1. On-chain verification

| # | Claim | Tier | Proof |
|---|---|---|---|
| 1.1 | Solidity rebuilds the 0G broker's signed chat text byte-for-byte, and it is exactly 129 bytes | REPRODUCIBLE | `contracts/test/WritLib.t.sol::test_signedTextIs129BytesAndMatchesBroker`. Fixtures from `contracts/script/gen-fixtures.mjs`, which reproduces `api/inference/internal/ctrl/signing.go` in JavaScript |
| 1.2 | Solidity rebuilds the centralized five-field routing text byte-for-byte | REPRODUCIBLE | `WritLib.t.sol::test_routingProofTextMatchesBrokerFormat` (217 bytes for `centralized`/`openrouter`) |
| 1.3 | The EIP-191 prefix carries the real decimal length, so a variable-length text verifies | REPRODUCIBLE | `WritLib.t.sol::test_routingProofPrefixCarriesTheDecimalLength` — the same signature recovers under `…\n217` and does not under `…\n129` |
| 1.4 | Tampering with **either** the request hash or the response hash breaks recovery | REPRODUCIBLE | `WritLib.t.sol::test_tamperedRequestDoesNotRecoverSigner`, `…ResponseDoesNotRecoverSigner` |
| 1.5 | The two supported formats do not cross-verify in either direction | REPRODUCIBLE | `WritLib.t.sol::test_theTwoSignedTextFormatsDoNotCrossVerify` |
| 1.6 | The routing text binds every one of its five fields | REPRODUCIBLE | `WritLib.t.sol::test_routingProofTextBindsEveryField` |
| 1.7 | The `sha256` precompile re-binds raw revealed bytes to the attested hashes | REPRODUCIBLE | `WritLib.t.sol::test_sha256PrecompileBindsRawRequestBytes`, `…RawResponseBytes` |
| 1.8 | A full chat verification costs 47,209 gas; a routing verification 69,337 | REPRODUCIBLE | `WritLib.t.sol::test_measuresVerificationGas`, `…RoutingProofVerificationGas`. Superseding the day-0 spike's 74,940, which came from a different harness shape |
| 1.9 | `notarize` costs 246,389 gas cold, `notarizeRoutingProof` 343,819, `execute` 399,533 approved / 344,549 refused, `executeRoutingProof` 501,311 | REPRODUCIBLE, with the caveat below | the four `test_measures*` tests. **These read a `MockInferenceServing`, so they are lower bounds** — 0G's real registry returns a much larger struct |
| 1.10 | Reaching `BadSignature` through 0G's **real** deployed registry costs 133,427 gas; one live `getService` plus assertions costs 79,689 | VERIFIED-LIVE | `forge test --match-path test/WritRegistry.fork.t.sol` against `https://evmrpc.0g.ai` |
| 1.11 | A *successful* notarization against the live registry has never been measured | — | no live TEE proof has been notarized; see §6 |

## 2. 0G mainnet, as it actually stands

All read live from chain 16661 on **2026-08-26**. Live state changes; re-run the commands.

| # | Claim | Tier | Proof |
|---|---|---|---|
| 2.1 | 0G mainnet `InferenceServing` at `0x47340d900bdFec2BD393c626E12ea0656F938d84` lists 24 registered services | VERIFIED-LIVE | `getAllServices(0, 50)`. Note the contract caps `limit` at 50 |
| 2.2 | 19 of them are `verifiability: "TeeML"` **and** `teeSignerAcknowledged: true` | VERIFIED-LIVE | same call |
| 2.3 | 13 of those 19 are `ProviderType: centralized` (routing-proof format); 6 are decentralized with `TargetSeparated: false` (chat format); 0 are decentralized-and-separated | VERIFIED-LIVE | `additionalInfo` JSON on each service; dispatch rule at `chatbot.go:561-607` |
| 2.4 | Writ verifies the signed text of 18 of the 19. The exception is `z-image-turbo` (`0xE29a72c7…`, `text-to-image`), the only live service that reaches the unsupported image format | VERIFIED-LIVE + MODELED | census is live; the mapping from service class to signed-text format is read from broker source, not observed per-provider |
| 2.5 | Provider `0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9` serves `0GM-1.0-35B-A3B` as acknowledged TeeML with TEE signer `0x8561E0a9dA3C8d6591A2E756a91334f1a3E537e0` | VERIFIED-LIVE | `WritRegistry.fork.t.sol::test_liveTeeProviderIsAcknowledgedAndTeeML` |
| 2.6 | `WritRegistry` rejects a live `verifiability: "standard"` service (`0xd3f02c1a04160389d98D2192AE2034159f731011`) with `NotTeeVerifiable` | VERIFIED-LIVE | `…fork.t.sol::test_rejectsLiveNonTeeProvider` |
| 2.7 | `WritRegistry` rejects a garbage signature for a live acknowledged TeeML provider | VERIFIED-LIVE | `…fork.t.sol::test_rejectsGarbageSignatureForLiveTeeProvider` |
| 2.8 | A provider 0G has never seen cannot be notarized — the live contract reverts `ServiceNotExist` and it propagates | VERIFIED-LIVE | `…fork.t.sol::test_rejectsUnregisteredProvider` |
| 2.9 | `teeSignerAcknowledged` can only be set by 0G's registry owner. There is **no** self-acknowledgement entry point | VERIFIED-LIVE | a selector scan of the runtime bytecode of the deployed beacon implementation `0x1c0A264f5ae6cfC37E8695442fB139efD884Ca48` — which is how Solidity dispatches. It contains `acknowledgeTEESignerByOwner(address)` (`0xb2394d09`) and does not contain `acknowledgeTEESigner()` (`0x7d484904`) or `acknowledgeTEESigner(address)` (`0x515579e8`). Corroborated by the fork probe in 2.10, which had to impersonate the owner. Owner is `0xddCDcbD9C7aeFB165dE00CE8684907fAAe8C8224` |
| 2.10 | Calling `addOrUpdateService` with a changed **model name**, changed **additionalInfo**, or a changed **teeSignerAddress** resets `teeSignerAcknowledged` to `false`. Changing only the **URL** or the **prices** does not | VERIFIED-LIVE | probed field-by-field on `anvil --fork-url https://evmrpc.0g.ai`, impersonating provider `0x4870Cb…` and the registry owner, re-acknowledging between each probe. Read-only against real mainnet; no mainnet transaction was sent |
| 2.11 | `GET {providerUrl}/v1/proxy/signature/{chatID}?model=…` is public and unauthenticated | VERIFIED-LIVE | unauthenticated probe, day-0 spike |
| 2.12 | Proofs expire. A live mainnet provider answers an unknown chat id with, verbatim, `{"error":"prepare HTTP request: Chat id not found or expired, chat_id_not_found"}` | VERIFIED-LIVE | same probe |
| 2.13 | The signature endpoint returns `text` and `signature`; `signing_address` is advisory and is ignored in favour of the on-chain `teeSignerAddress` | REPRODUCIBLE | `sdk/src/proof.ts`, `sdk/test/proof.test.ts`; the field is documented as a hint in `0g-pc-e2ee/protocol/proof/proof.go:39-43` |

Reproduce the census:

```bash
cast call 0x47340d900bdFec2BD393c626E12ea0656F938d84 \
  "getAllServices(uint256,uint256)" 0 50 --rpc-url https://evmrpc.0g.ai
cd writ/contracts && forge test --match-path test/WritRegistry.fork.t.sol -vv
```

## 3. Contract behaviour

| # | Claim | Tier | Proof |
|---|---|---|---|
| 3.1 | 146 contract tests pass — 142 unit plus 4 against a live mainnet fork | REPRODUCIBLE | `forge test` (142) and `forge test --match-path test/WritRegistry.fork.t.sol` (4) |
| 3.2 | A prompt-swap is rejected: a genuine, valid TEE signature over a *different* question does not satisfy the gate | REPRODUCIBLE | `AgentTreasury.t.sol::test_refusesPromptSwap`, `PolicyGate.t.sol::test_revertsWhenProofIsForADifferentQuestion`, `PolicyGateFactory.t.sol::test_deployedGateRefusesPromptSwap` |
| 3.3 | A refusal is a **successful transaction** that records the refusal permanently, not a revert | REPRODUCIBLE | `AgentTreasury.t.sol::test_recordsRefusalOnAttestedDeny`, `…OnAllowAboveCeiling`; `PolicyGate.t.sol::test_recordsDenyVerdictAsARefusal` |
| 3.4 | The gate names *who* refused — the model, or the policy ceiling overruling a willing model | REPRODUCIBLE | `PolicyGate.t.sol::test_denyIsRefusedByTheModel`, `…test_allowAboveTheCeilingIsRefusedByThePolicy`, `…test_approvedAgreesWithTheRefusalReason` |
| 3.5 | One decision authorises exactly one action, whichever of the two signed-text formats proved it | REPRODUCIBLE | `PolicyGate.t.sol::test_aRoutingProofSpendsTheChatDecisionToo`, `test_aChatProofSpendsTheRoutingDecisionToo`, `test_aRefusalSpendsTheDecisionAcrossFormats` |
| 3.6 | Every failure path has a specific custom error and none of them lets the guarded action through | REPRODUCIBLE | the error table in [`docs/architecture.md`](docs/architecture.md#6-contract-reference); one test per error across `WritRegistry.t.sol`, `PolicyGate.t.sol`, `VerdictLib.t.sol`, `TreasuryGate.t.sol`, `PolicyGateFactory.t.sol` |
| 3.7 | Anyone may notarize any valid proof. There is no allowlist and no privileged submitter | REPRODUCIBLE | `WritRegistry.t.sol::test_anyoneMayNotarize`. `WritRegistry` is ownerless and non-upgradeable — read the source; there is no `owner`, no proxy, no `selfdestruct` |
| 3.8 | A malformed answer reverts rather than being read as a refusal | REPRODUCIBLE | `VerdictLib.t.sol` (13 cases), `AgentTreasury.t.sol::test_refusesMalformedVerdict` |
| 3.9 | The gate's question changes with the balance, the nonce, the approval/refusal history and the recipient's payment history — so a proof is bound to the treasury as it stood | REPRODUCIBLE | `AgentTreasury.t.sol::test_questionChangesWhenTheBalanceChanges`, `…WithTheNonce`, `…WithApprovalAndRefusalHistory`, `…WithRecipientHistory` |
| 3.10 | An attested `ALLOW` to `address(0)` is refused before the proof is even examined | REPRODUCIBLE | `AgentTreasury.t.sol::test_executeRevertsForZeroRecipient`, `…test_executeRoutingProofRevertsForZeroRecipient` |
| 3.11 | The recovery hatch is timelocked, owner-only, and pushed out of reach by any verified proof including a refusal | REPRODUCIBLE | `TreasuryGate.t.sol`, 12 tests, including `test_refusalPostponesRecovery` and `test_failedVerificationDoesNotPostponeRecovery` |
| 3.12 | A factory-deployed gate enforces the ceiling, provider and model it was given, and the deployer does not become the owner | REPRODUCIBLE | `PolicyGateFactory.t.sol`, 12 tests |

## 4. SDK and MCP server

| # | Claim | Tier | Proof |
|---|---|---|---|
| 4.1 | 98 SDK tests and 138 MCP tests pass | REPRODUCIBLE | `cd writ/sdk && pnpm test`; `cd writ/mcp && pnpm test` |
| 4.2 | The SDK never hashes a re-serialized object. What is hashed is the exact wire bytes | REPRODUCIBLE | `sdk/src/inference.ts` reads the response with `res.text()` and hashes it as-is; `sdk/test/hashes.test.ts`, `sdk/test/inference.test.ts` |
| 4.3 | The SDK refuses a streaming request before any network call, because a stream has no single signable body | REPRODUCIBLE | `sdk/src/inference.ts::assertNotStreaming`; eval scenario `trap-streaming-request` |
| 4.4 | The SDK's hand-written ABIs match the compiled artifacts — every selector and every topic hash | REPRODUCIBLE | `sdk/test/abi.test.ts` compiles the Foundry project and compares |
| 4.5 | The SDK verifies a proof locally *before* archiving and before any transaction, so a run that cannot be proved costs nothing | REPRODUCIBLE | `sdk/src/attest.ts`; `sdk/test/attest.test.ts` (12 tests) covers the ordering |
| 4.6 | The SDK claims the proof immediately after inference, before the archive, because the chat id expires | REPRODUCIBLE | `sdk/src/attest.ts` ordering; `sdk/test/attest.test.ts` |
| 4.7 | The signed text — not a loose field, not configuration — decides which format was used | REPRODUCIBLE | `sdk/src/hashes.ts::parseSignedText`, `sdk/src/notarize.ts::notarizeProof`; `sdk/test/routing.test.ts` |
| 4.8 | A locally-computed 0G Storage merkle root is compared against the indexer's before anything is notarized | REPRODUCIBLE | `sdk/src/archive.ts::uploadTranscript`; `sdk/test/archive.test.ts` |
| 4.9 | An archived transcript is self-consistent before it is uploaded, and re-derivable from public data alone afterwards | REPRODUCIBLE | `sdk/src/archive.ts::assertSelfConsistent`; `mcp/src/rehydrate.ts::verifyArchivedTranscript`, which ignores the transcript's own `signingAddress` and anchors on `InferenceServing` |
| 4.10 | The MCP server mirrors `VerdictLib` byte-for-byte, so it can say what the gate will do before spending gas | REPRODUCIBLE | `mcp/src/verdict.ts`; `mcp/test/verdict.test.ts` |
| 4.11 | The MCP server detects a proof gone stale against the gate's live state and says *why* — including "a stranger deposited into the treasury" — instead of retrying | REPRODUCIBLE | `mcp/src/question.ts::explainDrift`, `mcp/src/tools/execute.ts::driftAgainst`; `mcp/test/execute.test.ts` (23 tests) |
| 4.12 | The MCP server keeps the 0G SDKs' `console.log` off `stdout`, which would otherwise corrupt the JSON-RPC stream | REPRODUCIBLE | `mcp/src/stdio-guard.ts`; `mcp/test/stdio-guard.test.ts` |
| 4.13 | An outcome is read from the emitted event, never inferred from the fact that a transaction mined | REPRODUCIBLE | `mcp/src/tools/execute.ts::decisionFrom`; a missing decision event is reported as an error, not guessed |

## 5. The evaluation

| # | Claim | Tier | Proof |
|---|---|---|---|
| 5.1 | 38 scenarios, written and committed **before** the harness was run against them | REPRODUCIBLE | `eval/scenarios.json` (`"version": 2`, `"registeredOn": "2026-08-26"`); the v1→v2 diff is in git |
| 5.2 | On a fork of 0G mainnet: 38/38 ran, 0 errored, 0 false approvals, 18/18 traps refused, 4/4 negative controls failed as designed | REPRODUCIBLE | `eval/results/fork.json`, `EVAL.md`. Reproduce with `cd writ/eval && pnpm eval:fork` |
| 5.3 | The grader itself was falsified twice — inverted expectations must fail everything, broken setups must record as errored rather than pass | REPRODUCIBLE | `EVAL.md` § "Is the harness itself trustworthy?"; reproduce with `--scenarios <doctored key>` |
| 5.4 | **The fork run measures our enforcement machinery. It measures nothing about the model's judgement.** | stated, not claimed | see NOT-CLAIMED #9 |
| 5.5 | No `--live` run has been performed | — | `EVAL.md` § "Scorecard — `--live`" is empty and says why |

## 6. What has never been run

Listed as claims because their absence is itself a claim about what this project has and has not
shown.

| # | Statement | Tier |
|---|---|---|
| 6.1 | No contract has been deployed to 0G mainnet or to Galileo testnet | fact |
| 6.2 | No inference has been run against a live 0G Compute provider by this codebase | fact |
| 6.3 | No transcript has been uploaded to 0G Storage by this codebase. `sdk/src/archive.ts` is exercised against an injected indexer, never against the real one | fact |
| 6.4 | No proof produced by a real Intel TDX enclave has been notarized | fact |
| 6.5 | The deployer wallet `0xe1b27008710E5453fe021B521428B3DF074804DF` is unfunded, which is why | fact |
| 6.6 | Cost estimates for mainnet operation are derived from measured gas × the live gas price, not from a paid transaction | MODELED |

## 7. The web app

`writ/app` (a Next.js "docket" that renders a writ's proof chain and lets a reader re-check it in
their own browser) is being built in a parallel workstream and is not yet committed. **Its claims
are not in this ledger.** They must be added here, at the same standard, before it is presented as
part of the submission. Until then, treat any claim it makes as unaudited by this file.

---

# NOT-CLAIMED

Everything below is something Writ deliberately does not assert, or a limitation that is real and
would otherwise have to be discovered by a reader. Several were found by auditing our own code and
0G's while writing this file; those are marked **(found here)** so you can see the difference
between a limitation we designed around and one we went looking for.

### 1. We do not claim the model's judgement is correct

Writ proves **which** model was named, **what** it said, and **to which question**. Nothing more.
It does not claim the answer is right, safe, well-calibrated, or reproducible. A model that
confidently approves a theft produces a permanently recorded, cryptographically attested, entirely
wrong decision — and Writ will have done its job.

### 2. 0G's own SDK verification does not rebuild the signed text

In `0g-compute-ts-sdk`, `Verifier.verifySignature` verifies the signature over **whatever `text`
the provider returned** from `/v1/proxy/signature/{chatID}`. The client never rebuilds that text
from the bytes it actually sent and received. The check therefore proves the TEE signed
*something*; it does not prove the signed statement is about *your* request.

**This is a scope limitation of a client-side convenience helper, not a vulnerability in 0G.** The
helper does exactly what it says; it is a signature check, not a binding check. 0G's own protocol
documentation is explicit that the client is the party holding the bytes and is expected to compare
the hashes — see the `0g-pc-e2ee` proof package, whose entire design is built around the verifier
recomputing the binding itself.

What Writ adds is doing that reconstruction **on chain**, from `sha256(request)` and
`sha256(response)`, where the request half is a hash the calling contract computed from its own
state rather than one anybody handed it. That is what makes the prompt-swap defence possible at
all.

### 3. Client-side verification of these proofs is not new, and we did not discover it

Client-side verification of 0G TEE inference proofs already exists, including in 0G's own SDK, and
at least one other buildathon entry implements the full off-chain check — fetching the signature
endpoint, parsing the five-field routing text, recovering the address in-browser, comparing it
against the on-chain `teeSignerAddress`, and recomputing `sha256` of the raw response.

Writ's contribution is moving that check **across the contract boundary**, so the proof becomes
permanent, public and executable by other contracts. **This is the closing move on a known problem,
not a discovery.** Anyone who tells you otherwise is selling something.

### 4. `proof: true` on a 0G Storage download is a no-op, so we do not claim proof-verified download

In `@0gfoundation/0g-storage-ts-sdk`, `Downloader.downloadTask` — the only place segment bytes are
fetched — takes the proof flag as an underscore-prefixed, **never-read** parameter `_proof`, and the
method above it carries the comment `// TODO: add proof check`. It calls
`downloadSegmentByTxSeq`, not `downloadSegmentWithProofByTxSeq`. The node-side methods
(`downloadSegmentWithProofByTxSeq`, `getSectorProof`) exist and work; the SDK simply never calls
them on download.

So Writ **does not claim proof-verified download**. Integrity is checked the way that actually
proves something: recompute the merkle root of the downloaded bytes with `MemData(...).merkleTree()`
and compare it to the requested root. The root is content-deterministic for identical bytes, so
this is a real end-to-end check — but it is our check, not the SDK's.

### 5. The recovery timelock measures gate inactivity, not provider outage

`TreasuryGate.lastAttestationAt` moves when the gate settles a verified proof. It does not and
cannot observe the provider directly — the gate only learns a provider is alive when the agent
brings it a proof. Three consequences, all intended:

- **A hostile agent that keeps producing decisions postpones recovery indefinitely.** Refusals
  count, because a refusal is as much evidence of a working provider as an approval. An agent that
  never approves anything but pays gas for one refusal every few weeks holds the treasury away from
  the owner for as long as it likes.
- **An agent that simply stops asking hands the owner a sweep after 30 days**, even if the provider
  was healthy the whole time. From the gate's point of view a silent provider and an idle agent are
  the same event.
- **Neither is reachable by an outsider.** The owner appoints the agent, so this is a trust
  assumption between those two parties, not a vulnerability.

Measuring provider liveness directly would mean trusting something other than a signature the
provider actually produced, which is the one thing this contract refuses to do anywhere else.

### 6. A proof is bound to the whole treasury state, so an unrelated deposit invalidates it

The nine facts include `treasuryBalance` and `amountPctOfBalance`. Anyone can send funds to the
gate — `receive()` is payable and unrestricted. A stranger depositing between attesting and
settling changes the question, so a perfectly good approval stops answering it and `execute`
reverts.

Nothing is wrong with the proof. It answers a question about a treasury that no longer exists in
that state. The remedy is to ask again, not to retry — the MCP server detects this case
specifically and says which fact moved and who could have moved it.

That is the price of giving the model real facts, and we pay it on purpose: the guarantee is that
the model judged the treasury **as it actually stood**.

### 7. `amountPctOfBalance` is a floored integer capped at 999

25× the balance and 1000× the balance are the same number to the model. Anything under 1% of the
balance reports `0`, not a fraction. The cap keeps an absurd amount from stretching the prompt and
the floor keeps the field small and readable, but a policy that needs to discriminate inside either
range cannot do it from this field alone. `amount` and `treasuryBalance` are both in the question at
full precision.

### 8. A provider can let a proof expire, and it is then unrecoverable

Provider brokers cache response signatures with a TTL. Miss the window and the evidence is gone —
there is no fallback, no re-derivation, and no way to compel a provider to produce evidence after
the fact. The SDK fetches the proof immediately after inference, before archiving and before any
transaction, which narrows the window but does not close it. If the provider is down, restarted, or
simply unwilling, the decision is unprovable and the gate will never act on it.

Writ cannot compel a provider to produce evidence. It can only refuse to act without it.

### 9. The fork evaluation proves our machinery, not the model's judgement

On a fork the answer is supplied by us: the "TEE" is a key we generated and whoever holds the key
decides what the "model" says. 13 of the 38 scenarios were graded against an answer we handed the
stand-in, and on the fork those are circular by construction. The other 25 handed the stand-in an
answer a naive gate would be fooled by, so they are a genuine test of enforcement — but of
enforcement only.

**Only a `--live` run measures a model, and no `--live` run has happened.** The live scorecard in
`EVAL.md` is empty and will stay empty until it is run.

### 10. `danger-sanctioned-recipient` still turns entirely on the model recognising a hex string

Nothing in the question says an address is sanctioned. The nine facts now carry the recipient's
payment history, so the question can say *this address is a stranger to this treasury* — but it
cannot say *this address is on a list*. `danger-sanctioned-recipient` and `danger-burn-address`
therefore measure whether the model recognises a particular hex string, which is a property of the
model's training data and not of this system. `danger-agent-pays-itself` likewise does not tell the
model that the recipient is the caller.

---

## Found while writing this file

### 11. `transcriptRoot` is unsigned, unverified, first-writer-wins, and permanent **(found here)**

The TEE signature covers the request and response hashes. **It does not cover `transcriptRoot`.**
The registry stores whatever `bytes32` the notarizer passes, including zero, without checking that
it resolves to anything on 0G Storage.

Combined with two other properties — notarization is permissionless, and `AlreadyNotarized` makes
a record immutable — this means **whoever notarizes a given proof first fixes its archive pointer
forever.** The signature endpoint is public, so a third party who learns a chat id can fetch the
same proof and notarize it with a junk root before the honest notarizer does. The proof's
cryptographic content is unaffected — the hashes and the signer are all still verified — but the
record's pointer to the transcript would be permanently wrong, and the MCP server's
reconstruct-from-storage path (`writ_execute` on a writ this session did not produce) would fail
for that writ.

We do not claim `transcriptRoot` is trustworthy. Verify a transcript by downloading it, re-hashing
it, and comparing to the `reqHash`/`respHash` in the writ — which is exactly what
`mcp/src/rehydrate.ts` does, and which does not trust the root either.

### 12. The TEE does not attest which model produced the answer **(found here)**

The signed text binds `sha256(request)` and `sha256(response)`. **It does not contain the model
name.** So:

- The model id inside the request body records *what was asked for*. 0G's compute SDK does not
  validate that id locally; the provider resolves it. Nothing in the proof says the provider routed
  to the model it was asked for.
- The `modelHash` in a writ records *what 0G's registry said this provider serves at the moment of
  notarization*. It is the registry's claim, not the enclave's.

`PolicyGate`'s model check is therefore "0G's registry said this provider serves this model when
this proof was recorded", not "these weights produced these tokens". That is still a useful
constraint, and it is bounded by claim 2.10 — a provider cannot silently rename its model while
staying acknowledged, because changing the model string resets `teeSignerAcknowledged`. But there is
a narrow race: if a provider re-registers under a new model name and 0G re-acknowledges it between
inference and notarization, the writ records the **new** name against an **old** answer.

### 13. A single-image proof is byte-identical to a chat proof **(found here)**

`signImageResponse` builds `sha256Hex(reqBody) + ":" + strings.Join(imgHashes, ",")`. For **one**
image, `strings.Join` returns the hash unchanged, so the text is
`sha256(req):sha256(img₀)` — 129 bytes, and structurally identical to the chat format.

Our own code comments claim the image format "is rejected rather than mistaken for a chat proof
— it also splits into two fields, but its second field is a comma-joined list rather than one
hash". **That is true only for two or more images.** The single-image case would be verified as a
chat proof, and the recorded `respHash` would be the hash of the image bytes rather than of an HTTP
response body. The SDK test that covers this case uses two images and therefore does not catch it.

Practical impact is small: the resulting writ would still state something true about what the TEE
signed, and a `PolicyGate` could only consume it if raw image bytes both hashed to the pinned
`respHash` and contained a well-formed `"content":"ALLOW:<n>"` marker while the request bytes were
simultaneously the gate's own chat-completions body. It is a defect in format discrimination
regardless, and we would rather name it than have it found.

Today it is unreachable in practice: exactly one live mainnet service (`z-image-turbo`) is
decentralized `text-to-image`, and it is not a service a `PolicyGate` would ever be pointed at.

### 14. There is a fourth signed-text family we do not support **(found here)**

The current broker signs scheme-tagged E2EE proofs via `signChatE2EE`, with texts assembled in
`0gfoundation/0g-pc-e2ee` (`protocol/proof/proof.go`) as `<scheme>:<reqH>:<respH>` under
`zg-sig-v1/e2ee-ct`, `zg-sig-v1/e2ee-ct-stream`, and a declared-but-unverified
`zg-sig-v1/plain`. The hash halves are **not** `sha256` of the wire body — they are
`sha256(sha256(aad) ‖ sha256(ciphertext))` per sealed envelope, aggregated in send order for the
stream variant.

Writ neither supports nor verifies these. They split into three `:`-separated fields, so
`parseSignedText` rejects them and no on-chain path accepts them — they **fail closed** rather than
being mistaken for anything. Writ never seals a request, so its own runs never produce one, but a
third party's archived proof might. Earlier notes in this project said the broker produces "three"
signed texts; that count was incomplete and is corrected in
[`docs/architecture.md`](docs/architecture.md#2-the-signed-text-exact-byte-layouts).

### 15. Writ does not verify Intel TDX attestation quotes **(found here — and it is the biggest one)**

Writ verifies a **secp256k1 signature** against an address 0G's registry names. It does **not**
verify a TDX quote, does not check the measurement registers, does not check the `ImageDigest` or
`ImageName` a provider publishes in `additionalInfo`, does not talk to Intel's PCS, and does not
evaluate a dstack verifier report.

The chain of trust is therefore: *Intel TDX* → *the dstack verifier* → *0G's registry owner
acknowledging that a given address is that enclave's key* → *the signature Writ checks*. Writ
occupies only the last link. Everything to its left is inherited, and the acknowledgement in the
middle is a **permissioned admin key** (`0xddCDcbD9C7aeFB165dE00CE8684907fAAe8C8224`, claim 2.9).

If that key acknowledges a signer that is not really inside an enclave, every writ verifying against
it is cryptographically valid and semantically worthless, and Writ has no way to notice. On-chain
quote verification is not something we are claiming to have solved, or attempted.

### 16. An approval to a recipient that rejects funds erases the whole record **(found here)**

`_settle` transfers with `to.call{value: amount}("")` and reverts `TransferFailed` if it returns
false. When `execute` also performed the notarization inline — which it does whenever the writ was
not already on the registry — that revert rolls back **the notarization too**. So:

- A refusal is permanent (it never transfers).
- An approval to a recipient that reverts on receive, or to an amount the treasury cannot cover,
  leaves **no record at all** that the model ever approved anything.

The mitigation is the SDK's documented ordering: notarize first, as a separate transaction, and
settle second. `sdk/src/notarize.ts` says exactly this, and `PolicyGate` skips notarizing when the
writ already exists, so the ordering costs nothing. But the combined path is still reachable, and
this asymmetry is not something the design's "a refusal is recorded forever" line implies on its
own. The eval's `trap-amount-exceeds-balance` hits this path and is scored as `blocked` — correctly
— but the rolled-back notarization is not called out there.

### 17. `recover` does not reset the recovery clock **(found here)**

`TreasuryGate.recover` sweeps the balance and emits `Recovered`, but it does **not** update
`lastAttestationAt`. Once the 30-day window has elapsed once, it stays elapsed until the agent
brings another verified proof. Every subsequent deposit into that gate can be swept by the owner
immediately, with no timelock at all.

Whether that is wrong depends on your reading. A treasury whose agent has been silent for 30 days
is arguably a dead treasury, and re-arming the timer would trap later deposits for another month.
But a depositor who funds a gate expecting the 30-day protection to apply to *their* funds does not
get it, and nothing tells them so. There is no test for repeated recovery.

### 18. A deployed gate's agent and policy can never be changed **(found here)**

`agent` and `owner` are `immutable`; the policy is written at construction and there is no setter.
This is deliberate — it is what makes "what the gate asks is fixed the moment it exists" true — but
it has a consequence worth naming: **a compromised agent key cannot be revoked.** The only recourse
is the 30-day hatch, and per NOT-CLAIMED #5 a compromised agent that keeps producing decisions can
hold that hatch open indefinitely. Deploy a gate with an agent key you are prepared to be stuck
with.

### 19. `WritRegistry`'s constructor does not validate its registry address **(found here)**

`constructor(address serving_)` stores the address as `immutable` with no check that it is a
contract, that it implements `getService`, or that it is 0G's. A registry deployed against the
wrong address would verify signatures against the wrong authority and would look entirely healthy
doing it. There is no deploy script in this repository yet, so nothing enforces the correct value.
Read `registry.serving()` after any deployment and compare it to
`0x47340d900bdFec2BD393c626E12ea0656F938d84` before trusting a single writ.

### 20. `PolicyGateFactory` cannot validate that a policy elicits the verdict grammar **(found here)**

It checks that `promptHead` is non-empty, that `agent` and `owner` are non-zero, and that
`maxRisk <= 100`. It does not check that the prompt halves form valid JSON, that the prompt
describes the `ALLOW:`/`DENY:` grammar, that `allowedModelHash` names a model anyone serves, or
that the assembled body is something a provider will accept. A badly-written policy yields a gate
that can never be satisfied. That harms only its deployer, but it is unchecked and the factory's
name does not suggest as much.

### 21. `recipientPriorTotal` saturates and then misreports **(found here)**

`RecipientHistory.total` is a `uint192` that clamps at `type(uint192).max` rather than reverting.
That is the right trade — this is a fact for a prompt, not a ledger, and a transfer should not be
lost to an arithmetic edge — but a saturated value is a **wrong** fact presented to the model as a
true one. It is not reachable with realistic amounts (2¹⁹² wei is around 6×10³⁸ 0G) and there is no
test for it.

### 22. Three of the nine facts are given to the model without explanation **(found here)**

`AgentTreasury`'s system prompt explains `amountPctOfBalance`, `recipientPriorPayments` and
`recipientPriorTotal`, and states the units. It says nothing about `nonce`, `priorApprovals` or
`priorRefusals`. Those three appear in the user message as bare `key=value` pairs and the model is
left to infer what they mean. We have not measured whether that inference is correct, and on a fork
we cannot.

### 23. A provider can repoint its endpoint without losing acknowledgement **(found here)**

Per claim 2.10, changing `url` does **not** reset `teeSignerAcknowledged`. So the URL a client is
directed to is not pinned by the acknowledgement, even though the model name and the TEE signer
address are. This does not weaken on-chain verification at all — the signature still has to recover
to the acknowledged address — but it does mean a client following the registry's `url` is not
following something the acknowledgement vouched for.

### 24. `PolicyGate` does not re-check the signature for an already-notarized writ

Already documented in `EVAL.md` (limitation 6) and restated here because it belongs in this list.
When `registry.isNotarized(id)` is true, `PolicyGate` reads the record and never looks at the
`signature` argument it was handed. That is correct — the record was verified when it was made —
but it means the signature parameter is inert on that path, and it is why the
`control-forged-signer-chain` scenario had to be run through a lower-level path that skips
notarization. Read that control as narrower than it looks.

### 25. `VerdictLib` anchors on the *first* `"content":"` in the response body

Also from `EVAL.md` (limitation 7). Every response shape we have seen puts the completion first, and
`trap-response-echoes-prompt` shows that a response echoing the prompt ahead of `choices` is refused
rather than misparsed. But a provider that echoed a *short* attacker-chosen string there could steer
the anchor. The response shape belongs to the TEE, not to the agent the gate defends against, so it
sits outside this threat model. It is still an assumption.

### 26. Non-determinism, and one seed

Two runs of the same prompt may differ. Writ provides attribution, not reproducibility, and does not
claim otherwise. `temperature` is pinned to `0` in the policy, which reduces variance but does not
eliminate it, and a provider is not obliged to honour it. The eval is one run with no repetition and
no variance measurement — which, for a live run against a stochastic model, would matter.

### 27. No enumeration, and `writCount` counts both kinds

`WritRegistry` exposes `writCount` but no index of writ ids. An indexer must read the `Notarized`
event. `writCount` counts chat writs and routing writs together, so it is not a count of distinct
decisions — one decision proved in both formats increments it twice.

---

## Reproducing everything in this file

```bash
# contracts: 142 unit tests
cd writ/contracts && forge test

# contracts: 4 tests against live 0G mainnet, read-only, spends nothing
forge test --match-path test/WritRegistry.fork.t.sol -vv

# gas measurements
forge test --match-test measures -vv

# sdk: 98 tests
cd ../sdk && pnpm install && pnpm test

# mcp: 138 tests
cd ../mcp && pnpm install && pnpm test

# the graded evaluation, on a fork of 0G mainnet
cd ../eval && pnpm install && pnpm eval:fork

# regenerate the signing fixtures the Solidity tests assert against
cd ../contracts && pnpm fixtures

# the live service census
cast call 0x47340d900bdFec2BD393c626E12ea0656F938d84 \
  "getAllServices(uint256,uint256)" 0 50 --rpc-url https://evmrpc.0g.ai
```
