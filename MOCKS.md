# MOCKS — the real-versus-simulated line

What in this repository talks to the real thing, and what stands in for it. One table per test
surface, no rounding in our favour.

The rule we held ourselves to: **anything on the 0G side that can be reached read-only, is
reached.** 0G's deployed `InferenceServing` is read live rather than mocked wherever a fork is
available; its provider registration and acknowledgement rules are exercised through that
contract's own functions rather than reimplemented; and the signed-text formats are reproduced from
the broker's Go source rather than from documentation.

The rule we could not hold: **a real Intel TDX key cannot be extracted from an enclave.** So
anywhere an enclave signature is needed without a funded mainnet ledger, the TEE *key* is
substituted — and that one substitution is the reason a fork run says nothing about model
behaviour.

The third rule, added because we broke it once: **describe what the code does, not what the tests
happen to exercise.** An earlier version of this file said the real 0G Storage uploader was reached
only from `--live`. It is reached from the MCP server's ordinary runtime with no flag at all — the
tests just never let it. The honest line is "never run", which is a claim about history; "only
reachable from `--live`" was a claim about the code, and it was false. Both rows have been
rewritten.

Last reviewed: 2026-08-26. Nothing has been deployed to 0G mainnet.

---

## The short version

| 0G component | Status |
|---|---|
| 0G Chain — `InferenceServing` at `0x47340d900bdFec2BD393c626E12ea0656F938d84` | **REAL.** Read live on mainnet by the fork tests, and used as the actual registry (`addOrUpdateService`, `acknowledgeTEESignerByOwner`, `getService`) by the fork evaluation |
| 0G Chain — a real registered TEE provider (`0x4870Cb…`, `0GM-1.0-35B-A3B`, signer `0x8561E0…`) | **REAL, but only read.** Its registration is read live and asserted against. It has never answered a request from this codebase |
| 0G Chain — Writ's own contracts | **REAL** compiled bytecode, freshly deployed on the fork. Never deployed to mainnet |
| 0G Compute — the TEE signing key | **SUBSTITUTED** everywhere. On the fork evaluation's registry path it is the *only* substituted value, which is a narrower claim than it sounds — read [what that scope does and does not mean](#what-the-tee-key-is-the-single-substituted-value-does-and-does-not-mean) |
| 0G Compute — the signed text format | **REAL.** Reproduced byte-for-byte from broker source; the Solidity tests assert against fixtures generated from it |
| 0G Compute — the provider HTTP surface | **STAND-IN** in tests: a local server implementing `/v1/proxy/chat/completions` and `/v1/proxy/signature/{chatId}` |
| 0G Storage — upload | **NOT YET EXERCISED.** Real code, never run. `sdk/src/archive.ts` uses the real `@0gfoundation/0g-storage-ts-sdk` and defaults to the real mainnet turbo indexer; the MCP server calls it that way with no flag. **No upload has ever been performed by this codebase** |
| 0G Storage — download | **NOT YET EXERCISED.** Two independent real implementations: `mcp/src/runtime.ts` constructs a real `Indexer` and calls `downloadToBlob`, and `app/src/lib/storage.ts` does a raw browser `GET {indexer}/file?root=…`. Both re-derive the merkle root of what came back. **Neither has ever been run against the live indexer** |
| 0G Storage — the merkle root arithmetic | **REAL in `sdk/` and `mcp/`** (`MemData(...).merkleTree()` from the real SDK, exercised by real tests against a stubbed indexer). **PORTED in `app/`** — `app/src/lib/zg-merkle.ts` reimplements it for the browser rather than shipping the SDK, and its tests compare against frozen vectors, not against the package |

**Read those rows carefully, and note what changed.** An earlier version of this file said "`--live`
calls the real uploader and nothing else does." **That was wrong.** The MCP server's production
runtime constructs the real `Indexer` against `https://indexer-storage-turbo.0g.ai` for both upload
and download, with no `--live` guard, and the web app fetches transcript bytes from that indexer
directly in the browser. The real integration is broader than that sentence admitted.

What is true — and it is the claim that matters — is that **no upload and no download executes in
any test**. Every test injects a stub or stubs `fetch`. Outside the tests, the SDK's uploader has now
run for real: both mainnet writs list a transcript root that
`https://indexer-storage-turbo.0g.ai/file?root=…` serves. The app's browser-side downloader and the
MCP server's have not been pointed at it. The correct statement is "not exercised by any test", not
"only reachable from `--live`".

---

