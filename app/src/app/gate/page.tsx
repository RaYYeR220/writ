import { GateIndex } from '@/components/GateIndex'

export const metadata = {
  title: 'Writ — treasuries',
  description: 'Every gate the factory has deployed, and what each one held and released.',
}

export default function GateIndexPage() {
  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="split">
            <div>
              <p className="eyebrow">Treasuries</p>
              <h1>One book each</h1>
            </div>
            <div className="stack">
              <p className="lede">
                Every gate keeps two columns and foots them together. What it withheld is as much a part of its record
                as what it paid.
              </p>
            </div>
          </div>
        </div>
      </section>
      <GateIndex />
    </>
  )
}
