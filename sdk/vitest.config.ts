import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The chain integration suite boots anvil and deploys the contract suite.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
