# Writ — the docket

The public face of Writ: a live record of AI decisions that a smart contract verified, and a page
where anyone can re-derive the proof of any one of them in their own browser.

Four views, one Next.js app.

| Route             | What it is                                                                          |
| ----------------- | ----------------------------------------------------------------------------------- |
| `/`               | **The docket.** Every decision across every gate — held on the left, released on the right. |
| `/writ/[id]`      | **The proof chain.** Four independently checkable rows, plus a live tamper demo.      |
| `/studio`         | **Compose a policy.** Live providers, the exact bytes a gate will pin, and their sha256. |
| `/gate/[address]` | **One treasury.** Balance, policy, a double-entry ledger, and the recovery countdown. |

Read-only views need no wallet, no account, no funds and no install. Only deploying a gate from
Studio and sweeping a treasury need a signer.

## Running it

```bash
pnpm install
cp .env.example .env.local     # already points at the live mainnet deployment
pnpm dev
```

`pnpm test` runs the client-side verification suite. `pnpm build` produces the production build.

`.env.example` ships the mainnet addresses, so a fresh clone reads the real docket. Point it
somewhere else and every view still states plainly what it could not read rather than rendering an
empty page that could be mistaken for an empty chain.

Two of the variables are worth reading twice.

**`NEXT_PUBLIC_GATES`** — a comma-separated list of gates to watch that the factory did not deploy.
The docket finds gates through `PolicyGateFactory`'s `GateDeployed` log, which only knows about
gates the factory made. The live `AgentTreasury` went out through `script/Deploy.s.sol`, so without
this list its settled approval and its settled refusal both render as records that no gate ever
acted on. An address here that does not answer as a gate is reported on the page with the reason,
never dropped silently and never shown as a gate with no decisions.

**`NEXT_PUBLIC_FROM_BLOCK`** — set it to the registry's deployment block. 0G mainnet is past 42
million blocks and public RPCs cap the span of a single `eth_getLogs`, so scanning from genesis
means thousands of chunked calls before the first row appears. Left at 0 the app scans the last
120,000 blocks instead. Either way the page says the exact block range it read, so a short docket
is never mistaken for a quiet chain.

To try it without spending anything, run a local fork and point the app at it:

```bash
anvil --fork-url https://evmrpc.0g.ai
# deploy WritRegistry and PolicyGateFactory to the fork, then:
# NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545 in .env.local
```

## What the design is arguing

**A refusal is a successful transaction, not an error.** That is the emotional core of the product,
so it is carried structurally rather than stated in a caption.

A single vertical **seam** splits the viewport for its full height. Held sits on the left in cold
blue, released on the right in warm gold. Neither verdict is red. Refusal permanently occupies half
the screen, which makes it impossible to read as an exception or an error path — it is one of the
two things this product does, given equal architecture. The running counters sit **on** the seam as
one balance rather than as a success metric beside a failure metric.

**Risk is plotted as distance from the seam.** The ceiling is not a tick mark on a bar; it *is* the
centre line. So a decision that went over it is drawn further from the middle of your screen, and
`+47` means forty-seven over. You read a page of enforcement before you read a word.

Exactly one warm accent is reserved for the over-ceiling overshoot and used for nothing else
anywhere in the app, so the only saturated object on any screen is always the thing being enforced.

On a writ page the same seam does the product's actual thesis: **the pinned question on the left,
the answer on the right, and one signature binding them across the line.** That is the claim, drawn
rather than described — the TEE signs `sha256(request):sha256(response)`, so a contract that holds
the bytes can prove *which question was asked*.

### Verdict state and proof state never share a visual language

This is the most important correctness point in the interface.

A refused transfer is the system working correctly. A failed proof is the system telling you
something is wrong. If the two rhymed, a proof failure would start reading like a refusal, and they
are opposite things.

So they run on separate channels:

- **Verdict** lives on the seam, in colour, and is always a settled outcome. Held is blue, released
  is gold, money that did not move is struck through in its own verdict colour.
- **Proof state** lives on the four rows of a writ page, in achromatic geometry — a square node on
  the centre line, knocked-out type, and a hatch. It is the only thing in the entire app permitted
  to read as broken, and it never borrows a verdict colour or the reserved accent.

The proof channel also keeps its own vocabulary: a check is *checked*, *broken*, or *not run*. It
never says held, released, allowed or refused.

### A third state, which is neither

