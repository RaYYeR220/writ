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

**The suite is deployed to 0G mainnet and two decisions have settled through it** — see [§6](#6-what-has-been-run-on-mainnet-and-what-still-has-not)
for the addresses, the two writs, and the transcript roots the 0G Storage indexer serves. Everything
in this file that does not carry a mainnet address is still reproducible without one: no key, no
funds, and for most of it no network.

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
| 1.9 | Cold, with a transcript root: `notarize` 315,325 gas, `notarizeRoutingProof` 412,712, `addTranscript` 48,480. Settling a writ that is already recorded: `execute` 174,591 approved / 119,607 refused, `executeRoutingProof` 178,764. **Those are plain `forge test` readings — the number a caller actually pays.** Under `forge test --gas-report` the same `gasleft()` deltas read 339,161 / 438,152 / 81,808 and 267,579 / 212,583 / 273,472, because the report's instrumentation is charged inside the window the test brackets; quote a figure with the mode it came from, and see 1.9a | REPRODUCIBLE, with two caveats below | the `test_measures*` tests, re-run 2026-08-26 after `forge build --force`. **These read a `MockInferenceServing`, so they are lower bounds** — 0G's real registry returns a much larger struct. **Every earlier figure in this row is superseded twice over**, once when notarization left the settle path and once when the transcript root became an append-only list; see 1.9a |
| 1.9a | **Gas measured through `gasleft()` is mode-dependent, and three ceilings had been set from one mode only.** `test_measuresExecuteGas`, `test_measuresRefusalGas` and `test_measuresRoutingProofExecuteGas` closed with `assertLt(used, 200_000)`. Plain `forge test` measured 174,591 / 119,607 / 178,764 and passed; `forge test --gas-report` measured 267,579 / 212,583 / 273,472 for the same three calls and failed all three. The report's instrumentation runs *inside* the `gasleft()` window the test brackets, so the delta is inflated by the harness. Since this file hands a reviewer `--gas-report` to see the figures, the one command we volunteered was the one that went red | fact **(found here, fixed)** | fixed in `bb841dc`: ceilings raised to 300,000 / 250,000 / 320,000 so both modes clear them, and the tests now carry a comment saying they are regression guards rather than pins. Verified after `forge build --force`: `forge test` and `forge test --gas-report` each report **217 passed, 0 failed**. The trap generalises — a `gasleft()` figure is only meaningful next to the mode that produced it, which is why 1.9 now gives both |
| 1.10 | Through 0G's **real** deployed registry, whole-test gas: reaching `BadSignature` 156,778; reaching `NotTeeVerifiable` 186,073; propagating `ServiceNotExist` 50,305; one live `getService` plus assertions 82,189 | VERIFIED-LIVE | `forge test --match-path test/WritRegistry.fork.t.sol` against `https://evmrpc.0g.ai`, 2026-08-26. These are whole-test figures including the tests' own assertions — the fork suite measures behaviour, not gas, and labelling them any other way would overstate them |
| 1.11 | A *successful* notarization against the live registry has never been measured | — | no live TEE proof has been notarized; see §6 |
| 1.12 | Deployment gas: `WritRegistry` 1,827,652; `PolicyGateFactory` 3,245,080; `AgentTreasury` 3,223,947; `TreasuryGate` deployed directly 2,581,551. One `PolicyGateFactory.deployGate` call costs 2,540,262 at the median, which is a whole `TreasuryGate` plus its policy written to storage | REPRODUCIBLE | `forge test --gas-report`, optimizer on at 200 runs |

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
| 2.14 | **A provider's broker may rewrite the request body before forwarding it upstream, and then sign what it forwarded.** Measured live on four acknowledged TeeML providers with a minimal body — `model` and `messages`, nothing `docs/design/request-translation.md` names as translatable. `0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D` (`glm-5.2`) and `0x25F8f01cA76060ea40895472b1b79f76613Ca497` (`openai/gpt-5.4-mini`) signed the exact bytes that were sent. `0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9` (`0GM-1.0-35B-A3B`) and `0xf56fAaf9989aDafDDf26fa5Ffdd03a9A27b38fAE` (`0GM-1.0-35B-A3B-SIA`) signed a different request hash | VERIFIED-LIVE, **dated 2026-08-27** | `cd writ/sdk && pnpm tsx examples/check-provider.ts <provider>`. See NOT-CLAIMED #30 |
| 2.15 | **The response half matched byte for byte on all four.** Response binding was unaffected by translation everywhere it was measured | VERIFIED-LIVE, **dated 2026-08-27** | same command; the `--json` output carries both hashes for each half |
| 2.16 | A translating provider's own answer reports `"model":"0GM-1.0-35B-A3B-0427"` while the registry publishes that provider as serving `0GM-1.0-35B-A3B` — independent corroboration that the broker rewrote the `model` field | VERIFIED-LIVE | the raw response body of the first live mainnet run, 2026-08-27 |
| 2.17 | **Which case a provider is in is a property to measure, not to assume.** It cannot be read from the registry: `verifiability`, `teeSignerAcknowledged` and `teeSignerAddress` are all identical between the two passthrough providers and the two translating ones | VERIFIED-LIVE | `getAllServices(0, 50)` next to the four measurements in 2.14 |

Reproduce the census:

```bash
cast call 0x47340d900bdFec2BD393c626E12ea0656F938d84 \
  "getAllServices(uint256,uint256)" 0 50 --rpc-url https://evmrpc.0g.ai
cd writ/contracts && forge test --match-path test/WritRegistry.fork.t.sol -vv
```

## 3. Contract behaviour

| # | Claim | Tier | Proof |
|---|---|---|---|
| 3.1 | There are **217 contract tests** — 213 unit plus 4 against a live mainnet fork. `forge test` runs all 217 in one command (it includes the fork suite, so it needs network) and reports **217 passed, 0 failed**. `forge test --gas-report` reports the same 217 passed — it did not before `bb841dc`, for the reason in 1.9a | REPRODUCIBLE | `cd writ/contracts && forge build --force && forge test`. Build with `--force` first: a stale artifact can silently skip suites |
| 3.2 | A prompt-swap is rejected: a genuine, valid TEE signature over a *different* question does not satisfy the gate | REPRODUCIBLE | `AgentTreasury.t.sol::test_refusesPromptSwap`, `PolicyGate.t.sol::test_revertsWhenProofIsForADifferentQuestion`, `PolicyGateFactory.t.sol::test_deployedGateRefusesPromptSwap` |
| 3.3 | A refusal is a **successful transaction** that records the refusal permanently, not a revert | REPRODUCIBLE | `AgentTreasury.t.sol::test_recordsRefusalOnAttestedDeny`, `…OnAllowAboveCeiling`; `PolicyGate.t.sol::test_recordsDenyVerdictAsARefusal` |
| 3.4 | The gate names *who* refused — the model, or the policy ceiling overruling a willing model | REPRODUCIBLE | `PolicyGate.t.sol::test_denyIsRefusedByTheModel`, `…test_allowAboveTheCeilingIsRefusedByThePolicy`, `…test_approvedAgreesWithTheRefusalReason` |
| 3.5 | One decision authorises exactly one action, whichever of the two signed-text formats proved it | REPRODUCIBLE | `PolicyGate.t.sol::test_aRoutingProofSpendsTheChatDecisionToo`, `test_aChatProofSpendsTheRoutingDecisionToo`, `test_aRefusalSpendsTheDecisionAcrossFormats` |
| 3.6 | Every failure path has a specific custom error and none of them lets the guarded action through | REPRODUCIBLE | the error table in [`docs/architecture.md`](docs/architecture.md#6-contract-reference); one test per error across `WritRegistry.t.sol`, `PolicyGate.t.sol`, `VerdictLib.t.sol`, `TreasuryGate.t.sol`, `PolicyGateFactory.t.sol` |
| 3.7 | Anyone may notarize any valid proof. There is no allowlist and no privileged submitter | REPRODUCIBLE | `WritRegistry.t.sol::test_anyoneMayNotarize`. `WritRegistry` is ownerless and non-upgradeable — read the source; there is no `owner`, no proxy, no `selfdestruct` |
| 3.8 | A malformed answer reverts rather than being read as a refusal | REPRODUCIBLE | `VerdictLib.t.sol` (13 cases), `AgentTreasury.t.sol::test_refusesMalformedVerdict` |
| 3.9 | The gate's question changes with the balance, the nonce, the approval/refusal history and the recipient's payment history — so a proof is bound to the treasury as it stood | REPRODUCIBLE | `AgentTreasury.t.sol::test_questionChangesWhenTheBalanceChanges`, `…WithTheNonce`, `…WithApprovalAndRefusalHistory`, `…WithRecipientHistory` |
| 3.10 | An attested `ALLOW` to `address(0)` is refused before the proof is even examined | REPRODUCIBLE | `AgentTreasury.t.sol::test_executeRevertsForZeroRecipient`, `…test_executeRoutingProofRevertsForZeroRecipient` |
| 3.11 | The recovery hatch is timelocked, owner-only, and pushed out of reach by any verified proof including a refusal. A successful sweep **restarts** the clock, so the hatch closes behind itself | REPRODUCIBLE | `TreasuryGate.t.sol`, 14 tests, including `test_refusalPostponesRecovery`, `test_failedVerificationDoesNotPostponeRecovery`, `test_recoverRestartsTheClock` and `test_aFailedRecoverDoesNotRestartTheClock` |
| 3.12 | A factory-deployed gate enforces the ceiling, provider and model it was given, and the deployer does not become the owner | REPRODUCIBLE | `PolicyGateFactory.t.sol`, 23 tests |
| 3.13 | **The gate cannot notarize.** `_consume` and `_consumeRoutingProof` take no signature and revert `WritNotNotarized(id)` for a proof that is not already recorded, so an approval whose payout reverts cannot roll the record back with it | REPRODUCIBLE | `AgentTreasury.t.sol::test_aRevertingRecipientLeavesTheNotarizationIntact` — the settlement rolls back, the writ, its transcript candidate and its `notarizedBy` survive, and the decision is not marked consumed. `PolicyGate.t.sol` covers the `WritNotNotarized` path on both formats |
| 3.14 | **A gate cannot ask about one model and accept an answer from another.** The model name that is spliced into `{"model":"…"}` is the same string `allowedModelHash` is derived from, in one shared implementation | REPRODUCIBLE | `PromptLib.sol`; `PolicyGateFactory.t.sol::test_theModelInTheQuestionIsTheModelTheGateAccepts`, `…test_splicesWhateverModelNameItIsGiven`, `…test_aDeployedGateRefusesAWritForADifferentModel`; `PromptLib.t.sol`, 15 tests |
| 3.15 | A caller cannot smuggle a second `"model"` key into either prompt half, and cannot end the JSON string literal from inside a model name | REPRODUCIBLE | `PromptLib.t.sol::test_refusesAModelKeyInTheHead`, `…InTheTail`, `…test_refusesAQuoteInTheModelName`, `…ABackslashInTheModelName`, `…AControlByteInTheModelName`. Read NOT-CLAIMED #28 for what the `"model"` scan does **not** promise |
| 3.16 | Nobody can be denied a transcript slot. A griefer with one address spends 4 candidates and no more; the real archivist always has room, and a reader re-derives its way past the junk | REPRODUCIBLE | `WritRegistry.t.sol::test_aGrieferCannotDenyTheRealArchivistASlot`, `test_aFrontRunnersJunkRootDoesNotShutOutTheRealOne`, `test_theQuotaIsPerWritNotPerAddress`, `test_addTranscriptRejectsADuplicateFromAnySubmitter` |
| 3.17 | The deploy script refuses to broadcast against a provider that is not acknowledged `TeeML`, or whose model name cannot be spliced into the pinned JSON | REPRODUCIBLE | `Deploy.t.sol`, 11 tests, including `test_refusesAProviderThatIsNotTeeML`, `test_refusesAProviderWhoseSignerIsNotAcknowledged`, `test_refusesAProviderTheRegistryHasNeverSeen`, `test_refusesAModelNameThatCannotBeSpliced` |

## 4. SDK and MCP server

| # | Claim | Tier | Proof |
|---|---|---|---|
| 4.1 | 134 SDK tests and 145 MCP tests pass, counted 2026-08-28 | REPRODUCIBLE | `cd writ/sdk && pnpm test`; `cd writ/mcp && pnpm test`. One of the 134 (`sdk/test/chain.test.ts`, "reads the live 0G mainnet registry's TEE providers through the SDK ABI") makes a real mainnet read, so the SDK suite needs network |
| 4.2 | The SDK never hashes a re-serialized object. What is hashed is the exact wire bytes | REPRODUCIBLE | `sdk/src/inference.ts` reads the response with `res.text()` and hashes it as-is; `sdk/test/hashes.test.ts`, `sdk/test/inference.test.ts` |
| 4.3 | The SDK refuses a streaming request before any network call, because a stream has no single signable body | REPRODUCIBLE | `sdk/src/inference.ts::assertNotStreaming`; eval scenario `trap-streaming-request` |
| 4.4 | The SDK's and the app's hand-written ABIs match the compiled artifacts — every selector, every event topic hash, **and the field names and order of every returned struct** | REPRODUCIBLE | `sdk/test/abi.test.ts` compiles the Foundry project and compares; `app/test/abi.test.ts` does the same for the browser ABIs. The return-shape half is not optional — see the methodology lesson at the end of this file for the drift it exists to catch |
| 4.5 | The SDK verifies a proof locally *before* archiving and before any transaction, so a run that cannot be proved costs nothing | REPRODUCIBLE | `sdk/src/attest.ts`; `sdk/test/attest.test.ts` (12 tests) covers the ordering |
| 4.6 | The SDK claims the proof immediately after inference, before the archive, because the chat id expires | REPRODUCIBLE | `sdk/src/attest.ts` ordering; `sdk/test/attest.test.ts` |
| 4.7 | The signed text — not a loose field, not configuration — decides which format was used | REPRODUCIBLE | `sdk/src/hashes.ts::parseSignedText`, `sdk/src/notarize.ts::notarizeProof`; `sdk/test/routing.test.ts` |
| 4.8 | A locally-computed 0G Storage merkle root is compared against the indexer's before anything is notarized | REPRODUCIBLE | `sdk/src/archive.ts::uploadTranscript`; `sdk/test/archive.test.ts` |
| 4.9 | An archived transcript is self-consistent before it is uploaded, and re-derivable from public data alone afterwards | REPRODUCIBLE | `sdk/src/archive.ts::assertSelfConsistent`; `mcp/src/rehydrate.ts::verifyArchivedTranscript`, which ignores the transcript's own `signingAddress` and anchors on `InferenceServing` |
| 4.10 | The MCP server mirrors `VerdictLib` byte-for-byte, so it can say what the gate will do before spending gas | REPRODUCIBLE | `mcp/src/verdict.ts`; `mcp/test/verdict.test.ts` |
| 4.11 | The MCP server detects a proof gone stale against the gate's live state and says *why* — including "a stranger deposited into the treasury" — instead of retrying | REPRODUCIBLE | `mcp/src/question.ts::explainDrift`, `mcp/src/tools/execute.ts::driftAgainst`; `mcp/test/execute.test.ts` (26 tests) |
| 4.12 | The MCP server keeps the 0G SDKs' `console.log` off `stdout`, which would otherwise corrupt the JSON-RPC stream | REPRODUCIBLE | `mcp/src/stdio-guard.ts`; `mcp/test/stdio-guard.test.ts` |
| 4.13 | An outcome is read from the emitted event, never inferred from the fact that a transaction mined | REPRODUCIBLE | `mcp/src/tools/execute.ts::decisionFrom`; a missing decision event is reported as an error, not guessed |
| 4.14 | `checkProviderPassthrough` measures whether a provider's broker forwards a request body unmodified, and distinguishes `passthrough`, `response-only` and `unusable`. It never reports `passthrough` on incomplete evidence: an unreachable provider, an unfetchable proof, an unparseable signed text and a signature that does not recover to the registered TEE signer all come back as `unusable` with the reason | REPRODUCIBLE | `sdk/src/passthrough.ts`; `sdk/test/passthrough.test.ts` (16 tests) covers each refusal separately, including a proof whose halves both match but whose signature is a stranger's |
| 4.15 | The check verifies the signature **before** comparing hashes, and against the TEE signer 0G's registry publishes — never against the address the provider volunteers | REPRODUCIBLE | `sdk/src/passthrough.ts`; `sdk/test/passthrough.test.ts`, "refuses a proof signed by anyone other than the registered TEE signer" |
| 4.16 | The check refuses to spend anything on a provider the registry already disqualifies — not TeeML, signer not acknowledged, or the zero signer — so a disqualified provider costs one `eth_call` and no tokens | REPRODUCIBLE | `sdk/test/passthrough.test.ts` asserts no `fetch` call is made in each of those three cases |

## 5. The evaluation

| # | Claim | Tier | Proof |
|---|---|---|---|
| 5.1 | 43 scenarios, written and committed **before** the harness was run against them | REPRODUCIBLE | `eval/scenarios.json` (`"version": 4`, `"registeredOn": "2026-08-26"`) — 9 `safe`, 9 `dangerous`, 21 `trap`, 4 `control`. Every version diff is in git: v2 rewrote the key for the nine-fact question, v3 for the notarize/settle split, v4 added five centralized-routing scenarios and made recipient addresses seed-derived. **No `expected` value has ever been weakened in any revision** — what moved was the predicted *mechanism*, and `EVAL.md` names every prediction that was rewritten |
| 5.2 | On a fork of 0G mainnet: 43/43 ran, 0 errored, 0 skipped, 0 false approvals, 0 false refusals, 9 correct approvals, 34 correct refusals, 21/21 traps refused, 4/4 negative controls failed as designed, 0 mechanism mismatches; 28 scenarios answered adversarially and 15 supplied a correct answer | REPRODUCIBLE, and **dated — see 5.6** | `eval/results/fork.json` (fork block 42720784, finished `2026-08-26T20:38:30Z`), `EVAL.md`. Reproduce with `cd writ/eval && pnpm eval:fork`. **Independently re-run on 2026-08-26 against a different fork block (42722755) via `npx tsx run.ts --fork --out <elsewhere>`, and the scorecard came back byte-identical** — so this row reproduces across blocks, not only from the committed artifact. The artifact self-describes: it records the fork block, its start and finish timestamps, `inferenceServingIsLiveContract: true`, `modelBehaviourMeasured: false`, and the public recipient seed |
| 5.3 | The grader itself was falsified twice — inverted expectations must fail everything, broken setups must record as errored rather than pass | REPRODUCIBLE | `EVAL.md` § "Is the harness itself trustworthy?"; reproduce with `--scenarios <doctored key>` |
| 5.4 | **The fork run measures our enforcement machinery. It measures nothing about the model's judgement.** | stated, not claimed | see NOT-CLAIMED #9. `fork.json` records `modelBehaviourMeasured: false` in the artifact itself |
| 5.5 | No `--live` run has been performed | — | `EVAL.md` § "Scorecard — `--live`" is empty and says why |
| 5.6 | **A scorecard is only valid for the contract and harness revision it ran against, and this one has been superseded twice.** The first committed run (block 42693145, 2026-08-26T13:16:49Z) predated the reshape that moved notarization out of the settle path and turned the transcript root into an append-only list. `eval/run.ts` still called the six-argument `execute`, so it **stopped reproducing silently** — a stale artifact keeps reading fine. It was brought forward and re-run at block 42716521 under answer key v3. That run has since been superseded in turn, deliberately this time, by v4: five centralized-routing scenarios added and recipient addresses made seed-derived. The run 5.2 reports is block **42720784** (2026-08-26T20:38:30Z) | fact, stated because the first failure mode is invisible | The artifact records its own fork block, timestamps and answer-key version, so a reader can check provenance without trusting this row. **The rule that follows: after any change to a contract or to the harness, `eval/results/fork.json` must be regenerated before it is cited — and every document quoting it re-swept in the same commit.** A scorecard that no longer reproduces looks exactly like one that does. **This row's own siblings drifted for exactly that reason and it is worth admitting:** `CLAIMS.md` and `MOCKS.md` sat at 38 scenarios for a while after `EVAL.md` and the artifact had moved to 43. Two honesty documents disagreeing is worse than either number, and the second half of the rule above exists because of it |

## 6. What has been run on mainnet, and what still has not

This section used to be a list of things that had never happened. It is kept in the same place
because the shape of the claim has not changed — what a project has *not* done is as much a claim
as what it has — but the first five rows are now the other way round. All read live from chain
16661 on **2026-08-28**.

| # | Statement | Tier |
|---|---|---|
| 6.1 | The suite is deployed to 0G mainnet: `WritRegistry` `0x857D288652e4f4523347EFf1918B9E1263A574f4`, `PolicyGateFactory` `0x4320Ae51D672f2636a0faFfb2B28C5520013b6D7`, `AgentTreasury` `0x2688059e106195941F320110bE2d5fe9a1c75fEE` | VERIFIED-LIVE |
| 6.2 | Inference has been run against a live 0G Compute provider by this codebase, and two writs are on the registry — `0x3d5c0087…` (`ALLOW:15`, 0.01 0G released) and `0xf2009042…` (`DENY:95` on 1.9 0G, held). Both are chat-format proofs from provider `0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D`, notarized 2026-08-28 | VERIFIED-LIVE |
| 6.3 | Transcripts have been uploaded to 0G Storage and read back from it. Each of the two writs lists one transcript root, and `GET https://indexer-storage-turbo.0g.ai/file?root=0x74cb4118…` / `…?root=0x312a8684…` return the archived JSON | VERIFIED-LIVE |
| 6.4 | A proof from a provider 0G's registry publishes as acknowledged TeeML has been notarized on mainnet, and it recovers to the `teeSignerAddress` that registry names. **Whether the hardware behind that key is a genuine Intel TDX enclave is still not something Writ checks** — see NOT-CLAIMED #15 | VERIFIED-LIVE for the signature; the quote is unverified |
| 6.5 | **The first mainnet `AgentTreasury`, `0xaF9C87f5Eb7c3c5ebb16AcBa23C6cD25faCcAd63`, can never settle a decision.** It is pinned to a provider whose broker translates the request, so the hash it rebuilds on chain will never be the hash the enclave signed. It is deliberately not hidden: it is the artifact that surfaced NOT-CLAIMED #30, and the redeployment at `0x2688059e…` is pinned to a provider that was measured first | fact |
| 6.6 | No contract has been deployed to Galileo testnet | fact |
| 6.7 | Gas figures in this file are still measured gas × the live gas price rather than a reconciliation of what the mainnet transactions actually cost | MODELED |

## 7. The web app

`writ/app` is committed: a Next.js 16 / React 19 "docket" over four routes — `/` (every decision
across every gate), `/writ/[id]` (one writ's proof chain, four independently checkable rows plus a
live tamper demo), `/studio` (compose a policy, deploy a gate), and `/gate/[address]` (one
treasury: balance, policy, ledger, recovery countdown).

| # | Claim | Tier | Proof |
|---|---|---|---|
| 7.1 | 139 app tests pass, counted 2026-08-29 | REPRODUCIBLE | `cd writ/app && pnpm test`. **No app test touches a network** — `fetch` is stubbed and chain reads go through an injected source surface |
| 7.2 | The app's hand-written ABIs match the compiled artifacts, including the return shape of `getWrit` and the absence of a `transcriptRoot` field | REPRODUCIBLE | `app/test/abi.test.ts` |
| 7.3 | A reader re-checks a writ **in their own browser**: the transcript bytes are fetched from 0G Storage, content-addressed against the merkle root, re-hashed to `reqHash`/`respHash`, and the signature is recovered against the on-chain `teeSignerAddress` | REPRODUCIBLE; the two live writs exercise it end to end | `app/src/lib/verify.ts`, `app/src/lib/storage.ts`, `app/src/lib/zg-merkle.ts`; `app/test/verify.test.ts` (24), `app/test/storage.test.ts` (9) — all against stubbed `fetch`, so the *tests* touch no network. The live path is 6.3 |
| 7.4 | The app carries its own port of 0G Storage's merkle-root algorithm rather than shipping the storage SDK to the browser | REPRODUCIBLE, with the caveat in 7.5 | `app/src/lib/zg-merkle.ts`; `app/test/zg-merkle.test.ts`, 8 vectors across 12 tests |
| 7.5 | **Those 8 vectors are frozen constants, not a live comparison against the storage SDK.** They were captured from `@0gfoundation/0g-storage-ts-sdk@1.2.11` and committed as hex, so the test catches a regression in our port but would **not** catch a change upstream in the SDK | fact **(found here, comment fixed)** | `app/test/zg-merkle.test.ts` imports only `vitest` and the local module. `zg-merkle.ts`'s header used to claim the port was "checked against that package directly, so a change upstream shows up as a failing test"; it now says what the test actually does. The vectors are frozen on purpose — `app` does not depend on the storage SDK (it is installed only under `sdk/`), and pulling its Node-only dependencies into the app to re-derive a hash was not worth it. Re-capture them if the SDK version moves |
| 7.6 | Studio shows request-binding compatibility as a **third state**, separate from verdict colour and from the achromatic proof channel, and never runs the check itself — it costs a billed inference request, so the page hands over the command and takes the measurement back | REPRODUCIBLE | `app/src/lib/passthrough.ts`, `app/src/components/Studio.tsx`; `app/test/passthrough.test.ts` (14 tests), including one asserting that no state is ever described as broken or failed |
| 7.7 | An unmeasured provider is shown as unmeasured. The app never defaults a provider to passing | REPRODUCIBLE | `app/test/passthrough.test.ts`, "reports nothing at all for a provider nobody has measured" |
| 7.8 | The docket watches gates the factory did not deploy, and reports a configured address that does not answer as a gate rather than listing it with no decisions | REPRODUCIBLE | `app/src/lib/docket.ts::discoverGates`; `app/test/docket.test.ts` (7 tests) |

---

# NOT-CLAIMED

Everything below is something Writ deliberately does not assert, or a limitation that is real and
would otherwise have to be discovered by a reader. Several were found by auditing our own code and
0G's while writing this file; those are marked **(found here)** so you can see the difference
between a limitation we designed around and one we went looking for.

**Everything in this list is live.** Four defects that used to be here were fixed rather than
documented, and they have moved to [Found here, and since
fixed](#found-here-and-since-fixed) — where they read as history, not as caveats. Nothing in the
numbered list below is a defect we have already closed.

### 1. We do not claim the model's judgement is correct

Writ proves **which** model was named, **what** it said, and **to which question**. Nothing more.
It does not claim the answer is right, safe, well-calibrated, or reproducible. A model that
confidently approves a theft produces a permanently recorded, cryptographically attested, entirely
wrong decision — and Writ will have done its job.

### 2. 0G's own SDK verification does not rebuild the signed text

In `0g-compute-ts-sdk` v0.9.0 (repo `0gfoundation/0g-compute-ts-sdk` at `3e833e2`, read
2026-08-26), `Verifier.verifySignature` (`src.ts/sdk/inference/broker/verifier.ts:883`) verifies
the signature over **whatever `text` the provider returned** from
`/v1/proxy/signature/{chatID}` — its only caller,
`src.ts/sdk/inference/broker/response.ts:98`, passes `ResponseSignature.text` straight through.
The client never rebuilds that text from the bytes it actually sent and received. The check
therefore proves the TEE signed *something*; it does not prove the signed statement is about
*your* request.

**0G's own documentation draws the same line, which is the best evidence that this is scope and
not oversight.** `0gfoundation/0g-doc` at `df02a0c`,
`docs/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution.md`,
lists four steps for verifying from scratch. The fourth is *"Confirm the signed `text` matches the
response content you received from the Router."* `processResponse` performs the first three and
cannot perform the fourth: its signature is
`processResponse(providerAddress, chatID?, content?)`, and `content` is a usage JSON used to
compute the fee. The request and response bodies never enter the function, so there is nothing in
scope for it to compare.

**This is a scope limitation of a client-side convenience helper, not a vulnerability in 0G.** The
helper does exactly what it says; it is a signature check, not a binding check. 0G's own protocol
documentation is explicit that the client is the party holding the bytes and is expected to compare
the hashes — see the `0g-pc-e2ee` proof package, whose entire design is built around the verifier
recomputing the binding itself. `protocol/proof/proof.go` documents `BindingHash` as "the single
definition of the convention; the broker and the client MUST both route through it … so the bytes
cannot drift", and marks `signing_address` as "a HINT for logging only — verification MUST anchor
on the on-chain acknowledged `teeSignerAddress`".

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
decides what the "model" says. 15 of the 43 scenarios were graded against an answer we handed the
stand-in, and on the fork those are circular by construction. The other 28 handed the stand-in an
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

### 11. A transcript root is unsigned and unverified — and the list of them is unbounded **(found here; the first-writer-wins half is now fixed)**

The TEE signature covers the request and response hashes. **It does not cover a transcript root.**
The registry has no way to check that a `bytes32` resolves to anything on 0G Storage, and it does
not try.

**What was found, and fixed.** The registry used to store one root, in the `Writ` struct, chosen by
whoever notarized. Combined with two other properties — notarization is permissionless, and
`AlreadyNotarized` makes a record immutable — that meant **whoever notarized a given proof first
fixed its archive pointer forever**, and because the signature endpoint is public and
unauthenticated, that could be a stranger who learned a chat id and published junk. The proof's
cryptographic content was unaffected, but the archive pointer was permanently wrong and nothing
could correct it.

`Writ` no longer has a root field and `Notarized` no longer carries one. Roots are an append-only
list — `addTranscript`, `transcriptRoots`, `transcriptRootCount`, `transcriptRootAt`,
`transcriptSubmitter`, `transcriptQuotaUsed`, event `TranscriptAdded` — with a per-submitter quota
of `MAX_ROOTS_PER_SUBMITTER = 4`. A wrong first root is now noise, not damage.

**What is still true, and is a design consequence rather than a defect.** A root is still a claim
by whoever published it, and this is what remains NOT-CLAIMED:

- **Nothing here vouches for any root.** `transcriptSubmitter` gives attribution, not endorsement.
  Verify a transcript by downloading it, re-hashing it, and comparing to the `reqHash`/`respHash`
  in the writ, which is what `mcp/src/rehydrate.ts` does and which trusts no pointer.
- **The list has no ceiling.** See NOT-CLAIMED #27 for why a ceiling would be worse.
- **A consumer that finds no verifying candidate must say `unavailable`, not `fail`.** See
  NOT-CLAIMED #29.

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

Our code comments used to claim the image format "is rejected rather than mistaken for a chat proof
— it also splits into two fields, but its second field is a comma-joined list rather than one
hash". **That is true only for two or more images.** The single-image case would be verified as a
chat proof, and the recorded `respHash` would be the hash of the image bytes rather than of an HTTP
response body. The SDK test that covers this case uses two images and therefore does not catch it.

**Both wrong comments have since been corrected** — `WritLib`'s NatSpec in
`contracts/src/WritLib.sol` and `parseSignedText`'s doc comment in `sdk/src/hashes.ts`. Neither now
claims a discrimination it does not perform; both say the single-image case is indistinguishable
and that nothing downstream depends on telling them apart. `WritLib.t.sol::test_aSingleImageProofIsByteIdenticalToAChatProof`
and `…test_aMultiImageProofCannotBeReadAsAChatProof` pin both halves. **The underlying
indistinguishability is not fixed and cannot be — the bytes are identical.** Only the claim about
it was wrong, and only the claim was fixable.

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

### 16. A deployed gate's agent and policy can never be changed **(found here)**

`agent` and `owner` are `immutable`; the policy is written at construction and there is no setter.
This is deliberate — it is what makes "what the gate asks is fixed the moment it exists" true — but
it has a consequence worth naming: **a compromised agent key cannot be revoked.** The only recourse
is the 30-day hatch, and per NOT-CLAIMED #5 a compromised agent that keeps producing decisions can
hold that hatch open indefinitely. Deploy a gate with an agent key you are prepared to be stuck
with.

### 17. `WritRegistry`'s constructor does not validate its registry address **(found here)**

`constructor(address serving_)` rejects `address(0)` with `ZeroServing()` — that one case was worth
catching, because it is what a missing environment variable produces and it would otherwise deploy
a registry that fails silently on every proof. **Nothing else is checked.** The address is stored
`immutable` with no check that it is a contract, that it implements `getService`, or that it is
0G's. A registry deployed against a wrong non-zero address would verify signatures against the
wrong authority and would look entirely healthy doing it.

Two things narrow this, neither of them a check inside the constructor. `script/Deploy.s.sol` now
exists and reads a real service off the configured address before broadcasting, so a wrong address
aborts the deployment rather than producing a dead registry — but the script is not the only way to
deploy, and nothing forces its use. So the standing advice holds: read `registry.serving()` after
any deployment and compare it to `0x47340d900bdFec2BD393c626E12ea0656F938d84` before trusting a
single writ.

### 18. `PolicyGateFactory` cannot validate that a policy elicits the verdict grammar **(found here)**

It checks that `spec.promptHead` is non-empty, that `agent` and `owner` are non-zero, that
`spec.maxRisk <= 100`, and — since the `GateSpec` reshape — that the model name can be safely
spliced and that neither prompt half carries a `"model"` key. It does **not** check that the prompt
halves form valid JSON, that the prompt describes the `ALLOW:`/`DENY:` grammar, that
`spec.modelName` is a model anyone actually serves, or that the assembled body is something a
provider will accept. A badly-written policy yields a gate that can never be satisfied. That harms
only its deployer, but it is unchecked and the factory's name does not suggest as much.

### 19. `recipientPriorTotal` saturates and then misreports **(found here)**

`RecipientHistory.total` is a `uint192` that clamps at `type(uint192).max` rather than reverting.
That is the right trade — this is a fact for a prompt, not a ledger, and a transfer should not be
lost to an arithmetic edge — but a saturated value is a **wrong** fact presented to the model as a
true one. It is not reachable with realistic amounts (2¹⁹² wei is around 6×10³⁸ 0G) and there is no
test for it.

### 20. Three of the nine facts are given to the model without explanation **(found here)**

`AgentTreasury`'s system prompt explains `amountPctOfBalance`, `recipientPriorPayments` and
`recipientPriorTotal`, and states the units. It says nothing about `nonce`, `priorApprovals` or
`priorRefusals`. Those three appear in the user message as bare `key=value` pairs and the model is
left to infer what they mean. We have not measured whether that inference is correct, and on a fork
we cannot.

### 21. A provider can repoint its endpoint without losing acknowledgement **(found here)**

Per claim 2.10, changing `url` does **not** reset `teeSignerAcknowledged`. So the URL a client is
directed to is not pinned by the acknowledgement, even though the model name and the TEE signer
address are. This does not weaken on-chain verification at all — the signature still has to recover
to the acknowledged address — but it does mean a client following the registry's `url` is not
following something the acknowledgement vouched for.

### 22. Consuming a writ deliberately does not recheck the provider's live standing — **this is the design**

Not a caveat. State it as the rule it is: **a permanent record means the check happened once, at
recording time.**

`WritRegistry` checks the TEE signature, the provider's `TeeML` verifiability and 0G's
acknowledgement of its signer at the moment a proof is recorded. `PolicyGate` then reads that
record and re-checks none of it — it cannot, because since notarization left the settle path there
is no signature argument to check anything against. `_consume` takes `(policyId, params,
rawResponse, provider)` and nothing else.

That is deliberate, and re-deriving it later would be the bug. A writ's meaning would change with
the registry's later state: a proof recorded while 0G vouched for its provider would stop reading
as a proof the moment 0G stopped vouching, and the "permanent public record" would be permanent
only until someone else's opinion moved. A writ says what a named signer signed at a named moment.
It stays saying that.

So read the gate's model check for exactly what it is: the writ names this policy's provider and
model, and its answer obeys the verdict grammar. It does **not** assert that 0G still acknowledges
that provider today. `PolicyGate.t.sol::test_consumingDoesNotRecheckTheProvidersLiveStanding` pins
the behaviour directly — the provider is downgraded to `verifiability: "standard"` and
unacknowledged *after* notarization, and the writ still consumes.

The consequence for the evaluation is unchanged and still worth naming: `control-forged-signer-chain`
exercises a lower-level path, because at the gate there is no signature left to forge. Read that
control as narrower than its name suggests. Previously documented as `EVAL.md` limitation 6.

### 23. `VerdictLib` anchors on the *first* `"content":"` in the response body

Also from `EVAL.md` (limitation 7). Every response shape we have seen puts the completion first, and
`trap-response-echoes-prompt` shows that a response echoing the prompt ahead of `choices` is refused
rather than misparsed. But a provider that echoed a *short* attacker-chosen string there could steer
the anchor. The response shape belongs to the TEE, not to the agent the gate defends against, so it
sits outside this threat model. It is still an assumption.

### 24. Non-determinism, and one seed

Two runs of the same prompt may differ. Writ provides attribution, not reproducibility, and does not
claim otherwise. `temperature` is pinned to `0` in the policy, which reduces variance but does not
eliminate it, and a provider is not obliged to honour it. The eval is one run with no repetition and
no variance measurement — which, for a live run against a stochastic model, would matter.

### 25. No enumeration, and `writCount` counts both kinds

`WritRegistry` exposes `writCount` but no index of writ ids. An indexer must read the `Notarized`
event. `writCount` counts chat writs and routing writs together, so it is not a count of distinct
decisions — one decision proved in both formats increments it twice.

### 26. `PolicyGate` checks the model 0G's **registry** names, not the model the request body asked for **(found here)**

This is the limitation that survived the factory fix, and it is a 0G-level trust assumption we
cannot close at our layer. It belongs beside #15's acknowledgement key.

`WritRegistry` records `keccak256(bytes(svc.model))` — the model string 0G's `InferenceServing`
says this provider serves. `PolicyGate` compares the policy's `allowedModelHash` against that. It
does **not** compare against the `"model"` field inside the request body that was actually posted,
and it cannot: the TEE signs the request and response hashes and no model name at all, so nothing
in the proof would contradict a provider that served something else.

**Concretely.** If a provider's endpoint honours a `model` field differing from its registration,
the request can name one model, the endpoint can answer with another, and the writ still records
the *registered* name while the gate still accepts.

The factory change (#F3 below) made the **question's** model trustworthy: a gate cannot ask about
one model and accept an answer attributed to another, because both halves come from one string.
This entry is the other half, and it is untouched: the **answer's** model is only as trustworthy as
0G's registration. Claim 2.10 bounds it — a provider cannot silently rename its registration and
stay acknowledged — but "cannot rename its registration" is a strictly weaker statement than "must
serve what it registered", and only the first is enforced by anything.

### 27. The transcript list is unbounded, by design **(found here)**

`MAX_ROOTS_PER_SUBMITTER = 4` is a quota per **address**, not a cap on the list. That trades a
lockout for growth, on purpose.

A global cap plus permissionless writes cannot both be safe: a griefer spends the whole list on
distinct junk roots and the real archivist is locked out forever, which is the front-running the
mechanism exists to defeat, only worse and permanent. With a per-address quota a griefer exhausts
nothing but their own and every honest publisher always has room.

**The cost, stated plainly: one attacker with N addresses can publish 4N candidates.** Nobody is
denied a slot — that was the actual attack — but `transcriptRoots(id)` can be grown until loading
it whole is expensive. That is precisely why `transcriptRootCount(id)` and
`transcriptRootAt(id, i)` exist: a caller that cannot bound its own gas walks the list instead of
loading it. We do not claim the list is cheap to read in the presence of a determined sybil. We
claim nobody can be shut out of it, and we prefer that trade, because an unbounded read costs gas
and a permanent lockout costs the archive.

Bounding the list at all reintroduces the lockout. There is no third option that keeps both.

### 28. The factory's `"model"` scan is a byte scan, not a JSON parser **(found here)**

`PromptLib.requireNoModelKey` searches the author's prompt halves for exactly the seven bytes
`0x22 6D 6F 64 65 6C 22`. **An escaped spelling passes it.** A JSON key written `"model"` is
twelve different bytes, contains none of that needle, and every JSON parser resolves it to the key
`model`. The scan misses it.

**Do not read the scan as a guarantee, because it is not one.** What makes a smuggled key
survivable is structural, not the check: `allowedModelHash` is derived from `modelName` alone. So a
smuggled second key can make a provider run a different model, and the writ then comes back
carrying that other model's hash, and the gate refuses every single one. **The result is a dead
gate, not a lying one** — it harms its own deployer and nobody else.

The scan is there to catch the accident and the obvious attempt. The guarantee is the shared
string.

### 29. `unavailable` is not `fail`, and the distinction is load-bearing **(found here)**

A transcript candidate that does not re-derive is **somebody's failed claim, not evidence against
the writ.**

This has to be said out loud because grading it the other way is an attack. Anyone may publish a
candidate. If a consumer reported "verification failed" when a candidate did not re-derive, a
front-runner could make a perfectly sound writ *read as broken* by publishing junk first — the
exact griefing the append-only list was built to defeat, re-entering through the report instead of
the storage.

So the rule, everywhere a consumer touches the archive: try candidates in submission order, stop at
the first that re-derives, and if none does, report **`unavailable` with a reason** — never a pass,
never a fallback to a weaker check, never a failure attributed to the writ. The writ was verified
by signature recovery against 0G's registered TEE signer, independently of every pointer. The
archive is a convenience for reconstructing the bytes; it is not, and must never become, part of
the trust chain.

### 30. On-chain request binding requires a provider whose broker forwards the body unmodified **(found on live mainnet)**

**Writ does not claim that its prompt-swap defence works against every 0G provider. It works
against a provider that passes the request through, and which providers do is measured rather than
assumed.**

0G's broker accepts a portable OpenAI-schema chatbot request and, before forwarding it upstream,
rewrites certain fields into the third-party schema the target model actually understands —
`0gfoundation/0g-serving-broker`, `docs/design/request-translation.md`. The document names
`max_tokens` ↔ `max_completion_tokens`, `reasoning_effort` mapped into one of five upstream
dialects, and notes that "model validation may already have rewritten" the `model` field to the
upstream id. Translation is driven by the model's advertised `supportedParameters`. The broker then
signs **the translated body**. The same document says that a model advertising nothing translatable
gets its body passed through untouched.

`TreasuryGate.execute` rebuilds the exact request bytes on chain and derives the writ id from
`sha256` of them. Where the broker translates, the enclave signed a hash of bytes no contract can
reproduce, so the writ the gate computes is not the writ the proof supports and the decision can
never settle. **Response binding is unaffected** — the response is hashed exactly as delivered — so
what is lost is the ability to prove *which question was asked*, which is the entire prompt-swap
defence.

**How it was found.** On the first live end-to-end run against 0G mainnet, 2026-08-27, the SDK's own
guard refused to notarize: `provider signed "2dbfc853…:af714102…", which is not this request and
response`. Probing the halves separately, `sha256(response)` matched byte for byte and
`sha256(request)` did not. Naive reconstructions were tried and rejected — the model id swapped to
the versioned form, a `JSON.parse` round trip, an added `stream:false`, and combinations. The
transformation is not something a contract can reproduce.

**The measurement**, taken the same day with a minimal body carrying nothing translatable:

| provider | model | request | response |
|---|---|---|---|
| `0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9` | `0GM-1.0-35B-A3B` | differs | matches |
| `0xf56fAaf9989aDafDDf26fa5Ffdd03a9A27b38fAE` | `0GM-1.0-35B-A3B-SIA` | differs | matches |
| `0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D` | `glm-5.2` | **matches** | matches |
| `0x25F8f01cA76060ea40895472b1b79f76613Ca497` | `openai/gpt-5.4-mini` | **matches** | matches |

**Response binding held on every provider tested.** Two of four passed the request through. Nothing
in the registry distinguishes the two groups: all four are acknowledged TeeML with a non-zero TEE
signer. That is why `checkProviderPassthrough` exists and why Studio shows an unmeasured provider
as unmeasured rather than as fine.

**This is a property of 0G's broker, not a defect we worked around, and only an on-chain
reconstruction could have surfaced it.** 0G's own client-side check cannot see it: as NOT-CLAIMED #2
sets out, `Verifier.verifySignature` verifies the signature over whatever `text` the provider
returned, so a translated request still reads as verified. **That is a scope limitation of a
client-side convenience helper, not a vulnerability** — the helper is a signature check, not a
binding check, and 0G's own documentation says the client is the party holding the bytes. What
changes here is that rebuilding the request *inside the contract* turns a scope limitation into a
visible one: the contract had to compute the hash itself, and the moment it did, the divergence had
nowhere to hide.

Two consequences are carried in the code rather than in this paragraph. A `passthrough` verdict is
a measurement of the body that was actually sent, so it does not license adding `max_tokens` or
`reasoning_effort` to a gate's prompt afterwards — `translatableFields` exists to notice that. And
the first mainnet deployment is pinned to a translating provider and is kept rather than removed;
see 6.5.

---

## Found here, and since fixed

These were real defects in this codebase, found by auditing it. They are recorded because a ledger
that only lists what is still broken is not an honesty ledger — and because a reader deserves to
see what a claim of "we went looking" actually produced. **Each of these is fixed in the shipping
contracts and pinned by a named test.** They are not live limitations.

### F1. An approval to a recipient that rejected funds used to erase the whole record

`_settle` transfers with `to.call{value: amount}("")` and reverts `TransferFailed` if it returns
false. When `execute` also performed the notarization inline — which it did whenever the writ was
not already recorded — that revert rolled back **the notarization with it**. The asymmetry:

- A refusal was permanent (it never transfers).
- An approval to a recipient that reverts on receive, or to an amount the treasury could not cover,
  left **no record at all** that the model ever approved anything.

That falsifies the project's central claim. "Every decision is recorded forever" cannot survive a
path where failed approvals are the one kind of decision that vanishes, and the mitigation at the
time was a documented SDK ordering — a convention, not a guarantee.

**Fixed structurally.** `PolicyGate._consume` and `_consumeRoutingProof` no longer notarize and no
longer take a signature; they require the writ to already exist and revert `WritNotNotarized(id)`
otherwise. `TreasuryGate.execute` and `executeRoutingProof` lost their trailing
`bytes signature, bytes32 transcriptRoot` arguments as a consequence. Notarizing is now its own
transaction, so nothing the guarded action does can reach the record.
Pinned by `AgentTreasury.t.sol::test_aRevertingRecipientLeavesTheNotarizationIntact`: the
settlement rolls back, the writ and its transcript candidate survive, and the decision is not
marked consumed. See also claim 3.13.

### F2. `recover` used to leave the recovery clock elapsed

`TreasuryGate.recover` swept the balance and emitted `Recovered` without updating
`lastAttestationAt`. Once the 30-day window had elapsed once, it stayed elapsed until the agent
brought another verified proof — so every later deposit into that gate could be swept immediately,
with no timelock at all, and nothing told a depositor so.

**Fixed.** `recover` now sets `lastAttestationAt = block.timestamp` before transferring, so the
hatch closes behind itself and the agent gets a fresh full delay to bring the gate back to life. A
sweep is the owner acting on the gate, so it counts as activity exactly as a decision does.
Pinned by `TreasuryGate.t.sol::test_recoverRestartsTheClock`, with
`test_aFailedRecoverDoesNotRestartTheClock` covering the case where the sweep itself reverts.

### F3. A gate could ask about one model and accept an answer from another

The worst of the three, because every check passed while it happened. `AgentTreasury` spelled its
model inside `promptHead` and took `allowedModelHash` as a separate constructor argument;
`PolicyGateFactory.deployGate` took a whole `PolicyGate.Policy` with the same two fields
independent. A caller could name one model in the pinned JSON and set an unrelated
`allowedModelHash`, producing a gate whose question and whose acceptance rule disagreed —
**and nothing on chain could reconcile them afterwards**, because `PolicyGate` compares the hash
against 0G's registry and never reads the prompt.

**Fixed by making the mismatch unrepresentable rather than validating against it.** Everything that
builds a gate now takes a model **name**: `deployGate(GateSpec spec, address agent, address owner)`
with `GateSpec { string modelName; bytes promptHead; bytes promptTail; address allowedProvider;
uint8 maxRisk; }`, and `AgentTreasury`'s constructor taking `string modelName` in position 4. The
splice and its four errors live in one place, `contracts/src/PromptLib.sol`, which both come
through — because two copies of this rule is how the defect happened. `allowedModelHash` is derived
from that same string. `AgentTreasury`'s `PROMPT_MODEL` constant and the exported
`AGENT_TREASURY_PROMPT_MODEL` were removed, and the deploy script's
`ModelIsNotTheOneThePromptNames` guard was removed because it became structurally unable to fire.
Pinned by `PolicyGateFactory.t.sol::test_theModelInTheQuestionIsTheModelTheGateAccepts` and
`test_aDeployedGateRefusesAWritForADifferentModel`; see claim 3.14.

**This closed one half of the model problem, not both.** NOT-CLAIMED #26 is the half that remains.

### F4. Whoever notarized first used to fix the archive pointer forever

Covered in full at NOT-CLAIMED #11, which is where a reader looking for the surviving limitation
will go. In short: the root lived in the `Writ` struct, notarization is permissionless, and records
are immutable, so a stranger who learned a chat id could notarize with a junk root and the real
archivist had nowhere to put the true one. Roots are now an append-only candidate list with a
per-submitter quota. What remains is #11, #27 and #29 — a root is still nobody's fact.

### A methodology lesson worth recording: **ABI drift tests must compare return shapes, not selectors**

Not a contract defect — a defect in how we were checking for contract defects, and it nearly cost
us silently.

A function selector is computed over the **input** types only. So when `transcriptRoot` left the
`Writ` struct, `getWrit(bytes32)` **kept the identical selector**. A drift test that compares
selectors — which is the obvious thing to write, and what we had — passes cleanly across a change
that reshapes what the function returns. Three positional decodes in the app would have rendered
wrong values, in the wrong fields, with **no throw and no failing test**: a shorter tuple simply
decodes into fewer variables and the trailing ones read as undefined.

The rule that follows: an ABI fidelity test has to assert the **return tuple's field names and
order**, and event **argument lists**, not only selectors and topic hashes. Topic hashes are the
same trap in the other direction — an event's topic covers its full signature, so it does catch a
removed field, but a selector never will. Claim 4.4 is written against this standard now.

---

## Reproducing everything in this file

```bash
# contracts: 217 tests (213 unit + 4 against live mainnet). Build with --force first —
# a stale artifact silently skips suites. Expect 217 passed, 0 failed.
cd writ/contracts && forge build --force && forge test

# contracts: the 4 tests against live 0G mainnet on their own, read-only, spends nothing
forge test --match-path test/WritRegistry.fork.t.sol -vv

# gas measurements. Both commands pass; they do not print the same numbers, and claim 1.9
# gives both. The first is what a caller pays, the second is that plus the report's own
# instrumentation, which is charged inside the gasleft() window the tests measure.
forge test --match-test measures -vv
forge test --match-test measures -vv --gas-report

# deployment gas and the per-function min/median/max tables
forge test --gas-report

# a dry run of the deployment. Reads 0G mainnet, broadcasts nothing, costs nothing.
forge script script/Deploy.s.sol --fork-url https://evmrpc.0g.ai

# sdk: 134 tests (one makes a real mainnet read)
cd ../sdk && pnpm install && pnpm test

# mcp: 145 tests, no chain at all
cd ../mcp && pnpm install && pnpm test

# app: 139 tests, no network at all
cd ../app && pnpm install && pnpm test

# the graded evaluation, on a fork of 0G mainnet. Regenerate this after ANY change to a
# contract the harness calls — see claim 5.6 for the time it silently stopped reproducing.
cd ../eval && pnpm install && pnpm eval:fork

# regenerate the signing fixtures the Solidity tests assert against
cd ../contracts && pnpm fixtures

# the live service census
cast call 0x47340d900bdFec2BD393c626E12ea0656F938d84 \
  "getAllServices(uint256,uint256)" 0 50 --rpc-url https://evmrpc.0g.ai
```
