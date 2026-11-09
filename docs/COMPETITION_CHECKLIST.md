# Competition compliance & scoring checklist

Source: Official Rules and Overview of the PayPal AI Hackathon (read 2026-11-09). ✅ = done in the repo, 🧑 = only you can do it, ⚠️ = risk or known gap.

## A. Stage 1 (pass/fail)

| Requirement | Status | Evidence |
|---|---|---|
| Meaningfully integrates PayPal (sandbox) | ✅ | Payouts, Orders v2 (AUTHORIZE→capture→void, CAPTURE checkout), Refunds, Billing Subscriptions, Webhooks verification — `src/paypal/live.js`, contract-tested with a fake `fetch` |
| Meaningfully uses AI | ✅ | Claude + heuristic reviewers for payments, deliverables, refunds, mandate drafting, finance copilot — `src/ai/` |
| Working build judges can run | ✅ | `npm start`, zero keys, zero dependencies; simulator mirrors the PayPal sandbox state machine |
| Public repo with **licence visible in About** | 🧑 | `LICENSE` (MIT) is included; push to a public GitHub repo and check the About box shows “MIT license” |
| README with setup/run instructions | ✅ | `README.md` |
| Public YouTube video **< 3:00**, shows the project working | 🧑 | Script in `docs/VIDEO_SCRIPT.md` (2:58 target) |
| No third-party trademarks / copyrighted music in the video | ✅/🧑 | No logos recreated in the app; record with no music; show PayPal's own checkout ≤ 2 s |
| English materials | ✅ | All docs and UI are English |
| Text description, tools used and how | ✅ | `docs/SUBMISSION.md` (“Tools used and how” section) |
| Not a mock-up | ✅ | Real state machine, 70 tests |
| Project created in the submission period | ✅ | New project (rules require explaining this: it is in `SUBMISSION.md`) |
| Eligibility (Egypt is not excluded) | ✅ | Rules §3; winners need tax forms (W-8BEN) |

## B. Stage 2 (five equal criteria, scored 1–5)

| Criterion | What the judges asked | Evidence in the product |
|---|---|---|
| **Technological Implementation** | “thoroughly and skillfully… genuine effort, non-trivial” | Serial execution queue (no budget races), idempotent PayPal calls, HMAC-signed mandates, hash-chained ledger with tamper detection, strictest-wins AI ensemble with fail-safe, signed-webhook handling, MCP server, strict CSP + CSRF + rate limits, 70 tests |
| **Design** | “complete, coherent product experience — not just a proof of concept” | 11 screens: Overview, Approvals, Agents & mandates, Agent console (+ what-if tester), Orders & refunds, Escrow, **Reports**, **Audit log** (search, filters, proof drawer), **Security** (kill switch + event log), Plan & usage; storefront; command palette (Ctrl/Cmd K); light/dark; responsive; keyboard focus states; reduced motion; print stylesheet for reports |
| **Potential Impact** | “credible, specific case… real audience” | Anyone letting an AI agent spend money; SaaS plans make it a business; refund/fraud handling for merchants; exportable reports for finance teams |
| **Innovation/Idea** | “creative and novel… differs from existing concepts” | AI that can only tighten decisions; attack→defence demos (poisoned invoice, look-alike payee, manipulative refund reason, manipulative deliverable); milestone escrow on authorize/partial-capture; kill switch; dry-run “what-if”; trust score and burn-rate forecast; tamper-evidence demo |
| **Presentation** | “video shows it working end to end… problem, who, why” | `docs/VIDEO_SCRIPT.md`; the UI itself is built to be filmed (stamps, hero sentence, one-click scenarios, tamper demo) |

Tie-break note: ties are broken by **Technological Implementation first** — that is the project's deepest area.

## C. Prize fit

| Prize | Fit |
|---|---|
| Best Use of Agentic Commerce ($5k) | Core of the product: agents buy, pay and hire, governed by signed mandates |
| Best Use of PayPal + AI ($5k) | Five PayPal APIs + AI decisioning on every money movement |
| Most Impactful / Most Creative / Best Demo Delivery | Attack→defence story, kill switch and tamper demo are built for the video |
| Render ($1000/750/500 credits) | `render.yaml` provided — **only tick Render if you deploy there** |
| **AG Grid** ($5k / $2k / $1k×3) | ✅ Used for real: Audit log, Transactions report and Orders are AG Grid Community grids (vendored in `public/vendor/ag-grid`, MIT). 🧑 **Tick “AG Grid” in the sponsor-tools section of the Devpost form** and mention the AG Grid features used (see `SUBMISSION.md`). Judges: Sylwia Vargas (AG Grid) |
| Bryntum / APIMatic / Channel3 / Elastic / Postman / Zapier / KERNEL / Astropods | Not used — do not tick |

A project can win **one** grand-or-honourable prize plus **one** sponsor prize — so AG Grid + a grand/honourable prize is a valid combination.

## D. Known gaps and risks (be honest in the submission)

1. ⚠️ **Live PayPal sandbox and Claude were not exercised with real credentials** in development — only the simulator and mocked contract tests. Run the live flows once yourself before recording and tell me about any error.
2. ⚠️ Sandbox Payouts may need enabling on your app (ask on the PayPal Discord). Escrow/Orders work independently.
3. ⚠️ Refunds, Subscriptions and Webhooks are verified against the simulator and fake `fetch`; PayPal Billing Plans must be created by you for live subscriptions.
4. ⚠️ Single-process JSON storage — fine for a prototype, stated in the README.
5. ⚠️ The video must not show PayPal's own marks for long (an unanswered forum thread asks about this).
6. 🧑 After the deadline, **do not edit the repo, video or linked material** until winners are announced (≈ 21 Dec) and keep any hosted demo alive.

## E. Final pre-submit run (10 minutes)

1. Fresh clone → `npm start` → sign in with the printed token → run all nine scenarios.
2. Reports → switch 7/30/90 days; export CSV; Audit → search “injection”; open a row; “Simulate tampering” → “Restore original”.
3. Security → Freeze → try a scenario (all blocked) → Resume.
4. `npm test` → all green.
5. Re-open the public repo logged out: licence, README and video link visible.
