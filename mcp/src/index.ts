#!/usr/bin/env node
// This import MUST stay first. It points console.log/info/debug at stderr before any other
// module in the graph is evaluated, and therefore before any 0G SDK object can exist to write
// a progress line into the JSON-RPC stream this process speaks over stdout.
import './stdio-guard.js'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'
import { createLiveDeps } from './runtime.js'
import { createWritServer, SERVER_NAME, SERVER_VERSION } from './server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const server = createWritServer(createLiveDeps(config))

  await server.connect(new StdioServerTransport())

  // stderr only. Anything on stdout would be parsed as a JSON-RPC frame.
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} on stdio | chain ${config.chainId} via ${config.rpcUrl} | ` +
      `registry ${config.registry ?? '(unset)'} | signing key ${config.privateKey ? 'loaded' : 'absent'}`,
  )
}

main().catch((err: unknown) => {
  console.error('writ mcp server failed to start:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
