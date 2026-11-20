# Privacy

Mandate is self-hosted software. There is no hosted service operated by the authors and no telemetry.

**What it stores.** Mandates, payment requests, approvals, orders, escrows and the audit log are written to local JSON files under `DATA_DIR` (default `./data`) on the machine that runs it. Admin and agent tokens stay in that folder and in your environment.

**What leaves your machine, and only if you configure it**
- `api-m.sandbox.paypal.com` — PayPal **sandbox** API, when `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` are set. Payee emails, amounts and order data are sent to PayPal to perform the payment you requested. The client refuses any other host.
- `api.anthropic.com` — Anthropic Messages API, when `ANTHROPIC_API_KEY` is set. Payment purposes, invoice text, deliverables and refund reasons are sent for risk review; aggregate numbers only are sent for the finance copilot. Without a key nothing is sent and the built-in heuristic reviewer is used.

With neither configured, everything runs offline against the built-in simulator. The dashboard loads no third-party scripts, fonts or analytics (AG Grid is vendored in `public/vendor/ag-grid`; URLs inside vendored files are comments, not requests).

**Your data.** Delete the `DATA_DIR` folder to erase everything. Do not enter real personal or financial data; this project targets the PayPal sandbox only.

Questions: open an issue on the repository.
