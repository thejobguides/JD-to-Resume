# Setup checklist: services, accounts and keys

Everything outside the code that Job Match Optimizer needs to be fully working: where to get it, the steps, and what to bring back.

It's split into two stages:

- **Stage 1 — Test with real services (on your computer).** Real AI, real emails and Stripe's test mode for payments. No real money moves except small AI credits. About 1–2 hours of your time. After this, I can run and test everything end to end.
- **Stage 2 — Go live.** Domain, hosting, live payments, Chrome Web Store, legal. Some steps include reviews that take days, so you can start them early, in parallel with Stage 1.

Prices and screen names below were correct as far as I know; providers change them, so check the provider's current pricing page before paying.

---

## How to hand things over (read this first)

- **Secret values go in a file, not in chat.**
  - Secret values are API keys, tokens and webhook secrets.
  - Copy `.env.example` (project root) to a new file named `.env`, and paste each value next to its name.
  - `.env` stays on your computer and is excluded from git. When you're done, just tell me "Stage 1 is filled in". I'll use the values without printing them.
- **Non-secret values are fine in chat.** These are product and price IDs, your domain, email addresses, and your answers to the decisions in §8.
- **Use test mode and spending limits everywhere.** Stripe test mode for payments, and a monthly cap on every AI account.
- **If a key is ever exposed** (pasted in chat, a screenshot, a commit), delete it at the provider and create a new one.

---

## At a glance

| # | Service | What it's for | Needed? | Stage | Cost to start |
|---|---|---|---|---|---|
| 1 | OpenAI | Main AI: reads job posts, rewrites resumes, checks every change | **Required** | 1 | ~$10 credits |
| 2 | Anthropic (Claude) | Backup AI if OpenAI fails | Recommended | 1 | ~$5 credits |
| 3 | Google Gemini (paid tier) | Second backup AI | Optional | 1 | Pay as you go |
| 4 | NVIDIA API Catalog | Free model trials, **tests only**, never real users | Optional | 1 | Free |
| 5 | Stripe (test mode) | Payments, subscriptions, coupons | **Required** | 1 | Free |
| 6 | Resend | Sign-in code emails | **Required** | 1 | Free tier |
| 6b | Google Cloud (OAuth) | The "Continue with Google" button | Recommended | 1 | Free |
| 7 | Your tools | Chrome, Docker (already set up) and the Stripe CLI | — | 1 | Free |
| 8 | Your decisions | Name, prices, emails, refund policy | **Required** | 1 | — |
| 9 | Domain name | Website, emails, payment approval | **Required** | 2 | ~$10–15 / year |
| 10 | Cloudflare | DNS, website hosting, admin protection, email forwarding | **Required** | 2 | Free |
| 11 | Neon | Production database (Postgres) | **Required** | 2 | Free tier to start |
| 12 | App hosting (Render, Fly.io or Railway) | Runs the API and admin API | **Required** | 2 | ~$10–25 / month |
| 13 | Resend domain | Send email from your own domain | **Required** | 2 | Free |
| 14 | Stripe (live) | Real payments and payouts to your bank | **Required** | 2 | 2.9% + $0.30 per card payment, +0.7% on subscriptions (US) |
| 15 | Chrome Web Store | Publishing the extension | **Required** | 2 | $5 one-time |
| 16 | Legal and tax | Privacy notice, terms, refund policy, sales tax | **Required** | 2 | Lawyer / accountant fees |

Error tracking (Sentry) and uptime alerts (Better Stack) are mentioned in the research docs but **aren't wired into the code yet**. Skip them for now, and tell me if you want them.

---

# Stage 1 — Test with real services

## 1. OpenAI — required

Used for every AI step. The code is set up for **GPT-6 Luna** (fast, cheap: reading jobs and checking edits) and **GPT-6 Sol** (stronger: rewriting).

