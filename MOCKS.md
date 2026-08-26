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

Last reviewed: 2026-08-26. Nothing has been deployed to 0G mainnet.

---

## The short version

| 0G component | Status |
|---|---|
| 0G Chain — `InferenceServing` at `0x47340d900bdFec2BD393c626E12ea0656F938d84` | **REAL.** Read live on mainnet by the fork tests, and used as the actual registry (`addOrUpdateService`, `acknowledgeTEESignerByOwner`, `getService`) by the fork evaluation |
| 0G Chain — a real registered TEE provider (`0x4870Cb…`, `0GM-1.0-35B-A3B`, signer `0x8561E0…`) | **REAL, but only read.** Its registration is read live and asserted against. It has never answered a request from this codebase |
| 0G Chain — Writ's own contracts | **REAL** compiled bytecode, freshly deployed on the fork. Never deployed to mainnet |
| 0G Compute — the TEE signing key | **SUBSTITUTED** everywhere. This is the single substituted value |
| 0G Compute — the signed text format | **REAL.** Reproduced byte-for-byte from broker source; the Solidity tests assert against fixtures generated from it |
| 0G Compute — the provider HTTP surface | **STAND-IN** in tests: a local server implementing `/v1/proxy/chat/completions` and `/v1/proxy/signature/{chatId}` |
| 0G Storage | **NOT YET EXERCISED.** The SDK integrates the real `@0gfoundation/0g-storage-ts-sdk` against the real mainnet turbo indexer, and `--live` is wired to it, but no upload has ever been performed by this codebase |

**Read that last row carefully.** It would be easy to write "real 0G Storage" here. It is not true
yet. `--live` calls the real uploader and nothing else does; `--live` has never been run.

---

## 1. Contract unit tests — `writ/contracts`, 142 tests

`forge test`. No network, no funds.

| Piece | Real or substituted | Detail |
|---|---|---|
| `WritLib`, `VerdictLib`, `WritRegistry`, `PolicyGate`, `TreasuryGate`, `AgentTreasury`, `PolicyGateFactory` | **REAL** | the shipping source, compiled by `solc 0.8.24` |
| `InferenceServing` | **SUBSTITUTED** | `test/mocks/MockInferenceServing.sol` — a 5-field setter and a `getService`. It reproduces the fields `WritRegistry` reads and nothing else, so gas here is a lower bound |
| TEE signature | **REAL cryptography, substituted key** | Foundry's `vm.sign` over the exact EIP-191 digest, and static fixtures produced by `script/gen-fixtures.mjs` with key `0x11…11` |
| The signed text | **REAL** | `gen-fixtures.mjs` reproduces `api/inference/internal/ctrl/signing.go` and `api/common/tee/tls.go::FormatRoutingProofText` in JavaScript. The Solidity assertions are against the resulting strings, character by character |
| Response bodies | **REAL shape, hand-written** | `{"id":…,"choices":[{"message":{"content":"ALLOW:12"}}]}` — the OpenAI-compatible shape, written as literal bytes because the signature is over wire bytes |

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

## 3. SDK tests — `writ/sdk`, 98 tests

`pnpm test`.

| Piece | Real or substituted | Detail |
|---|---|---|
| Chain | **REAL anvil, forked when reachable** | `test/helpers/anvil.ts` prefers `anvil --fork-url https://evmrpc.0g.ai`; falls back to a bare local chain when there is no network, and **reports which one it got** so a test can say what it proved |
| Writ contracts | **REAL** | compiled by `forge` into a private artifact directory and deployed by `ethers.ContractFactory` |
| `InferenceServing` | **REAL when forked**, otherwise `MockInferenceServing` | |
| Live mainnet read | **REAL** | one test (`chain.test.ts`, "reads the live 0G mainnet registry's TEE providers through the SDK ABI") queries mainnet directly through the SDK's hand-written ABI |
| 0G Compute provider | **STAND-IN** | `test/helpers/provider-stub.ts` — a real `node:http` server on localhost implementing `POST /v1/proxy/chat/completions` and `GET /v1/proxy/signature/{chatId}`, which signs `sha256hex(request):sha256hex(response)` over **the exact bytes it received**. It can also be told to expire proofs, to sign the five-field routing text, or to sign an arbitrary pair (i.e. forge a proof for a different question) |
| TEE key | **SUBSTITUTED** | an `ethers.Wallet` the test holds |
| 0G Storage | **SUBSTITUTED** | `IndexerLike` is injected. The merkle-root computation itself is real (`MemData(...).merkleTree()` from the real SDK); only the network upload is replaced |
| ABI fidelity | **REAL** | `abi.test.ts` compiles the Foundry project and compares every function selector and event topic hash against the hand-written ABIs |

