import { isEIP3009Payload } from "@x402/evm"
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
import type { FacilitatorClient, HTTPTransportContext } from "@x402/core/server"
import type { Network } from "@x402/core/types"
import type { ExactEvmPayloadV2 } from "@x402/evm"
import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express"

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

/** The token of an `Authorization: Bearer <token>` header, if it is one. */
function stripBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined
  return header.slice("Bearer ".length)
}

/** The identity proof (bearer token) on the request that reached the payment layer. */
function bearerFromTransport(transportContext: unknown): string | undefined {
  // x402 types the hook's transportContext as unknown; the express adapter
  // always passes its own HTTPTransportContext, so read it as one.
  return stripBearer(
    (
      transportContext as HTTPTransportContext | undefined
    )?.request.adapter.getHeader("authorization"),
  )
}

/**
 * The wallet that signed the x402 payment (EIP-3009 `from`). The library guard
 * only proves an `authorization` field is present, so the address itself is
 * still checked before it is trusted as the payer. Anything else reads as no
 * payer, which aborts the payment.
 */
export function paymentPayer(
  payload: Record<string, unknown>,
): string | undefined {
  // Safe input for the guard: it decides the shape, testing only for the
  // `authorization` key.
  const candidate = payload as ExactEvmPayloadV2
  if (!isEIP3009Payload(candidate)) return undefined
  const from: unknown = candidate.authorization.from
  return typeof from === "string" ? from : undefined
}

/**
 * Build the seller Express app. Handler order on the protected route is the
 * security invariant, and it is literally the argument order of one app.get:
 *
 *   1. ACK-ID identity verification (did:web resolution + JWT verification)
 *   2. Authorization stub (amount cap)          (1 and 2 are identityGate)
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
      const verified = await verifyIdentityProof(
        stripBearer(req.headers.authorization),
        { audience: identity.did, resolver },
      )
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
      // The verdict is typed boolean but arrives runtime-unvalidated from the
      // facilitator client, and x402 settles on its truthiness: a garbage
      // verdict like "false" would settle a payment the facilitator never
      // declared valid. Only an explicit true proceeds to the checks below.
      // An explicit false settles nothing, so it must consume nothing:
      // otherwise a bogus payment quoting the bound wallet would burn a
      // valid proof's nonce and deny the real holder. Anything else aborts.
      // Optional-chained: a null result must abort below, not throw here
      // (x402 swallows hook throws and proceeds).
      const verdict: unknown = (
        ctx.result as { isValid?: unknown } | null | undefined
      )?.isValid
      if (verdict === false) return Promise.resolve()
      if (verdict !== true) {
        return Promise.resolve({
          abort: true as const,
          reason: "facilitator_verdict_malformed",
          message: "Facilitator verify result was not a boolean verdict",
        })
      }
      try {
        const token = bearerFromTransport(ctx.transportContext)
        const bound = token
          ? readBoundPaymentAddress(token)?.toLowerCase()
          : undefined
        const payer = paymentPayer(ctx.paymentPayload.payload)?.toLowerCase()
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
        consumeProofNonce(token, nonceCache)
      } catch (error) {
        // x402 swallows a hook throw and settles the payment anyway, so nothing
        // in this hook may escape: an unchecked failure would settle without
        // binding the payer or consuming the nonce.
        const identityError = error instanceof IdentityError ? error : undefined
        return Promise.resolve({
          abort: true as const,
          reason: identityError?.code ?? "identity_check_failed",
          message:
            identityError?.message ??
            "Identity could not be checked at settlement",
        })
      }
      return Promise.resolve()
    })
  const payment = paymentMiddleware(
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
  )

  // Express answers HEAD through app.get handlers, but the x402 route key
  // above only covers GET, so a HEAD request would skip the payment layer
  // and reach the handler. Registered before app.get so it wins the route.
  app.head(PROTECTED_PATH, (_req, res) => {
    res.set("Allow", "GET").status(405).end()
  })

  // The invariant, as one ordered chain: gate, payment, resource (4). Mounting
  // them together is the point: a separate `app.use` for the gate could be
  // skipped by a route registered above it, and paymentMiddleware reads
  // `req.path`, so it must stay on a route that keeps the full path (an
  // `app.use(PROTECTED_PATH, ...)` mount strips it and the route below would
  // then serve the resource for free).
  app.get(PROTECTED_PATH, identityGate, payment, (_req, res) => {
    res.json({
      report: "premium-market-signal",
      signal: "accumulate",
      confidence: 0.87,
      buyer: res.locals.buyerDid,
      issuedAt: new Date().toISOString(),
    })
  })

  // Errors from any handler above: log the stack, return a bare 500. Express's
  // default handler puts the stack in the response body outside production.
  app.use(
    (
      error: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ): void => {
      console.error(error)
      res.status(500).json({ error: "internal_error" })
    },
  )

  return { app, identity }
}