## 1. Contract unit tests — `writ/contracts`, 213 tests

Run as part of `forge test`, which executes all **217** contract tests (213 here plus the 4 fork
tests in §2) and reports **217 passed, 0 failed**. `forge test --gas-report` reports the same; it
did not always, and why it did not is worth reading in `CLAIMS.md` 1.9a before you re-measure any
gas figure. Build with `forge build --force` first; a stale artifact silently skips suites.

These 213 need no network and no funds.

| Piece | Real or substituted | Detail |
|---|---|---|
| `WritLib`, `VerdictLib`, `PromptLib`, `WritRegistry`, `PolicyGate`, `TreasuryGate`, `AgentTreasury`, `PolicyGateFactory` | **REAL** | the shipping source, compiled by `solc 0.8.24` |
| `script/Deploy.s.sol` | **REAL** | `Deploy.t.sol` drives `deploy(Config)` directly, so the provider checks run without the process environment. The broadcast itself is Foundry's, against a local chain |
| `InferenceServing` | **SUBSTITUTED** | `test/mocks/MockInferenceServing.sol` — a five-argument `set` and a `getService` that reverts `ServiceNotExist` the way the live contract does. It reproduces the fields `WritRegistry` reads and nothing else, so gas here is a lower bound |
| TEE signature | **REAL cryptography, substituted key** | Foundry's `vm.sign` over the exact EIP-191 digest, and static fixtures produced by `script/gen-fixtures.mjs` with key `0x11…11` |
| The signed text | **REAL** | `gen-fixtures.mjs` reproduces `api/inference/internal/ctrl/signing.go` and `api/common/tee/tls.go::FormatRoutingProofText` in JavaScript. The Solidity assertions are against the resulting strings, character by character |
| Response bodies | **REAL shape, hand-written** | `{"id":…,"choices":[{"message":{"content":"ALLOW:12"}}]}` — the OpenAI-compatible shape, written as literal bytes because the signature is over wire bytes |
| Transcript roots | **NOT MODELLED AT ALL** | the registry treats a root as an opaque `bytes32` it cannot check, so the tests pass literals like `bytes32(uint256(0xBEEF))`. Nothing here stands in for 0G Storage because nothing here reads it — see `CLAIMS.md` #11 |

## 2. Contract fork tests — `writ/contracts`, 4 tests

`forge test --match-path test/WritRegistry.fork.t.sol -vv`. Read-only against 0G mainnet. **Spends
nothing.**

| Piece | Real or substituted |
|---|---|
| Chain state | **REAL** — `vm.createSelectFork("zg")` against `https://evmrpc.0g.ai`, chain 16661 |
| `InferenceServing` | **REAL** — 0G's deployed contract at its real address, with its real storage |
| Provider registrations | **REAL** — `0x4870Cb…` (acknowledged TeeML) and `0xd3f02c1a…` (`verifiability: "standard"`) are read as they actually are |
| `WritRegistry` | **REAL** bytecode, deployed onto the fork |
| Signatures | not needed — these four tests assert the registry checks, the `ServiceNotExist` propagation, and that garbage is rejected |

**Nothing in this suite is mocked.** It is the only place in the repository where every input is
0G's own.

## 3. SDK tests — `writ/sdk`, 134 tests

`pnpm test`.

| Piece | Real or substituted | Detail |
|---|---|---|
| Chain | **REAL anvil, forked when reachable** | `test/helpers/anvil.ts` prefers `anvil --fork-url https://evmrpc.0g.ai`; falls back to a bare local chain when there is no network, and **reports which one it got** so a test can say what it proved |
| Writ contracts | **REAL** | compiled by `forge` into a private artifact directory and deployed by `ethers.ContractFactory` |
| `InferenceServing` | **REAL when forked**, otherwise `MockInferenceServing` | |
| Live mainnet read | **REAL** | one test (`chain.test.ts`, "reads the live 0G mainnet registry's TEE providers through the SDK ABI") queries mainnet directly through the SDK's hand-written ABI |
| 0G Compute provider | **STAND-IN** | `test/helpers/provider-stub.ts` — a real `node:http` server on localhost implementing `POST /v1/proxy/chat/completions` and `GET /v1/proxy/signature/{chatId}`, which signs `sha256hex(request):sha256hex(response)` over **the exact bytes it received**. It can also be told to expire proofs, to sign the five-field routing text, or to sign an arbitrary pair (i.e. forge a proof for a different question) |
| TEE key | **SUBSTITUTED** | an `ethers.Wallet` the test holds |
| A translating broker | **STAND-IN** | `test/passthrough.test.ts` stubs `fetch` with a provider that can be told to sign a request hash over bytes the client never sent — the live behaviour of NOT-CLAIMED #30, reproduced offline. The real measurement is made by `examples/check-provider.ts`, which is not part of the suite because it spends money |
| 0G Storage | **SUBSTITUTED** | `IndexerLike` is injected. The merkle-root computation itself is real (`MemData(...).merkleTree()` from the real SDK); only the network upload is replaced |
| ABI fidelity | **REAL** | `abi.test.ts` compiles the Foundry project and compares every function selector and event topic hash against the hand-written ABIs |