Studio lists every provider 0G's registry publishes and disables the ones a gate could not use,
with the registry's own reason next to each. There is a third thing a provider has to be, and it is
not on the chain: **its broker has to forward the request body unmodified.** 0G's broker rewrites
some requests before forwarding them upstream and signs what it forwarded, and where that happens no
contract can rebuild the hash the enclave signed — so a gate pinned to that provider can never
settle, however impeccable its `TeeML` registration is. The response half is unaffected.

That is neither a verdict nor a proof state, and it borrows neither language. It is not blue or
gold, it is not on the seam, and it never uses the achromatic geometry the proof channel owns — a
provider that translates is not broken, it is doing what 0G documents. It gets a small typographic
stamp under the provider, a three-step tonal ladder in ink, and a date: *binds request + response*,
*binds response only*, *could not be measured*, or *request binding not measured*.

The last one is the important one. **An unmeasured provider is shown as unmeasured**, never as
fine. Measuring costs one billed inference request, so the page does not run the check for you — not
on load, not per provider, not at all. It hands over the command
(`pnpm tsx examples/check-provider.ts <provider> --json` in `sdk/`) and takes the answer back, keeps
it in this browser, and says when it was measured. Four providers measured on 0G mainnet on
2026-08-27 ship with the app, labelled as the dated record they are rather than as something this
page checked.

### Below 820px

The seam has nowhere to live in one column, so it becomes edge-on: the verdict colour is the row's
left-hand rule, and the distance-from-the-seam measurement falls back to an explicit bar against
the ceiling — black to the ceiling, the reserved accent for the overrun, a tick at the line. Same
semantics, less width. On a writ page the four proof nodes leave the centre line and become a spine
down the left. The empty half disappears, because emptiness was the seam's job and there is no seam.

## What the app will not do

**It will never fabricate state.** Every value on every page was read from somewhere, and anything
that could not be read is shown as a stated gap with the reason — hatched, dashed, and impossible
to mistake for content. There is no branch anywhere that substitutes a plausible default for a
value it does not have, and `unavailable` is kept rigorously distinct from `fail`:

- `fail` — the check ran and the claim did not hold. This is evidence.
- `unavailable` — the check could not be run. This is a missing measurement, and it is never a pass.

If 0G Storage does not answer, the transcript row says so, and the signature row that depends on it
says it is unavailable *because* of that — it does not fall back to the signer the transcript names
for itself, because a provider that vouches for its own key proves nothing.

## The trust path

"Verify in your browser" is literal. All three sources answer a browser directly, with
`Access-Control-Allow-Origin: *`:

1. the chain, over its public RPC — `WritRegistry.getWrit`
2. 0G's own `InferenceServing`, over the same RPC — the registered TEE signer
3. 0G Storage, over its public indexer — `GET /file?root=…`

The bytes that come back are content-addressed: `zg-merkle.ts` rebuilds 0G Storage's merkle root in
the browser and compares it with the root the chain recorded, so the byte source is interchangeable
and untrusted. A file dropped in from disk gets the identical check.

**This app's backend serves the page and nothing else.** It is not in the trust path, and every
writ page says so where a reader will see it.

## Tests

```bash
pnpm test
```

126 tests, in nine files:

- `verify.test.ts` — the four checks over real sha256 and real EIP-191 signatures. A sound proof
  passes; an edited question fails on hashes; an edited answer fails on hashes; a signature from a
  key the registry never published fails on the signer; a doctored transcript cannot vouch for its
  own signed text; unavailable never becomes pass.
- `zg-merkle.test.ts` — the 0G Storage merkle port, against eight vectors captured from the storage
  SDK and committed as constants, across every branch of the padding rule. They catch a regression
  in the port; they would not catch a change upstream in the SDK.
- `abi.test.ts` — every event signature and struct field order checked against the Solidity
  sources. The app decodes logs positionally, so a reordered parameter would render the wrong
  number beside the right verdict rather than throwing.
- `policy.test.ts` — Studio's byte preview against `TreasuryGate.buildParams`, field for field.
- `storage.test.ts` — the content-addressed fetch, including every way it can refuse.
- `transcript.test.ts` — parsing, and the verdict grammar read exactly as `VerdictLib` reads it.
- `presentation.test.ts` — amounts truncate rather than round, distance-from-seam, refusal naming.
- `docket.test.ts` — gate discovery: a gate the factory deployed, a gate it was told about, the
  same gate named twice in different case, an address that does not answer as a gate, and an entry
  that is not an address at all. Every failure has to surface as a stated problem rather than a
  missing row or a phantom one.
- `passthrough.test.ts` — the request-binding record: which measurement wins when there are two,
  what a pasted measurement has to carry before it is kept, and the rule that an unmeasured
  provider is shown as unmeasured rather than as fine.
