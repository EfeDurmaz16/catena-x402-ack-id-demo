import json

pages = []

pages.append({"n": 1, "title": "What this is, and the proof it works", "kicker": "OVERVIEW", "tag": "arch", "html": """
<span class="kicker">OVERVIEW</span><h2>What this is, and the proof it works</h2>
<p><span class="tag arch">ARCHITECTURE</span></p>
<div class="tldr"><b>In short.</b> A reference demo of identity-gated agentic payments: an x402 seller that verifies an ACK-ID identity proof (did:web + JWT) before any payment logic runs, then settles real USDC on Base Sepolia into a Catena sandbox account. Rejected identities never reach settlement, and that claim is proven by tests, not asserted in prose.</div>
<h3><span class="ic">◆</span>The whole flow on one diagram</h3>
<pre class="mermaid">flowchart LR
  B[Buyer script<br/>did:web identity] -->|1. GET + ACK-ID proof| G[Identity gate]
  G -->|2. verified| A[Authorization stub<br/>amount cap]
  A -->|3. authorized| X[x402 middleware<br/>402 challenge / settle]
  X -->|4. verify + settle| F[Facilitator<br/>x402.org]
  F -->|USDC on Base Sepolia| C[(Catena sandbox<br/>account)]
  X -->|5. 200 + receipt| B
  G -.->|401/403, no payment| B
  click G call jumpTo("src/seller/server.ts", 115)
  click A call jumpTo("src/seller/authorization.ts", 28)
  click X call jumpTo("src/seller/server.ts", 198)
  classDef new fill:#EEF3FF,stroke:#2563FF,color:#1E56F0;
  class G,A,X new
</pre>
<h3><span class="ic">◆</span>Evidence from the live sandbox run (2026-07-21)</h3>
<ul>
<li>Successful path: HTTP 200, facilitator <code>verify=1 settle=1</code>, on-chain settlement <code>0xbb9e5c55c91dbf16619b9daf77bfb911dd4a8e61bb90095321fc01d2593e5645</code> (block 44448767), $0.001 USDC from the buyer wallet to the Catena sandbox deposit address. The demo also re-confirms the transfer against a public Base Sepolia RPC before it prints PASS.</li>
<li>Catena ledger confirmation: the payment shows up as incoming transaction <code>txn_01KY35YNSB550T3HBDG92E90Q6</code>, status completed, counterparty = the buyer address, txHash identical.</li>
<li>Rejected paths (missing, mismatched, expired identity): 401/403 with stable error codes and <code>verify=0 settle=0</code> printed by the demo runner.</li>
</ul>
<div class="callout"><div class="lb">Scope constraints honored</div>The repo consumes only public surfaces: the agentcommercekit npm packages, the public x402 protocol packages, the public testnet facilitator, and a Catena sandbox account as the seller's receiving bank. There is no Catena SDK or CLI dependency anywhere in the runtime, per the Project Assignment's scope rule.</div>
"""})

