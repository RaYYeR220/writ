'use client'

import Link from 'next/link'
import { Interface, hexlify, toUtf8Bytes, toUtf8String } from 'ethers'
import { useEffect, useMemo, useState } from 'react'
import { Gap } from '@/components/primitives'
import { POLICY_GATE_FACTORY_ABI } from '@/lib/abi'
import { connectWallet, explain, factoryContract } from '@/lib/chain'
import { addressUrl, config, missingFactoryReason } from '@/lib/config'
import { loadServices, type ServiceOption } from '@/lib/services'
import {
  DEFAULT_HEAD,
  DEFAULT_TAIL,
  buildParams,
  buildRequestBody,
  explainGateError,
  modelHash,
  modelNameProblem,
  hasModelKey,
  validate,
  requestDigest,
  ZERO_ADDRESS,
  type PolicyDraft,
  type TransferFacts,
} from '@/lib/policy'

/**
 * Studio composes a policy, and the seam is the pinning boundary.
 *
 * Left: what you wrote. Right: the exact bytes the contract will commit to. On the line between
 * them, the sha256 of those bytes, churning as you type — which is the honest picture of what
 * deploying a gate actually does. You do not get to write the middle of the question. The
 * contract fills it in from its own state at execute time, and that is precisely why a caller
 * cannot understate a balance or claim a stranger is a familiar vendor.
 *
 * You do not get to write the *start* of it either, and that is newer. The model key is the
 * factory's: it writes `{"model":"<modelName>",` and derives `allowedModelHash` from that same
 * string, so a gate can no longer ask about one model and accept an answer from another. The
 * preview therefore asks the factory's own `buildPromptHead` what it will build rather than
 * concatenating the pieces here — an app that reproduced the splice could drift from the
 * contract and show a digest for bytes nobody will ever pin. If that call cannot be made, this
 * page says so and shows no bytes at all, because a plausible guess is exactly what it must
 * never print.
 */

const SAMPLE: TransferFacts = {
  recipient: '0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae',
  amount: 250_000_000_000_000_000_000n,
  nonce: 0n,
  treasuryBalance: 412_608_400_000_000_000_000n,
  priorApprovals: 0n,
  priorRefusals: 0n,
  recipientPriorPayments: 0n,
  recipientPriorTotal: 0n,
}

type Deploy =
  | { kind: 'idle' }
  | { kind: 'signing' }
  | { kind: 'mining'; txHash: string }
  | { kind: 'done'; gate: string; txHash: string }
  | { kind: 'failed'; reason: string }

/**
 * The prompt head as the FACTORY builds it, never as this page would.
 *
 * `pending` while the call is in flight, `unavailable` with the reason when it cannot be made.
 * There is deliberately no fourth state where the app falls back to splicing the strings itself:
 * the whole claim of this screen is that the bytes on the right are the bytes that will be
 * pinned, and a locally reconstructed head would make that claim without being able to keep it.
 */
type HeadPreview =
  | { kind: 'pending' }
  | { kind: 'ok'; head: string }
  | { kind: 'unavailable'; reason: string }

