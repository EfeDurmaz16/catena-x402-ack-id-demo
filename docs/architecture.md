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
non-did:web, over-cap, replayed nonce) and for each of those again with a
payment header present: the response is 401/403 and zero `verify`/`settle`
calls were made. (`getSupported` is capability discovery: the x402 middleware
calls it once at startup, never on a request, so it is not part of the
settlement path.) The demo scripts wrap the real facilitator in a counting
decorator and print the counts.

## The identity proof

A did-jwt JWT (ES256K) built with the agentcommercekit libraries:

```
{ iss: <buyer did:web>, aud: <seller did:web>, nonce: <uuid>, exp: now+300s }
```

The seller resolves `iss` to its did:web document and checks the signature
against the published keys. `iss` must be did:web specifically: the default
resolver also handles did:key and did:pkh, but a self-issued did:key verifies
against its own embedded key and proves no domain control, so those methods
are rejected. "Mismatched identity" means the JWT was signed by a key the
claimed DID does not publish. The VC/ControllerCredential layer of ACK-ID is
intentionally out of scope.

The proof also binds the wallet that pays: a `paymentAddress` claim naming the
buyer's EVM address.

## Binding identity to the payer

Verifying who is asking is not enough if anyone's payment can satisfy it. The
proof commits to a `paymentAddress`, and an `onAfterVerify` hook on the x402
resource server compares it to the wallet that actually signed the payment
(the EIP-3009 `from`). The hook runs after the facilitator verifies the
payment but before it settles, so a mismatch is rejected without moving money.
This closes the attack of pairing a valid identity proof with someone else's
payment authorization: the authenticated identity must control the paying
wallet.

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

## Confirming the settlement

The facilitator's `PAYMENT-RESPONSE` is a claim; the source of truth for "the
money reached the Catena account" is the chain. After settlement the demo reads
the transaction receipt over a public Base Sepolia RPC (`src/onchain.ts`) and
checks that a USDC `Transfer` for the exact amount went to the seller's Catena
deposit address. A reverted transaction, a transfer to the wrong address, or
the wrong amount fails the run; an unreadable receipt (RPC lag) is reported but
does not fail it, since the facilitator already settled. This uses only a
public RPC, so it adds no Catena CLI or SDK dependency.

## Catena surface

The seller's `payTo` is a Catena sandbox account's base-sepolia USDC deposit
address, so settlement lands in a Catena-governed account and shows up in its
ledger. The facilitator URL is env-injected (`X402_FACILITATOR_URL`, default
x402.org); a Catena facilitator would be a config change. The repo consumes
public surfaces only: agentcommercekit packages, x402 packages, the public
facilitator, and the sandbox account as the receiving bank.

## Known limitations

Real gaps a production version would close; called out so they are choices,
not oversights.

- **At-most-once nonce, no settlement reconciliation.** The nonce is consumed
  when a payment header is present, before the payment is decoded or settled.
  A garbage payment burns a valid proof (harmless: re-mint), but if settlement
  succeeds and the response is then lost, retrying the same proof is rejected
  rather than reconciled, a charge-without-delivery path. Production needs an
  idempotency key derived from the payment authorization.
- **Single process.** The nonce cache is in-memory, so replay protection does
  not hold across replicas or restarts. A shared store (Redis) keyed on the
  nonce is the production form.
- **No request rate limiting.** The seller does not cap request rate, so a
  caller can hammer the endpoint unbounded (each request costs a did:web
  resolution, bounded by the 5s fetch timeout, and a nonce-cache lookup,
  bounded by the cap). A production service would add per-IP / per-DID rate
  limiting. The public facilitator and RPC apply their own limits, and the
  price is required to be greater than zero so the demo never generates a
  0-value settlement.
- **did:web response size.** Resolution fetches with a timeout and allows HTTP
  only for local hosts (`createSellerResolver`), but does not cap the response
  body; a production resolver would stream and bound it.
