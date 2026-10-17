# Job Match Optimizer

A Chrome extension that tailors a resume to a job posting **without inventing anything**. The resume is parsed, scored and exported on the user's device; AI rewrites only use facts that are already in the resume, and every change is checked before the user sees it. There is also an admin panel for plans, coupons, AI providers and keys, model routing, runtime config, usage and cost dashboards, and an audit log.

The design documents are in [research/](research/). This README covers running and operating the code. For the accounts and API keys needed to run it with real services (AI providers, Stripe, Resend, hosting, Chrome Web Store), follow [docs/setup-checklist.md](docs/setup-checklist.md).

## What's in the repo

| Path | What it is |
|---|---|
| [apps/extension](apps/extension) | MV3 extension: side panel (resume → job → match → tailor → export) and the settings page (account, plans and coupons, bring-your-own-key, history, privacy) |
| [apps/api](apps/api) | Public API (Hono on Node): auth, job analysis, optimizations with SSE progress, quotas, Stripe billing and webhooks, signed config |
| [apps/admin-api](apps/admin-api) | Admin API: roles, step-up, coupons, plans, AI providers and key vault, routing, config lifecycle, analytics, audit |
| [apps/admin](apps/admin) | Admin panel (React) |
| [apps/web](apps/web) | Website: home and pricing, checkout return pages, account and billing (Stripe portal), privacy and terms drafts |
| [packages/*](packages) | Shared logic: `resume` (parse and generate), `job-extraction`, `scoring`, `evidence` (truthfulness gates), `ai` (router, providers, prompts), `config`, `vault`, `db` (SQL migrations), `server` (services), `ui` (shared design tokens, the Inter font and the logo for the website, admin panel and extension) |

## Run it locally

Needs Node 20+, pnpm 10 and Docker. You don't need any API keys: without them the AI is a deterministic mock and payments use a fake Stripe gateway, so the whole flow works offline.

```bash
pnpm install
cp .env.example .env          # optional; every value has a local default
pnpm db:up                    # Postgres 16 on localhost:54329
pnpm dev:api                  # http://localhost:8787 — migrates, seeds, creates .dev/keys.json on first start
pnpm dev:admin-api            # http://localhost:8788
pnpm dev:admin                # http://localhost:5174 — sign in as owner@example.com
pnpm dev:web                  # http://localhost:5175
pnpm build:extension:dev      # → apps/extension/dist-dev
```

Load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose `apps/extension/dist-dev`. Click the toolbar icon (or press Alt+J) on a job posting to open the side panel.

- Start the API **before** building the extension. The build embeds the public key from `.dev/keys.json` so the extension can verify the signed remote config; without it, remote config is ignored.
- Sign-in codes are emailed only when `RESEND_API_KEY` is set. Locally they're shown on screen and printed in the API console.
- `pnpm dev:extension` rebuilds on change; reload the extension in `chrome://extensions` afterwards.
- `pnpm db:reset` wipes and re-seeds the local database.

## Using real AI models

- **Before the first start:** put `OPENAI_API_KEY` in `.env` and the seed routes every step to OpenAI (GPT-6 Luna for extraction and checks, GPT-6 Sol for rewriting).
- **Any time, from the admin panel:**
  1. In **AI providers & keys**, add the key. It's encrypted in your browser; only the API can decrypt it.
  2. In **Model per step**, pick a model and key for each step, then **Save draft & validate**.
  3. **Run smoke eval**, then **Activate**. Activating a routing change requires a passing eval.
- **Free testing on NVIDIA models:** put `NVIDIA_API_KEY` and `AI_ROUTING=eval` in `.env`, run `pnpm nvidia:setup`, then restart the API. The whole app then runs on NVIDIA trial models, with a "Test mode" banner in the extension. Use made-up resumes only (`samples/sample-resume.pdf`). This mode is refused in production.
- **Free testing on OpenRouter models:** the same with `OPENROUTER_API_KEY` and `pnpm openrouter:setup`. It picks free `:free` models from OpenRouter's live list, retries with the schema in the prompt when a model's structured output fails, and runs the smoke eval. Free keys get about 50 requests a day, and popular free models are often rate-limited upstream; choose models with `--cheap <id> --strong <id>`. Synthetic data only: some free endpoints log or train on prompts.
- **NVIDIA trial keys** are for evals with synthetic data only. The provider is marked "not allowed in production / no personal data", and the validator blocks it from production routing. Use it only in **Eval routing**.
- **Bring your own key:** users on the Own-key plan add an OpenAI, Anthropic or Gemini (paid tier) key in the extension settings. The same gated pipeline then runs in their browser, and the key never reaches our servers.

## Payments and coupons

- **Locally:** a fake Stripe gateway is used. Checkout opens the website's test page; **Complete test payment** sends the same signed webhooks Stripe would.
- **Stripe test mode** (details in [docs/setup-checklist.md](docs/setup-checklist.md) §5):
  1. Put your `sk_test_…` key in `.env` as `STRIPE_SECRET_KEY`, then run `pnpm stripe:setup`. It creates a Stripe product and price for each plan and makes them the active prices.
  2. Run `stripe listen --forward-to localhost:8787/v1/webhooks/stripe`, put the `whsec_…` it prints in `.env` as `STRIPE_WEBHOOK_SECRET`, and restart the API.
  3. Save the customer portal settings once in the Stripe dashboard (Settings → Billing → Customer portal).
  4. Upgrade from the extension and pay with card 4242 4242 4242 4242. Checkout and the portal are Stripe-hosted, so the website needs no Stripe key.
- **Later price changes:** **Admin → Plans & pricing** creates a new Stripe price; existing subscribers keep theirs.
- **Coupons:** in **Admin → Coupons → New coupon**, set a percentage and duration per plan (monthly, quarterly, …), a single code or a batch, limits (total, per user, single-use), dates, an optional budget and new-customers-only. Each redemption, and the coupon's cost to you, is tracked on the coupon's page. Users enter codes under **Have a code?** in the extension's Plans tab. Each per-plan rule becomes a Stripe coupon that we apply to the Checkout Session ourselves; customers never type codes on Stripe's page.

## Tests

```bash
pnpm typecheck   # every package and app
pnpm test        # unit and integration (Vitest; integration tests need `pnpm db:up`)
pnpm e2e         # Playwright: the extension, website and admin panel in Chromium against the API (mock AI, fake Stripe)
pnpm e2e:live    # opt-in: real Stripe test mode, Resend and the eval-routing AI through the running dev stack
```

**Integration tests** (Vitest, each file on its own fresh database) cover every route of both APIs:

- `apps/api/src/routes.test.ts`: platform (CORS, request ids, error envelope, version gate, maintenance), sign-in (code expiry, the 5-attempt limit, 5 codes an hour, refresh rotation and stolen-token detection, logout, paused sign-ups), settings and export, AI routes with every quota and kill switch, optimizations (isolation between users, scores, acknowledgement, concurrency, burst limits), plans, feedback and the hidden internal routes.
- `apps/api/src/billing.test.ts`: what is sent to Stripe for each checkout, coupon rules and durations, every webhook path and subscription status, the portal, refunds, and deletion when Stripe is down.
- `apps/api/src/content.test.ts`: the opt-in saved content (nothing without consent, encryption and user binding, export, delete, opt-out, expiry).
- `apps/admin-api/src/admin.routes.test.ts`: admin sign-in and step-up limits, the role matrix, users and support, admins, audit (CSV-safe export), providers, keys and models, analytics, config, coupons, prices, saved content and system routes.

**E2E** builds the extension, website and admin panel and starts the API and admin API on a separate database (`jmo_e2e`):

- **Extension:** consent, PDF/TXT resumes and refused file types, job pages with, without and with stale structured data, local score, sign in, hosted tailoring over SSE, review, PDF/DOCX export, coupons and checkout through the website; settings (signed-out states, usage, BYOK plan gate, saved-content opt-in, local data download and wipe); hidden prompt-injection text is ignored; Google sign-in.
- **Website** (production build under its Content Security Policy): pricing, legal pages, every checkout state with a test payment, and the account page (plan, test cancellation, saved-content opt-in, data download, sign-out, deletion).
- **Admin panel:** every page; support actions with audit reasons; coupon creation, pausing and the step-up code export; a new price; the vault and the trial-provider policy block; Saved content (open behind step-up, JSONL export); the audit chain and CSV export.
- **Accessibility** (`a11y.spec.ts`): axe-core WCAG 2.1 AA scan of every website page, every admin page and dialog, every extension settings tab and every side-panel step; any violation fails the run.
- **UI regressions** (`ui-regressions.spec.ts`): one test per fixed front-end bug (session refresh under parallel requests, hash links and page titles, keyboard-reachable upload, 10 MB limit, resume drafts across steps, single-line fields, daily-limit message, credit-pack checkout completion, admin sign-in errors).

**Live** (`pnpm e2e:live`, `apps/extension/e2e-live`): needs `pnpm dev:api`, `pnpm dev:admin-api`, `pnpm dev:web`, a test-mode `STRIPE_SECRET_KEY` with `pnpm stripe:setup` run once, `stripe listen --forward-to localhost:8787/v1/webhooks/stripe`, and for the AI test `AI_ROUTING=eval` after `pnpm openrouter:setup` (or `nvidia:setup`). It pays on Stripe's real Checkout with card 4242, checks webhooks, the portal, a refund and deletion, and runs analysis and tailoring on real models with saved content. Each test skips when a prerequisite is missing.

Run E2E with `E2E_SHOTS=1` to save screenshots to `.e2e/shots/`.

## Saved content (opt-in)

Users can turn on “Help improve Job Match Optimizer” in the extension (Privacy & data) or on the website's account page. Only then the API saves the job posts they analyze, the resume they send for tailoring (the extension already removes name and contact details) and the tailored result, linked by optimization. Rows are AES-GCM encrypted with `CONTENT_ENCRYPTION_KEY` (each bound to its user), kept 12 months, included in the user's data download, and deleted when the user turns the setting off, chooses “Delete saved data” or deletes the account. In the admin panel, **Saved content** shows aggregates to every role; Owner and Admin can list items, open one or export JSON Lines for analysis, each behind a fresh step-up and written to the audit log.

## Deploying

`pnpm deploy:prod` (`infrastructure/cloudflare/deploy.ts`) does the whole release; its header lists the steps.

1. `pnpm deploy:prod init` creates `.env.production` (git-ignored, never share it) with generated secrets and the keys copied from `.env`. It lists what is still missing: `WORKERS_SUBDOMAIN`, `DATABASE_URL` (or `PROD_DATABASE_URL` in `.env`, e.g. a free Neon database), `EMAIL_FROM`, `ADMIN_OWNER_EMAIL`, `OPENAI_API_KEY` and, for Render, `RENDER_API_KEY`. Keep the generated values: new ones sign everyone out and make stored data unreadable.
2. `pnpm deploy:prod db` migrates and seeds the database and creates the Stripe test prices.
3. Push to GitHub, then `pnpm deploy:prod deploy`: the two APIs (Render free web services built from the repo, or Cloudflare Containers with `API_HOST=cloudflare`), the Stripe webhook, then the website and admin panel as static Workers on Cloudflare (`wrangler login` once; wrangler needs Node 22+).
4. `pnpm deploy:prod extension` builds the extension for the deployed API with a fixed ID (`EXTENSION_KEY`) and zips it in `apps/extension/release/`.

Render's free services sleep after 15 idle minutes; the first request after that takes about a minute.

- **API and admin API:** `infrastructure/docker/Dockerfile` builds one image for both; `APP=api` or `APP=admin-api` picks the service and the server listens on `PORT` when the host sets it. In production, the API refuses to start unless `JWT_SECRET` (not the development placeholder), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `INTERNAL_TOKEN`, `MAILBOX_KEY` and `CONTENT_ENCRYPTION_KEY` (32+ characters each, separate secrets) are set, plus `CONFIG_SIGNING_PRIVATE_KEY_JWK` for the public API. It also needs the vault keys (`pnpm --filter @jmo/vault keygen`), `DATABASE_URL`, `WEB_ORIGIN`, `ADMIN_ORIGIN` and `EXTENSION_ORIGINS=chrome-extension://<id>`. Put the admin panel and admin API behind Cloudflare Access (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`): in production the admin API refuses every signed-in request without it, unless `ADMIN_ALLOW_WITHOUT_ACCESS=true` (for hosting such as Render, where Access can’t sit in front of the API; admins are then protected by emailed codes, step-up and the audit log only).
- **Extension:** `pnpm build:extension` with `EXTENSION_API_URL`, `EXTENSION_WEB_URL` and `CONFIG_PUBLIC_KEY_JWK` set (and `EXTENSION_KEY` for a fixed ID outside the Chrome Web Store), then zip `apps/extension/dist`.
- **Website and admin panel:** static builds (`pnpm --filter @jmo/web build`, `pnpm --filter @jmo/admin build`) with `VITE_API_URL` and `VITE_ADMIN_API_URL`. The builds carry a Content Security Policy meta tag for those API origins, and `public/_headers` sets anti-framing and other security headers on Cloudflare.
- **Stripe webhook:** the deploy script creates it. By hand: an endpoint at `https://<api>/v1/webhooks/stripe` (Developers → Webhooks) for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created|updated|deleted` and `charge.refunded`, with its signing secret as `STRIPE_WEBHOOK_SECRET`.

## Where the code differs from the research docs

- **Extension build:** plain Vite (multi-entry plus a generated manifest) instead of WXT. WXT 0.21 needs Node 22+, and this keeps the toolchain the same as the other apps.
- **Payments:** Stripe (hosted Checkout, customer portal, Stripe coupons applied by id) instead of Paddle. Stripe is **not a merchant of record**, so sales tax and VAT are not collected; Stripe Tax isn't wired in. Provider ids live in provider-neutral columns (`provider_price_id`, `provider_subscription_id`, …; migration `0002_stripe.sql`). Refunds of one-time purchases (credit packs) update our records; refunds of subscription payments show in Stripe but don't mark the coupon redemption as refunded yet.
- **Saved content:** the research docs say no resume or job content is stored on servers. That still holds by default; users can now opt in to saving it for product analysis (see Saved content above).
- **Hosting:** the API runs as Node services (Docker) rather than Cloudflare Workers. Exact quotas use Postgres row locks instead of a Durable Object, and optimizations run in-process with SSE instead of Workflows. Porting them is still to do.

## Not done yet

- Cloudflare Workers deployment (Workflows for optimizations, Hyperdrive for Postgres)
- Phone-number sign-in (deliberately left out: SMS cost and fraud risk), multi-device history sync, Chrome Web Store listing assets
- A golden eval set run against real providers in CI (only the synthetic smoke eval exists)
- Legal review of the privacy notice and terms (`apps/web/src/pages/Legal.tsx`; both are marked as drafts)
