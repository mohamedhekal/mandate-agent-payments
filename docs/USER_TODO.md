See also `docs/COMPETITION_CHECKLIST.md` (rules and scoring map, known gaps).

# What only YOU can do (in order) — deadline Thu 12 Nov 2026, 12:00 pm PT ≈ 10:00 pm Cairo

I never created accounts, entered credentials, or submitted anything for you.

## Today (Mon 9 Nov)
1. **Check it runs**: `cd paypal-hackathon && npm test && npm start` → open http://localhost:8787, paste the admin token printed in the terminal, press all nine scenarios and open `/shop.html`.
2. **Devpost**: log in (or sign up) → open the hackathon → **Join Hackathon**. Confirm you accept the Official Rules. Start the submission as a **draft** (you can edit until the deadline).
3. **PayPal sandbox** (needed for the live-mode video):
   - Sign in at <https://developer.paypal.com/> with a PayPal account (create one free if needed; if sign-up isn't offered for Egypt, ask on the PayPal Discord linked from the hackathon page — don't wait on this, the simulator keeps you eligible).
   - Dashboard → *Apps & Credentials* → **Sandbox** → *Create app* (Merchant). Copy Client ID + Secret.
   - Dashboard → *Testing tools → Sandbox accounts*: note one **Personal** account (buyer/payout receiver). 
   - `cp .env.example .env` and put the keys + `DEMO_PAYEE_EMAIL=<sandbox personal email>` in `.env`. Leave `MANDATE_SECRET`/`ADMIN_TOKEN` empty (auto-generated) or set long random values. **Never commit `.env` or `data/`.**
   - *(Optional, SaaS billing)* create two Billing Plans in the sandbox dashboard and put their ids in `PAYPAL_PLAN_PRO` / `PAYPAL_PLAN_SCALE`; without them subscriptions work only in simulated mode.
   - *(Optional, webhooks)* add a webhook for your public URL in the dashboard and set `PAYPAL_WEBHOOK_ID`.
   - `npm start` → header must say **PayPal SANDBOX · live API**. Run the scenarios; for escrow, open the PayPal sandbox checkout with the sandbox personal account, approve, then press *I approved in PayPal → authorise*.
   - If Payouts returns a permissions error, ask on the Discord to enable Payouts for your sandbox app. Escrow (Orders) works independently.
4. *(Optional)* `ANTHROPIC_API_KEY` in `.env` to see Claude + heuristic reviewing together. Not required.

## Tue 10 Nov
5. **GitHub**: create a **public** repo, push the contents of `paypal-hackathon/` (check `git status` shows no `.env` and no `data/*.json`). In the repo's **About** section make sure the **MIT licence is detected** (the `LICENSE` file does this). Update the author name in `LICENSE` if you wish.
6. *(Optional, Render sponsor prize)* Deploy the repo on Render with `render.yaml` (simulated mode, no keys; judge token `judge-demo-2026` — mention it in the testing instructions), and tick **Render** on the Devpost form.
7. **Record the video** following `docs/VIDEO_SCRIPT.md` (live sandbox mode, < 3:00, no music, no logos, no secrets on screen). **Upload to YouTube as Public** *today* — processing can take hours.

## Wed 11 Nov
8. Fill the Devpost form from `docs/SUBMISSION.md`: description, Built With, tools used, repo URL, YouTube URL, optional hosted URL. **Tick “AG Grid” in the sponsor tools** (it is genuinely used). Add 3–5 screenshots (dashboard, blocked poisoned invoice, escrow, ledger). Tick sponsor tools only if you truly used them.
9. Test the judge path from a **clean clone** in a new folder: `npm start`, nine scenarios, `npm test`.

## Thu 12 Nov (before ~8 pm Cairo to be safe)
10. Press **Submit** (a draft is not a submission). Re-open the public page logged out and confirm repo, licence, and video are visible.
11. **Then freeze**: the organisers say not to edit the repo, video or linked materials until winners are announced (~21 Dec), and to keep any hosted demo / keys alive until then.

## Decisions I made that you may want to change
- Name **Mandate**, MIT licence, "Mandate contributors" as copyright holder.
- Hosted demo stays **simulated** (no keys on a public server); live sandbox is for your video and local runs.
- If the PayPal sandbox is unreachable from Egypt for you, the video can be recorded in simulated mode — but then say "simulated PayPal sandbox" in the voice-over and description; do not claim live API calls.
