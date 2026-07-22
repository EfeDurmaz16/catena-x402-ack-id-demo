# catena-x402-ack-id-demo

An [x402](https://github.com/x402-foundation/x402) seller that verifies an [ACK-ID](https://www.agentcommercekit.com) identity proof before any payment logic runs, then settles USDC on Base Sepolia. No verified identity, no payment. Tests assert the settlement adapter is never invoked for rejected identities.

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
  |          200 + PAYMENT-RESPONSE   |
  |<----------------------------------|
```

Rejected identities (missing, malformed, expired, mismatched, replayed) stop at step 1 with 401/403. [docs/architecture.md](docs/architecture.md) explains why the ordering holds.

## Quickstart

Node >= 22.13, pnpm >= 9.

```sh
pnpm install
cp .env.example .env
```

The rejected-identity demos need no keys or funds:

```sh
pnpm demo:missing-identity
pnpm demo:mismatched-identity
pnpm demo:expired-identity
```

For the real payment against the Catena sandbox:

1. **Catena sandbox account.** Sign in at [app.catena.com](https://app.catena.com) and create (or open) a sandbox agent. In the sandbox, open the account and copy its **Base Sepolia USDC deposit address** (the console shows it; the same value the API's `get_deposit_address` returns). This is where the payment will land. Set it as `SELLER_PAY_TO_ADDRESS` in `.env`.
2. **Buyer wallet.** `pnpm exec tsx scripts/new-wallet.ts`, then fund the printed address with Base Sepolia USDC at [faucet.circle.com](https://faucet.circle.com) (select Base Sepolia). No ETH needed; transfers are gasless EIP-3009 and the facilitator pays gas. Set the printed key as `BUYER_EVM_PRIVATE_KEY`.
3. `pnpm demo:valid` completes a ~$0.001 USDC payment, then reads the chain over a public RPC to confirm the exact amount reached your Catena deposit address (the "Loop closed" line). The deposit also appears in the Catena console as a completed incoming transaction.

Nothing here needs the Catena CLI or SDK: the demo consumes public surfaces only (the sandbox account as the receiving bank, a public facilitator, and a public RPC for confirmation).

## Commands

| Command                                      | Result                                                    |
| -------------------------------------------- | --------------------------------------------------------- |
| `pnpm demo:valid`                            | Verified identity, real USDC settlement, protected result |
| `pnpm demo:missing-identity`                 | 401 before any payment logic                              |
| `pnpm demo:mismatched-identity`              | 403 before any payment logic                              |
| `pnpm demo:expired-identity`                 | 401 before any payment logic                              |
| `pnpm seller`                                | Seller service standalone                                 |
| `pnpm test` / `pnpm lint` / `pnpm typecheck` | Checks                                                    |

## Layout

- [src/identity.ts](src/identity.ts): ACK-ID proof creation and verification, nonce replay cache
- [src/seller/server.ts](src/seller/server.ts): identity gate → authorization stub → x402 middleware → handler
- [src/seller/authorization.ts](src/seller/authorization.ts): the injectable authorization stub (amount cap)
- [src/buyer/buyer.ts](src/buyer/buyer.ts): scripted buyer, one entrypoint per scenario
- [src/onchain.ts](src/onchain.ts): on-chain confirmation that the USDC reached the Catena account
- [test/ordering.test.ts](test/ordering.test.ts): proof that rejected identities never reach settlement

## License

MIT
