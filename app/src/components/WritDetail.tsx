'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ProofKey, ProofRows } from '@/components/ProofRows'
import { Amount, Gap } from '@/components/primitives'
import { refusedByPhrase } from '@/lib/abi'
import { addressUrl, config, missingRegistryReason, txUrl } from '@/lib/config'
import { formatCount, utc } from '@/lib/format'
import { shortAddress } from '@/lib/hashes'
import { headRange } from '@/lib/logs'
import { findOutcome, type Outcome } from '@/lib/outcome'
import { rulerReading } from '@/lib/ruling'
import { chainSources, notarizingTx } from '@/lib/sources'
import { extractAnswer, extractPrompt, parseVerdict, type Transcript } from '@/lib/transcript'
import {
  chainSummary,
  emptyRows,
  runProofChain,
  tamperCase,
  type CandidateOutcome,
  type ProofChain,
  type ProofRow,
  type WritRecord,
} from '@/lib/verify'

type Phase =
  | { kind: 'loading' }
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'missing'; reason: string }
  | { kind: 'ready' }

export function WritDetail({ id }: { id: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [rows, setRows] = useState<ProofRow[]>(emptyRows())
  const [chain, setChain] = useState<ProofChain | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [outcomeSearched, setOutcomeSearched] = useState(false)
  const [notaryTx, setNotaryTx] = useState<{ txHash: string; blockNumber: number; model: string } | null>(null)
  const [running, setRunning] = useState(false)
  const aborted = useRef<AbortController | null>(null)

  const verify = useCallback(async () => {
    const controller = new AbortController()
    aborted.current?.abort()
    aborted.current = controller

    setRunning(true)
    setRows(emptyRows())
    try {
      const result = await runProofChain(id, chainSources(controller.signal), (next) => {
        if (!controller.signal.aborted) setRows(next)
      })
      if (controller.signal.aborted) return
      setChain(result)
      setRows(result.rows)
      setPhase({ kind: 'ready' })
    } catch (e) {
      if (controller.signal.aborted) return
      const message = e instanceof Error ? e.message : String(e)
      setPhase({
        kind: 'missing',
        reason: /NotNotarized|could not decode|revert/i.test(message)
          ? `The registry at ${config.registry} has no writ under ${id}. It was never notarized, or it lives on a different chain than the one this app is pointed at.`
          : message,
      })
    } finally {
      if (!controller.signal.aborted) setRunning(false)
    }
  }, [id])

  useEffect(() => {
    const reason = missingRegistryReason()
    if (reason) {
      setPhase({ kind: 'unconfigured', reason })
      return
    }
    void verify()
    return () => aborted.current?.abort()
  }, [verify])

  // The gate outcome is a separate question from whether the proof is sound, so it is fetched
  // separately and its absence never colours the proof rows.
  //
  // Deliberately keyed on the writ and the phase only. Putting the "already searched" flag in the
  // dependency list would tear the effect down the moment it set that flag, and the second half
  // of the lookup would be cancelled by its own success.
  useEffect(() => {
    if (phase.kind !== 'ready') return
    let live = true
    void (async () => {
      const found = await findOutcome(id)
      if (!live) return
      setOutcome(found)
      setOutcomeSearched(true)

      const range = await headRange()
      const tx = await notarizingTx(id, range.fromBlock, range.toBlock)
      if (live) setNotaryTx(tx)
    })()
    return () => {
      live = false
    }
  }, [phase.kind, id])

  if (phase.kind === 'unconfigured' || phase.kind === 'missing') {
    return (
      <div className="wrap pad" style={{ maxWidth: '68ch' }}>
        <Gap title={phase.kind === 'unconfigured' ? 'Nothing to read' : 'No such writ'}>
          <p>{phase.reason}</p>
          <p>
            <Link href="/">Back to the docket</Link>
          </p>
        </Gap>
      </div>
    )
  }

  const writ = chain?.writ ?? null
  const transcript = chain?.transcript ?? null
  const verdict = transcript ? parseVerdict(transcript.response) : null
  const summary = chainSummary(rows)

  // Which side of the seam this writ belongs on. Derived from what a gate actually did; if no
  // gate spent it, the answer itself decides, and if there is no answer yet, neither side does.
  const held = outcome ? !outcome.approved : verdict ? !verdict.allowed : null
  const sideClass = held === null ? 'unspent' : held ? 'held' : 'released'
  const risk = outcome?.risk ?? verdict?.risk ?? null
  const ceiling = outcome?.ceiling ?? null

  return (
    <div className="wrap">
      <div className="tribunal">
        <Hero
          id={id}
          writ={writ}
          held={held}
          risk={risk}
          verdict={verdict}
          outcome={outcome}
          outcomeSearched={outcomeSearched}
          sideClass={sideClass}
          notaryTx={notaryTx}
        />

        <Ruler risk={risk} ceiling={ceiling} held={held} refusedBy={outcome?.refusedBy ?? null} sideClass={sideClass} />

        <Bytes
          writ={writ}
          transcript={transcript}
          sideClass={sideClass}
          source={chain?.transcriptSource ?? null}
          acceptedRoot={chain?.acceptedRoot ?? null}
          candidates={chain?.candidates ?? []}
          row={rows.find((r) => r.key === 'transcript')}
        />

        <VerifyBar running={running} onVerify={() => void verify()} summary={summary} />

        <ProofRows rows={rows} />
        <div className="trow">
          <div style={{ gridColumn: '1 / -1' }}>
            <ProofKey />
          </div>
        </div>

        {writ && transcript ? <Tamper writ={writ} transcript={transcript} /> : null}

        <Record writ={writ} chain={chain} notaryTx={notaryTx} />
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────── hero ───────── */

function Hero({
  id,
  writ,
  held,
  risk,
  verdict,
  outcome,
  outcomeSearched,
  sideClass,
  notaryTx,
}: {
  id: string
  writ: WritRecord | null
  held: boolean | null
  risk: number | null
  verdict: { allowed: boolean; risk: number } | null
  outcome: Outcome | null
  outcomeSearched: boolean
  sideClass: string
  notaryTx: { txHash: string; blockNumber: number; model: string } | null
}) {
  const word = held === null ? '—' : held ? 'DENY' : 'ALLOW'
  const number = risk !== null ? `:${String(risk).padStart(2, '0')}` : ''

  // The verdict owns the held side unless a gate actually released the funds; an unspent writ
  // has no side to own, so it stays where the reader's eye starts.
  const verdictSide = (
    <div className={held === false ? 'r' : 'l'}>
      <p className="big cond">
        {word}
        {number}
      </p>
      <p className="facts">
        <b className="cond" style={{ letterSpacing: '0.12em' }}>
          WRIT
        </b>{' '}
        <span className="mono">{id}</span>
        <br />
        {writ ? (
          <>
            notarized {utc(writ.notarizedAt)} · submitted by <span className="mono">{shortAddress(writ.notarizedBy)}</span>
            <br />
            {notaryTx ? (
              <>
                block <b>{formatCount(notaryTx.blockNumber)}</b> ·{' '}
                <TxLink hash={notaryTx.txHash}>{shortAddress(notaryTx.txHash)}</TxLink>
                <br />
              </>
            ) : null}
            model <b>{notaryTx?.model ?? 'name in the Notarized log'}</b> · chain {config.chainId}
          </>
        ) : (
          <span className="dimmer">reading the record…</span>
        )}
      </p>
    </div>
  )

  const moneySide = (
    <div className={held === false ? 'l' : 'r'}>
      {outcome ? (
        <>
          <p className="quiet cond">{outcome.approved ? 'moved' : 'did not move'}</p>
          <p className={outcome.approved ? 'quiet cond' : 'quiet cond struck'}>
            <Amount wei={outcome.amount} />
          </p>
          <p className="facts">
            to <span className="mono">{outcome.to}</span>
            <br />
            gate{' '}
            <Link href={`/gate/${outcome.gate}`} className="mono">
              {outcome.gate}
            </Link>
            <br />
            {outcome.approved ? (
              <>the model answered within the gate&rsquo;s ceiling, so the transfer settled</>
            ) : (
              <em>{refusedByPhrase(outcome.refusedBy)}</em>
            )}
            <br />
            <TxLink hash={outcome.txHash}>settlement {shortAddress(outcome.txHash)}</TxLink>
          </p>
          {!outcome.approved ? (
            <p className="note" style={{ marginTop: 14, marginLeft: held ? 0 : 'auto' }}>
              The refusal is the transaction — recorded permanently, and checkable by anyone without asking us.
            </p>
          ) : null}
        </>
      ) : outcomeSearched ? (
        <p className="facts">
          <b>No gate spent this writ</b> in the scanned block range. The proof is on the record either way — anyone may
          notarize a valid proof, and notarizing is not the same as acting on one.
          {verdict ? (
            <>
              <br />
              The answer itself reads <span className="mono">{verdict.allowed ? 'ALLOW' : 'DENY'}:{String(verdict.risk).padStart(2, '0')}</span>.
            </>
          ) : null}
        </p>
      ) : (
        <p className="facts dimmer">looking for a gate that acted on this…</p>
      )}
    </div>
  )

  return (
    <div className={`trow dhero wrow ${sideClass}`} style={{ borderBottom: '1px solid var(--seam)' }}>
      {held === false ? moneySide : verdictSide}
      <div className="pin">
        <span className="seam-label">the seam is the ceiling</span>
      </div>
      {held === false ? verdictSide : moneySide}
    </div>
  )
}

/* ────────────────────────────────────────────────────────── ruler ───────── */

/**
 * The ceiling is not a tick mark on a bar. It is the centre line, so a decision that went over
 * it is literally further from the middle of your screen.
 *
 * The picture measures the score against the line. It cannot see *why* the funds stayed, so the
 * words come from `refusedBy` instead — see `@/lib/ruling`. A model that answered DENY at a
 * score of 95 against a ceiling of 50 really is 45 past the line, and the ceiling really is not
 * why it was held.
 */
function Ruler({
  risk,
  ceiling,
  held,
  refusedBy,
  sideClass,
}: {
  risk: number | null
  ceiling: number | null
  held: boolean | null
  refusedBy: number | null
  sideClass: string
}) {
  if (risk === null) return null

  if (ceiling === null) {
    return (
      <div className="trow" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div className="pad" style={{ gridColumn: '1 / -1', maxWidth: '64ch', margin: '0 auto' }}>
          <p className="note">
            The model reported risk <b>{risk}</b>. No gate ceiling is known for this writ in the scanned range, so
            there is no line to plot it against — and a chart drawn against a guessed ceiling would be worse than none.
          </p>
        </div>
      </div>
    )
  }

  const reading = rulerReading({ risk, ceiling, held, refusedBy })
  const past = reading.past
  const span = Math.max(ceiling, 100 - ceiling, 1)
  const reach = Math.max(6, Math.min(94, Math.round((Math.abs(reading.delta) / span) * 100)))

  const measured = (
    <div className={`ruler-half ${past ? 'l' : 'r'}`}>
      <div className="ruler-track" />
      {/* `past` is the only thing the one reserved accent keys off, so a model that declined
          under the ceiling draws no overshoot and stays in the verdict colour. */}
      <div className={`ruler-fill ${past ? 'past' : ''}`} style={{ width: `${reach}%` }} />
      <div className="ruler-mark" style={past ? { right: `${reach}%` } : { left: `${reach}%` }} />
      <div className={`ruler-lab ${past ? 'past' : ''}`} style={past ? { right: `${reach}%` } : { left: `${reach}%` }}>
        {reading.label}
      </div>
      <div className="ruler-end">{reading.end}</div>
    </div>
  )

  const blank = (
    <div className="ruler-half">
      <div className="ruler-track" />
    </div>
  )

  return (
    <div className={`trow ruler wrow ${sideClass}`}>
      {past ? measured : blank}
      <div className="pin">
        <div className="on-seam ceiling-mark cond">
          <b>{ceiling}</b>
          CEILING
        </div>
      </div>
      {past ? blank : measured}
      {reading.note ? (
        <p className="note" style={{ gridColumn: '1 / -1', maxWidth: '64ch', margin: '20px auto 0', padding: '0 18px' }}>
          {reading.note}
        </p>
      ) : null}
    </div>
  )
}

/* ────────────────────────────────────────────────────────── bytes ───────── */

/**
 * The thesis, laid out as the page's own geometry: the pinned question on one side, the answer
 * on the other, and one signature spanning the seam between them.
 *
 * This is the claim in a single picture — the TEE signed `sha256(question):sha256(answer)`, so a
 * contract that holds the bytes can prove *which question was asked*. A prompt cannot be
 * swapped for a friendlier one, because the friendlier one hashes differently and the signature
 * stops recovering.
 */
function Bytes({
  writ,
  transcript,
  sideClass,
  source,
  acceptedRoot,
  candidates,
  row,
}: {
  writ: WritRecord | null
  transcript: Transcript | null
  sideClass: string
  source: string | null
  acceptedRoot: string | null
  candidates: CandidateOutcome[]
  row: ProofRow | undefined
}) {
  const [rawQuestion, setRawQuestion] = useState(false)

  return (
    <div className={`trow bytes wrow ${sideClass}`} style={{ borderBottom: '1px solid var(--rule)' }}>
      <div className="side-pad l-pad">
        <h3 className="h5">The pinned question</h3>
        {transcript ? (
          <>
            <pre className="code">{rawQuestion ? transcript.request : extractPrompt(transcript.request)}</pre>
            <button className="ghost-btn cond" style={{ marginTop: 10 }} onClick={() => setRawQuestion((v) => !v)}>
              {rawQuestion ? 'Show the prompt' : 'Show the exact request bytes'}
            </button>
            <p className="note" style={{ marginTop: 10 }}>
              sha256 covers the <b>exact request body</b>, not the prompt as displayed. The contract built these bytes
              itself from its stored policy, so the caller never chose the wording.
            </p>
          </>
        ) : (
          <p className="dimmer" style={{ fontStyle: 'italic' }}>
            The bytes are being fetched from 0G Storage. The commitment below is on chain either way.
          </p>
        )}
        <p className="hexline" style={{ marginTop: 12 }}>
          sha256(request) = {writ ? writ.reqHash.slice(2) : '…'}
        </p>
      </div>

      <div className="pin">
        <div className="on-seam seam-bind">
          <span className="cond">ONE SIGNATURE</span>
          <span className="bind-arrow" aria-hidden="true">
            ←&nbsp;·&nbsp;→
          </span>
          <span className="cond">COVERS BOTH</span>
        </div>
      </div>

      <div className="side-pad r-pad">
        <h3 className="h5">The answer</h3>
        {transcript ? (
          <p className="answer-big">{extractAnswer(transcript.response)}</p>
        ) : (
          <p className="dimmer" style={{ fontStyle: 'italic' }}>
            fetching…
          </p>
        )}
        <p className="hexline" style={{ marginTop: 12 }}>
          sha256(response) = {writ ? writ.respHash.slice(2) : '…'}
        </p>

        <h3 className="h5" style={{ marginTop: 26 }}>
          TEE signature · 65 bytes
        </h3>
        {transcript ? (
          <p className="hexline">{transcript.signature}</p>
        ) : (
          <p className="dimmer" style={{ fontStyle: 'italic' }}>
            inside the transcript
          </p>
        )}

        <h3 className="h5" style={{ marginTop: 26 }}>
          Transcript · 0G Storage
        </h3>
        <TranscriptRoots acceptedRoot={acceptedRoot} candidates={candidates} source={source} row={row} />
      </div>
    </div>
  )
}

/**
 * The archive pointers, all of them, with the arithmetic that settled which one is real.
 *
 * There is no single `transcriptRoot` to print any more, and that absence is the feature. The
 * TEE never signed a pointer, and notarizing is permissionless, so whoever got there first used
 * to fix the archive pointer forever — including someone who learned a chat id and published
 * junk. Now every candidate is listed, anyone may append one, and the page shows which one
 * actually re-derives the writ's own hashes rather than which one arrived first.
 */
function TranscriptRoots({
  acceptedRoot,
  candidates,
  source,
  row,
}: {
  acceptedRoot: string | null
  candidates: CandidateOutcome[]
  source: string | null
  /** The transcript check itself, so this panel can never contradict the row above it. */
  row: ProofRow | undefined
}) {
  // Before the list has been read there is nothing to say about it. An empty array here means
  // "not asked yet", and reporting that as "nobody published one" would be this page inventing
  // a fact it has not checked — the one thing it exists not to do.
  if (!row || row.state === 'idle' || row.state === 'running') {
    return (
      <p className="dimmer" style={{ fontStyle: 'italic' }}>
        reading the archive pointers published for this writ…
      </p>
    )
  }

  // No candidates and no list: the check's own reason covers both "nobody published one" and
  // "the registry would not answer", which are very different things and must not be merged.
  if (candidates.length === 0) {
    return <p className="note">{row.reason}</p>
  }

  return (
    <>
      <ol className="roots">
        {candidates.map((c) => (
          <li key={`${c.index}-${c.root}`} className={`root ${c.state}`}>
            <p className="hexline">{c.root}</p>
            <p className="pms" style={{ margin: '2px 0 0' }}>
              {c.state === 'accepted' ? 're-derives this writ' : c.state === 'untried' ? 'not fetched' : c.reason}
              {' · published by '}
              <span className="mono">{c.submitter}</span>
            </p>
          </li>
        ))}
      </ol>
      <p className="note" style={{ marginTop: 8 }}>
        {acceptedRoot ? (
          <>
            {candidates.length === 1 ? (
              <>One pointer was published, and it re-derives.</>
            ) : (
              <>
                {candidates.length} pointers were published; the accepted one is the first whose bytes sha256 to the
                request and response hashes this writ committed to.
              </>
            )}{' '}
            {source ? (
              <>
                Retrieved from <b>{source}</b>, then rebuilt to that merkle root here before anything was read out of
                it.
              </>
            ) : null}
          </>
        ) : (
          <>
            None of these re-derive, so there are no bytes here to check. A pointer is a claim by whoever published it
            and nothing more — the proof itself was verified against the TEE signature at notarization, independently of
            all of them.
          </>
        )}
      </p>
    </>
  )
}

/* ─────────────────────────────────────────────────────── verify bar ─────── */

function VerifyBar({
  running,
  onVerify,
  summary,
}: {
  running: boolean
  onVerify: () => void
  summary: { state: string; sentence: string }
}) {
  return (
    <div className="trow verify-bar" style={{ borderBottom: '1px solid var(--rule)' }}>
      <div className="side-pad l-pad" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12 }}>
        <button className="big-btn cond" onClick={onVerify} disabled={running}>
          {running ? 'Verifying in your browser…' : 'Verify in your browser'}
        </button>
        <p className="pms" style={{ margin: 0 }}>
          {summary.sentence}
        </p>
      </div>
      <div className="pin" />
      <div className="side-pad r-pad">
        <p className="note">
          Every check on this page is re-derived here, in this tab, from public sources only: the chain over{' '}
          <span className="mono">{config.rpcUrl}</span>, 0G&rsquo;s own <span className="mono">InferenceServing</span>{' '}
          registry over that same RPC, and 0G Storage over its public indexer. <b>Our backend is not in the trust path</b>{' '}
          — it serves this page and nothing else. Nothing here is taken on our word, including the parts that pass.
        </p>
      </div>
    </div>
  )
}

/* ───────────────────────────────────────────────────────── tamper ───────── */

/**
 * The tamper case, computed live rather than illustrated.
 *
 * Edit a word of the question and the page recomputes the sha256, rebuilds the text the TEE would
 * have had to sign, and re-runs recovery. The address it lands on is whatever it lands on. None
 * of these numbers is stored anywhere — which is the point, because a hard-coded demo of a hash
 * mismatch would prove nothing about hashes.
 */
function Tamper({ writ, transcript }: { writ: WritRecord; transcript: Transcript }) {
  const original = useMemo(() => extractPrompt(transcript.request), [transcript.request])
  const [edited, setEdited] = useState<string | null>(null)
  const [result, setResult] = useState<Awaited<ReturnType<typeof tamperCase>> | null>(null)

  const suggestion = useMemo(() => softenOneLine(transcript.request), [transcript.request])

  useEffect(() => {
    if (edited === null) {
      setResult(null)
      return
    }
    let live = true
    void tamperCase(writ, transcript, edited).then((r) => {
      if (live) setResult(r)
    })
    return () => {
      live = false
    }
  }, [edited, writ, transcript])

  return (
    <div className="trow tamper" style={{ borderBottom: '1px solid var(--seam)' }}>
      <div className="side-pad l-pad">
        <h3 className="tam-h cond">
          Swap the question
          <br />
          and the seal breaks
        </h3>
        <p className="note" style={{ marginLeft: 'auto', marginTop: 12 }}>
          The signature binds the <em>request</em> bytes, not only the answer. Soften one sentence and the digest is a
          stranger — which is exactly why an attacker cannot ask the model something easier and submit that ALLOW.
        </p>
        <div style={{ marginTop: 16, textAlign: 'left' }}>
          <label className="h5" htmlFor="tamper-box">
            Edit the request bytes and watch
          </label>
          <textarea
            id="tamper-box"
            className="tamper-box mono"
            value={edited ?? transcript.request}
            spellCheck={false}
            onChange={(e) => setEdited(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <button className="ghost-btn cond" onClick={() => setEdited(suggestion)} disabled={suggestion === null}>
              Make the question friendlier
            </button>
            <button className="ghost-btn cond" onClick={() => setEdited(null)} disabled={edited === null}>
              Restore the original
            </button>
          </div>
        </div>
      </div>

      <div className="pin" />

      <div className="side-pad r-pad">
        <h3 className="h5">Pinned digest · recorded on chain</h3>
        <p className="hexline">{writ.reqHash.slice(2)}</p>

        <h3 className="h5" style={{ marginTop: 18 }}>
          Digest of what is in the box
        </h3>
        {result ? (
          <p className={result.changed ? 'hexline over' : 'hexline'}>{result.tamperedReqHash.slice(2)}</p>
        ) : (
          <p className="hexline dimmer">unchanged — edit the box on the left</p>
        )}

        {result?.changed ? (
          <div style={{ marginTop: 18 }}>
            <h3 className="h5">What recovery lands on now</h3>
            <p className="hexline">{result.recovered ?? 'nothing — the signature no longer parses against this text'}</p>
            <p className="note" style={{ marginTop: 10 }}>
              That address is not the TEE signer 0G publishes for this provider, so{' '}
              <b>WritRegistry.notarize would revert with BadSignature</b> and the gate would never see a decision at
              all. Nothing was faked to produce this — the hash above was computed from the characters in that box a
              moment ago.
            </p>
          </div>
        ) : (
          <p className="note" style={{ marginTop: 18 }}>
            Change a single character. The digest changes completely, and the 65 bytes the enclave signed stop
            recovering to a key anyone has published. That is the whole defence, and it is one line of arithmetic.
          </p>
        )}

        <p className="facts" style={{ marginTop: 18 }}>
          Original prompt, for comparison:
          <br />
          <span className="dimmer" style={{ fontSize: 12.5 }}>
            {original.slice(0, 320)}
            {original.length > 320 ? '…' : ''}
          </span>
        </p>
      </div>
    </div>
  )
}

/**
 * The classic prompt-swap: replace the sentence that made the recipient look risky.
 *
 * Returns `null` when the request contains no such sentence, rather than inventing an edit —
 * the button then stays disabled and the reader types their own, which demonstrates the same
 * thing without the page pretending to know this prompt's shape.
 */
function softenOneLine(request: string): string | null {
  const patterns: [RegExp, string][] = [
    [/Recipient was first seen[^."]*\./, 'Recipient is a long-standing vendor.'],
    [/no prior relationship[^."]*\./, 'a long and uneventful relationship with this treasury.'],
    [/recipientPriorPayments=0/, 'recipientPriorPayments=94'],
  ]
  for (const [pattern, replacement] of patterns) {
    if (pattern.test(request)) return request.replace(pattern, replacement)
  }
  return null
}

/* ───────────────────────────────────────────────────────── record ───────── */

function Record({
  writ,
  chain,
  notaryTx,
}: {
  writ: WritRecord | null
  chain: ProofChain | null
  notaryTx: { txHash: string; blockNumber: number } | null
}) {
  if (!writ) return null
  const service = chain?.service ?? null

  return (
    <div className="trow" style={{ paddingTop: 26 }}>
      <div className="side-pad l-pad">
        <h3 className="h5">The record, as the registry holds it</h3>
        <p className="facts">
          provider <AddrLink address={writ.provider} />
          <br />
          modelHash <span className="mono">{writ.modelHash}</span>
          <br />
          notarizedBy <AddrLink address={writ.notarizedBy} />
          <br />
          notarizedAt {utc(writ.notarizedAt)}
          {notaryTx ? (
            <>
              <br />
              recorded in <TxLink hash={notaryTx.txHash}>{notaryTx.txHash}</TxLink>
            </>
          ) : null}
          {writ.isRouting && writ.routing ? (
            <>
              <br />
              <br />
              This is a centralized provider&rsquo;s routing proof, so the signature binds the upstream that actually
              answered as well:
              <br />
              providerType <b>{writ.routing.providerType}</b>
              <br />
              providerIdentity <b>{writ.routing.providerIdentity}</b>
              <br />
              tlsFingerprint <span className="mono">{writ.routing.tlsFingerprint}</span>
            </>
          ) : null}
        </p>
      </div>
      <div className="pin" />
      <div className="side-pad r-pad">
        <h3 className="h5">The provider, as 0G publishes it today</h3>
        {service ? (
          <p className="facts">
            model <b>{service.model}</b>
            <br />
            verifiability <b>{service.verifiability}</b>
            <br />
            teeSignerAcknowledged <b>{String(service.teeSignerAcknowledged)}</b>
            <br />
            teeSignerAddress <AddrLink address={service.teeSignerAddress} />
            <br />
            endpoint <span className="mono">{service.url}</span>
            <br />
            <br />
            Read live from <span className="mono">InferenceServing</span> at{' '}
            <AddrLink address={config.inferenceServing} />, which is the only authority on which key a provider&rsquo;s
            enclave signs with. A provider naming its own signer would prove nothing.
          </p>
        ) : (
          <p className="dimmer" style={{ fontStyle: 'italic' }}>
            0G&rsquo;s registry has not answered for this provider. See the second check above for the reason.
          </p>
        )}
      </div>
    </div>
  )
}

function TxLink({ hash, children }: { hash: string; children: React.ReactNode }) {
  const url = txUrl(hash)
  if (!url) return <span className="mono">{children}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mono">
      {children}
    </a>
  )
}

function AddrLink({ address }: { address: string }) {
  const url = addressUrl(address)
  if (!url) return <span className="mono">{address}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mono">
      {address}
    </a>
  )
}
