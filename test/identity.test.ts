import { createServer } from "node:http"
import { createJwt, createJwtSigner } from "@agentcommercekit/jwt"
import { generateKeypair } from "@agentcommercekit/keys"
import { afterEach, describe, expect, it } from "vitest"
import { startDidHost } from "../src/buyer/did-host.js"
import { loadConfig, moneyToMicros } from "../src/config.js"
import {
  consumeProofNonce,
  createIdentity,
  createSellerResolver,
  createIdentityProof,
  IdentityError,
  NonceCache,
  verifyIdentityProof,
} from "../src/identity.js"
import { createAmountCapAuthorization } from "../src/seller/authorization.js"
import type { DidHost } from "../src/buyer/did-host.js"
import type { AddressInfo } from "node:net"
import type { Identity } from "../src/identity.js"

const SELLER_DID = "did:web:seller.example"

let host: DidHost | undefined

afterEach(async () => {
  await host?.close()
  host = undefined
})

/** Start a DID host and mint an identity whose document it serves. */
async function hostedIdentity(): Promise<Identity> {
  host = await startDidHost()
  const identity = await createIdentity(host.baseUrl)
  host.setDocument(identity.didDocument)
  return identity
}

async function expectRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(IdentityError)
  expect((error as IdentityError).code).toBe(code)
}

describe("moneyToMicros", () => {
  it("parses money strings into exact micro-dollars", () => {
    expect(moneyToMicros("$0.001")).toBe(1000n)
    expect(moneyToMicros("$1")).toBe(1_000_000n)
    expect(moneyToMicros("$12.34")).toBe(12_340_000n)
  })

  it("rejects malformed and over-precise values", () => {
    expect(() => moneyToMicros("0.001")).toThrow()
    expect(() => moneyToMicros("$0.0000001")).toThrow()
  })
})

describe("config", () => {
  it("rejects a zero endpoint price (a paid endpoint must charge > 0)", () => {
    expect(() => loadConfig({ ENDPOINT_PRICE_USD: "$0" })).toThrow()
    expect(() => loadConfig({ ENDPOINT_PRICE_USD: "$0.000000" })).toThrow()
  })

  it("accepts a positive price", () => {
    expect(
      loadConfig({ ENDPOINT_PRICE_USD: "$0.001" }).ENDPOINT_PRICE_USD,
    ).toBe("$0.001")
  })

  it("treats empty optional env values as absent (copied .env.example)", () => {
    // A fresh `cp .env.example .env` leaves these empty; empty must mean unset,
    // not an invalid address/key, or the keyless demos fail at startup.
    const config = loadConfig({
      SELLER_PAY_TO_ADDRESS: "",
      BUYER_EVM_PRIVATE_KEY: "",
    })
    expect(config.SELLER_PAY_TO_ADDRESS).toBeUndefined()
    expect(config.BUYER_EVM_PRIVATE_KEY).toBeUndefined()
  })
})

describe("amount-cap authorization stub", () => {
  const authorize = createAmountCapAuthorization("$0.05")
  const did = "did:web:buyer.example" as const

  it("allows prices at or under the cap", async () => {
    expect((await authorize({ did, price: "$0.001" })).allowed).toBe(true)
    expect((await authorize({ did, price: "$0.05" })).allowed).toBe(true)
  })

  it("denies prices over the cap", async () => {
    const decision = await authorize({ did, price: "$0.06" })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain("cap")
  })
})