pages.append({"n": 2, "title": "The invariant: identity strictly before payment", "kicker": "CORE GUARANTEE", "tag": "sec", "html": """
<span class="kicker">CORE GUARANTEE</span><h2>The invariant: identity strictly before payment</h2>
<p><span class="tag sec">SECURITY</span></p>
<div class="tldr"><b>In short.</b> The ordering is enforced structurally by Express middleware order, not by convention: every rejection path in the identity gate ends the response without calling <code>next()</code>, so the x402 layer and the facilitator are unreachable for rejected requests.</div>
<div class="ba">
  <div class="col before"><div class="lb">Plain x402 (baseline)</div><pre class="mermaid">flowchart TB
  R[Request] --> P[x402 payment<br/>middleware]
  P --> H[Protected handler]
  P --> F[Facilitator settle]
  classDef gone fill:#FBEBE7,stroke:#A5341E,color:#A5341E;
  class P gone
</pre></div>
  <div class="col after"><div class="lb">This demo</div><pre class="mermaid">flowchart TB
  R[Request] --> G{Identity gate<br/>did:web + JWT}
  G -->|fail| E[401/403<br/>response ends]
  G -->|pass| Z{Authorization stub<br/>cap check}
  Z -->|deny| E
  Z -->|allow| P[x402 payment<br/>middleware]
  P --> F[Facilitator settle]
  P --> H[Protected handler]
  click G call jumpTo("src/seller/server.ts", 115)
  click Z call jumpTo("src/seller/server.ts", 126)
  click P call jumpTo("src/seller/server.ts", 198)
  classDef new fill:#EEF3FF,stroke:#2563FF,color:#1E56F0;
  class G,Z new
</pre></div>
</div>
<h3><span class="ic">◆</span>The gate itself</h3>
<div class="diffblock"><div class="fn"><span class="g"></span>src/seller/server.ts</div><div class="body">
<div class="dl add"><span class="s">+</span><span class="c">  const identityGate: RequestHandler = async (req, res, next) =&gt; {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    try {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      const verified = await verifyIdentityProof(extractBearerToken(req), {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        audience: identity.did,</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        resolver,</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      })</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      const decision = await authorize({ did: verified.did, price })</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      if (!decision.allowed) {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        res.status(403).json({ error: "authorization_denied", ... })</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        return</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      }</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      res.locals.buyerDid = verified.did</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    } catch (error) {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      if (error instanceof IdentityError) {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        res.status(error.status).json({ error: error.code, ... })</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        return</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      }</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      next(error)</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      return</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    }</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    // Outside the try: a throw from downstream middleware must not be</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    // caught here, or this handler would call next twice.</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    next()</span></div>
</div></div>
<p><button class="seecode" onclick="jumpTo('src/seller/server.ts', 115)">See the full diff →</button></p>
<h3><span class="ic">◆</span>What a reviewer should check</h3>
<ul>
<li>Mount order in <code>createSeller</code>: gate at line 150, payment middleware at line 198, handler at line 215. Express runs them in that order; there is no other route to the handler.</li>
<li>The authorization stub is a single injected function (verified DID + amount cap). It is deliberately minimal and labelled as the seam where a real policy system would plug in; it does not attempt to recreate one.</li>
</ul>
<div class="callout risk"><div class="lb">Risk &amp; blast radius</div>If a future route is added under a different path without the gate, it would bypass identity entirely. The gate is mounted on <code>PROTECTED_PATH</code> specifically; adding a second paid route requires mounting the gate for it too. A helper that wires gate + payment together would remove this footgun.</div>
"""})

pages.append({"n": 3, "title": "ACK-ID proof: creation, resolution, verification", "kicker": "IDENTITY LEG", "tag": "sec", "html": """
<span class="kicker">IDENTITY LEG</span><h2>ACK-ID proof: creation, resolution, verification</h2>
<p><span class="tag sec">SECURITY</span></p>
<div class="tldr"><b>In short.</b> The proof is a plain did-jwt JWT (ES256K) with <code>iss</code> = buyer did:web, <code>aud</code> = seller DID, a UUID nonce and a 5 minute expiry. The seller resolves the issuer's did:web document over HTTP and verifies the signature against the published keys, using the public agentcommercekit libraries. Every failure maps to a stable, tested rejection code.</div>
<h3><span class="ic">◆</span>Verification path</h3>
<pre class="mermaid">flowchart LR
  J[JWT from<br/>Authorization header] --> V[verifyJwt<br/>did-jwt + resolver]
  V --> D[(did:web document<br/>/.well-known/did.json)]
  V -->|payload| N[nonce + iss checks]
  V -->|throw| C[classifyVerificationError]
  C --> E[IdentityError<br/>with stable code]
  click V call jumpTo("src/identity.ts", 244)
  click C call jumpTo("src/identity.ts", 315)
  classDef new fill:#EEF3FF,stroke:#2563FF,color:#1E56F0;
  class V,N,C,E new
</pre>
<h3><span class="ic">◆</span>The rejection taxonomy</h3>
<ul>
<li><code>identity_missing</code> · no bearer token · 401</li>
<li><code>identity_invalid</code> · malformed JWT, unresolvable DID, missing nonce · 401</li>
<li><code>identity_expired</code> · <code>exp</code> in the past (did-jwt enforces it) · 401</li>
<li><code>identity_mismatched</code> · signature does not match any key in the claimed DID's document, or wrong audience · 403. This is the impersonation case: an agent claiming a DID it does not control.</li>
<li><code>identity_replayed</code> · nonce already consumed · 403</li>
</ul>
<div class="callout"><div class="lb">Found in adversarial self-review</div>did-jwt only enforces its <code>audience</code> option when the payload actually carries an <code>aud</code> claim, so a validly signed proof that simply omits <code>aud</code> would verify for any seller and be replayable across sellers. The seller now asserts an exact <code>payload.aud === audience</code> match itself, and a dedicated test covers the omitted-aud case.</div>
<div class="diffblock"><div class="fn"><span class="g"></span>src/identity.ts</div><div class="body">
<div class="dl add"><span class="s">+</span><span class="c">  // did-jwt only enforces its audience option when the payload carries an</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  // aud claim, so a proof that omits aud would otherwise verify for any</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  // seller. Require an exact match ourselves.</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  if (payload.aud !== audience) {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    throw new IdentityError(</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      "identity_mismatched",</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      "Identity proof was issued for a different audience"</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    )</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  }</span></div>
</div></div>
<p><button class="seecode" onclick="jumpTo('src/identity.ts', 264)">See the full diff →</button></p>
<div class="diffblock"><div class="fn"><span class="g"></span>src/identity.ts</div><div class="body">
<div class="dl add"><span class="s">+</span><span class="c">    // 401: authentication failed (absent, malformed, expired credentials).</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    // 403: proof is well-formed but must not be accepted (wrong key, replay).</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    this.status =</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      code === "identity_mismatched" || code === "identity_replayed" ? 403 : 401</span></div>
</div></div>
<p><button class="seecode" onclick="jumpTo('src/identity.ts', 117)">See the full diff →</button></p>
<h3><span class="ic">◆</span>Choices a reviewer may question</h3>
<ul>
<li>The VC/ControllerCredential layer of ACK-ID (agent-to-owner ownership chains) is deliberately skipped: it adds an A2A dependency without changing the identity-before-payment story. The plain JWT path uses the same ACK resolver and signature machinery.</li>
<li>Error classification matches on did-jwt message substrings (line 315). Brittle if did-jwt rewords errors; acceptable for a demo, and the fallback is the safe <code>identity_invalid</code>.</li>
<li>did:web documents are served over localhost HTTP, which the ACK resolver explicitly allows for local hosts only; real deployments use HTTPS.</li>
</ul>
"""})

