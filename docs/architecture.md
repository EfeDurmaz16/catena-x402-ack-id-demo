# Architecture: identity before payment

## The invariant

A request reaches payment logic only after its identity proof is verified and
the authorization stub approves it. Enforcement is Express middleware order,
not convention:

```
GET /api/premium
  1. identityGate        resolve iss (did:web), verify JWT signature against
                         the DID document, check aud, exp, nonce
  2. authorization stub  verified DID + amount cap; single injectable function
  3. x402 middleware     402 challenge, then facilitator verify + settle
  4. protected handler
```

Every rejection in 1-2 ends the response without calling `next()`, so 3-4 are
unreachable for rejected requests.

## Proven, not asserted

The seller receives its `FacilitatorClient` (verify/settle/getSupported) by
injection. Tests inject a recording fake and assert, for every rejected
scenario (missing, malformed, expired, mismatched key, wrong audience,
over-cap, replayed nonce): the response is 401/403 and zero facilitator calls
were made. The demo scripts wrap the real facilitator in a counting decorator
and print the counts.

## The identity proof

A did-jwt JWT (ES256K) built with the agentcommercekit libraries:

```
{ iss: <buyer did:web>, aud: <seller did:web>, nonce: <uuid>, exp: now+300s }
```

The seller resolves `iss` to its did:web document and checks the signature
against the published keys. "Mismatched identity" means the JWT was signed by
a key the claimed DID does not publish. The VC/ControllerCredential layer of
ACK-ID is intentionally out of scope.

## Nonce rules

x402 sends the same proof twice: an unpaid request that earns the 402, then a
paid retry. Only payment-bearing requests consume the nonce; a second paid use
is rejected 403 before the payment layer. Two hardening rules (see
`JWT_SKEW_SECONDS`, `MAX_PROOF_LIFETIME_SECONDS` in `src/identity.ts`):

- A proof must carry a bounded `exp`. did-jwt skips its expiry check when
  `exp` is absent, so a non-expiring proof would verify forever and its nonce
  entry would never be pruned.
- The nonce is reserved until `exp` plus did-jwt's ~300s clock skew. A shorter
  reservation would be pruned while the proof still verifies.

Known limit: the nonce is consumed on payment-header presence, not on a
validated payment. An attacker who captures an unspent proof (requires no TLS)
can burn its nonce; no money moves, the victim re-mints. The cache is
in-memory, single-instance scope.

## Payment leg

x402 v2 (`@x402/*` 2.19.0), `exact` scheme, network `eip155:84532`, USDC
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`. The buyer signs a gasless
EIP-3009 `transferWithAuthorization`; the facilitator settles on-chain and the
response carries the transaction in `PAYMENT-RESPONSE`.

## Catena surface

The seller's `payTo` is a Catena sandbox account's base-sepolia USDC deposit
address, so settlement lands in a Catena-governed account and shows up in its
ledger. The facilitator URL is env-injected (`X402_FACILITATOR_URL`, default
x402.org); a Catena facilitator would be a config change. The repo consumes
public surfaces only: agentcommercekit packages, x402 packages, the public
facilitator, and the sandbox account as the receiving bank.
