# PayPal AI Hackathon — analysis & winning concept

Source: Overview, Rules, Resources, Updates, FAQs, Discussions and Gallery tabs of <https://paypalaihackathon.devpost.com/>, read on 2026-11-09.

## 1. Hard facts

| Item | Detail |
|---|---|
| **Deadline** | **Thu 12 Nov 2026, 12:00 pm Pacific** (= 20:00 UTC = **10:00 pm Cairo**; confirm with Devpost's countdown). Submissions lock afterwards — *no edits to repo, video or linked material until winners are announced (≈21 Dec)*. Early-check date (5 Nov) has passed. |
| Judging | Stage 1 pass/fail (working build, public repo **with licence visible in About**, public YouTube video < 3 min, meaningful PayPal **and** AI use). Stage 2: five **equally weighted** criteria, scored 1–5. Judges are *not required* to run the project → the **video carries huge weight**. Ties break on the first criterion (Technological Implementation), then the next. |
| Theme | None. "No prescribed problem statements and no tracks." Only requirement: **meaningfully use both PayPal and AI**. Inspiration categories: AI agents/automation (agent-to-agent commerce, "not just recommend, but actually transact"), money movement, business tools, consumer, social impact. |
| Required tech | PayPal developer platform via the free **sandbox** (any PayPal service counts: Payouts, Orders, Invoicing, Subscriptions, Braintree, Venmo, Hyperwallet…). Any AI model. Sponsor tools optional (AG Grid, APIMatic, Astropods, Bryntum, Channel3, Elastic, KERNEL, Postman, Render, Zapier). |
| Submit | Text description · functional demo (hosted URL **or** run instructions in repo; mock-ups don't count) · tools used & how · **public repo + open-source licence** · **YouTube video < 3 min, public, showing the project working on its device, no third-party trademarks/copyrighted music** · sponsor tools ticked on the form if chasing sponsor prizes. English only. |
| Prizes ($69,750) | 1st $12k · 2nd $8k · 3rd $5k · Most Creative $5k · Most Impactful $5k · Best Demo Delivery $5k · **Best Use of PayPal + AI $5k** · **Best Use of Agentic Commerce $5k** · sponsor prizes (AG Grid $5k/2k/1k×3, APIMatic, Bryntum, Channel3, Render credits). A project can win **one** grand-or-honourable prize **plus one** sponsor prize. |
| Eligibility | Adults; individuals, teams, orgs. Excluded: Brazil, Quebec, Russia, Crimea, Cuba, Iran, N. Korea & OFAC-comprehensively-sanctioned places; sponsor/judge affiliates. **Egypt is not on the exclusion list.** Winners need tax forms (W-8BEN for non-US). If PayPal sandbox sign-up fails in Egypt, ask on the PayPal Discord (the FAQ says sign-up availability is separate from eligibility). |
| Existing projects | Allowed only if *significantly updated during the period* — this is a brand-new project. |

## 2. Signals hidden in the discussion board and updates

1. **Judges can't use your AI key** (organiser's reply). → the project must run end-to-end **without any keys**, or via a hosted demo. Mandate runs fully offline (simulated PayPal sandbox + heuristic AI) and upgrades to live sandbox + Claude when keys are present.
2. **The hosted PayPal MCP server was erroring** (`PAYPAL_API_SETUP_ERROR … Unsupported cache mode`) for several people, and the organisers just redirect to Discord. → don't make the demo depend on it. Mandate uses the **REST API directly** and ships its *own* MCP server.
3. **Vaulting ("charge later") returns `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`** in hackathon sandbox apps; a participant found **authorize + partial capture** works. → Escrow is built on exactly that (it is also the *right* primitive for milestone escrow).
4. Many threads are sandbox-access problems (Pakistan, Libya, Iraq, Bangladesh). → The simulator makes the entry resilient to *any* account trouble.
5. The video-tips post: *"Open with the problem and who it's for, then show PayPal and AI working end to end. Cut loading screens and setup steps."* A forum thread asks whether PayPal's own names on screen violate the "no third-party trademarks" rule — **unanswered** → keep PayPal branding minimal in the video (use the word, not recreated logos; avoid showing PayPal's checkout chrome for more than a moment, or blur it) and use no music.
6. The gallery is empty (not published yet) → we can't see competitors; expect many "AI shopping agent", "invoice chatbot", "split the bill" entries. Those are the crowded middle.