pages.append({"n": 4, "title": "Nonce semantics under x402's double-send", "kicker": "SUBTLE BUG, SOLVED", "tag": "sec", "html": """
<span class="kicker">SUBTLE BUG, SOLVED</span><h2>Nonce semantics under x402's double-send</h2>
<p><span class="tag sec">SECURITY</span></p>
<div class="tldr"><b>In short.</b> x402 sends the same proof twice: an unpaid request that earns the 402 challenge, then a paid retry. There is exactly one safe moment to consume the proof's single-use nonce - at settlement, after the facilitator has verified the payment and it is bound to the paying wallet. Consume any earlier and a request that never settles (an unpaid probe, a junk payment, a payment from the wrong wallet) burns a legitimate proof.</div>
<div class="ba">
  <div class="col before"><div class="lb">Consume on payment-header presence (was)</div><pre class="mermaid">flowchart TB
  H[Proof + any payment header] --> K[consume nonce]
  K --> V[facilitator verify]
  V -->|junk payment fails to decode| X[402, but nonce already burned]
  classDef gone fill:#FBEBE7,stroke:#A5341E,color:#A5341E;
  class K,X gone
</pre></div>
  <div class="col after"><div class="lb">Consume at settlement (shipped)</div><pre class="mermaid">flowchart TB
  U[Unpaid probe<br/>verify only] --> C[402 challenge]
  P[Paid + verified] --> B{bound to payer?}
  B -->|no| A1[abort<br/>nonce untouched]
  B -->|yes| N[consume nonce]
  N -->|fresh| S[settle + 200]
  N -->|already used| A2[abort 403<br/>identity_replayed]
  click N call jumpTo("src/seller/server.ts", 184)
  click A2 call jumpTo("src/identity.ts", 218)
  classDef new fill:#EEF3FF,stroke:#2563FF,color:#1E56F0;
  class B,N new
</pre></div>
</div>
<h3><span class="ic">◆</span>Bind first, then consume, both before settle</h3>
<div class="diffblock"><div class="fn"><span class="g"></span>src/seller/server.ts (onAfterVerify)</div><div class="body">
<div class="dl add"><span class="s">+</span><span class="c">      // a. bind identity to payer FIRST, so a proof paired with someone</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      //    else's payment aborts without burning the real holder's nonce.</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      if (token === undefined || bound === undefined ||</span></div>
<div class="dl add"><span class="s">+</span><span class="c">          payer === undefined || bound !== payer) {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        return { abort: true, reason: "identity_payer_mismatch", ... }</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      }</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      // b. only now - a bound, verified payment about to settle - consume.</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      consumeProofNonce(token, nonceCache) // throws identity_replayed on reuse</span></div>
</div></div>
<p><button class="seecode" onclick="jumpTo('src/seller/server.ts', 184)">See the payment hook →</button></p>
<h3><span class="ic">◆</span>What this buys and what it costs</h3>
<ul>
<li>A stolen proof can still fish for 402 challenges and can still be paired with a junk payment: both are harmless, because neither settles and neither consumes the nonce. Only a real, bound, verified payment consumes it - the replay that actually matters on a money path.</li>
<li>Consuming immediately before settle is the at-most-once point: it serializes on the nonce, so two concurrent verified payments cannot both settle. The residual gap (consume succeeds, then settle fails or its response is lost) is the reconciliation limit in docs/architecture.md; a production idempotency key closes it.</li>
<li>The replay cache is in-memory with TTL pruning (<code>NonceCache</code>, src/identity.ts line 153), single-instance scope. Multi-instance sellers need a shared store; the class is the seam.</li>
</ul>
<p><button class="seecode" onclick="jumpTo('test/ordering.test.ts', 191)">See the replay test →</button></p>
<p><button class="seecode" onclick="jumpTo('test/ordering.test.ts', 233)">See the grief-protection test →</button></p>
<div class="callout"><div class="lb">Found in an independent codex review</div>An earlier version consumed the nonce on payment-header presence, in the identity gate, before the payment was verified. A captured but unspent proof could then be griefed: send it with a junk payment header, the nonce burns, and the legitimate holder's real payment is rejected as a replay. No money moved, but a valid proof was denied. Moving consumption to settlement (after verify, after binding) closes it, and a dedicated test drives a junk payment then a real one and asserts the real one still settles.</div>
<div class="callout"><div class="lb">Also hardened: bounded lifetime</div>The replay guarantee leans on a bounded <code>exp</code>. A proof must carry one (did-jwt skips its expiry check when <code>exp</code> is absent, so a non-expiring proof would verify forever and never be pruned), an <code>exp</code> past a fixed cap is rejected, and the nonce is reserved until <code>exp</code> plus did-jwt's ~300s skew - a shorter TTL would prune the entry while the proof still verifies. See <code>JWT_SKEW_SECONDS</code> / <code>MAX_PROOF_LIFETIME_SECONDS</code>.</div>
<div class="diffblock"><div class="fn"><span class="g"></span>src/identity.ts</div><div class="body">
<div class="dl add"><span class="s">+</span><span class="c">  const exp = payload.exp</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  if (typeof exp !== "number") {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    throw new IdentityError(</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      "identity_invalid",</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      "Identity proof must carry an expiry (exp)"</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    )</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  }</span></div>
</div></div>
<p><button class="seecode" onclick="jumpTo('src/identity.ts', 293)">See the full diff →</button></p>
"""})