describe("identity proof verification (did:web + JWT)", () => {
  it("verifies a valid proof and returns the buyer DID", async () => {
    const identity = await hostedIdentity()
    const proof = await createIdentityProof({
      issuerDid: identity.did,
      keypair: identity.keypair,
      audience: SELLER_DID,
    })
    const verified = await verifyIdentityProof(proof, { audience: SELLER_DID })
    expect(verified.did).toBe(identity.did)
    expect(verified.nonce).toBeTruthy()
  })

  it("rejects a missing proof as identity_missing", async () => {
    await expectRejection(
      verifyIdentityProof(undefined, { audience: SELLER_DID }),
      "identity_missing",
    )
  })

  it("rejects a malformed proof as identity_invalid", async () => {
    await expectRejection(
      verifyIdentityProof("not-a-jwt", { audience: SELLER_DID }),
      "identity_invalid",
    )
  })

  it("rejects an expired proof as identity_expired", async () => {
    const identity = await hostedIdentity()
    const proof = await createIdentityProof({
      issuerDid: identity.did,
      keypair: identity.keypair,
      audience: SELLER_DID,
      expiresInSeconds: -600,
    })
    await expectRejection(
      verifyIdentityProof(proof, { audience: SELLER_DID }),
      "identity_expired",
    )
  })

  it("rejects a proof signed by a key the DID does not publish as identity_mismatched", async () => {
    const identity = await hostedIdentity()
    const rogue = await generateKeypair("secp256k1")
    const proof = await createIdentityProof({
      issuerDid: identity.did,
      keypair: rogue,
      audience: SELLER_DID,
    })
    await expectRejection(
      verifyIdentityProof(proof, { audience: SELLER_DID }),
      "identity_mismatched",
    )
  })

  it("rejects a proof that omits aud entirely as identity_mismatched", async () => {
    // did-jwt skips its audience check when the payload has no aud claim,
    // so this must be caught by our own exact-match guard.
    const identity = await hostedIdentity()
    const proof = await createJwt(
      { nonce: "nonce-without-aud" },
      {
        issuer: identity.did,
        signer: createJwtSigner(identity.keypair),
        expiresIn: 300,
      },
    )
    await expectRejection(
      verifyIdentityProof(proof, { audience: SELLER_DID }),
      "identity_mismatched",
    )
  })

  it("rejects a proof issued for a different audience as identity_mismatched", async () => {
    const identity = await hostedIdentity()
    const proof = await createIdentityProof({
      issuerDid: identity.did,
      keypair: identity.keypair,
      audience: "did:web:some-other-seller.example",
    })
    await expectRejection(
      verifyIdentityProof(proof, { audience: SELLER_DID }),
      "identity_mismatched",
    )
  })

  it("consumeProofNonce consumes a nonce once and rejects the second use", async () => {
    // Replay single-use is enforced at settlement, not during verification, so
    // that an unpaid or non-settling request never burns a legitimate nonce.
    const identity = await createIdentity("https://buyer.example")
    const cache = new NonceCache()
    const proof = await createIdentityProof({
      issuerDid: identity.did,
      keypair: identity.keypair,
      audience: SELLER_DID,
    })
    consumeProofNonce(proof, cache) // first use: consumed
    let error: unknown
    try {
      consumeProofNonce(proof, cache) // second use: replay
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(IdentityError)
    expect((error as IdentityError).code).toBe("identity_replayed")
  })

  it("rejects a proof with no expiry as identity_invalid", async () => {
    // A non-expiring proof would verify forever and its nonce would never be
    // pruned; require a bounded exp.
    const identity = await hostedIdentity()
    const proof = await createJwt(
      { aud: SELLER_DID, nonce: "no-exp-nonce" },
      { issuer: identity.did, signer: createJwtSigner(identity.keypair) },
    )
    await expectRejection(
      verifyIdentityProof(proof, { audience: SELLER_DID }),
      "identity_invalid",
    )
  })

  it("rejects a proof whose expiry is too far in the future as identity_invalid", async () => {
    const identity = await hostedIdentity()
    const proof = await createIdentityProof({
      issuerDid: identity.did,
      keypair: identity.keypair,
      audience: SELLER_DID,
      expiresInSeconds: 100_000, // well beyond the 900s cap
    })
    await expectRejection(
      verifyIdentityProof(proof, { audience: SELLER_DID }),
      "identity_invalid",
    )
  })
})

describe("NonceCache TTL", () => {
  it("blocks reuse before expiry and allows it only after the entry is pruned", () => {
    const cache = new NonceCache()
    const now = Date.now()
    // Reserve a nonce that expires in the past: it is stored, then pruned on
    // the next call, so a fresh reservation of the same value succeeds.
    expect(cache.markUsed("n1", now - 1)).toBe(true)
    expect(cache.markUsed("n1", now + 60_000)).toBe(true)
    // Now it is reserved into the future: an immediate reuse is blocked.
    expect(cache.markUsed("n1", now + 60_000)).toBe(false)
  })
})

describe("did:web resolution safety", () => {
  it("refuses to follow a redirect during DID resolution", async () => {
    // The library applies its http/https allowlist to the FIRST url only and
    // Node follows redirects by default, so without redirect: "error" a
    // did:web could bounce the seller to plain http or an internal address.
    // Legitimate documents are served directly, so refusing costs nothing.
    let targetHits = 0
    const target = createServer((_req, res) => {
      targetHits += 1
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "did:web:whatever" }))
    })
    await new Promise<void>((resolve) => target.listen(0, resolve))
    const targetPort = (target.address() as AddressInfo).port

    const redirector = createServer((_req, res) => {
      res.writeHead(302, {
        location: `http://127.0.0.1:${targetPort}/.well-known/did.json`,
      })
      res.end()
    })
    await new Promise<void>((resolve) => redirector.listen(0, resolve))
    const redirectorPort = (redirector.address() as AddressInfo).port

    try {
      const resolver = createSellerResolver()
      const resolution = await resolver.resolve(
        `did:web:localhost%3A${redirectorPort}`,
      )
      expect(resolution.didResolutionMetadata.error).toBe("notFound")
      expect(targetHits).toBe(0) // the redirect was never followed
    } finally {
      await new Promise<void>((resolve) => {
        target.close(() => {
          resolve()
        })
      })
      await new Promise<void>((resolve) => {
        redirector.close(() => {
          resolve()
        })
      })
    }
  })
})
