import { generateKeypair } from "@agentcommercekit/keys"
import { describe, expect, it } from "vitest"
import { startDidHost } from "../src/buyer/did-host.js"
import { moneyToMicros } from "../src/config.js"
import {
  createIdentity,
  createIdentityProof,
  IdentityError,
  NonceCache,
  verifyIdentityProof
} from "../src/identity.js"
import { createAmountCapAuthorization } from "../src/seller/authorization.js"
import type { Identity } from "../src/identity.js"
import type { DidHost } from "../src/buyer/did-host.js"

const SELLER_DID = "did:web:seller.example"

async function hostedIdentity(): Promise<{ identity: Identity; host: DidHost }> {
  const host = await startDidHost()
  const identity = await createIdentity(host.baseUrl)
  host.setDocument(identity.didDocument)
  return { identity, host }
}

async function expectRejection(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
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
    const { identity, host } = await hostedIdentity()
    try {
      const proof = await createIdentityProof({
        issuerDid: identity.did,
        keypair: identity.keypair,
        audience: SELLER_DID
      })
      const verified = await verifyIdentityProof(proof, {
        audience: SELLER_DID
      })
      expect(verified.did).toBe(identity.did)
      expect(verified.nonce).toBeTruthy()
    } finally {
      await host.close()
    }
  })

  it("rejects a missing proof as identity_missing", async () => {
    await expectRejection(
      verifyIdentityProof(undefined, { audience: SELLER_DID }),
      "identity_missing"
    )
  })

  it("rejects a malformed proof as identity_invalid", async () => {
    await expectRejection(
      verifyIdentityProof("not-a-jwt", { audience: SELLER_DID }),
      "identity_invalid"
    )
  })

  it("rejects an expired proof as identity_expired", async () => {
    const { identity, host } = await hostedIdentity()
    try {
      const proof = await createIdentityProof({
        issuerDid: identity.did,
        keypair: identity.keypair,
        audience: SELLER_DID,
        expiresInSeconds: -600
      })
      await expectRejection(
        verifyIdentityProof(proof, { audience: SELLER_DID }),
        "identity_expired"
      )
    } finally {
      await host.close()
    }
  })

  it("rejects a proof signed by a key the DID does not publish as identity_mismatched", async () => {
    const { identity, host } = await hostedIdentity()
    try {
      const rogue = await generateKeypair("secp256k1")
      const proof = await createIdentityProof({
        issuerDid: identity.did,
        keypair: rogue,
        audience: SELLER_DID
      })
      await expectRejection(
        verifyIdentityProof(proof, { audience: SELLER_DID }),
        "identity_mismatched"
      )
    } finally {
      await host.close()
    }
  })

  it("rejects a proof issued for a different audience as identity_mismatched", async () => {
    const { identity, host } = await hostedIdentity()
    try {
      const proof = await createIdentityProof({
        issuerDid: identity.did,
        keypair: identity.keypair,
        audience: "did:web:some-other-seller.example"
      })
      await expectRejection(
        verifyIdentityProof(proof, { audience: SELLER_DID }),
        "identity_mismatched"
      )
    } finally {
      await host.close()
    }
  })

  it("rejects a replayed nonce as identity_replayed", async () => {
    const { identity, host } = await hostedIdentity()
    try {
      const nonceCache = new NonceCache()
      const proof = await createIdentityProof({
        issuerDid: identity.did,
        keypair: identity.keypair,
        audience: SELLER_DID
      })
      await verifyIdentityProof(proof, { audience: SELLER_DID, nonceCache })
      await expectRejection(
        verifyIdentityProof(proof, { audience: SELLER_DID, nonceCache }),
        "identity_replayed"
      )
    } finally {
      await host.close()
    }
  })
})
