import Link from 'next/link'
import { GateDetail } from '@/components/GateDetail'

export const metadata = {
  title: 'Writ — one treasury',
  description: 'Balance, policy, the double-entry ledger of every decision, and the timelocked recovery hatch.',
}

export default async function GatePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return (
      <div className="wrap pad" style={{ maxWidth: '62ch' }}>
        <div className="gap">
          <strong>Not an address</strong>
          <p>
            <code>{address}</code> is not a 20-byte address, so there is nothing to read.
          </p>
          <p>
            <Link href="/gate">Back to the treasuries</Link>
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="split">
            <div>
              <p className="eyebrow">Treasury</p>
              <h1>Operated, not owned</h1>
            </div>
            <div className="stack">
              <p className="lede">
                An agent runs this treasury and cannot drain it. Funds move only against a TEE-signed answer to the
                question this contract builds itself.
              </p>
              <p className="note">
                Everything below is read from the chain in your browser. Two columns, one book: what was withheld and
                what was disbursed, footed together.
              </p>
            </div>
          </div>
        </div>
      </section>
      <GateDetail address={address} />
    </>
  )
}
