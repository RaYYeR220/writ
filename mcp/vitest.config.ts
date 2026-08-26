import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Tests run against the SDK's TypeScript sources rather than its build output, so `pnpm test`
// works in a clean checkout and a change in the SDK cannot pass here while failing in `build/`.
const sdkSrc = fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: /^@writ\/sdk$/, replacement: sdkSrc }],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
})
