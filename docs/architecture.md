# Architecture note: identity before payment

## The invariant

A request may only reach payment/settlement logic after its ACK-ID identity
proof has been verified and the authorization stub has approved it. The
enforcement is structural, not conventional: Express middleware order.

```
GET /api/premium
  └─ 1. identityGate            (src/seller/server.ts)
        - resolve iss (did:web) via @agentcommercekit/did
        - verify JWT signature against the DID document's published keys
        - check aud == seller DID, exp, nonce single-use (payment-bearing
          requests only; see below)
        - on failure: respond 401/403, return. next() is never called.
  └─ 2. authorization stub      (src/seller/authorization.ts)
        - DID already verified upstream + per-request amount cap
        - single injectable function; the seam where a real authorization
          system (e.g. Catena's policy engine) would plug in
  └─ 3. x402 paymentMiddleware  (@x402/express)
        - no payment header -> 402 challenge (PAYMENT-REQUIRED)
        - payment header    -> facilitator verify + settle, then next()
  └─ 4. protected handler
```

Steps 3 and 4 are only reachable through `next()` calls in 1 and 2. Every
rejection path in 1-2 ends the response without calling `next()`, so a
rejected request cannot invoke the facilitator.

## How this is proven, not just asserted

The seller receives its `FacilitatorClient` (the settlement adapter:
`verify`/`settle`/`getSupported`) by constructor injection.
`test/ordering.test.ts` injects a recording fake and asserts, for every
rejected-identity scenario (missing, malformed, expired, mismatched key,
wrong audience, over-cap, replayed nonce):

- the response is 401/403 with a stable error code, and
- `verifyCalls` and `settleCalls` are both empty.

The demo scripts wrap the *real* HTTP facilitator in the same counting
decorator and print the counts, so the property is visible in live runs too.

## The identity proof

A plain did-jwt JWT (ES256K), created and verified with the public Agent
Commerce Kit libraries (`@agentcommercekit/did`, `jwt`, `keys`):

```
{ iss: <buyer did:web>, aud: <seller did:web>, nonce: <uuid>, exp: now+300s, iat }
```

Verification resolves `iss` to its did:web document (served at
`/.well-known/did.json`) and checks the signature against the published
verification keys. "Mismatched identity" is exactly the case where the JWT is
signed by a key the claimed DID does not publish: an attacker asserting an
identity they do not control.

Deliberately out of scope: ACK-ID's ControllerCredential/VC layer (agent-to-
owner ownership chains). It adds an A2A dependency without changing the
identity-before-payment story this demo exists to show.

### Nonce semantics under x402

x402 sends the same request twice: an unpaid request that earns the 402
challenge, then a paid retry carrying `PAYMENT-SIGNATURE`. Both carry the same
identity proof. The nonce is therefore consumed only by payment-bearing
requests: the ones that can reach settlement. Unpaid requests verify the
proof but leave the nonce intact; replaying a proof on a second
payment-bearing request is rejected (403 `identity_replayed`) before the
payment layer. The replay cache is in-memory (single-instance demo scope).

## Payment leg

x402 protocol v2 (`@x402/*` 2.19.0), `exact` scheme on `eip155:84532`
(Base Sepolia), USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle's
canonical testnet deployment). The buyer signs an EIP-3009
`transferWithAuthorization` (EIP-712, gasless); the facilitator verifies and
settles on-chain and the seller returns the protected result with the
settlement transaction in `PAYMENT-RESPONSE`.

## Catena integration surface

As of 2026-07-21 Catena Labs has no publicly documented payments API and no
live Catena-operated x402 facilitator; ACK's own docs list "ACK Payment
Services acting as x402 Facilitators" as a future direction, and the ACK-Lab
developer preview is closed. The Catena-owned public surface used here is the
Agent Commerce Kit libraries (identity leg).

The settlement adapter is the seam prepared for Catena: the facilitator URL
is env-injected (`X402_FACILITATOR_URL`) and the seller depends only on the
`FacilitatorClient` interface. When a Catena sandbox facilitator endpoint
exists, pointing the env var at it upgrades the demo to settle "through
Catena" with no code changes (plus credentials, if its auth scheme requires
them: `HTTPFacilitatorClient` supports auth headers).
