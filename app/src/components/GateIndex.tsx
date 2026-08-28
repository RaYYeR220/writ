'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Amount, Gap } from '@/components/primitives'
import { explain } from '@/lib/chain'
import { config, missingGateSourceReason } from '@/lib/config'
import { loadDocket, type GateSummary } from '@/lib/docket'
import { formatCount } from '@/lib/format'

type State =
  | { kind: 'loading' }
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'error'; reason: string }
  | { kind: 'ready'; gates: GateSummary[]; problems: string[] }

export function GateIndex() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    const reason = missingGateSourceReason()
    if (reason) {
      setState({ kind: 'unconfigured', reason })
      return
    }
    const controller = new AbortController()
    void loadDocket(controller.signal)
      .then((d) => !controller.signal.aborted && setState({ kind: 'ready', gates: d.gates, problems: d.problems }))
      .catch((e) => !controller.signal.aborted && setState({ kind: 'error', reason: explain(e) }))
    return () => controller.abort()
  }, [])

  return (
    <div className="wrap">
      <div className="tribunal">
        <div className="trow banner">
          <div className="side l">
            <h2>
              Held
              <span className="sub">by treasury</span>
            </h2>
          </div>
          <div className="pin">
            <span className="seam-label">seam · ceiling</span>
          </div>
          <div className="side r">
            <h2>
              Released
              <span className="sub">by treasury</span>
            </h2>
          </div>
        </div>

        {state.kind === 'loading' ? <div className="pad center dim">Reading the gate list…</div> : null}

        {state.kind === 'unconfigured' || state.kind === 'error' ? (
          <div className="pad" style={{ maxWidth: '62ch', margin: '0 auto' }}>
            <Gap title={state.kind === 'unconfigured' ? 'No factory configured' : 'The gate list could not be read'}>
              <p>{state.reason}</p>
            </Gap>
          </div>
        ) : null}

        {state.kind === 'ready' && state.gates.length === 0 ? (
          <div className="pad" style={{ maxWidth: '62ch', margin: '0 auto' }}>
            <Gap title="No gates to show in the scanned range">
              <p>
                {config.factory ? (
                  <>
                    <code>PolicyGateFactory</code> at <span className="mono">{config.factory}</span> has emitted no{' '}
                    <code>GateDeployed</code> events between the scanned blocks
                    {config.gates.length > 0 ? ', and none of the gates named in NEXT_PUBLIC_GATES answered' : ''}.{' '}
                  </>
                ) : (
                  <>None of the gates named in NEXT_PUBLIC_GATES answered, and no factory is configured to look for
                    others.{' '}</>
                )}
                <Link href="/studio">Compose one in Studio</Link>.
              </p>
            </Gap>
          </div>
        ) : null}

        {state.kind === 'ready'
          ? state.gates.map((g) => (
              <div className="trow wrow held" key={g.address}>
                <Link href={`/gate/${g.address}`} className="side l filled">
                  <span className="verdict">{formatCount(g.held)}</span>
                  <span className="amount">
                    <Amount wei={g.heldAmount} struck />
                  </span>
                  <span className="meta">
                    <span className="k">refusals · never left the treasury</span>
                  </span>
                </Link>
                <div className="pin">
                  <div>
                    <Link href={`/gate/${g.address}`} className="id cond">
                      {g.address.slice(0, 6)}…{g.address.slice(-4)}
                    </Link>
                  </div>
                  <div className="age">ceiling {g.ceiling ?? '?'}</div>
                </div>
                <Link
                  href={`/gate/${g.address}`}
                  className="side r filled"
                  style={{ ['--acc' as string]: 'var(--released)', ['--wash' as string]: 'var(--released-wash)' }}
                >
                  <span className="verdict" style={{ color: 'var(--released)' }}>
                    {formatCount(g.released)}
                  </span>
                  <span className="amount">
                    <Amount wei={g.releasedAmount} />
                  </span>
                  <span className="meta">
                    <span className="k">approvals · each against a signed answer</span>
                  </span>
                </Link>
              </div>
            ))
          : null}

        {state.kind === 'ready' && state.problems.length > 0 ? (
          <div className="pad" style={{ maxWidth: '66ch', margin: '0 auto' }}>
            <Gap title="Some sources could not be read">
              <ul>
                {state.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Gap>
          </div>
        ) : null}
      </div>
    </div>
  )
}
