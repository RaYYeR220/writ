# Five minutes, in order

Everything in this file is read-only. **No credentials, no install, no funds** for the reading
path — every link is a file in this repository. Two optional commands at the end need Foundry and
read 0G mainnet without spending anything.

If you only do one thing: open **[`CLAIMS.md`](CLAIMS.md)** and read the **NOT-CLAIMED** section
first. It is 29 numbered limitations plus four defects we found in our own code and fixed. Several
were found by going looking. If you find one that is not on that list, it is a real miss and we
want it.

---

## Minute 0 — what is and is not being claimed

Writ verifies a 0G Compute TEE inference proof inside a smart contract on 0G, records it
permanently, and lets other contracts act on the verified decision.

**Client-side verification of these proofs is not new and we do not claim it.** It exists in 0G's
own SDK and in at least one other buildathon entry. The contribution is moving the check across
the contract boundary. That is stated in the README and in
[`CLAIMS.md` NOT-CLAIMED #3](CLAIMS.md#3-client-side-verification-of-these-proofs-is-not-new-and-we-did-not-discover-it).

The one precise technical difference — stated as a scope limitation of a client-side convenience
helper, not as a vulnerability in 0G — is
[`CLAIMS.md` NOT-CLAIMED #2](CLAIMS.md#2-0gs-own-sdk-verification-does-not-rebuild-the-signed-text):
`Verifier.verifySignature` verifies over whatever `text` the provider returned. It never rebuilds
that text from the bytes the client actually sent. Writ rebuilds it on chain from
`sha256(request)` and `sha256(response)`.

The evidence tiers used throughout `CLAIMS.md`: **REPRODUCIBLE** (re-runnable from this repo),
**VERIFIED-LIVE** (proven against 0G mainnet, read-only, dated), **MODELED** (reasoned, said out
loud), **NOT-CLAIMED**.

---

## Minute 1 — the ~100 lines that are actually new

[**`contracts/src/WritLib.sol`**](contracts/src/WritLib.sol) — 95 lines, `internal pure`, no
storage, no owner. This is the piece worth reusing on its own.

- [`hex64`](contracts/src/WritLib.sol#L37) — Go's lowercase unprefixed hex, reproduced in Solidity.
  Uppercase would recover a different address and every proof would fail.
- [`signedText`](contracts/src/WritLib.sol#L47) — Format A, `sha256hex(req) ":" sha256hex(resp)`,
  exactly 129 bytes.
- [`recoverSigner`](contracts/src/WritLib.sol#L53) — EIP-191 via OpenZeppelin's
  `MessageHashUtils.toEthSignedMessageHash(bytes)`, then `ECDSA.recover`.
- [`routingProofText`](contracts/src/WritLib.sol#L67) /
  [`recoverRoutingProofSigner`](contracts/src/WritLib.sol#L82) — Format B, the five-field
  centralized routing proof whose fifth field is the upstream's TLS certificate fingerprint.

**What it reproduces, from 0G's Go source rather than from documentation** —
`0gfoundation/0g-serving-broker`, commit `3a2f1a5`:

| Writ | 0G source |
|---|---|
| `WritLib.hex64` | `sha256Hex`, `api/inference/internal/ctrl/signing.go:49-52` |
| `WritLib.signedText` | `signChatWithKey`, `signing.go:101-127` |
| `WritLib.routingProofText` | `FormatRoutingProofText`, `api/common/tee/tls.go:103-106` |
| EIP-191 handling, `v ∈ {27,28}` | `accounts.TextHash` + the `sig[64] += 27` normalisation, `signing.go:107-114` |

**Why the length prefix is the interesting part.** EIP-191 hashes
`"\x19Ethereum Signed Message:\n" ‖ decimal(len) ‖ message`. For Format A that is always `129`,
which is tempting to hardcode. For Format B it is `196 + |providerType| + |providerIdentity|`.
Writ uses OpenZeppelin's `bytes memory` overload so both formats take one code path with no
special case — [`WritLib.t.sol::test_routingProofPrefixCarriesTheDecimalLength`](contracts/test/WritLib.t.sol#L81)
pins it directly: the same signature recovers under `…\n217` and does not under `…\n129`.

Then read the two tests that pin the bytes:

- [`test_signedTextIs129BytesAndMatchesBroker`](contracts/test/WritLib.t.sol#L23)
- [`test_routingProofTextMatchesBrokerFormat`](contracts/test/WritLib.t.sol#L66) — 217 bytes for
  `centralized` / `openrouter`

Fixtures come from [`contracts/script/gen-fixtures.mjs`](contracts/script/gen-fixtures.mjs), which
reproduces the broker's Go signing path in JavaScript. Regenerate with `pnpm fixtures`.

**One we volunteer:** [`test_aSingleImageProofIsByteIdenticalToAChatProof`](contracts/test/WritLib.t.sol#L133).
For one image, `strings.Join([h], ",")` returns `h`, so an image proof is byte-identical to a chat
proof and Writ does **not** discriminate it. Both code comments that used to claim otherwise were
corrected. The indistinguishability cannot be fixed — the bytes are the same. Only the claim was
fixable, and it was. [`CLAIMS.md` NOT-CLAIMED #13](CLAIMS.md#13-a-single-image-proof-is-byte-identical-to-a-chat-proof-found-here).

---

## Minute 2 — where a proof is verified against 0G's real registry

[**`contracts/src/WritRegistry.sol`**](contracts/src/WritRegistry.sol) — ownerless,
non-upgradeable, no allowlist, no privileged submitter. Validity is decided entirely by the
signature and by 0G's own contract.

[`notarize`](contracts/src/WritRegistry.sol#L288) does, in order: compute the id, reject a
duplicate, **`serving.getService(provider)` — a live staticcall on every call, never a cached
copy**, require `teeSignerAcknowledged`, require `verifiability == "TeeML"`, require the recovered
address to equal `teeSignerAddress`, store, emit. [`serving`](contracts/src/WritRegistry.sol#L51)
is `immutable`.

**In your own browser, right now** — 0G's live mainnet registry, no wallet needed:
[`0x47340d900bdFec2BD393c626E12ea0656F938d84` on chainscan](https://chainscan.0g.ai/address/0x47340d900bdFec2BD393c626E12ea0656F938d84).
Call `getAllServices(0, 50)`. Read live on 2026-08-26 for this document: **24 registered services;
22 `TeeML`, of which 19 are acknowledged; 13 of those 19 are `ProviderType: centralized`** and
therefore produce the five-field routing proof, 6 are decentralized with `TargetSeparated: false`
and produce the chat format, 0 are decentralized-and-separated. 3 `TeeML` services are
unacknowledged and 2 are `verifiability: "standard"` with no TEE at all.

The four tests that run against that contract as it actually is —
[`contracts/test/WritRegistry.fork.t.sol`](contracts/test/WritRegistry.fork.t.sol), read-only,
spends nothing:

- [`test_liveTeeProviderIsAcknowledgedAndTeeML`](contracts/test/WritRegistry.fork.t.sol#L29) —
  `0x4870Cb…` serves `0GM-1.0-35B-A3B`, TEE signer `0x8561E0…`, acknowledged
- [`test_rejectsLiveNonTeeProvider`](contracts/test/WritRegistry.fork.t.sol#L38) — a real
  `verifiability: "standard"` service is refused `NotTeeVerifiable`
- [`test_rejectsGarbageSignatureForLiveTeeProvider`](contracts/test/WritRegistry.fork.t.sol#L47)
- [`test_rejectsUnregisteredProvider`](contracts/test/WritRegistry.fork.t.sol#L57) — 0G's own
  `ServiceNotExist` propagates

Two design decisions worth a glance because they are the ones an expert reader will poke at:

- [`struct Writ`](contracts/src/WritRegistry.sol#L31) has **no** `transcriptRoot` field, and
  [`event Notarized`](contracts/src/WritRegistry.sol#L113) carries none. The TEE signs two hashes
  and nothing else; a root is a claim by whoever published it, so it gets its own append-only list
  and its own [`event TranscriptAdded`](contracts/src/WritRegistry.sol#L135).
- [`addTranscript`](contracts/src/WritRegistry.sol#L256) is permissionless with a quota of **4 per
  address per writ**, not a cap on the list. A global cap plus permissionless writes cannot both
  be safe — a griefer would spend the whole list and lock the real archivist out permanently.
  [`test_aFrontRunnersJunkRootDoesNotShutOutTheRealOne`](contracts/test/WritRegistry.t.sol#L313),
  [`test_aGrieferCannotDenyTheRealArchivistASlot`](contracts/test/WritRegistry.t.sol#L334). The
  cost — an unbounded list — is stated as
  [NOT-CLAIMED #27](CLAIMS.md#27-the-transcript-list-is-unbounded-by-design-found-here).

---

## Minute 3 — the prompt-swap defence, and where the refusal is recorded

**The prompt swap.** [`AgentTreasury.t.sol::test_refusesPromptSwap`](contracts/test/AgentTreasury.t.sol#L210)
runs the whole attack. The attacker is the agent itself — the party the gate exists to constrain.
It asks the model a friendly question of its own and gets a **genuine, valid** TEE signature.

1. That proof **notarizes successfully.** It is true. It is an answer to the attacker's question,
   recorded under the attacker's request hash.
2. Re-notarizing it under the *gate's* request hash reverts `BadSignature` — the rebuilt text does
   not match what was signed.
3. Settling at the gate reverts `WritNotNotarized` — the gate computed
   `reqHash = sha256(buildRequestBody(...))` from **its own state**, and no writ exists there.

The caller never gets to say what the question was. That asymmetry is the whole mechanism:
[`PolicyGate._pin`](contracts/src/PolicyGate.sol#L173) computes the request hash itself and only
the response is revealed.

**Where the refusal is recorded.** A refusal is a **successful transaction**, not a revert:

- [`PolicyGate.Refusal`](contracts/src/PolicyGate.sol#L21) — `Model` (the model said `DENY`) or
  `Policy` (the model said `ALLOW` above this gate's ceiling). Both mean no funds moved; they mean
  different things and a reader is told which.
- [`TreasuryGate._settle`](contracts/src/TreasuryGate.sol#L243) — on refusal it advances
  `lastAttestationAt` and the nonce, increments `refusedCount`, emits
  [`TransferRefused`](contracts/src/TreasuryGate.sol#L92), and **returns**.
- Tests: [`test_recordsRefusalOnAttestedDeny`](contracts/test/AgentTreasury.t.sol#L126),
  [`test_recordsRefusalOnAllowAboveCeiling`](contracts/test/AgentTreasury.t.sol#L157).

**The test that shows why notarization is a separate transaction:**
[`test_aRevertingRecipientLeavesTheNotarizationIntact`](contracts/test/AgentTreasury.t.sol#L723).
An approval whose payout reverts rolls back the settlement — and the writ, its transcript
candidate, and its `notarizedBy` all survive. If the gate could notarize inline, refusals would be
permanent and failed approvals would leave nothing, which falsifies "every decision is recorded
forever". [`_consume`](contracts/src/PolicyGate.sol#L116) takes no signature argument, so it
cannot notarize even by accident.

Two more that pin the shape of the guarantee:

- [`test_consumesAProofSomeoneElseNotarized`](contracts/test/PolicyGate.t.sol#L497) — notarizing is
  a public good; you do not have to have done it.
- [`test_consumingDoesNotRecheckTheProvidersLiveStanding`](contracts/test/PolicyGate.t.sol#L473) —
  the provider is downgraded to `standard` and unacknowledged *after* notarization and the writ
  still consumes. **This is the design, not a shortcut:** a permanent record means the check
  happened once, at recording time. Re-deriving it later would make a writ's meaning change with
  the registry's later state. Stated as
  [NOT-CLAIMED #22](CLAIMS.md#22-consuming-a-writ-deliberately-does-not-recheck-the-providers-live-standing--this-is-the-design).

---

## Minute 4 — the evaluation, and what it is worth

[**`EVAL.md`**](EVAL.md). Read the first paragraph before the numbers.

38 scenarios in [`eval/scenarios.json`](eval/scenarios.json), written and committed **before** the
harness was run against them. Raw output in
[`eval/results/fork.json`](eval/results/fork.json) — regenerated by the run and by nothing else.

The committed fork scorecard: 38 ran, 0 errored, **0 false approvals**, 0 false refusals, 8 correct
approvals, 30 correct refusals, 18/18 traps refused, 4/4 negative controls failed as designed, 0
mechanism mismatches; 25 answered adversarially, 13 supplied a correct answer.

**That scorecard measures our enforcement machinery and nothing about model judgement.** On a fork
the "TEE" is a key we generated, and whoever holds the key decides what the "model" says. The
artifact says so about itself: `"modelBehaviourMeasured": false`. **No `--live` run has happened**
— the deployer wallet is unfunded, and `EVAL.md`'s live scorecard is empty and says why.

What the fork run *is* good for, and it is narrower than it sounds: `WritRegistry` verifies
against **0G's real deployed `InferenceServing`** on the fork. The eval's provider was registered
through that contract's own `addOrUpdateService`, paying the stake it actually charges, and
acknowledged through its own `acknowledgeTEESignerByOwner` called from its own owner address.
Exactly one value is substituted — the TEE private key, because an enclave key cannot be
extracted. The precise scope of that claim is written out in
[`MOCKS.md`](MOCKS.md#what-the-tee-key-is-the-single-substituted-value-does-and-does-not-mean).

The harness was also falsified on purpose, twice — inverted expectations must fail everything,
broken setups must record as errored rather than pass. `EVAL.md` § "Is the harness itself
trustworthy?", reproducible with `--scenarios <doctored key>`.

---

## Minute 5 — the honest limitations, in one place

[**`CLAIMS.md`**](CLAIMS.md), NOT-CLAIMED. The ones an expert reader will care about most:

| # | What is not claimed |
|---|---|
| [#15](CLAIMS.md#15-writ-does-not-verify-intel-tdx-attestation-quotes-found-here--and-it-is-the-biggest-one) | **Writ does not verify Intel TDX attestation quotes.** No measurement registers, no `ImageDigest`, no Intel PCS, no dstack report. It verifies a secp256k1 signature against an address 0G's registry names. The chain is TDX → dstack → 0G's registry owner acknowledging the key → the signature Writ checks, and Writ occupies only the last link |
| [#26](CLAIMS.md#26-policygate-checks-the-model-0gs-registry-names-not-the-model-the-request-body-asked-for-found-here) | The TEE signs no model name. `PolicyGate` checks the model **0G's registry** names, not the one the request body asked for, and it cannot |
| [#1](CLAIMS.md#1-we-do-not-claim-the-models-judgement-is-correct) | Writ proves which model was named, what it said, and to which question. It does not claim the answer is right |
| [#11](CLAIMS.md#11-a-transcript-root-is-unsigned-and-unverified--and-the-list-of-them-is-unbounded-found-here-the-first-writer-wins-half-is-now-fixed) | A transcript root is unsigned, unverified, and nobody's fact |
| [#29](CLAIMS.md#29-unavailable-is-not-fail-and-the-distinction-is-load-bearing-found-here) | `unavailable` is not `fail` — grading a failed archive candidate as a failed writ is itself the attack |
| [#28](CLAIMS.md#28-the-factorys-model-scan-is-a-byte-scan-not-a-json-parser-found-here) | The factory's `"model"` scan is a byte scan, not a JSON parser. An escaped spelling passes it. What makes that survivable is structural, not the check |
| [#4](CLAIMS.md#4-proof-true-on-a-0g-storage-download-is-a-no-op-so-we-do-not-claim-proof-verified-download) | `proof: true` on a 0G Storage download is a no-op in the SDK, so we do not claim proof-verified download — we recompute the merkle root instead |
| §6 | **What has never been run**: no deployment, no live TEE inference, no 0G Storage upload or download, no proof from a real enclave notarized |

[`MOCKS.md`](MOCKS.md) is the companion: one table per test surface, naming every substitute and
its path. The last section is a single grep-able list of everything fake in the repository.

**Nothing is deployed.** Every address in this repository is either 0G's own or is literally
`<UNDEPLOYED — no address exists yet>`. There is no placeholder hex anywhere that could be
mistaken for a deployment, and no claim depends on one.

---

## If you want to run something (Foundry only, spends nothing)

```bash
cd writ/contracts
forge build --force        # --force first: a stale artifact silently skips suites
forge test                 # 217 tests passed, 0 failed
```

The suite includes the 4 mainnet fork tests, so it needs network. To run only those:

```bash
forge test --match-path test/WritRegistry.fork.t.sol -vv
```

**Reproduce the gas figures — and note which mode they came from.** These two commands both pass
and they do **not** print the same numbers:

```bash
forge test --match-test measures -vv                  # what a caller pays
forge test --match-test measures -vv --gas-report     # the same calls, plus the report's own
                                                      # instrumentation, charged inside the
                                                      # gasleft() window the test brackets
```

| Operation | `forge test` | `--gas-report` |
|---|---:|---:|
| `WritLib.recoverSigner` | **47,209** | 47,209 |
| `WritLib.recoverRoutingProofSigner` | **69,337** | 69,337 |
| `WritRegistry.notarize`, cold, with a root | **315,325** | 339,161 |
| `WritRegistry.notarizeRoutingProof` | **412,712** | 438,152 |
| `AgentTreasury.execute`, approved | **174,591** | 267,579 |
| `AgentTreasury.execute`, refused | **119,607** | 212,583 |

Read the middle column. Reading the right one as the price overstates `execute` by 53%. We got
this wrong once and shipped a table that did exactly that; the story is
[`CLAIMS.md` 1.9a](CLAIMS.md) and it is why both columns are given everywhere.

A dry run of the real deployment — reads 0G mainnet, broadcasts nothing, costs nothing:

```bash
forge script script/Deploy.s.sol --fork-url https://evmrpc.0g.ai
```

It reads the configured provider off 0G's live registry **before** broadcasting and aborts unless
it is acknowledged `TeeML`, because a gate pointed at a provider that cannot produce verifiable
proofs is bricked from birth.

The rest of the suites, and the local world:

```bash
cd ../sdk  && pnpm install && pnpm test    # 118
cd ../mcp  && pnpm install && pnpm test    # 145
cd ../app  && pnpm install && pnpm test    # 105
cd ../eval && pnpm install && pnpm eval:fork
```

---

## Verifying a writ in a browser

[`app/src/lib/verify.ts`](app/src/lib/verify.ts) resolves a writ into **four independently
checkable rows** — `record`, `provider`, `transcript`, `signature` — each of which is `pass`,
`fail`, or `unavailable` **with a reason**. Those last two are kept apart in the types and on the
screen because they mean opposite things: a `fail` is evidence, an `unavailable` is a missing
measurement. Collapsing them would let a flaky network read as a broken proof — and would hand a
front-runner a way to make a sound writ *read as broken* by publishing a junk archive candidate
first.

The page fetches the transcript from 0G Storage itself, content-addresses it against the merkle
root using [`app/src/lib/zg-merkle.ts`](app/src/lib/zg-merkle.ts) (a browser port of 0G Storage's
root algorithm, not the SDK), re-hashes the bytes to `reqHash`/`respHash`, and recovers the
signature against the on-chain `teeSignerAddress`. It discards the transcript's own
`signingAddress` claim entirely.

**Be told the honest part: that path has never run against live 0G Storage, because nothing is
deployed to point it at.** Every one of its 105 tests stubs `fetch`. `CLAIMS.md` 6.3, 7.3 and 7.5.
Run it locally with `cd app && cp .env.example .env.local && pnpm dev`; with no registry address
set, the app states the gap on the page instead of rendering an empty view that would read as "no
activity yet".

---

## Where to push hardest

If you have time to attack rather than read, these are the seams we would go for, and where the
answers live:

1. **The acknowledgement key.** `CLAIMS.md` 2.9 — a selector scan of the deployed beacon
   implementation's runtime bytecode, corroborated by a fork probe that had to impersonate the
   owner. If `acknowledgeTEESigner()` existed, the whole trust story changes.
2. **What resets acknowledgement.** `CLAIMS.md` 2.10 — probed field by field on a fork. Model
   name, `additionalInfo`, and `teeSignerAddress` reset it; URL and prices do not. That last part
   is a real gap and it is listed as
   [NOT-CLAIMED #21](CLAIMS.md#21-a-provider-can-repoint-its-endpoint-without-losing-acknowledgement-found-here).
3. **The verdict parser.** [`VerdictLib.parseVerdict`](contracts/src/VerdictLib.sol#L19) is a
   marker-anchored scan, not a JSON parser, and it anchors on the **first** `"content":"`. 13 cases
   in [`VerdictLib.t.sol`](contracts/test/VerdictLib.t.sol). A malformed answer **reverts** rather
   than being read as a refusal — reading it as "no" would be inventing a decision the model did
   not make. The anchoring assumption is
   [NOT-CLAIMED #23](CLAIMS.md#23-verdictlib-anchors-on-the-first-content-in-the-response-body).
4. **ABI drift.** `sdk/test/abi.test.ts` and `app/test/abi.test.ts` compile the Foundry project and
   compare selectors, event topic hashes **and return-tuple field names and order**. That last part
   is not optional: a selector is computed over inputs only, so `getWrit(bytes32)` kept its
   selector when `transcriptRoot` left the struct. The methodology note is at the end of
   `CLAIMS.md`.
5. **The gas numbers.** Re-run both modes. If a figure in this repository does not reproduce, that
   is a finding and we would rather have it than not.