pages.append({"n": 5, "title": "The settlement adapter, and proof by injection", "kicker": "PAYMENT LEG", "tag": "arch", "html": """
<span class="kicker">PAYMENT LEG</span><h2>The settlement adapter, and proof by injection</h2>
<p><span class="tag arch">ARCHITECTURE</span></p>
<div class="tldr"><b>In short.</b> The seller talks to payment infrastructure only through the injected <code>FacilitatorClient</code> interface (verify / settle / getSupported). Tests inject a recording fake and assert zero calls on every rejected path; the demo wraps the real facilitator in a counting decorator and prints the counts live. The claim "rejected identities never reach settlement" is machine-checked.</div>
<h3><span class="ic">◆</span>One interface, three implementations</h3>
<pre class="mermaid">flowchart LR
  S[x402ResourceServer] --> I{{FacilitatorClient<br/>interface}}
  I --> R[HTTPFacilitatorClient<br/>x402.org, real runs]
  I --> C[CountingFacilitatorClient<br/>decorator, demo output]
  I --> F[FakeFacilitatorClient<br/>tests, records calls]
  click C call jumpTo("src/counting-facilitator.ts", 10)
  click F call jumpTo("test/helpers.ts", 33)
  classDef new fill:#EEF3FF,stroke:#2563FF,color:#1E56F0;
  class C,F new
</pre>
<h3><span class="ic">◆</span>The assertion that carries the whole demo</h3>
<div class="diffblock"><div class="fn"><span class="g"></span>test/ordering.test.ts</div><div class="body">
<div class="dl add"><span class="s">+</span><span class="c">      const { result, seller } = await runScenario(scenario)</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      expect(result.status).toBe(status)</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      expect(result.body).toMatchObject({ error: code })</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      expect(result.settlement).toBeUndefined()</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      expect(seller.facilitator.verifyCalls).toHaveLength(0)</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      expect(seller.facilitator.settleCalls).toHaveLength(0)</span></div>
</div></div>
<p><button class="seecode" onclick="jumpTo('test/ordering.test.ts', 93)">See the full diff →</button></p>
<h3><span class="ic">◆</span>Payment mechanics (x402 v2)</h3>
<ul>
<li>Protocol v2 packages pinned at 2.19.0 (the current line; the old unscoped v1 packages are deprecated). Network <code>eip155:84532</code>, USDC <code>0x036C...CF7e</code> (Circle's canonical testnet deployment).</li>
<li>The buyer signs an EIP-3009 <code>transferWithAuthorization</code> (EIP-712, gasless); the facilitator submits it on-chain, so the buyer wallet needs USDC only, no ETH.</li>
<li>Catena integration: the seller's <code>payTo</code> is the Catena sandbox account's deposit address, so settlement terminates inside a Catena-governed account and shows up in its ledger with the matching txHash. The facilitator URL stays env-injected for a future Catena facilitator.</li>
</ul>
<p><button class="seecode" onclick="jumpTo('src/config.ts', 10)">See the config boundary →</button></p>
"""})

