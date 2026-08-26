import { createServer, type Server } from 'node:http'
import { ethers } from 'ethers'
import { sha256Hex, signedTextRouting, type RoutingFields } from '../../src/hashes.js'

export type ProviderStub = {
  /** What `broker.inference.getServiceMetadata()` would return as `endpoint`. */
  endpoint: string
  /** The address the stub's "TEE" signs with. */
  teeSigner: string
  /** The exact request bytes the stub last received. */
  lastRequest: () => Uint8Array
  /** Force the signature endpoint to behave as if the chat id had expired. */
  expireProofs: (on: boolean) => void
  /** Sign an arbitrary request/response pair, i.e. forge a proof for a different question. */
  signPair: (request: Uint8Array, response: Uint8Array) => Promise<string>
  stop: () => Promise<void>
}

/**
 * A local stand-in for a 0G Compute provider that implements the two endpoints Writ depends on:
 * `POST /v1/proxy/chat/completions` and `GET /v1/proxy/signature/{chatID}`.
 *
 * It signs `sha256hex(request):sha256hex(response)` over the exact bytes it saw, the way the
 * real provider broker does, so the raw-bytes discipline is exercised for real rather than
 * asserted about.
 */
export async function startProviderStub(opts: {
  teeKey: string
  /** The assistant content to answer with, e.g. `ALLOW:12`. */
  content: string
  /** Set to sign the five-field routing text a centralized provider's TEE signs. */
  routing?: RoutingFields
}): Promise<ProviderStub> {
  const wallet = new ethers.Wallet(opts.teeKey)
  const proofs = new Map<string, Record<string, string>>()
  let lastRequest = new Uint8Array()
  let expired = false
  let counter = 0

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost')

        if (req.method === 'POST' && url.pathname === '/v1/proxy/chat/completions') {
          const body = new Uint8Array(Buffer.concat(chunks))
          lastRequest = body
          const chatId = `chat-${++counter}`
          // Not JSON.stringify of an object: the wire bytes are what get signed.
          const responseText = `{"id":"${chatId}","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"${opts.content}"},"finish_reason":"stop"}]}`
          const responseBytes = new TextEncoder().encode(responseText)

          const reqHash = '0x' + sha256Hex(body)
          const respHash = '0x' + sha256Hex(responseBytes)
          const text = opts.routing
            ? signedTextRouting(reqHash, respHash, opts.routing)
            : `${sha256Hex(body)}:${sha256Hex(responseBytes)}`

          proofs.set(chatId, {
            text,
            signature: await wallet.signMessage(text),
            ...(opts.routing
              ? {
                  provider_type: opts.routing.providerType,
                  provider_identity: opts.routing.providerIdentity,
                  tls_cert_fingerprint: opts.routing.tlsFingerprint,
                }
              : {}),
          })

          res.writeHead(200, { 'Content-Type': 'application/json', 'ZG-Res-Key': chatId })
          res.end(responseText)
          return
        }

        const sig = url.pathname.match(/^\/v1\/proxy\/signature\/(.+)$/)
        if (req.method === 'GET' && sig) {
          const proof = expired ? undefined : proofs.get(decodeURIComponent(sig[1]!))
          if (!proof) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end('{"error":"prepare HTTP request: Chat id not found or expired, chat_id_not_found"}')
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(proof))
          return
        }

        res.writeHead(404)
        res.end('{"error":"not found"}')
      })()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('provider stub failed to bind')

  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/proxy`,
    teeSigner: wallet.address,
    lastRequest: () => lastRequest,
    expireProofs: (on: boolean) => {
      expired = on
    },
    signPair: async (request: Uint8Array, response: Uint8Array) =>
      wallet.signMessage(`${sha256Hex(request)}:${sha256Hex(response)}`),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