The provider stub is a stand-in for the *service*, not for the *format*. It signs the same bytes a
real broker signs, over the same wire bytes, with the same EIP-191 prefix — which is what makes the
raw-byte discipline genuinely exercised rather than merely asserted.

## 4. MCP server tests — `writ/mcp`, 145 tests

`pnpm test`. **No chain at all, and no network at all.**

| Piece | Real or substituted |
|---|---|
| The MCP server, its four tools (`writ_attest`, `writ_execute`, `writ_lookup`, `writ_preview_question`), its error handling | **REAL** — the shipping source, driven over a real `StdioClientTransport` in `server.test.ts` |
| `WritDeps` (chain, compute, storage) | **SUBSTITUTED** — `test/helpers/world.ts`, a fully in-memory implementation of the injectable dependency surface |
| Writ ids, decision keys, the routing domain tag | **REAL** — recomputed in the harness with `ethers.AbiCoder` and `keccak256` to match the contracts exactly |
| `AgentTreasury`'s prompt head and tail | **REAL, verbatim** — copied from the contract source, so the tests exercise the prompt that actually ships |
| The nine-fact question | **REAL** — rendered by `src/question.ts`, the same code the server uses |
| TEE signatures | **REAL cryptography, substituted key** — fixed `ethers.Wallet`s, so a failure names the same addresses every run |
| 0G Storage transcripts | **SUBSTITUTED** — serialized with the real `serializeTranscript` from the SDK, then handed back in memory. The harness can also return a *missing* or a *tampered* transcript, which `rehydrate.ts` must reject |
| 0G Storage **roots**, in this harness | **SUBSTITUTED, and differently shaped** — `world.ts` returns `ethers.keccak256(bytes)`, a keccak256 of the serialized transcript, **not** a 0G merkle root. It is a real commitment to real content and it round-trips, which is all these tests need; it is not the value the real uploader would produce |

**The production runtime this harness replaces is real, and reaches the network.**
`mcp/src/runtime.ts` constructs a real `@0gfoundation/0g-storage-ts-sdk` `Indexer` against
`https://indexer-storage-turbo.0g.ai` for both upload and download, with no flag guarding it, and
re-derives the merkle root of anything it downloads before trusting the bytes. **It has never been
executed against the live indexer**, because there is nothing deployed to point it at — but the
line here is "never run", not "not wired".

This suite deliberately has no chain: it tests the server's decisions, not the contracts'. The
contracts are tested by suites 1 and 2, and the two are joined by suite 3.

## 4a. Web app tests — `writ/app`, 139 tests

`pnpm test`. **No chain, no network, nothing stubbed out at the module boundary that is not named
here.**

| Piece | Real or substituted |
|---|---|
| The app itself — the docket, the writ detail page with its four checkable rows, the studio, the gate page | **REAL** — the shipping Next.js 16 / React 19 source |
| Chain reads | **SUBSTITUTED in tests** — `app/src/lib/verify.ts` takes an injected `VerifySources`, and `app/src/lib/sources.ts::chainSources` (the real ethers implementation) is not exercised by any test |
| 0G Storage download | **SUBSTITUTED in tests** — `vi.stubGlobal('fetch', …)`. The shipping `app/src/lib/storage.ts` does a real `GET {indexer}/file?root=…` and content-addresses the result; that path now has live data to run against — both mainnet writs list a root the indexer serves (see `CLAIMS.md` 6.3) |
| The merkle root algorithm | **PORTED, not imported** — `app/src/lib/zg-merkle.ts` reimplements `AbstractFile.merkleTree` / `MerkleTree.build` for the browser rather than shipping the storage SDK. `app/package.json` does not depend on that SDK |
| The 8 merkle vectors | **FROZEN CONSTANTS** — `app/test/zg-merkle.test.ts` compares against committed hex, **not** against the real package. A regression in our port fails this suite; an upstream change in the SDK would not. `zg-merkle.ts`'s header used to claim otherwise and now says what the test does; see `CLAIMS.md` 7.5 |
| ABI fidelity | **REAL** — `app/test/abi.test.ts` compiles the Foundry project and compares selectors, event topic hashes **and return-tuple shapes**, including an explicit assertion that `getWrit` no longer carries a `transcriptRoot` |
| Request-binding compatibility | **A DATED RECORD, NOT A MEASUREMENT THE APP MAKES** — the four entries in `app/src/lib/passthrough.ts` are the live mainnet run of 2026-08-27, typed in by hand. The page labels them as such, and labels a measurement pasted in from the CLI differently. The app never runs the check itself, because it is a billed inference request; see `CLAIMS.md` 7.6 |
| Signature recovery, hashing | **REAL** — ethers in the browser, against the on-chain `teeSignerAddress` |