- [ ] Sign up or log in at **platform.openai.com**.
- [ ] Open **Settings → Billing**, add a payment method, and buy **$10** of credits.
- [ ] Open **Settings → Limits** and set a **monthly budget** (for example $20) so a bug can't run up costs.
- [ ] Create a **Project** (for example "Job Match Optimizer"), then open **API keys → Create new secret key** inside that project. Copy it now; it's shown only once.
- [ ] Check model access: on the **Limits** (or Models) page, confirm **gpt-6-luna** and **gpt-6-sol** are listed. Some newer models need **Organization verification** (an ID check under Settings → General). If either is missing, tell me which GPT models you do see, and I'll adjust.
- [ ] Leave **Data controls** at the default: API data is not used for training. (Zero Data Retention needs approval; it's not needed now.)

**Bring back:** `OPENAI_API_KEY` → `.env`.

## 2. Anthropic (Claude) — recommended

The backup for the rewriting step, so a provider outage doesn't break the product.

- [ ] Sign up at **console.anthropic.com**.
- [ ] Open **Billing** and add **$5** of credits. Also set a monthly spend limit.
- [ ] Open **API keys → Create key**.
- [ ] Confirm **Claude Sonnet 5.5** is available to your account.

**Bring back:** `ANTHROPIC_API_KEY` → `.env`.

## 3. Google Gemini (paid tier) — optional

A cheap second backup for the reading steps.

- [ ] Go to **aistudio.google.com → Get API key**. This creates a Google Cloud project.
- [ ] **Turn on billing for that project** (the paid tier). Don't use a free-tier key with real users: its terms allow Google to use inputs and forbid personal data such as resumes.

**Bring back:** `GOOGLE_API_KEY` → `.env`.

## 4. NVIDIA API Catalog — optional, tests only

Lets us try free models before paying for them. **Its trial terms forbid production use and personal data**, so the code only allows it in "eval" (test) routing with made-up data. The admin panel blocks it from real users automatically.

- [ ] Sign in at **build.nvidia.com** (an NVIDIA developer account).
- [ ] Open any model page → **Get API key** (it starts with `nvapi-`).

**Bring back:** `NVIDIA_API_KEY` → `.env`.

**Testing the app on NVIDIA models (free).** Keep `AI_ROUTING=eval` in `.env`, then run `pnpm nvidia:setup`. It:
- tests a few NVIDIA models with made-up data and keeps the ones that work;
- points the app's test ("eval") routing at them;
- runs a full test.

Restart the API afterwards. The extension then shows a "Test mode" banner. **Use only a made-up resume in this mode** (`samples/sample-resume.pdf`), never your real one: NVIDIA's trial terms forbid personal data.

**OpenRouter instead (also free).** Put a key from openrouter.ai/keys in `.env` as `OPENROUTER_API_KEY` and run `pnpm openrouter:setup`. Same rules: eval routing only, made-up resumes only. Free keys get about 50 requests a day, and popular free models (Gemma) are often rate-limited upstream; on 2026-10-09 `nvidia/nemotron-3-super-120b-a12b:free` passed the smoke eval.

## 5. Stripe (test mode) — required

Stripe takes the payments: Checkout for paying, the customer portal for cancelling or changing the card, and invoices. Test mode is a full copy with fake cards and no real money. Unlike Paddle, Stripe is **not a merchant of record**: it doesn't collect or remit sales tax for you (see §16).

**5a. Account and key**
- [ ] Sign up at **dashboard.stripe.com**. No business verification is needed for test mode.
- [ ] Make sure the **Test mode** toggle is on, then open **Developers → API keys** and copy the **Secret key** (starts with `sk_test_`).

**5b. Prices.** Nothing to create by hand. After the key is in `.env`, run `pnpm stripe:setup`: it creates one product and one price per plan in your Stripe account, at the current prices (Pro $19/month, Pro $45/quarter, Credit pack $12, Bring-your-own-key $39/year), and makes them the plans' active prices. Later price changes go through **Admin → Plans & pricing**.

**5c. Customer portal**
- [ ] Check **dashboard.stripe.com/test/settings/billing/portal**: **cancel subscriptions** at the end of the billing period and **update payment methods** on, **switch plans** off. Stripe creates this default configuration the first time the app opens the portal (seen 2026-10-09), so usually you only need to check it.

**5d. Webhook.** Stripe tells our server about payments through a webhook. Locally, the Stripe CLI forwards them to your computer, so no tunnel is needed:
- [ ] `brew install stripe/stripe-cli/stripe`, then `stripe login`.
- [ ] `stripe listen --forward-to localhost:8787/v1/webhooks/stripe`, and leave it running while you test.
- [ ] It prints a webhook signing secret (starts with `whsec_`); that's `STRIPE_WEBHOOK_SECRET`.

The events we use are `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `charge.refunded`.

**Test card:** 4242 4242 4242 4242, any future date and any CVC. `4000 0025 0000 3155` tests 3-D Secure.

**Bring back** (in `.env`):
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`, after step 5d

The website needs no Stripe key: Checkout and the portal are Stripe-hosted pages.

## 6. Resend — required

Sends the 6-digit sign-in codes.

- [ ] Sign up at **resend.com**. The free tier is about 3,000 emails a month.
- [ ] Open **API Keys → Create API key**, with "Sending access".
- [ ] For Stage 1 you **don't need a domain**: Resend lets new accounts send from `onboarding@resend.dev`, but only **to the email you signed up with**. So in Stage 1, use that same email to sign in to the extension and the admin panel. (Your own domain comes in §13.)

**Bring back:**
- `RESEND_API_KEY` → `.env`
- `ADMIN_OWNER_EMAIL` → `.env`: your Resend sign-up email, so you become the first admin.

## 6b. Google sign-in — recommended

Lets users click **Continue with Google** instead of typing an email and a code. It works in the extension and on the website's account page. We only receive the user's name and email address, never their Google password or any other Google data.

- [ ] Go to **console.cloud.google.com** and create a project (for example "Job Match Optimizer"). The same project as Gemini (§3) is fine.
- [ ] Open **APIs & Services → OAuth consent screen** (newer consoles call it **Google Auth Platform**) → **Get started**:
  - App name "Job Match Optimizer", your support email, audience **External**, your contact email.
  - Under **Data access** (scopes), add only `openid`, `email` and `profile`. These are basic scopes, so Google doesn't need to review the app.
  - Under **Audience**, the app starts in **Testing**: only the test users you list can sign in (up to 100). Add your own Gmail address as a test user.
- [ ] Open **Clients** (or **Credentials**) → **Create client** → **Web application**:
  - **Authorized JavaScript origins:** `http://localhost:5175` (the website on your computer).
  - **Authorized redirect URIs:** `https://hbbojlpbahndpodjekcjheebjlhjiobd.chromiumapp.org/`
    - This is the address of the development extension; it's fixed, so it won't change.
    - Copy it exactly, including the final `/`.
- [ ] Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). You can ignore the client secret; our setup doesn't use it, so don't share it.