The provider stub is a stand-in for the *service*, not for the *format*. It signs the same bytes a
real broker signs, over the same wire bytes, with the same EIP-191 prefix — which is what makes the
raw-byte discipline genuinely exercised rather than merely asserted.

## 4. MCP server tests — `writ/mcp`, 138 tests

`pnpm test`. **No chain at all.**

| Piece | Real or substituted |
|---|---|
| The MCP server, its four tools, its error handling | **REAL** — the shipping source, driven over a real `StdioClientTransport` in `server.test.ts` |
| `WritDeps` (chain, compute, storage) | **SUBSTITUTED** — `test/helpers/world.ts`, a fully in-memory implementation of the injectable dependency surface |
| Writ ids, decision keys, the routing domain tag | **REAL** — recomputed in the harness with `ethers.AbiCoder` and `keccak256` to match the contracts exactly |
| `AgentTreasury`'s prompt head and tail | **REAL, verbatim** — copied from the contract source, so the tests exercise the prompt that actually ships |
| The nine-fact question | **REAL** — rendered by `src/question.ts`, the same code the server uses |
| TEE signatures | **REAL cryptography, substituted key** — fixed `ethers.Wallet`s, so a failure names the same addresses every run |
| 0G Storage transcripts | **SUBSTITUTED** — serialized with the real `serializeTranscript` from the SDK, then handed back in memory. The harness can also return a *tampered* transcript, which `rehydrate.ts` must reject |

This suite deliberately has no chain: it tests the server's decisions, not the contracts'. The
contracts are tested by suites 1 and 2, and the two are joined by suite 3.

## 5. The graded evaluation, `--fork` mode — `writ/eval`, 38 scenarios

`pnpm eval:fork`. Read-only RPC against 0G mainnet. **Spends nothing.**

This is the surface where the real/substituted line matters most, so it is spelled out step by step.

| Piece | Real or substituted | Detail |
|---|---|---|
| Chain | **REAL 0G mainnet state** | `anvil --fork-url https://evmrpc.0g.ai`, forked at block 42693145 for the committed run |
| `InferenceServing` | **REAL — 0G's deployed contract** | `WritRegistry` is constructed against `0x47340d900bdFec2BD393c626E12ea0656F938d84` on the fork. Not a mock |
| Reading a real provider | **REAL** | before anything else, the harness reads `0x4870Cb…` off the fork and records what it says: `0GM-1.0-35B-A3B`, `TeeML`, signer `0x8561E0a9dA3C8d6591A2E756a91334f1a3E537e0`, acknowledged |
| **Registering the eval's provider** | **REAL registry logic, impersonated caller** | the harness impersonates a provider address on the fork and calls **0G's own `addOrUpdateService`**, paying the stake the registry actually charges — read out of the registry's own revert data rather than hardcoded, and 100 0G for the committed run. It then impersonates **the registry's own owner** (`0xddCDcbD9C7aeFB165dE00CE8684907fAAe8C8224`) and calls **0G's own `acknowledgeTEESignerByOwner`**. It then re-reads `getService` and refuses to proceed unless the registration actually took |
| **The TEE signing key** | **SUBSTITUTED — and this is the only substituted value in the registry path** | a key the harness generated. Everything `WritRegistry` checks — the `TeeML` requirement, the acknowledgement requirement, the signer comparison — runs against 0G's real contract logic against a real registration. Only the private key behind `teeSignerAddress` is ours |
| The model's answer | **SUPPLIED BY US** | a local stand-in returns the content the answer key specifies. Whoever holds the key decides what the "model" says. This is why the fork scorecard is silent on model behaviour |
| Writ contracts | **REAL** | `forge build`, then deployed onto the fork |
| Provider HTTP endpoint | **STAND-IN** | same shape as the SDK's stub |
| 0G Storage | **SUBSTITUTED** | `forkTranscriptRoot` returns `sha256` of the transcript instead of a merkle root. It is at least a real commitment to real content, but it is **not** a 0G Storage root and the report says so under `caveats` |
| Fallback | **DECLARED** | if the fork RPC is unreachable the harness falls back to a bare chain and `MockInferenceServing`, and prints that under `environment facts`. **That fallback did not happen in the committed run** — `eval/results/fork.json` records `"inferenceServingIsLiveContract": true` |