## 5. The graded evaluation, `--fork` mode — `writ/eval`, 43 scenarios

`pnpm eval:fork`. Read-only RPC against 0G mainnet. **Spends nothing.**

> **A note on provenance, because it has bitten this file twice.** The first committed scorecard
> was taken at block 42693145, before the contracts were reshaped, and it kept reading perfectly
> while quietly no longer reproducing — the harness was still calling the old six-argument
> `execute`. It was brought forward and re-run at block 42716521 under answer key v3. The harness
> then moved again, deliberately: answer key **v4** added five centralized-routing scenarios and
> made recipient addresses seed-derived. **This file lagged that second move** and described a
> 38-scenario run while the artifact and `EVAL.md` had gone to 43 — the same drift in a different
> guise, and the reason `CLAIMS.md` 5.6 now says every document quoting the scorecard must be
> re-swept in the same commit. The table below describes the current committed run, block
> **42720784**.

This is the surface where the real/substituted line matters most, so it is spelled out step by step.

| Piece | Real or substituted | Detail |
|---|---|---|
| Chain | **REAL 0G mainnet state** | `anvil --fork-url https://evmrpc.0g.ai`, forked at block 42720784 for the current committed run. The artifact records the block, so the number here is checkable rather than asserted. Re-running picks a fresh head block and the scorecard is unchanged by it — verified on 2026-08-26 at block 42722755 |
| `InferenceServing` | **REAL — 0G's deployed contract** | `WritRegistry` is constructed against `0x47340d900bdFec2BD393c626E12ea0656F938d84` on the fork. Not a mock |
| Reading a real provider | **REAL** | before anything else, the harness reads `0x4870Cb…` off the fork and records what it says: `0GM-1.0-35B-A3B`, `TeeML`, signer `0x8561E0a9dA3C8d6591A2E756a91334f1a3E537e0`, acknowledged |
| **Registering the eval's provider** | **REAL registry logic, impersonated caller** | the harness impersonates a provider address on the fork and calls **0G's own `addOrUpdateService`**, paying the stake the registry actually charges — read out of the registry's own revert data rather than hardcoded, and 100 0G for the committed run. It then impersonates **the registry's own owner** (`0xddCDcbD9C7aeFB165dE00CE8684907fAAe8C8224`) and calls **0G's own `acknowledgeTEESignerByOwner`**. It then re-reads `getService` and refuses to proceed unless the registration actually took |
| **The TEE signing key** | **SUBSTITUTED — and this is the only substituted value in the registry path** | a key the harness generated. Everything `WritRegistry` checks — the `TeeML` requirement, the acknowledgement requirement, the signer comparison — runs against 0G's real contract logic against a real registration. Only the private key behind `teeSignerAddress` is ours |
| The model's answer | **SUPPLIED BY US** | a local stand-in returns the content the answer key specifies. Whoever holds the key decides what the "model" says. This is why the fork scorecard is silent on model behaviour |
| Writ contracts | **REAL** | `forge build`, then deployed onto the fork |
| Provider HTTP endpoint | **STAND-IN** | same shape as the SDK's stub |
| 0G Storage | **SUBSTITUTED** | `eval/env.ts::forkTranscriptRoot` returns `'0x' + sha256(JSON.stringify(transcript))` instead of a merkle root — and not even over `serializeTranscript`'s bytes. It is at least a real commitment to real content, but it is **not** a 0G Storage root, and it is a third differently-shaped stand-in alongside the SDK's real `MemData` root and `world.ts`'s keccak256 |
| Recipient addresses | **REAL addresses, deterministically derived** | `eval/recipients.ts` derives each one as `keccak256("<seed> <scenarioId> <role>")` from the committed fork seed `writ-eval-fork-recipients-v1`, rather than `ethers.Wallet.createRandom()`. The gate cannot tell the difference — it formats whatever address it is handed — but the run becomes reproducible address for address, and the keys survive the run so `sweep.ts` can return the funds. **A `--live` run must supply its own `WRIT_RECIPIENT_SEED`**; it will not reuse the committed one. The seed is published in the artifact under `recipients.seed` |
| Fallback | **DECLARED** | if the fork RPC is unreachable the harness falls back to a bare chain and `MockInferenceServing`, and prints that under `environment facts`. **That fallback did not happen in the committed run** — `eval/results/fork.json` records `"inferenceServingIsLiveContract": true` |