## 3. What judges reward (criterion → how Mandate scores)

| Criterion (20% each) | What a 5/5 looks like | Mandate's answer |
|---|---|---|
| **Technological Implementation** — "thoroughly and skillfully", "non-trivial" | Several PayPal APIs used correctly (OAuth, idempotency, error handling), real engineering, tests | Payouts + Orders v2 authorize/partial-capture/void + refund; `PayPal-Request-Id` idempotency; serial execution to prevent budget races; HMAC-signed mandates; hash-chained ledger; Claude + heuristic ensemble with fail-safe; MCP server; 65 tests incl. live-client contract tests |
| **Design** — "complete, coherent product, not just a proof of concept" | A product, not an API demo | Dashboard with mandates, budget meters, per-decision evidence chips, approval queue, escrow milestones, ledger; plain-English mandate drafting; dark/light, responsive, keyboard accessible |
| **Potential Impact** — "credible, specific case… real audience" | Specific user + real pain | Anyone letting an AI agent spend: small businesses, researchers, dev teams. Pain = "I don't trust my agent with my card". Fraud via prompt-injected invoices is a *documented, growing* attack class |
| **Innovation/Idea** | Not another chatbot | The **control plane** for agentic commerce rather than another agent: signed mandates + "AI can only tighten" + escrow for agent-to-agent work. Demonstrates a live attack and its defeat |
| **Presentation** — end-to-end video, problem/who/why | Story with a villain | Video is built around an attack: *an agent gets a poisoned invoice → blocked → the legit one pays → escrow releases only verified work.* |

## 3b. Covering every inspiration category

The hackathon has no tracks; its "Inspiration" list is optional. To maximise reach across judges and the two agent-themed prizes, Mandate spans all of them in one coherent product: **AI agents that transact** (mandates, MCP), **money movement** (Payouts, escrow), **business tools** (storefront, refunds, finance copilot), **consumer experience** (PayPal checkout, plain-English mandates), and **SaaS** (plans + PayPal Subscriptions). Depth over breadth: every module shares the same policy/AI/ledger core.

## 4. Why this concept (and not the alternatives)

- **Targets two named honourable-mention prizes at once** — *Best Use of Agentic Commerce* and *Best Use of PayPal + AI* — while staying eligible for the grand prizes.
- **Differentiated from the crowd.** The easy entries are agents that *use* PayPal. This is what makes it *safe* for agents to use PayPal; judges from PayPal's own engineering/product side will recognise it as the missing piece of agentic payments.
- **Demo-proof.** Works with zero credentials, has a deterministic story, and has a live-sandbox mode for the video so "PayPal is central" is visibly true.
- **Tie-break strength:** Technological Implementation is the first tie-break; this is where the project is deepest.

Considered and rejected: split-the-bill receipt scanner (crowded, thin PayPal use); freelancer invoice bot (crowded); donation platform (impact-strong, but low technical depth for the AI/PayPal criteria).

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Judges see "simulated" and discount PayPal use | Record the video in **live sandbox mode** (badge shows *SANDBOX · live API*); README explains both modes; contract tests prove the live client's payloads |
| Sandbox Payouts not enabled on the user's app | Escrow path (Orders) is independent; ask on Discord for Payouts enablement; fall back to showing escrow live + payouts simulated *only if labelled* |
| "No third-party trademarks" in video | No logos recreated; name used descriptively; no music |
| Repo changes after deadline ⇒ risk | Freeze after submit; tag release `v1.0-submission` |
| 3-day runway | Everything is already built and tested; remaining work is the user's own account/key/video steps in `USER_TODO.md` |