**Bring back:** `GOOGLE_OAUTH_CLIENT_ID` → `.env`. It isn't secret, but keeping it in `.env` keeps everything in one place.

**Phone-number sign-in isn't included.** Text messages cost money per code (roughly $0.01–0.10 each, more in some countries). They're also a common target for fraud, where bots trigger thousands of costly texts. Google sign-in plus email covers nearly everyone. If you still want it, it needs a Twilio account; ask me and I'll add it.

## 7. Tools on your computer

- [ ] **Google Chrome** (you have it) to load the extension.
- [ ] **Docker Desktop** running (already set up) for the local database.
- [ ] The **Stripe CLI** to forward webhooks to your computer (§5d): `brew install stripe/stripe-cli/stripe`.

## 8. Decisions only you can make

Send these in chat. Each has a default I'll use if you don't decide yet.

- [ ] **Product name.** The working name is "Job Match Optimizer". Check that it's free to use (a quick web and trademark search) before buying a domain.
- [ ] **Prices.** Currently: Free (3 tailoring runs a month), Pro $19/month, Pro $45/quarter, Credit pack $12 for 25 runs, Bring-your-own-key $39/year, all USD. Keep or change?
- [ ] **Refund policy.** Card networks and Stripe expect one on your website, and **the site doesn't have a refund page yet**; I'll add it once you decide. For example: "14-day refund on first purchase, no partial refunds after".
- [ ] **Support email** and **privacy contact.** Quebec's Law 25 expects a named person responsible for personal information, with a published contact.
- [ ] **Admins.** Who besides you gets admin access, and which role (Admin, Support, Finance or Analyst)?

---

# Stage 2 — Go live

Start §14 (Stripe live) and §15 (Chrome Web Store) early: both involve reviews that can take several days.

## 9. Domain name

**Why you need one, even though users only install the extension:** the extension can't send sign-in emails or take payments by itself.

- Resend only emails strangers from a verified domain, so without one, users never receive their sign-in code.
- Stripe's account review looks for a website on your own domain showing what you sell, pricing, terms, privacy and refunds.
- The Chrome Web Store needs a privacy policy link.

One domain covers everything through sub-addresses. Not needed for Stage 1.

- [ ] Register a domain, ideally at **Cloudflare Registrar** (at-cost pricing, and the DNS ends up in the same place). Any registrar works.
- [ ] We'll use these addresses:
  - `yourdomain.com` — website
  - `api.yourdomain.com` — API
  - `admin.yourdomain.com` — admin panel
  - `admin-api.yourdomain.com` — admin API