The harness keeps its own copy of the nine-fact question so it can post one the gate did not build
— that is how the stale-nonce and doctored-facts probes work. Before it doctors anything it renders
the *honest* facts and compares them byte for byte against `buildParams`, refusing to run the probe
if they differ, so a formatting bug of ours can never be mistaken for the gate's binding holding.

28 of the 43 scenarios hand the stand-in an **adversarial** answer — the one a naive gate would be
fooled by. Those are a real test of the enforcement machinery even on the fork. The other 15 hand it
the answer a correct model *would* give; those grade the plumbing and nothing else, and
`eval/scenarios.json` records which is which per scenario.

## 6. The graded evaluation, `--live` mode — **never run**

`WRIT_LIVE_CONFIRM=1 pnpm eval:live`. It is written, it typechecks, the same 43 scenarios feed it,
and it has never been executed.

| Piece | What it would use |
|---|---|
| Chain | 0G mainnet, chain 16661 |
| `InferenceServing` | the same real contract, no impersonation |
| Provider | a real registered TEE provider, answering from inside an Intel TDX enclave |
| TEE key | the provider's real hardware key — **nothing substituted** |
| 0G Storage | the real `archiveTranscript`, against `https://indexer-storage-turbo.0g.ai` |
| Contracts | Writ's contracts, deployed on mainnet |
| Recipient addresses | derived from an operator-supplied `WRIT_RECIPIENT_SEED` — **never the committed fork seed** — so the funds a live run moves are recoverable with `pnpm eval:sweep` instead of burnt to addresses nobody holds a key for |

Not all 43 run live. **2 always report as skipped**, because they need a signer we control:
`trap-response-echoes-prompt` (a TEE willing to sign a body we composed) and
`control-forged-signer-sdk` (a provider endpoint that signs with the wrong key). Their on-chain
equivalents do run, so neither property goes unmeasured. **A further 5 skip unless `WRIT_PROVIDER`
is a centralized provider** — those are the routing-proof scenarios. So a live run grades 41 of 43
against a centralized provider and 36 of 43 against a decentralized one, and every skip is printed
with its reason and counted as a skip, never as a pass.

The contracts a live run needs now exist on mainnet, so what remains is funding: `--live` spends
real 0G on inference and storage for every scenario, and it refuses to start without
`WRIT_LIVE_CONFIRM=1` for exactly that reason. A live run must also be pointed at a provider whose
broker forwards the request body unmodified — `cd writ/sdk && pnpm tsx examples/check-provider.ts
<provider>` — or every scenario that settles will fail for a reason that has nothing to do with the
scenario. See `CLAIMS.md` NOT-CLAIMED #30.

---

## What "the TEE key is the single substituted value" does and does not mean

It is a precise statement about the **fork evaluation's registry path**, and it is worth being
exact about its scope because it is the strongest claim in this file.

**What it covers.** On the fork, `WritRegistry` verifies against 0G's real deployed
`InferenceServing`. The provider it verifies was registered by that contract's own
`addOrUpdateService`, paying the stake that contract actually charges, and acknowledged by that
contract's own `acknowledgeTEESignerByOwner` called from its own owner address. Every rule
`WritRegistry` depends on — `verifiability == "TeeML"`, `teeSignerAcknowledged == true`,
`teeSignerAddress` being whatever the registry says it is — is enforced by 0G's code, not by a mock
of it. If 0G changed those rules, the fork run would break, which is the point.

**What it does not cover.**

- **Model behaviour.** Whoever holds the key decides what the "model" says. A fork scorecard with
  zero false approvals means our enforcement held against answers we chose; it does not mean a model
  would have chosen them.
