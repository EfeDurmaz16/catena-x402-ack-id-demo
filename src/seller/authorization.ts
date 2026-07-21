import { moneyToMicros } from "../config.js"
import type { DidUri } from "@agentcommercekit/did"

export interface AuthorizationRequest {
  /** The buyer DID, already verified against its did:web document. */
  did: DidUri
  /** Price of the requested resource, as a "$x.yz" money string. */
  price: string
}

export interface AuthorizationDecision {
  allowed: boolean
  reason?: string
}

export type Authorize = (
  request: AuthorizationRequest
) => Promise<AuthorizationDecision> | AuthorizationDecision

/**
 * AUTHORIZATION STUB: deliberately minimal and injectable.
 *
 * This is the single seam where a real authorization system (e.g. the Catena
 * policy engine) would plug in. Per the assignment scope it only does two
 * things: relies on the DID having been verified upstream, and enforces a
 * per-request amount cap. It must NOT grow into a policy engine.
 */
export function createAmountCapAuthorization(maxPrice: string): Authorize {
  const capMicros = moneyToMicros(maxPrice)
  return ({ did, price }) => {
    const priceMicros = moneyToMicros(price)
    if (priceMicros > capMicros) {
      return {
        allowed: false,
        reason: `Price ${price} exceeds the per-request cap ${maxPrice} for ${did}`
      }
    }
    return { allowed: true }
  }
}