**Bring back:** the domain name (chat).

## 10. Cloudflare — free plan

- [ ] Create an account at **dash.cloudflare.com** and add your domain (DNS).
- [ ] **Email Routing** (free): forward `support@`, `privacy@` and `no-reply@yourdomain.com` to your personal inbox.
- [ ] **Pages:** this hosts the website and the admin panel. I'll deploy them; you only need the account.
- [ ] **Zero Trust → Access** (free for up to 50 users): this puts a login wall with your Google or email login in front of the admin panel.
  1. Create a team name; this gives your **team domain**, `yourteam.cloudflareaccess.com`.
  2. Add a "Self-hosted application" for `admin.yourdomain.com` and `admin-api.yourdomain.com`.
  3. Set a policy that allows only your admins' emails.
  4. Copy the application's **Audience (AUD) tag**.
- [ ] Create an **API token** so I can deploy: **My Profile → API Tokens**, with "Cloudflare Pages: Edit" and "DNS: Edit" for your domain.

**Bring back:**
- In `.env`: `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and the deploy token as `CLOUDFLARE_API_TOKEN`.
- In chat: your Cloudflare account ID.

## 11. Neon — production database

- [ ] Sign up at **neon.tech** and create a project with **Postgres 16**.
- [ ] Choose a **region**: near the app hosting (§12) and your users. For Canadian and US users, a US-East or Canada region is typical; the privacy notice already says data may be processed outside Canada.
- [ ] Copy the **pooled connection string**; it looks like `postgres://…neon.tech/…?sslmode=require`.

**Bring back:** the production database URL → `.env`, under a separate name: `PROD_DATABASE_URL`.

## 12. App hosting for the API and admin API

The two server programs run as Docker containers; the image recipe is already in the repo. Pick **one** host. (Recommended: **Render**, the simplest dashboard.)

- [ ] Create an account on **Render**, **Fly.io** or **Railway** and add a payment method. Expect roughly $7–15 a month per small service, so two services in total.
- [ ] Create an **API token** for deploys: on Render, **Account settings → API keys**; on Fly.io, `fly tokens create deploy`.

**Bring back:**
- In chat: which host you chose.
- In `.env`: the deploy token as `HOSTING_API_TOKEN`.

## 13. Resend: your own domain

- [ ] In Resend, open **Domains → Add domain** (`yourdomain.com`), then add the DNS records it shows (SPF, DKIM) in Cloudflare DNS. Resend has a one-click Cloudflare option. Wait for the domain to show **Verified**.
- [ ] Add a basic **DMARC** record (Resend shows an example). It helps the codes avoid spam folders.

**Bring back:** `EMAIL_FROM="Job Match Optimizer <no-reply@yourdomain.com>"` → `.env`.

## 14. Stripe: live mode

- [ ] In the Stripe dashboard, click **Activate payments** and complete the account:
  - Legal name, address and ID.
  - Business details (sole proprietors are accepted).
  - **Bank account for payouts.**
  - The website on your domain (Stripe checks that it shows what you sell, pricing, terms, privacy notice, refund policy and contact details; the website covers these once §8 and §16 are done).
- [ ] Optional but worth considering: **Stripe Tax** (0.5% per transaction) if you must collect sales tax or VAT. The code doesn't turn it on yet; tell me if you want it.
- [ ] In live mode: copy the live secret key, save the customer portal settings (as in 5c), and add a webhook endpoint `https://api.yourdomain.com/v1/webhooks/stripe` under **Developers → Webhooks** with the events from 5d. Choose API version **2025-08-27.basil** for the endpoint if Stripe asks.
- [ ] Create the live prices in **Admin → Plans & pricing** (`pnpm stripe:setup` refuses live keys on purpose).

**Bring back:**
- In `.env`, under separate names: `PROD_STRIPE_SECRET_KEY` and `PROD_STRIPE_WEBHOOK_SECRET`.

## 15. Chrome Web Store

- [ ] Register as a developer at **chrome.google.com/webstore/devconsole** with a Google account that has **2-Step Verification**. There's a one-time $5 fee.
- [ ] Verify your publisher email or domain. This shows a verified publisher on the listing.
- [ ] Prepare the listing:
  - Short and long description.
  - At least 1 screenshot (1280×800). I can generate these from the test run.
  - A small promo tile (440×280).
  - Category: Productivity.