- **The enclave.** There is no Intel TDX anywhere in the fork run. No quote, no measurement
  registers, no attestation report. See `CLAIMS.md` NOT-CLAIMED #15 — Writ does not verify TDX
  quotes even on the live path.
- **The network.** No mainnet transaction was sent by any of this. `anvil_impersonateAccount` and
  `anvil_setBalance` are local; the mainnet chain is only ever read.
- **0G Storage.** No byte reaches or leaves it on the fork. The archive step returns
  `forkTranscriptRoot`, a `sha256` over `JSON.stringify(transcript)`, and the contracts accept it
  because a root is an opaque `bytes32` they cannot check anyway. So the fork exercises the
  *plumbing* around an archive pointer, and nothing about the archive.
- **The transcript candidate list.** The eval harness does not touch it: neither `eval/run.ts` nor
  `eval/env.ts` calls `addTranscript`, `transcriptRoots`, `transcriptRootCount` or
  `transcriptRootAt`. The append-only behaviour, the per-submitter quota and the griefing defence
  are covered by the contract suite (§1) and by `writ/mcp` and `writ/app` — not here.

---

## Everything substituted, in one list

If you want to grep for what is fake, this is the whole set.

| Substitute | Path | Stands in for |
|---|---|---|
| `MockInferenceServing` | `contracts/test/mocks/MockInferenceServing.sol` | 0G's registry, in unit tests only |
| `PolicyGateHarness` | `contracts/test/harness/PolicyGateHarness.sol` | a concrete gate, to reach `PolicyGate`'s internals |
| `WritLibHarness`, `VerdictLibHarness`, `PromptLibHarness` | `contracts/test/harness/` | an external call boundary, so an `internal` library's reverts are observable by `vm.expectRevert` and its gas is measurable. Those four files are the whole directory |
| `gen-fixtures.mjs` | `contracts/script/gen-fixtures.mjs` | the broker's Go signing path, reproduced in JavaScript |
| `startProviderStub` | `sdk/test/helpers/provider-stub.ts` | a 0G Compute provider's two HTTP endpoints |
| `anvil.ts`, `contracts.ts` | `sdk/test/helpers/` | the chain a test runs on, and the Foundry build/deploy step. Also imported by `eval/env.ts` |
| injected `IndexerLike` | `sdk/src/archive.ts`, `sdk/test/archive.test.ts` | 0G Storage's indexer. The merkle root beside it is the **real** `MemData(...).merkleTree()` |
| `world.ts` | `mcp/test/helpers/world.ts` | the entire `WritDeps` surface — chain, compute, storage. Its transcript "roots" are `ethers.keccak256`, not merkle roots |
| `client.ts` | `mcp/test/helpers/client.ts` | an MCP client, in process |
| `fixture.ts` | `app/test/helpers/fixture.ts` | the app's writ/gate data surface |
| stubbed `globalThis.fetch` | `app/test/storage.test.ts` | the 0G Storage indexer's HTTP endpoint |
| 12 frozen merkle vectors | `app/test/zg-merkle.test.ts` | `@0gfoundation/0g-storage-ts-sdk`'s root computation. **These are committed constants, not a live comparison** — see `CLAIMS.md` 7.5 |
| `forkTranscriptRoot` | `eval/env.ts` | a 0G Storage merkle root, in fork mode |
| the eval's stand-in signer and answer source | `eval/env.ts`, `eval/run.ts` | the enclave's key and the model's judgement |
| `MockInferenceServing` fallback | `eval/env.ts::registerOnFork` | 0G's registry, **only** when the fork RPC is unreachable — and it says so in the output |

Everything else in this repository is the shipping code.

Two things that look like substitutes and are not, because they are worth naming rather than
leaving a reader to wonder:

- **`contracts/script/Deploy.s.sol`** is the real deployment, exercised by 11 tests that call
  `deploy(Config)` directly. It has never been broadcast to any public chain.
- **`app/src/lib/zg-merkle.ts`** is a real reimplementation, not a mock — the app genuinely
  recomputes 0G Storage's root in the browser. What is substituted is only its *test oracle*, one
  row above.
- **`eval/recipients.ts`** produces real addresses, derived rather than random. Deriving them from
  a published seed makes a run reproducible and its funds recoverable; it does not make the
  addresses fake. The gate formats whatever address it is handed and the model sees one lowercase
  hex string either way, so nothing the scenarios measure depends on where the address came from.
