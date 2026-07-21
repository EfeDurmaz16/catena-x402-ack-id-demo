import { getDidResolver } from "@agentcommercekit/did"
import { ExactEvmScheme } from "@x402/evm/exact/server"
import { paymentMiddleware, x402ResourceServer } from "@x402/express"
import express from "express"
import {
  createIdentity,
  IdentityError,
  NonceCache,
  verifyIdentityProof,
} from "../identity.js"
import type { Identity } from "../identity.js"
import type { Authorize } from "./authorization.js"
import type { DidResolver, DidUri } from "@agentcommercekit/did"
import type { FacilitatorClient } from "@x402/core/server"
import type { Network } from "@x402/core/types"
import type { Express, Request, RequestHandler } from "express"

declare global {
  // Types the cross-middleware contract: identityGate writes buyerDid, the
  // protected handler reads it. Express is only extensible this way.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      buyerDid?: DidUri
    }
  }
}

export const PROTECTED_PATH = "/api/premium"

export interface SellerOptions {
  /** Public base URL of this seller; determines its did:web identity. */
  baseUrl: string
  /** CAIP-2 network id, e.g. "eip155:84532" for Base Sepolia. */
  network: Network
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

/** Non-empty header value, mirroring @x402/express's truthiness check. */
function hasHeader(value: string | string[] | undefined): boolean {
  return value !== undefined && value.length > 0
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
    resolver = getDidResolver(),
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

  // 1 + 2: identity, then authorization: both strictly before payment
  const identityGate: RequestHandler = async (req, res, next) => {
    try {
      // Only payment-bearing requests can reach settlement, so only they
      // consume the proof's single-use nonce; the initial unpaid request
      // (which just earns the 402 challenge) verifies without consuming.
      // Truthiness, not presence: @x402/express treats an empty header as
      // unpaid (getHeader(...) || getHeader(...)), and this check must agree
      // with it or a nonce could be burned on a request the payment layer
      // considers unpaid.
      const carriesPayment =
        hasHeader(req.headers["payment-signature"]) ||
        hasHeader(req.headers["x-payment"])
      const verified = await verifyIdentityProof(extractBearerToken(req), {
        audience: identity.did,
        resolver,
        nonceCache,
        consumeNonce: carriesPayment,
      })
      const decision = await authorize({ did: verified.did, price })
      if (!decision.allowed) {
        res.status(403).json({
          error: "authorization_denied",
          message: decision.reason ?? "Request not authorized",
        })
        return
      }
      res.locals.buyerDid = verified.did
    } catch (error) {
      if (error instanceof IdentityError) {
        res.status(error.status).json({
          error: error.code,
          message: error.message,
        })
        return
      }
      next(error)
      return
    }
    // Outside the try: a throw from downstream middleware must not be caught
    // here, or this handler would call next twice.
    next()
  }
  app.use(PROTECTED_PATH, identityGate)

  // 3: x402 payment: only reachable with a verified, authorized identity
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    network,
    new ExactEvmScheme(),
  )
  app.use(
    paymentMiddleware(
      {
        [`GET ${PROTECTED_PATH}`]: {
          accepts: {
            scheme: "exact",
            network,
            payTo,
            price,
          },
          description: "Premium market signal (demo protected resource)",
        },
      },
      resourceServer,
    ),
  )

  // 4: the protected resource
  app.get(PROTECTED_PATH, (_req, res) => {
    res.json({
      report: "premium-market-signal",
      signal: "accumulate",
      confidence: 0.87,
      buyer: res.locals.buyerDid,
      issuedAt: new Date().toISOString(),
    })
  })

  return { app, identity }
}
