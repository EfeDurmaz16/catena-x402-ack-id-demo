# Demo script (3-5 minutes)

Audience: anyone who should understand why identity-gated payments matter for
agent commerce. Two live runs: one rejection, one real payment.

## Setup (before the demo)

- `pnpm install`, `.env` filled in, buyer wallet funded with Base Sepolia
  USDC (see README quickstart).
- Terminal open in the repo, font large.

## 1. Frame it (30s)

> "Agents are starting to pay each other over HTTP. x402 handles the payment
> leg. But a payment rail without identity is a vending machine: anyone with
> coins gets served. This demo shows the missing half: the seller verifies
> WHO is paying, cryptographically, before any money moves."

## 2. Rejected run (60-90s)

```sh
pnpm demo:mismatched-identity
```

Talk over the output:

> "The buyer here claims a did:web identity but signs with a key that
> identity never published: an agent impersonating another agent. The seller
> resolves the DID document, checks the signature, and rejects with 403."

Point at the last two lines:

> "And this is the important part. Settlement adapter calls: verify zero,
> settle zero. The payment machinery was never touched. That's asserted in
> the test suite too, not just printed."

## 3. Valid run (60-90s)

```sh
pnpm demo:valid
```

Talk over the output:

> "Same endpoint, but now the proof verifies against the buyer's did:web
> document. The seller answers 402 with payment requirements, the buyer signs
> a gasless USDC authorization, the facilitator settles it on Base Sepolia,
> and the protected resource comes back."

Open the printed BaseScan link:

> "That's a real on-chain USDC transfer, about a tenth of a cent, settled
> by the x402 facilitator."

## 4. Close (30s)

> "The whole policy surface between identity and payment is one deliberately
> small injectable stub: verified DID plus an amount cap. That's the seam
> where a real authorization engine plugs in. Identity first, payment second,
> and the ordering is proven by tests that show the settlement adapter is
> never invoked for rejected identities."

## Fallbacks

- No network/funds: run `pnpm demo:missing-identity` and `pnpm test` instead
  of the valid run; the ordering tests tell the same story offline.
- Facilitator flaky: re-run once; the buyer wallet needs USDC only, no ETH.