pages.append({"n": 6, "title": "Buyer scenarios and the demo runner", "kicker": "SCRIPTED BUYER", "tag": "ok", "html": """
<span class="kicker">SCRIPTED BUYER</span><h2>Buyer scenarios and the demo runner</h2>
<p><span class="tag ok">BEHAVIOUR</span></p>
<div class="tldr"><b>In short.</b> One buyer entrypoint runs four scripted scenarios. Each mints a fresh did:web identity, hosts its DID document on an ephemeral HTTP server, and differs only in how the proof is signed. The demo runner starts the seller in-process, runs the buyer, prints the outcome plus settlement-adapter counts, and exits non-zero when a scenario misbehaves.</div>
<h3><span class="ic">◆</span>How each scenario constructs its proof</h3>
<ul>
<li><b>valid</b> · proof signed by the keypair the hosted DID document publishes.</li>
<li><b>missing-identity</b> · no Authorization header at all.</li>
<li><b>mismatched-identity</b> · proof signed by a rogue keypair while claiming the hosted DID (buyer.ts line 99): impersonation, rejected 403.</li>
<li><b>expired-identity</b> · <code>expiresInSeconds: -600</code> (line 117), rejected 401.</li>
</ul>
<div class="diffblock"><div class="fn"><span class="g"></span>src/buyer/buyer.ts</div><div class="body">
<div class="dl add"><span class="s">+</span><span class="c">      case "mismatched-identity": {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        // Signed with a key the claimed DID does not publish: an attacker</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        // asserting an identity they do not control.</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        const rogueKeypair = await generateKeypair("secp256k1")</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        proof = await createIdentityProof({</span></div>
<div class="dl add"><span class="s">+</span><span class="c">          issuerDid: identity.did,</span></div>
<div class="dl add"><span class="s">+</span><span class="c">          keypair: rogueKeypair,</span></div>
<div class="dl add"><span class="s">+</span><span class="c">          audience: sellerDid,</span></div>
<div class="dl add"><span class="s">+</span><span class="c">          paymentAddress</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        })</span></div>
<div class="dl add"><span class="s">+</span><span class="c">        break</span></div>
<div class="dl add"><span class="s">+</span><span class="c">      }</span></div>
</div></div>
<p><button class="seecode" onclick="jumpTo('src/buyer/buyer.ts', 99)">See the full diff →</button></p>
<h3><span class="ic">◆</span>A bug the live run caught</h3>
<p>The first "successful" sandbox run was actually served by a stale seller process holding port 4021 with old config: the new demo's <code>listen</code> failed silently and the stale server answered with a different payTo. Two symptoms exposed it: the settlement went to the wrong address, and the fresh process printed <code>verify=0 settle=0</code> despite a successful payment. The runner now attaches an error listener and fails loudly on a taken port.</p>
<div class="diffblock"><div class="fn"><span class="g"></span>scripts/demo.ts</div><div class="body">
<div class="dl add"><span class="s">+</span><span class="c">  // Fail loudly if the port is taken: a stale seller with old config would</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  // otherwise serve the demo silently.</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  s.once("error", reject)</span></div>
</div></div>
<p><button class="seecode" onclick="jumpTo('scripts/demo.ts', 61)">See the full diff →</button></p>
<div class="callout"><div class="lb">PASS criteria are explicit</div>valid requires 200, a successful settlement, <b>and</b> an on-chain re-confirmation of the exact USDC amount at the payTo address; every rejection scenario requires 401-403 plus zero facilitator calls (scripts/demo.ts line 127). The demo cannot claim success on a half-working flow.</div>
"""})