- [ ] Fill in the **Privacy practices** tab honestly. The extension:
  - Handles a resume (personal information) and the content of job pages.
  - Stores them on the device, encrypted.
  - Sends minimized text to our API for AI features.
  - Doesn't sell data.
- [ ] Add the privacy notice URL: `https://yourdomain.com/privacy`.
- [ ] After the first upload, note the **extension ID** (32 letters). The API needs it to accept requests from the published extension.

- [ ] **Google sign-in for real users** (back in the Google Cloud project from §6b):
  - Add `https://<store-extension-id>.chromiumapp.org/` as an authorized redirect URI.
  - Add `https://yourdomain.com` as an authorized JavaScript origin.
  - In **Branding**, set the privacy and terms links and add `yourdomain.com` as an authorized domain.
  - In **Audience**, click **Publish app**. With only the basic scopes there's no Google review, though adding a logo can trigger a short brand check.

**Bring back:** the extension ID (chat). I'll set `EXTENSION_ORIGINS`.

## 16. Legal and tax — not a sign-up, but required

- [ ] Have a **lawyer review** the privacy notice and terms (drafts are on the website, marked "Draft"), plus the refund policy from §8. Canadian law applies (PIPEDA, Quebec Law 25, CASL), and the GDPR also applies for users in the EU or UK.
- [ ] Decide your **business structure** (sole proprietor or corporation), which Stripe's verification asks about.
- [ ] Ask an **accountant** about GST/HST registration and sales tax or VAT where your customers live. **Stripe doesn't collect or remit tax for you** (it isn't a merchant of record); Stripe Tax can calculate and collect it, but registering and filing stay with you.

---

## When you come back

Tell me which stage is filled in. For **Stage 1**, I'll:

1. Check that every key in `.env` works, without printing any of them.
2. Reset the local database so AI routing uses the real models, and run `pnpm stripe:setup` to create the Stripe prices.
3. Start `stripe listen` for webhooks and check the customer portal settings with you (§5c–5d).
4. Run the full flow with real services:
   - Upload a resume and read a real job posting.
   - AI analysis and tailoring with GPT-6, with the fallback to Claude tested.
   - A sign-in code arriving in your inbox, and Continue with Google in the extension and on the website.
   - A coupon applied, then a test-mode payment, a plan upgrade, cancellation and resumption.
   - Bring-your-own-key mode.
   - The admin dashboards showing real token usage and cost per step and per user.
5. Report what worked, what didn't, and the real cost of a tailoring run.

For **Stage 2**, I'll deploy:

- The database.
- The API and admin API.
- The website and admin panel, with the admin panel behind Cloudflare Access.
- A production extension build for the Chrome Web Store.

Then we'll run a live smoke test together.

## `.env` values at a glance

| Name in `.env` | From | Stage |
|---|---|---|
| `OPENAI_API_KEY` | §1 OpenAI | 1 |
| `ANTHROPIC_API_KEY` | §2 Anthropic | 1 |
| `GOOGLE_API_KEY` | §3 Gemini (optional) | 1 |
| `NVIDIA_API_KEY` | §4 NVIDIA (optional) | 1 |
| `STRIPE_SECRET_KEY` | §5a Stripe test mode | 1 |
| `STRIPE_WEBHOOK_SECRET` | §5d `stripe listen` | 1 |
| `RESEND_API_KEY`, `ADMIN_OWNER_EMAIL` | §6 Resend | 1 |
| `GOOGLE_OAUTH_CLIENT_ID` | §6b Google sign-in | 1 |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CLOUDFLARE_API_TOKEN` | §10 Cloudflare | 2 |
| `PROD_DATABASE_URL` | §11 Neon | 2 |
| `HOSTING_API_TOKEN` | §12 Hosting | 2 |
| `EMAIL_FROM` | §13 Resend domain | 2 |
| `PROD_STRIPE_SECRET_KEY`, `PROD_STRIPE_WEBHOOK_SECRET` | §14 Stripe live | 2 |

You **don't** need to create these; I generate them: `JWT_SECRET`, `INTERNAL_TOKEN`, `MAILBOX_KEY`, `CONTENT_ENCRYPTION_KEY`, the vault keys and the config-signing keys. Keep them in your password manager too: losing `CONTENT_ENCRYPTION_KEY` makes the saved content of opted-in users unreadable.