The harness keeps its own copy of the nine-fact question so it can post one the gate did not build
— that is how the stale-nonce and doctored-facts probes work. Before it doctors anything it renders
the *honest* facts and compares them byte for byte against `buildParams`, refusing to run the probe
if they differ, so a formatting bug of ours can never be mistaken for the gate's binding holding.

25 of the 38 scenarios hand the stand-in an **adversarial** answer — the one a naive gate would be
fooled by. Those are a real test of the enforcement machinery even on the fork. The other 13 hand it
the answer a correct model *would* give; those grade the plumbing and nothing else, and
`eval/scenarios.json` records which is which per scenario.

## 6. The graded evaluation, `--live` mode — **never run**

`WRIT_LIVE_CONFIRM=1 pnpm eval:live`. It is written, it typechecks, the same 38 scenarios feed it,
and it has never been executed.

| Piece | What it would use |
|---|---|
| Chain | 0G mainnet, chain 16661 |
| `InferenceServing` | the same real contract, no impersonation |
| Provider | a real registered TEE provider, answering from inside an Intel TDX enclave |
| TEE key | the provider's real hardware key — **nothing substituted** |
| 0G Storage | the real `archiveTranscript`, against `https://indexer-storage-turbo.0g.ai` |
| Contracts | Writ's contracts, deployed on mainnet |

Blocked on one thing: the deployer wallet `0xe1b27008710E5453fe021B521428B3DF074804DF` is unfunded,
so there are no mainnet contracts to point it at and no 0G Compute ledger to pay a provider with.
`--live` refuses to start without `WRIT_LIVE_CONFIRM=1`, because it moves real funds and spends real
0G on inference and storage.

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
- **0G Storage.** Not touched on the fork at all.

---

## Everything substituted, in one list

If you want to grep for what is fake, this is the whole set.

| Substitute | Path | Stands in for |
|---|---|---|
| `MockInferenceServing` | `contracts/test/mocks/MockInferenceServing.sol` | 0G's registry, in unit tests only |
| `PolicyGateHarness` | `contracts/test/harness/PolicyGateHarness.sol` | a concrete gate, to reach `PolicyGate`'s internals |
| `WritLibHarness`, `VerdictLibHarness` | `contracts/test/harness/` | an external caller, so library gas can be measured |
| `gen-fixtures.mjs` | `contracts/script/gen-fixtures.mjs` | the broker's Go signing path, reproduced in JavaScript |
| `startProviderStub` | `sdk/test/helpers/provider-stub.ts` | a 0G Compute provider's two HTTP endpoints |
| injected `IndexerLike` | `sdk/src/archive.ts`, `sdk/test/archive.test.ts` | 0G Storage's indexer |
| `world.ts` | `mcp/test/helpers/world.ts` | the entire `WritDeps` surface — chain, compute, storage |
| `forkTranscriptRoot` | `eval/env.ts` | a 0G Storage merkle root, in fork mode |
| the eval's stand-in signer and answer source | `eval/env.ts`, `eval/run.ts` | the enclave's key and the model's judgement |
| `MockInferenceServing` fallback | `eval/env.ts::registerOnFork` | 0G's registry, **only** when the fork RPC is unreachable — and it says so in the output |

Everything else in this repository is the shipping code.
