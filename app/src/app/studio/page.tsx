import { Studio } from '@/components/Studio'

export const metadata = {
  title: 'Writ — compose a policy',
  description: 'Write the question a treasury will pin, see the exact bytes and their sha256, and deploy the gate.',
}

export default function StudioPage() {
  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="split">
            <div>
              <p className="eyebrow">Studio</p>
              <h1>Write the question once</h1>
            </div>
            <div className="stack">
              <p className="lede">
                A gate stores a prompt head, a prompt tail, one model, one provider and one risk ceiling. Between the
                head and the tail it writes its own facts, at execute time, from its own state.
              </p>
              <p className="note">
                That is the whole prompt-swap defence in one sentence: you choose the question&rsquo;s shape, the
                contract fills in what it is about, and the enclave signs the result. Nobody in the middle gets a turn.
              </p>
            </div>
          </div>
        </div>
      </section>
      <Studio />
    </>
  )
}