export function Studio() {
  const [draft, setDraft] = useState<PolicyDraft>({
    model: '',
    promptHead: DEFAULT_HEAD,
    promptTail: DEFAULT_TAIL,
    provider: '',
    restrictToProvider: true,
    maxRisk: 40,
    agent: '',
    owner: '',
  })

  const [services, setServices] = useState<ServiceOption[] | null>(null)
  const [servicesError, setServicesError] = useState<string | null>(null)
  const [head, setHead] = useState<HeadPreview>({ kind: 'pending' })
  const [digest, setDigest] = useState<string | null>(null)
  const [wallet, setWallet] = useState<{ address: string } | null>(null)
  const [deploy, setDeploy] = useState<Deploy>({ kind: 'idle' })

  useEffect(() => {
    let live = true
    void loadServices()
      .then((s) => live && setServices(s))
      .catch((e) => live && setServicesError(explain(e)))
    return () => {
      live = false
    }
  }, [])

  const factoryReason = missingFactoryReason()

  // Ask the factory what it will build. Debounced, because this runs on every keystroke, and
  // guarded by `live` so a slow answer for an old draft can never overwrite a newer one.
  useEffect(() => {
    let live = true
    setHead({ kind: 'pending' })

    const localProblem = modelNameProblem(draft.model) ?? (hasModelKey(draft.promptHead) ? 'The head writes its own "model" key, which the factory rejects with ModelKeyInPrompt().' : null)

    if (factoryReason) {
      setHead({
        kind: 'unavailable',
        reason: `${factoryReason} The head is the factory's to build — it writes the model key itself — so without one there is no way to show you the bytes that would actually be pinned.`,
      })
      return
    }
    if (localProblem) {
      setHead({ kind: 'unavailable', reason: localProblem })
      return
    }

    const timer = setTimeout(() => {
      void factoryContract()
        .buildPromptHead(draft.model, toHex(draft.promptHead))
        .then((hex) => live && setHead({ kind: 'ok', head: toUtf8String(hex) }))
        .catch(
          (e) =>
            live &&
            setHead({
              kind: 'unavailable',
              reason: `The factory at ${config.factory} did not answer buildPromptHead: ${explain(e)}`,
            }),
        )
    }, 250)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [draft.model, draft.promptHead, factoryReason])

  const body = useMemo(
    () => (head.kind === 'ok' ? buildRequestBody(head.head, draft.promptTail, SAMPLE) : null),
    [head, draft.promptTail],
  )

  // The digest is recomputed on every keystroke, from the bytes on the right, in this browser.
  useEffect(() => {
    if (body === null) {
      setDigest(null)
      return
    }
    let live = true
    void requestDigest(body).then((d) => live && setDigest(d))
    return () => {
      live = false
    }
  }, [body])

  async function onDeploy() {
    setDeploy({ kind: 'signing' })
    try {
      const connection = await connectWallet()
      setWallet({ address: connection.address })

      const factory = factoryContract(connection.signer)
      // The spec carries the model NAME, not a hash. The factory writes the key and derives
      // the hash from this one string, so there is no second argument that could disagree.
      const tx = await factory.deployGate(
        {
          modelName: draft.model,
          promptHead: toHex(draft.promptHead),
          promptTail: toHex(draft.promptTail),
          allowedProvider: draft.restrictToProvider && draft.provider ? draft.provider : ZERO_ADDRESS,
          maxRisk: draft.maxRisk,
        },
        draft.agent,
        draft.owner,
      )
      setDeploy({ kind: 'mining', txHash: tx.hash })

      const receipt = await tx.wait()
      const deployed = receipt?.logs
        .map((l) => (l.topics[0] === GATE_DEPLOYED_TOPIC ? topicToAddress(l.topics[1]) : null))
        .find((a): a is string => a !== null)

      if (!deployed) {
        setDeploy({
          kind: 'failed',
          reason: `The transaction ${tx.hash} was mined, but no GateDeployed event was found in its receipt. Check the explorer rather than trusting this page.`,
        })
        return
      }
      setDeploy({ kind: 'done', gate: deployed, txHash: tx.hash })
    } catch (e) {
      setDeploy({ kind: 'failed', reason: explainGateError(explain(e)) })
    }
  }

  const problems = validateAll(draft)
  // Deliberately gated on the preview having come back: if the factory would not tell us what
  // it builds, this page has not shown the reader what they are about to pin.
  const ready = problems.length === 0 && !factoryReason && head.kind === 'ok'

  return (
    <div className="wrap">
      <div className="tribunal">
        <div className="trow banner">
          <div className="side l">
            <h2>
              Your policy
              <span className="sub">what you write, once, before anything runs</span>
            </h2>
          </div>
          <div className="pin">
            <span className="seam-label">seam · the pinning boundary</span>
          </div>
          <div className="side r">
            <h2>
              The pinned bytes
              <span className="sub">what the contract will commit to</span>
            </h2>
          </div>
        </div>

        <div className="trow" style={{ borderBottom: '1px solid var(--rule)' }}>
          <div className="side-pad l-pad" style={{ textAlign: 'left' }}>
            <ProviderPicker
              services={services}
              error={servicesError}
              selected={draft.provider}
              onSelect={(s) => setDraft({ ...draft, provider: s.provider, model: s.model })}
            />

            <div className="field" style={{ marginTop: 24 }}>
              <label className="lab" htmlFor="model">
                Model name — the one string the factory both asks for and enforces
              </label>
              <input
                id="model"
                type="text"
                spellCheck={false}
                placeholder="choose a provider above, or type a model name"
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
              <p className="hint">
                The factory writes <code>{'{"model":"'}</code>
                {draft.model || '…'}
                <code>{'",'}</code> itself and derives <code>allowedModelHash</code> from this same string. That is why
                it is a field and not something you write into the prompt: the two used to arrive as unrelated
                arguments, and a gate whose halves disagreed asked about one model and accepted an answer from another
                with every check passing.
              </p>
            </div>

            <div className="field">
              <label className="lab" htmlFor="head">
                Prompt head — everything after the model key, before the contract&rsquo;s own facts
              </label>
              <textarea
                id="head"
                value={draft.promptHead}
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, promptHead: e.target.value })}
              />
              <p className="hint">
                Continues from the key above, so it starts at <code>&quot;temperature&quot;:0,&quot;messages&quot;:[</code>{' '}
                — no opening brace, and no <code>&quot;model&quot;</code> key of your own. The factory rejects one with{' '}
                <code>ModelKeyInPrompt()</code>.
              </p>
            </div>

            <div className="field">
              <label className="lab" htmlFor="tail">
                Prompt tail — everything after them
              </label>
              <textarea
                id="tail"
                value={draft.promptTail}
                spellCheck={false}
                style={{ minHeight: 60 }}
                onChange={(e) => setDraft({ ...draft, promptTail: e.target.value })}
              />
            </div>

            <div className="field">
              <label className="lab" htmlFor="ceiling">
                Risk ceiling — {draft.maxRisk}
              </label>
              <input
                id="ceiling"
                className="slider"
                type="range"
                min={0}
                max={100}
                value={draft.maxRisk}
                onChange={(e) => setDraft({ ...draft, maxRisk: Number(e.target.value) })}
              />
              <p className="hint">
                An ALLOW above this is still a refusal — recorded as <code>refusedBy = Policy</code>, so the record says
                the model agreed and the ceiling did not.
              </p>
            </div>

            <div className="field">
              <label className="lab" htmlFor="agent">
                Agent — the only address that may call execute
              </label>
              <input
                id="agent"
                type="text"
                spellCheck={false}
                placeholder="0x…"
                value={draft.agent}
                onChange={(e) => setDraft({ ...draft, agent: e.target.value.trim() })}
              />
            </div>

            <div className="field">
              <label className="lab" htmlFor="owner">
                Owner — holds the 30-day recovery hatch
              </label>
              <input
                id="owner"
                type="text"
                spellCheck={false}
                placeholder="0x…"
                value={draft.owner}
                onChange={(e) => setDraft({ ...draft, owner: e.target.value.trim() })}
              />
              <p className="hint">
                Deliberately not the agent. An agent that also held the hatch could stop asking for verdicts and sweep
                the treasury after thirty days.
              </p>
            </div>

            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 13.5 }}>
              <input
                type="checkbox"
                checked={draft.restrictToProvider}
                onChange={(e) => setDraft({ ...draft, restrictToProvider: e.target.checked })}
              />
              <span>
                Accept proofs only from this provider. Unchecked stores <code>address(0)</code>, which means any
                acknowledged TeeML provider serving a model with the same name hash.
              </span>
            </label>
          </div>

          <div className="pin digest-pin">
            <div className="on-seam digest" style={{ maxWidth: 100 }}>
              <span className="cond" style={{ fontSize: 9, letterSpacing: '0.16em', color: 'var(--ink-3)' }}>
                SHA256
              </span>
              <br />
              {digest ? <Churn hex={digest} /> : <span className="churn">…</span>}
            </div>
          </div>

          <div className="side-pad r-pad">
            <h3 className="h5">The exact bytes, for one example transfer</h3>
            {head.kind === 'pending' ? (
              <p className="dimmer" style={{ fontStyle: 'italic' }}>
                Asking <span className="mono">PolicyGateFactory.buildPromptHead()</span> what it will build…
              </p>
            ) : head.kind === 'unavailable' ? (
              <Gap title="No bytes to show you">
                <p>{head.reason}</p>
                <p>
                  This page will not splice the model key on by itself and call the result the pinned bytes. The head is
                  the factory&rsquo;s to build, so if the factory cannot be asked, the honest answer is nothing rather
                  than a plausible guess with a sha256 under it.
                </p>
              </Gap>
            ) : (
              <pre className="code">{body}</pre>
            )}
            <p className="note" style={{ marginTop: 12 }}>
              The start is not yours to write either: <b>the factory writes the model key</b> and hashes the same string
              into <code>allowedModelHash</code>. The bytes above came back from{' '}
              <span className="mono">buildPromptHead()</span> on chain, not from this page.
            </p>
            <p className="note" style={{ marginTop: 12 }}>
              The middle section is not yours to write. <b>The contract builds it</b> from the recipient, the amount, its
              own nonce, its own balance and its own history, at the moment execute is called:
            </p>
            <pre className="code" style={{ marginTop: 10, maxHeight: '18vh' }}>
              {buildParams(SAMPLE)}
            </pre>
            <p className="note" style={{ marginTop: 12 }}>
              So a caller cannot understate a balance, hide a refusal history, or claim a stranger is a familiar
              vendor. Change the recipient and every byte after it changes, which changes the digest, which means the
              old signature answers a different question and the gate rejects it.
            </p>

            <h3 className="h5" style={{ marginTop: 26 }}>
              What gets stored on chain
            </h3>
            <p className="hexline">
              modelName = {draft.model || 'choose a provider'}
              <br />
              allowedModelHash = {draft.model ? modelHash(draft.model) : '—'}
              <br />
              allowedProvider = {draft.restrictToProvider && draft.provider ? draft.provider : ZERO_ADDRESS}
              <br />
              maxRisk = {draft.maxRisk}
            </p>
            <p className="note" style={{ marginTop: 8 }}>
              <code>allowedModelHash</code> is not something you supply — the factory computes{' '}
              <code>keccak256(bytes(modelName))</code> from the name above. It is shown here as the same keccak,
              recomputed in this browser, so you can see the two halves of the gate are one string.
            </p>
            <p className="note" style={{ marginTop: 8 }}>
              The policy is copied into the gate at construction and is not governable afterwards. What the gate asks is
              fixed the moment it exists.
            </p>
          </div>
        </div>

        <DeployBar
          state={deploy}
          ready={ready}
          problems={problems}
          factoryReason={factoryReason}
          wallet={wallet}
          onDeploy={() => void onDeploy()}
        />
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────── provider picker ───── */

