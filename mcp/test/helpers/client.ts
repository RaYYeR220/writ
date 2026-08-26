import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { WritDeps } from '../../src/deps.js'
import { createWritServer } from '../../src/server.js'

export type Harness = {
  client: Client
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

/**
 * Drives the real server through a real MCP client over a linked in-memory transport.
 *
 * Everything a hosted client would exercise is exercised here: tool registration, input schema
 * validation, output schema validation, and the `isError` shaping. Calling the handlers
 * directly would skip exactly the parts most likely to be wrong.
 */
export async function connect(deps: WritDeps): Promise<Harness> {
  const server = createWritServer(deps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'writ-mcp-test', version: '0.0.0' })

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    client,
    call: async (name, args) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

export function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}
