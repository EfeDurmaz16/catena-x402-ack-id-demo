import { ExactEvmScheme } from "@x402/evm/exact/server"
import { paymentMiddleware, x402ResourceServer } from "@x402/express"
import express from "express"
import {
  consumeProofNonce,
  createIdentity,
  createSellerResolver,
  IdentityError,
  NonceCache,
  readBoundPaymentAddress,
  verifyIdentityProof,
} from "../identity.js"
import type { Identity } from "../identity.js"
import type { Authorize } from "./authorization.js"
import type { DidUri } from "@agentcommercekit/did"
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

/** Minimal read-only view of the x402 hook's transport context. */
interface X402Transport {
  request?: { adapter?: { getHeader(name: string): string | undefined } }
}

/** The identity proof (bearer token) on the request that reached the payment layer. */
function bearerFromTransport(transportContext: unknown): string | undefined {
  const header = (
    transportContext as X402Transport | undefined
  )?.request?.adapter?.getHeader("authorization")
  if (!header?.startsWith("Bearer ")) return undefined
  return header.slice("Bearer ".length)
}

/** The wallet that signed the x402 payment (EIP-3009 `from`). */
function paymentPayer(paymentPayload: unknown): string | undefined {
  const payload = (paymentPayload as { payload?: unknown } | undefined)?.payload
  const from = (payload as { authorization?: { from?: unknown } } | undefined)
    ?.authorization?.from
  return typeof from === "string" ? from : undefined
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
  const { baseUrl, network, payTo, price, facilitatorClient, authorize } =
    options
  const resolver = createSellerResolver()

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
      // Verify identity only. The proof's single-use nonce is NOT consumed here:
      // x402 sends the same proof on both the unpaid 402 probe and the paid
      // retry, and consuming on either would either reject the legitimate retry
      // or let a garbage payment burn a valid nonce. Consumption happens once,
      // at settlement, in the payment hook below.
      const verified = await verifyIdentityProof(extractBearerToken(req), {
        audience: identity.did,
        resolver,
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

  // 3: x402 payment: only reachable with a verified, authorized identity.
  // onAfterVerify runs once the facilitator has verified the payment but before
  // it settles, so aborting here rejects the request without moving money. Two
  // checks run here, in order:
  //   a. Bind identity to payment: the wallet that signed the payment must be
  //      the one the proof committed to. Without this, an attacker could pair
  //      their own valid proof with someone else's payment authorization.
  //   b. Consume the proof's single-use nonce, now that a bound, verified
  //      payment is about to settle. Binding runs first so a mismatched (that
  //      is, misused) proof aborts without burning the real holder's nonce.
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(network, new ExactEvmScheme())
    .onAfterVerify((ctx) => {
      const token = bearerFromTransport(ctx.transportContext)
      const bound = token
        ? readBoundPaymentAddress(token)?.toLowerCase()
        : undefined
      const payer = paymentPayer(ctx.paymentPayload)?.toLowerCase()
      if (
        token === undefined ||
        bound === undefined ||
        payer === undefined ||
        bound !== payer
      ) {
        return Promise.resolve({
          abort: true as const,
          reason: "identity_payer_mismatch",
          message:
            "Payment wallet is not the address bound in the identity proof",
        })
      }
      try {
        consumeProofNonce(token, nonceCache)
      } catch (error) {
        if (error instanceof IdentityError) {
          return Promise.resolve({
            abort: true as const,
            reason: error.code,
            message: error.message,
          })
        }
        throw error
      }
      return Promise.resolve()
    })
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