function ProviderPicker({
  services,
  error,
  selected,
  onSelect,
}: {
  services: ServiceOption[] | null
  error: string | null
  selected: string
  onSelect: (s: ServiceOption) => void
}) {
  if (error) {
    return (
      <Gap title="0G's provider registry did not answer">
        <p>{error}</p>
        <p>
          Without it there is no list of models, and no way to tell an enclave-executed one from a merely hosted one.
          Rather than show you a guess, this shows you nothing.
        </p>
      </Gap>
    )
  }

  if (!services) {
    return (
      <p className="dimmer" style={{ fontStyle: 'italic' }}>
        Reading <span className="mono">InferenceServing.getAllServices()</span> at{' '}
        <span className="mono">{config.inferenceServing}</span>…
      </p>
    )
  }

  const usable = services.filter((s) => s.usable)
  const blocked = services.filter((s) => !s.usable)

  return (
    <div>
      <h3 className="h5">
        Providers · {usable.length} usable of {services.length} registered
      </h3>

      {usable.length === 0 ? (
        <Gap title="No TEE provider is currently usable">
          <p>
            Every service 0G publishes right now either advertises a verifiability other than <code>TeeML</code> or has
            not acknowledged a TEE signer. A gate deployed against one would never accept a proof.
          </p>
        </Gap>
      ) : null}

      <div role="listbox" aria-label="0G inference providers">
        {usable.map((s) => (
          <button
            key={s.provider}
            role="option"
            className="service"
            aria-selected={selected.toLowerCase() === s.provider.toLowerCase()}
            onClick={() => onSelect(s)}
          >
            <span className="model cond">{s.model}</span>
            <div className="sub">
              {s.provider} · signs with {s.teeSignerAddress}
            </div>
            <div className="reason" style={{ fontStyle: 'normal', color: 'var(--ink-2)' }}>
              verifiability <b>TeeML</b>, signer acknowledged — a contract can check its signature against a key 0G
              publishes.
            </div>
          </button>
        ))}
      </div>

      {blocked.length > 0 ? (
        <>
          <h3 className="h5" style={{ marginTop: 22 }}>
            Registered, but not usable here · {blocked.length}
          </h3>
          <p className="hint" style={{ marginBottom: 8 }}>
            These are left on the page on purpose. The difference between a model 0G <em>hosts</em> and a model 0G
            <em> attests</em> is the entire product, and it is easier to see than to be told.
          </p>
          <div>
            {blocked.map((s) => (
              <div key={s.provider} className="service" aria-disabled="true">
                <span className="model cond">{s.model}</span>
                <div className="sub">{s.provider}</div>
                <div className="reason">{s.blockedReason}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

/* ────────────────────────────────────────────────────────── deploy ─────── */

function DeployBar({
  state,
  ready,
  problems,
  factoryReason,
  wallet,
  onDeploy,
}: {
  state: Deploy
  ready: boolean
  problems: string[]
  factoryReason: string | null
  wallet: { address: string } | null
  onDeploy: () => void
}) {
  return (
    <div className="trow verify-bar">
      <div className="side-pad l-pad" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12 }}>
        <button className="big-btn cond" onClick={onDeploy} disabled={!ready || state.kind === 'signing' || state.kind === 'mining'}>
          {state.kind === 'signing' ? 'Waiting for your wallet…' : state.kind === 'mining' ? 'Mining…' : 'Deploy this gate'}
        </button>
        <p className="pms" style={{ margin: 0 }}>
          {wallet ? `connected ${wallet.address}` : 'a wallet is needed only for this button'}
        </p>
      </div>
      <div className="pin" />
      <div className="side-pad r-pad">
        {factoryReason ? (
          <Gap title="No factory configured">
            <p>{factoryReason}</p>
            <p>Everything else on this page still works — the bytes and the digest are computed here, not fetched.</p>
          </Gap>
        ) : problems.length > 0 ? (
          <Gap title="Not deployable yet">
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Gap>
        ) : state.kind === 'failed' ? (
          <Gap title="The deploy did not go through">
            <p>{state.reason}</p>
          </Gap>
        ) : state.kind === 'done' ? (
          <div className="stack">
            <p className="lede">
              Gate live at{' '}
              <Link href={`/gate/${state.gate}`} className="mono">
                {state.gate}
              </Link>
            </p>
            <p className="note">
              Its policy is now immutable. Fund it, point your agent at it, and every decision it makes from here —
              approved or refused — lands on the docket.
            </p>
            <p className="note">
              <a href={addressUrl(state.gate) ?? '#'} target="_blank" rel="noreferrer">
                Check it on the explorer
              </a>{' '}
              rather than taking this page&rsquo;s word for it.
            </p>
          </div>
        ) : (
          <p className="note">
            Deploying calls <span className="mono">PolicyGateFactory.deployGate(policy, agent, owner)</span>. The
            factory is ownerless and keeps an index and nothing else — it has no authority over the gate afterwards, and
            the gate never consults it again.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * The digest, with the bytes that just changed marked.
 *
 * A sha256 that visibly churns is the cheapest way to show that it is a function of every
 * character — you type one letter and the whole thing turns over.
 */
function Churn({ hex }: { hex: string }) {
  return (
    <span>
      {hex.match(/.{1,8}/g)?.map((chunk, i) => (
        <span key={`${chunk}-${i}`}>
          {chunk}
          {i % 2 === 1 ? <br /> : ' '}
        </span>
      ))}
    </span>
  )
}

const GATE_DEPLOYED_TOPIC = new Interface(POLICY_GATE_FACTORY_ABI as unknown as string[]).getEvent('GateDeployed')!
  .topicHash

/** `bytes` for the policy struct: the prompt is stored as raw UTF-8, not as a string. */
function toHex(text: string): string {
  return hexlify(toUtf8Bytes(text))
}

function topicToAddress(topic: string | undefined): string | null {
  if (!topic || topic.length !== 66) return null
  return '0x' + topic.slice(26)
}

/**
 * One list of problems, from `validate`, so the button and the page cannot disagree.
 *
 * It used to be a second copy of the same rules living here, which is exactly how a screen ends
 * up enabling a deploy the chain will reject.
 */
function validateAll(draft: PolicyDraft): string[] {
  return validate(draft).map((p) => p.message)
}
