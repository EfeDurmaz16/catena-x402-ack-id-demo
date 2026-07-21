import { randomUUID } from "node:crypto"
import {
  createDidWebDocumentFromKeypair,
  getDidResolver,
  isDidUri
} from "@agentcommercekit/did"
import { createJwt, createJwtSigner, verifyJwt } from "@agentcommercekit/jwt"
import { generateKeypair } from "@agentcommercekit/keys"
import type { DidDocument, DidResolver, DidUri } from "@agentcommercekit/did"
import type { Keypair } from "@agentcommercekit/keys"

export interface Identity {
  did: DidUri
  didDocument: DidDocument
  keypair: Keypair
}

/** Generate a fresh secp256k1 keypair and its did:web document for `baseUrl`. */
export async function createIdentity(baseUrl: string): Promise<Identity> {
  const keypair = await generateKeypair("secp256k1")
  const { did, didDocument } = createDidWebDocumentFromKeypair({
    keypair,
    baseUrl
  })
  return { did, didDocument, keypair }
}

export interface CreateProofOptions {
  /** DID the proof claims to be from (`iss`). */
  issuerDid: DidUri
  /** Keypair used to sign. Must control `issuerDid` for the proof to verify. */
  keypair: Keypair
  /** Intended recipient (`aud`), the seller's DID. */
  audience: string
  /** Seconds until expiry. Negative produces an already-expired proof. */
  expiresInSeconds?: number
}

/**
 * Sign an ACK-ID identity proof: a did-jwt JWT with iss/aud/nonce/exp,
 * verifiable against the key published in the issuer's did:web document.
 */
export async function createIdentityProof(
  options: CreateProofOptions
): Promise<string> {
  const { issuerDid, keypair, audience, expiresInSeconds = 300 } = options
  return createJwt(
    { aud: audience, nonce: randomUUID() },
    {
      issuer: issuerDid,
      signer: createJwtSigner(keypair),
      expiresIn: expiresInSeconds
    }
  )
}

export type IdentityRejectionCode =
  | "identity_missing"
  | "identity_invalid"
  | "identity_expired"
  | "identity_mismatched"
  | "identity_replayed"

export class IdentityError extends Error {
  readonly code: IdentityRejectionCode
  readonly status: number

  constructor(code: IdentityRejectionCode, message: string) {
    super(message)
    this.name = "IdentityError"
    this.code = code
    // 401: authentication failed (absent, malformed, expired credentials).
    // 403: proof is well-formed but must not be accepted (wrong key, replay).
    this.status =
      code === "identity_mismatched" || code === "identity_replayed" ? 403 : 401
  }
}

/**
 * In-memory nonce replay cache. The ACK libraries verify signatures and
 * standard JWT claims but leave replay protection to the application.
 * ponytail: in-memory Map, swap for a shared store if the seller ever runs
 * more than one instance.
 */
export class NonceCache {
  #seen = new Map<string, number>()

  /** Returns false if the nonce was already used and has not expired. */
  markUsed(nonce: string, expiresAtMs: number): boolean {
    const now = Date.now()
    for (const [key, expiry] of this.#seen) {
      if (expiry <= now) this.#seen.delete(key)
    }
    if (this.#seen.has(nonce)) return false
    this.#seen.set(nonce, expiresAtMs)
    return true
  }
}

export interface VerifyProofOptions {
  /** The seller's DID; the proof's `aud` must match. */
  audience: string
  resolver?: DidResolver
  nonceCache?: NonceCache
  /**
   * Whether to consume the proof's nonce. The x402 flow sends the same proof
   * twice (the unpaid request that earns the 402 challenge, then the paid
   * retry), so the nonce is only consumed on requests that carry a payment -
   * the ones that can reach settlement.
   */
  consumeNonce?: boolean
}

export interface VerifiedIdentity {
  did: DidUri
  nonce: string
}

/**
 * Verify an identity proof: resolve the issuer's did:web document, check the
 * JWT signature against its published keys, and enforce aud, exp and nonce
 * single-use. Throws IdentityError with a stable rejection code.
 */
export async function verifyIdentityProof(
  jwt: string | undefined,
  options: VerifyProofOptions
): Promise<VerifiedIdentity> {
  const {
    audience,
    resolver = getDidResolver(),
    nonceCache,
    consumeNonce = true
  } = options
  if (!jwt) {
    throw new IdentityError("identity_missing", "No identity proof provided")
  }

  let payload
  try {
    const verified = await verifyJwt(jwt, { audience, resolver })
    payload = verified.payload
  } catch (error) {
    throw classifyVerificationError(error)
  }

  const issuer = payload.iss
  if (!isDidUri(issuer)) {
    throw new IdentityError(
      "identity_invalid",
      "Identity proof issuer is not a DID"
    )
  }
  const nonce = payload.nonce
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new IdentityError(
      "identity_invalid",
      "Identity proof is missing a nonce"
    )
  }
  if (nonceCache && consumeNonce) {
    const expiresAtMs = (payload.exp ?? Math.floor(Date.now() / 1000)) * 1000
    if (!nonceCache.markUsed(nonce, expiresAtMs)) {
      throw new IdentityError(
        "identity_replayed",
        "Identity proof nonce was already used"
      )
    }
  }
  return { did: issuer, nonce }
}

function classifyVerificationError(error: unknown): IdentityError {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("expired")) {
    return new IdentityError("identity_expired", "Identity proof has expired")
  }
  if (
    message.includes("Signature invalid") ||
    message.includes("no matching public key") ||
    message.includes("invalid_signature")
  ) {
    return new IdentityError(
      "identity_mismatched",
      "Identity proof signature does not match the claimed DID's published keys"
    )
  }
  if (message.includes("audience")) {
    return new IdentityError(
      "identity_mismatched",
      "Identity proof was issued for a different audience"
    )
  }
  return new IdentityError(
    "identity_invalid",
    `Identity proof could not be verified: ${message}`
  )
}
