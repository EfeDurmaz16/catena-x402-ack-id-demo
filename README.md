# catena-x402-ack-id-demo

Reference demo of **identity-gated agentic payments**: an [x402](https://github.com/x402-foundation/x402) seller service that verifies an [ACK-ID](https://www.agentcommercekit.com) identity proof (did:web resolution + JWT verification) **before** any payment logic runs, then settles a small USDC payment on Base Sepolia through an x402 facilitator.

The one-sentence pitch: *no verified identity, no payment*. The tests prove the settlement adapter is never even invoked for rejected identities.

**Demo:** [media/demo.mp4](media/demo.mp4) is a short recording of two real runs (rejected identity, then a valid one that settles USDC on Base Sepolia into a Catena sandbox account) — real terminal output, the live review notebook, and the actual on-chain transaction on BaseScan. A per-page code-review notebook of the whole change is at [v1.efebarandurmaz.com](https://v1.efebarandurmaz.com).

```
Buyer                              Seller
  |  GET /api/premium                 |
  |  Authorization: Bearer <ACK-ID>   |
  |---------------------------------->|  1. resolve did:web, verify JWT
  |                                   |  2. authorization stub (amount cap)
  |          402 + PAYMENT-REQUIRED   |  3. x402 challenge
  |<----------------------------------|
  |  retry + PAYMENT-SIGNATURE        |
  |---------------------------------->|  1-2 again, then verify + settle
  |          200 + PAYMENT-RESPONSE   |     via facilitator (USDC on
  |<----------------------------------|     Base Sepolia)
```

Rejected identities (missing, malformed, expired, mismatched, replayed) stop at step 1 with a 401/403. See [docs/architecture.md](docs/architecture.md) for why the ordering holds.

## Quickstart (sandbox run in under 30 minutes)

Prerequisites: Node >= 22.13, pnpm >= 9.

```sh
pnpm install
cp .env.example .env
```

The three rejected-identity demos need no keys and no funds:

```sh
pnpm demo:missing-identity
pnpm demo:mismatched-identity
pnpm demo:expired-identity
```

Each starts the seller locally, runs the scripted buyer, and prints the HTTP outcome plus the settlement-adapter call counts (always zero for these).

For the real-payment run:

1. Generate a throwaway buyer wallet: `pnpm exec tsx scripts/new-wallet.ts`
2. Fund the printed address with Base Sepolia **USDC** at <https://faucet.circle.com> (free, select "Base Sepolia"). No ETH needed: x402's `exact` scheme uses gasless EIP-3009 transfers; the facilitator pays gas.
3. Set `BUYER_EVM_PRIVATE_KEY` (the printed key) and `SELLER_PAY_TO_ADDRESS` (any address you control) in `.env`.
4. Run:

```sh
pnpm demo:valid
```

This completes a real ~$0.001 USDC payment on Base Sepolia via the public x402 facilitator and prints the settlement transaction with a BaseScan link.

## Commands

| Command | What it does |
|---|---|
| `pnpm demo:valid` | Full happy path: verified identity, real USDC settlement, protected result |
| `pnpm demo:missing-identity` | No identity proof: 401 before any payment logic |
| `pnpm demo:mismatched-identity` | Proof signed by a key the claimed DID does not publish: 403 before any payment logic |
| `pnpm demo:expired-identity` | Expired proof: 401 before any payment logic |
| `pnpm seller` | Run the seller service standalone |
| `pnpm test` | Unit + integration tests (identity, ordering, authorization) |
| `pnpm lint` / `pnpm typecheck` | Static checks |

## What's where

- [src/identity.ts](src/identity.ts): ACK-ID proof creation/verification: did:web resolution via `@agentcommercekit/did`, JWT via `@agentcommercekit/jwt` (did-jwt, ES256K), plus the nonce replay cache the ACK libraries intentionally leave to the application.
- [src/seller/server.ts](src/seller/server.ts): the seller: identity gate → authorization stub → x402 payment middleware → protected handler, in that order.
- [src/seller/authorization.ts](src/seller/authorization.ts): the **authorization stub**: injectable, DID-verified + per-request amount cap, deliberately nothing more.
- [src/buyer/buyer.ts](src/buyer/buyer.ts): scripted buyer: mints a did:web identity, hosts its DID document, signs the proof for each scenario, pays via `@x402/fetch`.
- [src/counting-facilitator.ts](src/counting-facilitator.ts): settlement-adapter decorator that counts verify/settle calls; the demos print it, the tests assert on it.
- [test/ordering.test.ts](test/ordering.test.ts): proof that rejected identities never reach the settlement adapter.

## Catena sandbox note

The seller banks at Catena: set `SELLER_PAY_TO_ADDRESS` to your Catena sandbox account's base-sepolia USDC deposit address (shown in the Catena console). The x402 settlement then lands directly in the Catena-governed account, and the received payment is visible in the console and via Catena's account/transaction reads.

The facilitator endpoint is also env-injected (`X402_FACILITATOR_URL`, defaulting to the public x402 testnet facilitator); if Catena exposes a facilitator endpoint, point the env var at it; no code changes needed. See [docs/architecture.md](docs/architecture.md#catena-integration-surface) for the current state of Catena's public surface.

## License

MIT
