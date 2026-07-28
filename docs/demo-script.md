# Demo script (3-5 min screen recording)

Target: show a successful, verified run and a rejected run, per the
acceptance criteria. Rehearse once; the whole flow is deterministic.

Prep (off camera): `.env` filled in, buyer wallet funded with Base Sepolia
USDC, `pnpm install` done, the Catena console open in a background tab on
the account's transactions view.

## Scene 1 - What this is (30s)

Show the README top. Say:

> An x402 seller that verifies the buyer's ACK-ID identity, did:web plus a
> signed JWT, before any payment logic runs. Then a real USDC payment on
> Base Sepolia settles into a Catena sandbox account. Identity strictly
> before payment, and the tests prove the ordering.

## Scene 2 - The verified run (90s)

```sh
pnpm demo:valid
```

Point at, in order:

- `Seller: ... did:web:localhost...` - the seller's own identity
- `HTTP status: 200` and `Settlement: success=true`
- `On-chain: 1000 atomic USDC confirmed to 0x7b59... (block N)` - say:
  the facilitator's answer is a claim; the demo re-reads the chain over a
  public RPC and confirms the exact amount reached the deposit address
- `verify=1 settle=1` - the settlement adapter ran exactly once

Switch to the Catena console tab, refresh transactions, show the incoming
$0.001 with the matching tx hash. Say: settlement lands inside a
Catena-governed account, and the ledger agrees with the chain.

## Scene 3 - The rejected runs (60s)

```sh
pnpm demo:missing-identity
pnpm demo:mismatched-identity
```

Point at: 401 for missing, 403 for mismatched (a proof signed by a key the
DID does not publish, the impersonation case), and both ending with
`verify=0 settle=0`. Say:

> Rejected identities never reach the settlement adapter. That is not a
> log line, it is an assertion the test suite makes on every rejection
> path.

## Scene 4 - Close (30s)

Show `pnpm test` output (37 tests) briefly, then the review notebook at
v1.efebarandurmaz.com for one beat. Closing line:

> Everything here consumes public surfaces only: the agentcommercekit
> libraries, the public x402 flow, and a sandbox account as the receiving
> bank. No Catena SDK or CLI in the runtime.
