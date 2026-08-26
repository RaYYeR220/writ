import { Docket } from '@/components/Docket'

export default function DocketPage() {
  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="split">
            <div>
              <p className="eyebrow">The docket · 0G</p>
              <h1>Refusal is the transaction</h1>
            </div>
            <div className="stack">
              <p className="lede">
                A model answered a question inside an Intel TDX enclave and signed{' '}
                <span className="mono">sha256(question):sha256(answer)</span> with a key 0G publishes on chain. A
                contract checked that signature itself, recorded it, and acted on it.
              </p>
              <p className="note">
                Because the signature covers the question as well as the answer, nobody can swap the prompt for a
                friendlier one after the fact. Every line below — money moved and money held — is a settled
                transaction, permanent, and checkable by anyone without asking us.
              </p>
            </div>
          </div>
        </div>
      </section>
      <Docket />
    </>
  )
}