pages.append({"n": 7, "title": "Money discipline, configuration and CI", "kicker": "GUARDRAILS", "tag": "ci", "html": """
<span class="kicker">GUARDRAILS</span><h2>Money discipline, configuration and CI</h2>
<p><span class="tag ci">HYGIENE</span></p>
<div class="tldr"><b>In short.</b> Money never touches floats: prices are "$x.yz" strings parsed to bigint micro-dollars for the cap comparison. Env is zod-validated at the boundary, secrets stay out of git, and CI runs lint, typecheck and the full test suite on Node 22.</div>
<h3><span class="ic">◆</span>Exact money, no floats</h3>
<div class="diffblock"><div class="fn"><span class="g"></span>src/config.ts</div><div class="body">
<div class="dl add"><span class="s">+</span><span class="c">export function moneyToMicros(money: string): bigint {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  const match = /^\\$(\\d+)(?:\\.(\\d+))?$/.exec(money)</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  if (!match?.[1]) {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    throw new Error(`Invalid money string: ${money}`)</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  }</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  const whole = match[1]</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  const rawFraction = match[2] ?? ""</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  if (rawFraction.length &gt; 6) {</span></div>
<div class="dl add"><span class="s">+</span><span class="c">    throw new Error(`Too many decimal places for micro-dollars: ${money}`)</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  }</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  const fraction = rawFraction.padEnd(6, "0")</span></div>
<div class="dl add"><span class="s">+</span><span class="c">  return BigInt(whole) * 1_000_000n + BigInt(fraction)</span></div>
<div class="dl add"><span class="s">+</span><span class="c">}</span></div>
</div></div>
<p><button class="seecode" onclick="jumpTo('src/config.ts', 82)">See the full diff →</button></p>
<h3><span class="ic">◆</span>Boundaries and hygiene</h3>
<ul>
<li>Env parsing is a single zod schema; the demo refuses malformed addresses and keys at startup rather than failing mid-payment. Empty optional values (a fresh <code>cp .env.example .env</code>) are normalized to absent, so the keyless rejection demos start cleanly.</li>
<li><code>.env</code> is gitignored; <code>.env.example</code> documents every variable without secrets. A repo-wide scan confirms no key material is committed (the only 64-hex constant is the documented throwaway placeholder for rejection scenarios, which never signs anything).</li>
<li>Strict TypeScript (<code>exactOptionalPropertyTypes</code>, <code>noUncheckedIndexedAccess</code>), typescript-eslint <code>strictTypeChecked</code> + <code>stylisticTypeChecked</code>, Prettier, 36 tests. CI: format check, lint, typecheck, test on Node 22.</li>
</ul>
<h3><span class="ic">◆</span>Known limits, stated on purpose</h3>
<ul>
<li>Nonce cache is in-memory: single seller instance scope, seam documented for a shared store.</li>
<li>Authorization is a stub by contract: verified DID plus an amount cap, nothing else. It must not grow into a policy engine.</li>
<li>The buyer pays with its own testnet wallet. Paying out of a Catena account is blocked today because the Catena CLI's x402 command cannot attach an identity header; the gap is reported to the Catena team as product feedback.</li>
</ul>
<div class="callout risk"><div class="lb">Risk &amp; blast radius</div>The demo depends on the public x402.org facilitator staying live for base-sepolia. If it goes away, the facilitator URL is env-injected and any compatible facilitator (including a future Catena one) slots in without code changes.</div>
"""})

with open(".pr-review/pages.json", "w") as f:
    json.dump(pages, f, indent=1)
print("wrote", len(pages), "pages")
