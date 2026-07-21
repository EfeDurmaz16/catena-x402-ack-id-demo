import { getDidResolver } from "@agentcommercekit/did"
import { ExactEvmScheme } from "@x402/evm/exact/server"
import { paymentMiddleware, x402ResourceServer } from "@x402/express"
import express from "express"
import {
  createIdentity,
  IdentityError,
  NonceCache,
  verifyIdentityProof
} from "../identity.js"
import type { Identity } from "../identity.js"
import type { Authorize } from "./authorization.js"
import type { DidResolver, DidUri } from "@agentcommercekit/did"
import type { FacilitatorClient } from "@x402/core/server"
import type { Network } from "@x402/core/types"
import type { Express, Request, RequestHandler } from "express"

export const PROTECTED_PATH = "/api/premium"

export interface SellerOptions {
  /** Public base URL of this seller; determines its did:web identity. */
  baseUrl: string
  /** CAIP-2 network id, e.g. "eip155:84532" for Base Sepolia. */
  network: string
  /** Address receiving the USDC payment. */
  payTo: string
  /** Price of the protected endpoint as a "$x.yz" money string. */
  price: string
  /**
   * Settlement adapter. The seller talks to payment infrastructure ONLY
   * through this interface (verify/settle/getSupported), so tests can prove
   * it is never invoked for rejected identities, and the Catena sandbox
   * facilitator can be swapped in without touching seller logic.
   */
  facilitatorClient: FacilitatorClient
  authorize: Authorize
  resolver?: DidResolver
}

export interface Seller {
  app: Express
  identity: Identity
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization
  if (!header?.startsWith("Bearer ")) return undefined
  return header.slice("Bearer ".length)
}

/**
 * Build the seller Express app. Middleware order is the security invariant:
 *
 *   1. ACK-ID identity verification (did:web resolution + JWT verification)
 *   2. Authorization stub (amount cap)
 *   3. x402 payment (402 challenge, facilitator verify + settle)
 *   4. Protected resource handler
 *
 * Requests failing 1 or 2 are rejected with 401/403 and never reach 3, so
 * the facilitator (settlement) is never contacted for rejected identities.
 */
export async function createSeller(options: SellerOptions): Promise<Seller> {
  const {
    baseUrl,
    network,
    payTo,
    price,
    facilitatorClient,
    authorize,
    resolver = getDidResolver()
  } = options

  const identity = await createIdentity(baseUrl)
  const nonceCache = new NonceCache()
  const app = express()

  // did:web document for the seller's own identity
  app.get("/.well-known/did.json", (_req, res) => {
    res.json(identity.didDocument)
  })

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", did: identity.did })
  })

  // 1 + 2: identity, then authorization — both strictly before payment
  const identityGate: RequestHandler = async (req, res, next) => {
    try {
      // Only payment-bearing requests can reach settlement, so only they
      // consume the proof's single-use nonce; the initial unpaid request
      // (which just earns the 402 challenge) verifies without consuming.
      const carriesPayment =
        req.headers["payment-signature"] !== undefined ||
        req.headers["x-payment"] !== undefined
      const verified = await verifyIdentityProof(extractBearerToken(req), {
        audience: identity.did,
        resolver,
        nonceCache,
        consumeNonce: carriesPayment
      })
      const decision = await authorize({ did: verified.did, price })
      if (!decision.allowed) {
        res.status(403).json({
          error: "authorization_denied",
          message: decision.reason ?? "Request not authorized"
        })
        return
      }
      res.locals.buyerDid = verified.did
      next()
    } catch (error) {
      if (error instanceof IdentityError) {
        res.status(error.status).json({
          error: error.code,
          message: error.message
        })
        return
      }
      next(error)
    }
  }
  app.use(PROTECTED_PATH, identityGate)

  // 3: x402 payment — only reachable with a verified, authorized identity
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    network as Network,
    new ExactEvmScheme()
  )
  app.use(
    paymentMiddleware(
      {
        [`GET ${PROTECTED_PATH}`]: {
          accepts: {
            scheme: "exact",
            network: network as Network,
            payTo,
            price
          },
          description: "Premium market signal (demo protected resource)"
        }
      },
      resourceServer
    )
  )

  // 4: the protected resource
  app.get(PROTECTED_PATH, (_req, res) => {
    res.json({
      report: "premium-market-signal",
      signal: "accumulate",
      confidence: 0.87,
      buyer: res.locals.buyerDid as DidUri,
      issuedAt: new Date().toISOString()
    })
  })

  return { app, identity }
}
