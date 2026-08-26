import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  // The docket reads the chain from the browser. Nothing here is rendered from a private
  // database, so there is no server-side secret to leak and no build-time data to stale out.
  env: {},
}

export default config
