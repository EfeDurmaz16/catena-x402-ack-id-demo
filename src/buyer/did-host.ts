import { createServer } from "node:http"
import type { DidDocument } from "@agentcommercekit/did"
import type { Server } from "node:http"

export interface DidHost {
  port: number
  baseUrl: string
  setDocument: (document: DidDocument) => void
  close: () => Promise<void>
}

/**
 * Minimal HTTP host for a did:web document at /.well-known/did.json.
 * Started before the identity is created because the did:web URI encodes the
 * port; call setDocument once the identity exists.
 */
export function startDidHost(port = 0): Promise<DidHost> {
  let document: DidDocument | undefined

  const server: Server = createServer((req, res) => {
    if (req.url === "/.well-known/did.json" && document) {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(document))
      return
    }
    res.statusCode = 404
    res.end()
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error("Could not determine did-host port"))
        return
      }
      resolve({
        port: address.port,
        baseUrl: `http://localhost:${address.port}`,
        setDocument: (doc) => {
          document = doc
        },
        close: () =>
          new Promise((res) => {
            server.close(() => res())
          })
      })
    })
  })
}
