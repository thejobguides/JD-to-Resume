# Architecture — AI Resume / Job Match Optimizer

**Purpose.** This is the engineering blueprint. It covers:

- the one recommended system architecture;
- the Chrome MV3 extension design;
- JD extraction;
- resume parsing and the canonical schema;
- the Evidence Store and anti-hallucination enforcement;
- the scoring engine;
- the optimization pipeline and before/after logic;
- DOCX/PDF generation;
- backend services, authentication, caching, scalability, reliability, observability, deployment and privacy-first mode;
- more than 35 failure scenarios;
- the tech stack and the monorepo layout.

Implementing agents should treat this document as the source of truth for *how* to build. [product-requirements.md](product-requirements.md) is the source of truth for *what* to build.

Last updated: 2026-09-29 · Companion docs: [api-design.md](api-design.md), [database-design.md](database-design.md), [ai-model-comparison.md](ai-model-comparison.md), [security-threat-model.md](security-threat-model.md), [cost-analysis.md](cost-analysis.md), [implementation-roadmap.md](implementation-roadmap.md)

**Labels:** **[FACT]** verified with the source URL and date (2026-09-29 unless noted) · **[ASSUMPTION]** · **[ESTIMATE]** · **[RECOMMENDATION]** · **[OPEN QUESTION]**

---

## Table of contents

1. [Summary and decision register](#1-summary-and-decision-register)
2. [Final recommended architecture](#2-final-recommended-architecture)
3. [Chrome extension architecture (MV3)](#3-chrome-extension-architecture-mv3)
4. [Job description extraction pipeline](#4-job-description-extraction-pipeline)
5. [Resume parsing and the canonical resume schema](#5-resume-parsing-and-the-canonical-resume-schema)
6. [Evidence Store and anti-hallucination enforcement](#6-evidence-store-and-anti-hallucination-enforcement)
7. [Scoring engine](#7-scoring-engine)
8. [Optimization pipeline and before/after](#8-optimization-pipeline-and-beforeafter)
9. [Resume generation and the ATS-safe template](#9-resume-generation-and-the-ats-safe-template)
10. [Backend services, AI gateway, quotas and budgets](#10-backend-services-ai-gateway-quotas-and-budgets)
11. [Authentication](#11-authentication)
12. [Caching and Redis](#12-caching-and-redis)
13. [Scalability](#13-scalability)
14. [Reliability and fallbacks](#14-reliability-and-fallbacks)
15. [Observability](#15-observability)
16. [Deployment](#16-deployment)
17. [Privacy-first mode](#17-privacy-first-mode)
18. [Failure scenarios](#18-failure-scenarios)
19. [Recommended tech stack](#19-recommended-tech-stack)
20. [Monorepo folder structure](#20-monorepo-folder-structure)

---

## 1. Summary and decision register

The core idea is to do as much as possible **locally and deterministically in the extension**. The backend is a **thin, stateless, privacy-minimal AI orchestrator**. The LLM only ever *proposes* rewrites that **code validates against evidence**.

| ID | Decision | Choice | Main reason |
|---|---|---|---|
| D-01 | Primary UI surface | **Chrome Side Panel** (no popup); options page for settings | It stays open while the user browses; the popup closes on blur ([FACT] §3.2) |
| D-02 | Install-time permissions | `activeTab`, `scripting`, `sidePanel`, `storage`, `contextMenus`, `offscreen`, `unlimitedStorage`; **no host permissions at install** | No scary install warning; lowest review risk ([FACT] §3.4) |
| D-03 | JD extraction | User-initiated `executeScript` on the active tab: JSON-LD/microdata → site adapter → generic readability heuristic → user selection or paste → LLM structuring | Works on most sites without crawling; respects platform terms |
| D-04 | Portal support tiers | Tier A (first-class): Greenhouse, Lever, Ashby, SmartRecruiters, Workday, iCIMS, JSON-LD career pages. Tier B (user-initiated generic extraction + selection/paste; **no site-specific code until counsel review**): LinkedIn, Indeed, Glassdoor, ZipRecruiter, Wellfound, Naukri | Legal risk profile (see [product-requirements.md](product-requirements.md) §6) |
| D-05 | Resume parsing | **In the extension**: pdf.js + a layout pass; mammoth + a custom OOXML pass for DOCX; TXT/paste. LLM maps lines to the schema with span citations. OCR is opt-in and post-MVP. | Privacy, zero cost, provenance |
| D-06 | Where data lives | Resumes, evidence, JDs and history in **extension IndexedDB**. Backend stores **metadata only**. Encrypted cloud sync is opt-in. | Privacy-first; minimal breach surface |
| D-07 | Scoring | Deterministic, explainable weighted engine in a shared TypeScript package that runs in the extension; the LLM only helps map ambiguous requirements | Brief §13–14; anti-gaming |
| D-08 | Anti-hallucination | Evidence IDs + strict schema + deterministic diffs + LLM entailment + one repair + revert-on-fail + user review | Truthfulness is priority #1 |
| D-09 | Generation | Standard ATS-safe templates rendered **in the extension**: DOCX via `docx`, PDF via `pdfmake`. Preserving the original DOCX template is **post-MVP**. | Reliability; no server needed |
| D-10 | Backend runtime | TypeScript + Hono on **Cloudflare Workers**; **Workflows** for optimization jobs; **Durable Object** per user for quotas, locks and progress | Waiting on an LLM isn't billed; durable steps ([FACT] §16) |
| D-11 | Database | **PostgreSQL (Neon)** via Hyperdrive | Relational + JSONB; portable ([database-design.md](database-design.md)) |
| D-12 | Redis | **None** at 100 / 1k / 10k users; re-evaluate at 100k | Load is ~1 request/s at Scenario B peak (§12) |
| D-13 | AI | Router with cheap tier (gpt-6-luna) and strong tier (gpt-6-sol vs claude-sonnet-5-5 bake-off); AI Gateway in front, using our own keys | [ai-model-comparison.md](ai-model-comparison.md) |
| D-14 | Auth | **No account** for local and BYOK modes. Account required for hosted AI: **Better Auth** (self-hosted, Postgres) with Google via `launchWebAuthFlow` + email OTP (Resend) | Friction only where needed |
| D-15 | Payments | **Paddle** (merchant of record); Stripe Managed Payments is the alternative | Canada-based seller; the merchant of record handles global sales tax/VAT/GST ([cost-analysis.md](cost-analysis.md) §11.4) |
| D-16 | Observability | Sentry + Workers Logs (PII-free) + `ai_requests` table + Langfuse (eval/synthetic only) + Better Stack | Cheap; no PII sent to third-party log vendors |
| D-17 | Deployment | Cloudflare (Workers, Pages/static assets, R2) + Neon, the same at every stage; code kept portable (Web-standard Request/Response) | No rewrite needed to scale; can move to containers if needed |
| D-18 | Admin panel *(owner request, 2026-09-29)* | Custom SPA `apps/admin` + a **separate** `admin-api` Worker behind **Cloudflare Access**; Better Auth admin roles; impersonation disabled | Every change goes through one validated, audited choke point; no vendor gets DB credentials ([admin-panel.md](admin-panel.md) §3–4) |
| D-19 | Runtime configuration | **Versioned config namespaces** (Postgres → KV + signed `/v1/config`) with an eval gate for AI, prompt and scoring changes, canary rollout and one-click rollback. A short list of **invariants is not configurable.** | "Everything configurable and traceable" without letting a typo disable truthfulness or privacy ([admin-panel.md](admin-panel.md) §2, §6) |
| D-20 | Coupons | **Own coupon engine** (per-plan %, duration, total and per-user limits, new-customer rule, budget cap) + one non-checkout **Paddle discount per plan rule**, applied server-side; complimentary grants instead of 100% codes | Paddle's native usage limit is total only, not per customer ([admin-panel.md](admin-panel.md) §7) |
| D-21 | AI providers and keys *(owner request)* | **Provider registry** (incl. OpenAI-compatible hosts such as NVIDIA) + **write-only key vault**: keys encrypted in the admin's browser, decryptable only by the API Worker. **Model + key per step** in `ai_routing`, with a **data-policy rule in code**. NVIDIA free keys: evals only. | Change models and keys without a deploy, without making keys readable or letting trial terms be broken ([admin-panel.md](admin-panel.md) §6.5) |
| D-22 | AI usage analytics *(owner request)* | `ai_requests` → 5-minute rollups (`ai_usage_hourly`, `ai_usage_daily.by_step`) in Postgres → admin dashboards by step, user, model, key, plan and version; rule-based **insights** and a **what-if** re-pricing simulator; monthly reconcile against provider totals | The per-call data already exists; no separate analytics store until ~100k users ([admin-panel.md](admin-panel.md) §9) |

Each decision has a full Decision / Options / Pros / Cons / Cost / Risk / Recommendation / Reason block in the relevant section below or in [research-report.md](research-report.md) §10–11.

---

## 2. Final recommended architecture

### 2.1 Diagram

```text
┌──────────────────────────────── USER'S CHROME (trusted zone = extension origin) ───────────────────────────────┐
│                                                                                                                 │
│  Job page tab (UNTRUSTED)            Extension service worker (thin router)        Side Panel (main UI, React)  │
│  ┌──────────────────────┐   inject   ┌──────────────────────────────┐  messages   ┌───────────────────────────┐ │
│  │ DOM of job page      │◄──────────│ action/contextMenu/commands  │◄───────────►│ Onboarding, Resume mgr,    │ │
│  │ extractJob() runs in │  (activeTab)│ tab events, badge, sidePanel │             │ Job analysis, Score,       │ │
│  │ ISOLATED world, once │──────────►│ open, message validation      │             │ Optimize, Diff, Download   │ │
│  └──────────────────────┘  JSON result└──────────────────────────────┘             │                           │ │
│                                                                                    │ packages/job-extraction    │ │
│  Offscreen document (only when panel closed): pdf.js worker, DOCX parse/gen        │ packages/resume (parse/gen)│ │
│                                                                                    │ packages/scoring (engine)  │ │
│  IndexedDB (extension origin): resumes, source files, evidence, jobs, results      │ packages/evidence          │ │
│  chrome.storage.session: auth access token, BYOK key (memory only)                 │ packages/ai (BYOK direct)  │ │
│  chrome.storage.local (TRUSTED_CONTEXTS): settings, consent, remote-config cache   └────────────┬──────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────┘
                                             HTTPS (JWT bearer; X-Extension-Version)               │   BYOK direct → provider APIs
                                                                                                  ▼   (privacy mode; no backend)
┌──────────────────────────────────────────── CLOUDFLARE EDGE ─────────────────────────────────────────────────────┐
│  API Gateway layer: Workers route + WAF + Rate-Limiting binding + Turnstile (signup) + CORS(chrome-extension://id) │
│                                                                                                                   │
│  apps/api (Hono on Workers)                                                                                       │
│   ├─ Auth service (Better Auth): Google OAuth, email OTP, JWT issue/refresh                                        │
│   ├─ Account/Usage service: plans, quotas (reads UserQuota DO), usage, export, delete                              │
│   ├─ Job Analysis service: jd_hash cache lookup ─► Postgres job_analyses ─► miss → AI Router (jd_extract)          │
│   ├─ Resume Structuring service: lines → canonical JSON (AI Router: resume_extract) — transient, not stored        │
│   ├─ Match service: ambiguous requirement mapping (AI Router: match_map) — transient                               │
│   ├─ Optimization service: creates Workflow instance, returns id; SSE progress via UserQuota DO                    │
│   ├─ Billing service: Paddle checkout + webhooks → subscriptions; coupon preview/reserve/redeem                    │
│   └─ Config service: active config versions from KV → signed flat config (selectors, flags, kill switches, …)      │
│                                                                                                                   │
│  Cloudflare Workflows: OptimizeWorkflow (steps: reserve quota → rewrite → deterministic gates → entailment →       │
│                        repair → finalize + release/settle quota)  — checkpointed, never re-runs completed LLM step │
│  Durable Object UserQuota (per user): exact counters, AI $ budget, concurrency lock, progress fan-out (SSE)        │
│  AI Router (packages/ai) ─► Cloudflare AI Gateway (own keys, logging of bodies OFF) ─► OpenAI │ Anthropic │ Google  │
│  Hyperdrive ─► Neon Postgres (users, subscriptions, usage, ai_requests, job_analyses cache, optimizations meta)    │
│  R2 (opt-in encrypted sync blobs / history files, TTL)                                                            │
│  Browser Run (fallback HTML→PDF renderer, optional)                                                                │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
      Paddle (MoR)      Resend (email)      Sentry (errors)      Better Stack (uptime)      Langfuse (evals, synthetic only)

┌──────────────────────────── ADMIN PLANE (separate deployment; admin-panel.md) ────────────────────────────────────┐
│  Admin browser ─► Cloudflare Access (SSO + MFA) ─► apps/admin (static SPA) ─► admin-api Worker (Hono, /admin/v1)  │
│   admin-api: role/permission check → validate → write + audit_log (same DB txn) → Paddle API (discounts, prices) │
│              → config publisher (Postgres config_versions → KV + signed extension config) → UserQuota DO (RPC)   │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component responsibilities

| Component | Responsibility | Holds personal data? |
|---|---|---|
| **Content extraction function** (`extractJob`) | Injected **once, on a user gesture**, into the active tab's isolated world. Reads JSON-LD, microdata and DOM; strips hidden and noise nodes; returns ≤ 200 KB JSON. No persistent content script. | Reads the job page only |
| **Service worker** | Registers context menus and commands, opens the side panel, routes and validates messages, handles `onInstalled`. Never runs long jobs ([FACT] it can be terminated after 30 s idle, or if a `fetch()` response takes > 30 s: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). | No |
| **Side panel app** | All UI; runs parsing, scoring, generation and BYOK calls; talks to the API | Yes (local) |
| **Offscreen document** | Parsing and generation when the panel is closed (e.g. a context-menu action before the panel opens). Reasons `WORKERS`, `BLOBS`, `DOM_PARSER`. | Transient |
| **IndexedDB (extension origin)** | System of record for resumes, source files, evidence, jobs, analyses, optimization outputs | Yes (local, encrypted at rest with a WebCrypto key, §17) |
| **API Worker** | Auth, quotas, AI orchestration, billing, config. Stateless. | Transient in memory only |
| **OptimizeWorkflow** | Durable multi-step rewrite with checkpointing | Step outputs contain resume content → **encrypt step payloads with a per-job key** and keep the 30-day retention setting in mind ([FACT] Workflows instance state retention: Paid 30 days — https://developers.cloudflare.com/workflows/reference/pricing/). Store results in the DO only for ≤ 24 h. |
| **UserQuota Durable Object** | Exact quota and budget counters, concurrency lock, progress stream, short-lived result mailbox | Result mailbox (≤ 24 h, encrypted) |
| **AI Router + AI Gateway** | Model selection, budgets, retries, fallback, cost logging; gateway gives analytics, exact-match caching, coarse rate limits | Transient |
| **Postgres (Neon)** | Accounts, subscriptions, usage ledger, `ai_requests` metadata, the shared JD-analysis cache (derived), optimization metadata | Email, name (account). **No resume content.** |
| **R2** | Only for opt-in cloud sync or history (client-side encrypted blobs) | Ciphertext only |
| **Admin SPA + `admin-api` Worker** | Support, coupons, plans and prices, runtime config, traces, audit log ([admin-panel.md](admin-panel.md)) | Emails (masked by default; reveals audited) and metadata. **Never resume or JD content.** |
| **Paddle / Resend / Sentry / Better Stack / Langfuse** | Payments, email, errors, uptime, eval tracing | Email (Paddle, Resend); scrubbed errors (Sentry); synthetic data only (Langfuse) |

### 2.3 End-to-end sequence (hosted mode)

```text
User clicks toolbar icon on a job page
 → Chrome opens side panel (openPanelOnActionClick) ─► side panel asks SW to extract
 → SW: chrome.scripting.executeScript({target:{tabId, allFrames:true}, func: extractJob, args:[siteConfig]})
 → extractJob returns {jsonld, microdata, dom_text, title, url, frames[]} (≤200 KB)
 → Side panel: normalize + compute jd_hash; show "Detected: <title> at <company>" (user can correct)
 → POST /v1/jobs/analyze {jd_text, url_host, jsonld_fields, jd_hash}
      API: cache hit? → return job_analysis. Miss → AI Router(jd_extract@v1, Luna) → validate quotes ⊂ jd_text → store derived analysis → return
 → Side panel: deterministic match (packages/scoring) with local resume + evidence
      ambiguous requirements? → POST /v1/matches/map {requirements, evidence_claims(minimized)} → Luna → mappings
 → Show Job Match Score + breakdown + missing/weak + "could not improve" preview (evidence ceiling)
 → User clicks Optimize → POST /v1/optimizations {job_analysis_id, resume_payload(minimized, ids), options, idempotency_key}
      API: UserQuota DO reserve(1) → start OptimizeWorkflow → 202 {optimization_id}
      Side panel subscribes GET /v1/optimizations/{id}/events (SSE): queued → rewriting → validating → repairing → done
      Workflow: rewrite (Sol) → deterministic gates → entailment (Luna) → repair (≤1) → assemble → settle quota
 → Side panel fetches result (once; DO mailbox deleted after fetch or 24 h) → re-scores locally (after score)
 → Diff view with evidence popovers; user accepts/rejects per change → generate DOCX/PDF locally → download
```

---

## 3. Chrome extension architecture (MV3)

### 3.1 Contexts and their jobs

| Context | Lifetime | Allowed APIs | Our use |
|---|---|---|---|
| Service worker | Event-driven; [FACT] terminated after 30 s idle, if a single event or API call takes > 5 min, or if a `fetch()` response takes > 30 s to arrive (lifecycle doc) | All extension APIs; no DOM | Router, context menus, commands, `sidePanel.open`, script injection |
| **Side panel** (extension page) | [FACT] "As an extension page, side panels have access to all Chrome APIs"; it lives while open and "remains open when navigating between tabs (if set to do so)" (https://developer.chrome.com/docs/extensions/reference/api/sidePanel) | All APIs, DOM, Workers, Blob URLs | Main app |
| Options page | Full tab (`options_page`) | All | Settings, BYOK keys, data export/delete, privacy |
| Offscreen document | [FACT] Only `chrome.runtime` is available inside; one open at a time; no lifetime limit except for audio (https://developer.chrome.com/docs/extensions/reference/api/offscreen) | runtime only | Background parsing and generation |
| Injected function (isolated world) | Single execution | DOM + limited runtime | JD extraction only |

### 3.2 UI surface decision (brief §8, §35)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Popup** | Familiar; tiny | [FACT] "Popups automatically close when the user focuses on some portion of the browser outside of the popup. There is no way to keep the popup open" (https://developer.chrome.com/docs/extensions/develop/ui/add-popup). Max 800×600 px. Loses state mid-flow; bad for 30–60 s optimizations and side-by-side reading. | ❌ |
| **Side panel** | Persistent while browsing; sits alongside the JD; per-tab or global instances; opens on action click via `setPanelBehavior({openPanelOnActionClick:true})`; full extension-page capabilities; the user chooses left or right | Chrome 114+ (`open()` 116+); narrow width (design for ~360–480 px); users must discover it | ✅ **Primary** |
| **Injected page UI** (Shadow DOM widget on the job page) | Contextual "Analyze" button | Runs next to hostile page JS; [FACT] LinkedIn prohibits extensions that "modify the appearance of" its site (https://www.linkedin.com/help/linkedin/answer/a1341387); [FACT] CWS quality guidance calls toolbars injected into every page "not recommended" (https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq); needs host permissions | ❌ for MVP; revisit as an opt-in badge on Tier A sites only |
| **Full extension page** (tab) | Room for diff and editing | Takes the user away from the JD | ✅ for "Resume workspace" / large diff view, opened from the side panel |

**[RECOMMENDATION]**

- Side panel for the whole core flow, plus a full-page "Resume workspace" for heavy editing and resume management.
- No popup: clicking the action opens the panel.
- The context menu "Analyze selected text as job description" is the universal fallback.
- A keyboard shortcut (`commands`) opens the panel.

### 3.3 Messaging

- Every message has the shape `{type, v, requestId, payload}` and is validated with Zod at the receiver. Unknown types are rejected.
- Check `sender.id === chrome.runtime.id`.
- For results from injected functions, accept only the return value of `executeScript`. There is no long-lived content-script channel.
- [FACT] Chrome messaging uses JSON serialization with a 64 MiB max, and structured clone is opt-in from Chrome 148 (`"message_serialization": "structured_clone"`) (https://developer.chrome.com/blog/structured-clone-messaging). **[RECOMMENDATION]** Set `minimum_chrome_version` to "148" and enable structured clone, so `File`/`Blob` objects pass between the side panel and the offscreen document. Otherwise hand them over via IndexedDB.
- [FACT] "Assume that messages from a content script might have been crafted by an attacker" (https://developer.chrome.com/docs/extensions/develop/concepts/messaging). The only page-derived data we accept is the extraction result, which is size-capped and schema-validated, then treated as untrusted text.

### 3.4 Permissions strategy

| Permission | Why | Install warning |
|---|---|---|
| `activeTab` | Read the job page after a user gesture | None ([FACT] https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) |
| `scripting` | `executeScript(extractJob)` | None |
| `sidePanel` | Main UI | None |
| `storage`, `unlimitedStorage` | Settings; large local resume/history store | None |
| `contextMenus` | "Analyze selected text" fallback | None |
| `offscreen` | Background parse and generation | None |
| `identity` (not `identity.email`) | `launchWebAuthFlow` for Google sign-in | None |
| `optional_host_permissions`: Tier A portal hosts | v1.1 "auto-detect jobs on supported sites" opt-in | Prompt shown at opt-in time |
| `optional_host_permissions`: `https://api.openai.com/*`, `https://api.anthropic.com/*`, `https://generativelanguage.googleapis.com/*` | BYOK direct calls (requested when the user enables BYOK) | Prompt at opt-in |
| *Not requested:* `tabs`, `downloads`, `<all_urls>`, `webRequest`, `cookies`, `history` | – | – |

- [FACT] Permission warnings list no warning for `activeTab`, `scripting`, `sidePanel`, `storage`, `unlimitedStorage`, `contextMenus`, `offscreen`, or `identity` without `.email` (https://developer.chrome.com/docs/extensions/reference/permissions-list).
- [ASSUMPTION] Our API can be called without a host permission if it returns CORS headers allowing `chrome-extension://<id>`. Verify in the PoC.
- [OPEN QUESTION] Does `openPanelOnActionClick` still grant `activeTab`? It must be tested in the PoC. If it doesn't, the panel's "Analyze this page" button (a user gesture inside an extension page) triggers injection instead. [FACT] `sidePanel.open()` and user gestures on extension pages count ([FACT] sidePanel docs); the activeTab doc lists "executing an action" and context-menu/command gestures.
- Downloads use a Blob URL and an `<a download>` click from the side panel. [ASSUMPTION] This works without the `downloads` permission; verify in the PoC.

### 3.5 Manifest sketch (configuration, not production code)

```jsonc
{
  "manifest_version": 3,
  "name": "Job Match Optimizer (working name)",
  "minimum_chrome_version": "148",
  "action": { "default_title": "Open Job Match Optimizer" },
  "side_panel": { "default_path": "sidepanel.html" },
  "options_page": "options.html",
  "background": { "service_worker": "sw.js", "type": "module" },
  "permissions": ["activeTab", "scripting", "sidePanel", "storage", "unlimitedStorage", "contextMenus", "offscreen", "identity"],
  "optional_host_permissions": [
    "https://*.greenhouse.io/*", "https://jobs.lever.co/*", "https://jobs.ashbyhq.com/*",
    "https://jobs.smartrecruiters.com/*", "https://*.myworkdayjobs.com/*", "https://*.icims.com/*",
    "https://api.openai.com/*", "https://api.anthropic.com/*", "https://generativelanguage.googleapis.com/*"
  ],
  "externally_connectable": { "ids": [], "matches": ["https://app.<our-domain>/*"] },
  "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
  "message_serialization": "structured_clone",
  "commands": { "_execute_action": { "suggested_key": { "default": "Alt+J" } } }
}
```

- [FACT] If `externally_connectable` is absent, "all extensions can connect", so declare it explicitly (https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable).
- [FACT] `'wasm-unsafe-eval'` is the most permissive CSP allowed for extension pages; `'unsafe-eval'` fails to install (https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).
- The full security rationale is in [security-threat-model.md](security-threat-model.md) §8.

### 3.6 Update lifecycle

- [FACT] An update installs only when the extension is idle: the service worker is not running **and no extension pages are open**. Raising `minimum_chrome_version` above a user's Chrome version silently stops their updates (https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle).
- Because the side panel stays open for long periods, the API must support the current extension version and the previous one or two. The extension sends `X-Extension-Version`; the API returns `426` only for truly incompatible versions, and the panel shows "Reload to update" when idle (`runtime.onUpdateAvailable`).

---

## 4. Job description extraction pipeline

### 4.1 Is DOM extraction alone sufficient?

**No.** DOM text alone mixes the JD with navigation, recommendations ("similar jobs"), cookie banners, ads and duplicated mobile/desktop copies. SPAs (Workday, Ashby, LinkedIn) render late, and some ATS put the JD in iframes (iCIMS in a same-host iframe; Greenhouse embeds in a cross-origin iframe on employer domains).

The pipeline is therefore **layered**, prefers **structured data**, and always shows the user what was detected so they can correct it.

### 4.2 Layers

```text
L0  Site detection        url host/path + DOM fingerprints → adapter id (or "generic")
L1  Structured data       JSON-LD @type JobPosting (all frames) → microdata itemtype schema.org/JobPosting
L2  Site adapter          flat selector config per Tier-A host (title, company, location, description container)
L3  Generic extractor     readability-style scoring of text blocks + JD-heading heuristics ("Responsibilities",
                          "Requirements", "Qualifications", "What you'll do", "Nice to have", "Benefits")
L4  User assist           "Use selected text" (context menu or panel button), or paste box
L5  Reconciliation        compare L1 vs L2/L3 text (similarity); choose richest consistent source; flag conflicts
L6  LLM structuring       jd_extract@v1 on the chosen text → requirements with verbatim quote spans (server or BYOK)
L7  User confirmation     "We detected: Senior Data Engineer · Acme · Remote (US)"  [Edit]  [Looks right]
```

**Evidence for each layer:**

- **L1** — [FACT] Google requires `datePosted`, `description`, `hiringOrganization`, `jobLocation` and `title` for JobPosting rich results, so employers have a strong incentive to embed them (https://developers.google.com/search/docs/appearance/structured-data/job-posting, updated 2026-09-08). [FACT, observed 2026-09-29] Structured-data support by platform:
  - Lever and Ashby: JSON-LD.
  - Workday: JSON-LD when the posting is open.
  - iCIMS: JSON-LD inside the iframe.
  - SmartRecruiters: microdata.
  - Greenhouse's hosted page: **no JSON-LD** in the sample, but server-rendered `.job__description`.
- **L2 adapters** are **remote flat config** validated against a bundled JSON Schema. [FACT] CWS allows "Fetching a remote configuration file ... where all logic for the functionality is contained within the extension package" and prohibits "an interpreter to run complex commands fetched from a remote source" (https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements). Selectors are data; extraction logic ships in the package.
- **L3 generic extractor:**
  1. Remove `script`, `style`, `nav`, `header`, `footer`, `aside`, `[aria-hidden=true]`, `display:none` / `visibility:hidden` / zero-size nodes, cookie/consent containers (common ids and classes), and "similar jobs" lists.
  2. Score blocks by text density, the number of JD headings, bullet lists, and closeness to the `<h1>` title.
  3. Take the best block plus adjacent blocks that share JD headings.
  4. Dedupe repeated paragraphs (hash by normalized sentence).

### 4.3 Dynamic pages

- **SPAs and lazy loading.** `extractJob` waits for readiness in this order: JSON-LD present, or the adapter selector present, or DOM stable. "DOM stable" means a `MutationObserver` quiet for 500 ms, with a maximum of 4 s. If the posting has an expander ("Show more"), read the full hidden text node when it is in the DOM. **Never click or expand automatically**: LinkedIn and Indeed prohibit automation, and it is a user-visible change.
- **Frames.** Inject with `allFrames: true` (activeTab covers frames of the same tab? [OPEN QUESTION] for cross-origin frames, verify in the PoC). If the JD is in a cross-origin iframe without access, show a "Open the job in its own tab" hint with the iframe URL (Greenhouse `boards.greenhouse.io/embed/...`, or use the `gh_jid` parameter).
- **Hidden content.** Exclude elements with computed `display:none`, `visibility:hidden`, `opacity:0`, font-size < 4 px, off-screen positioning or clip-path hiding. This is also a **prompt-injection defence** (hidden instructions are removed; see [security-threat-model.md](security-threat-model.md) §7).
- **Size limits.** JD text is capped at 20,000 characters (the typical JD is 3–8k). Anything longer is truncated at section boundaries, with a warning.

### 4.4 Site detection and extractor selection

```text
ExtractorRegistry: [
  { id:'greenhouse',      match: host ~ /(^|\.)greenhouse\.io$/ OR url has gh_jid,   layers:[L1,L2,L3] },
  { id:'lever',           match: host == 'jobs.lever.co',                           layers:[L1,L2,L3] },
  { id:'ashby',           match: host == 'jobs.ashbyhq.com',                        layers:[L1,L3] },
  { id:'smartrecruiters', match: host == 'jobs.smartrecruiters.com',                layers:[L1(microdata),L2,L3] },
  { id:'workday',         match: host ~ /\.myworkdayjobs\.com$/ AND window.workday, layers:[L1,L3] },
  { id:'icims',           match: host ~ /\.icims\.com$/ (read iframe in_iframe=1),  layers:[L1,L3] },
  { id:'generic',         match: *,                                                 layers:[L1,L3,L4] }
]
Tier-B hosts (linkedin.com, indeed.*, glassdoor.*, ziprecruiter.com, wellfound.com, naukri.com) → 'generic'
  on explicit click only, with a one-time notice; no host-specific selectors until counsel review (D-04).
```

The brief's `LinkedInExtractor`, `IndeedExtractor`, etc. are deliberately **not** separate code modules in the MVP. See [product-requirements.md](product-requirements.md) §6 for the legal rationale.

### 4.5 Output: `ExtractedJob`

```jsonc
{
  "source": { "url": "https://jobs.lever.co/acme/123", "host": "jobs.lever.co", "adapter": "lever",
              "layers_used": ["L1","L3"], "extracted_at": "2026-09-29T10:00:00Z", "confidence": 0.92 },
  "fields": { "title": "Senior Data Engineer", "company": "Acme", "location": ["Remote (US)"],
              "employment_type": "FULL_TIME", "salary": {"min":150000,"max":180000,"currency":"USD","interval":"YEAR"} },
  "description_text": "…normalized plain text with preserved headings and bullets…",
  "sections": [{ "heading": "Requirements", "start": 1840, "end": 2710 }],
  "warnings": ["hidden_text_removed", "truncated"],
  "jd_hash": "sha256:…"
}
```

### 4.6 Structured JD analysis (the `jd_extract@v1` output)

The fields extracted are: title, company, location(s) and work mode, salary (only if explicitly stated), employment type, responsibilities, required qualifications, preferred qualifications, education, certifications, skills (normalized), years of experience (min/max per skill or overall), work authorization/clearance flags, and benefits (optional; not scored). Every requirement has a verbatim `quote` that must be a substring of `description_text`. The validator rejects any requirement whose quote is not found, which prevents invented requirements and injection-driven fabrication.

---

## 5. Resume parsing and the canonical resume schema

### 5.1 Inputs and libraries

| Input | Parser (in extension) | Notes |
|---|---|---|
| PDF (text) | **pdfjs-dist 6.3.x** (Apache-2.0), bundled worker | [FACT] `getTextContent()` gives items with transform/width/height/font; `getAnnotations()` gives links; `getStructTree()` gives tags or `null` (https://github.com/mozilla/pdf.js/blob/master/src/display/api.js). [MEASURED in research] The worker is 1.27 MB (375 KB gzipped); no eval paths in 6.3.289. **Set `isEvalSupported: false`** ([FACT] CVE-2024-4367 fixed in 4.2.67: https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq). |
| PDF (scanned / no text layer) | Detect → ask for DOCX or text PDF; opt-in cloud OCR is post-MVP | [FACT] tesseract.js "does not support PDF files" and loads WASM from CDNs by default, so it must be bundled (~30 MB) (https://github.com/naptha/tesseract.js) |
| DOCX | **mammoth 1.13** (BSD-2) for body semantics + a **custom OOXML pass** (JSZip) for `header*.xml`, `footer*.xml`, hyperlinks, text boxes | [FACT] mammoth does not extract headers/footers (issue #9, open since 2013) and "performs no sanitisation" (https://github.com/mwilliamson/mammoth.js) |
| TXT / paste | Direct | Universal fallback |
| LinkedIn "Save to PDF" / data export ZIP | PDF path / CSV parser for the `Positions`, `Education`, `Skills`, `Certifications`, `Projects` files | [FACT] LinkedIn offers both to members for their own profile (https://www.linkedin.com/help/linkedin/answer/a541960, /a1339364); the archive format is [ASSUMPTION] ZIP of CSVs |
| .doc, .pages, .odt, .rtf | Not supported → "Save as DOCX or PDF" | Keeps parsing surface small |

### 5.2 Layout pass (deterministic)

1. **Items → lines.** Group text items by baseline y-coordinate within a tolerance; sort by x.
2. **Column detection.** Build a histogram of item x-starts; find a vertical whitespace gutter spanning more than 60% of page height. If found, split into regions (e.g. sidebar and main), and set reading order to the main column first, then the sidebar, with the sidebar tagged as such. Never sort top-to-bottom across columns: that interleaves them. [FACT] Textkernel reports a finding code for columnar data rearrangement, and Greenhouse lists "columned layouts" among parse issues (https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse).
3. **Section headings.** Detected by font size or bold relative to body text, ALL CAPS, short lines, and a synonym dictionary (Experience / Work History / Professional Experience …).
4. **Bullets.** Glyph detection (•, ▪, –, *, numbering) plus hanging indent.
5. **Dates.** Regex set covering month-year and year ranges, "Present/Current", and localized month names (en first).
6. **Quality gate:**
   - Characters per page below 200, **or** more than 5% `(cid:…)` or private-use glyphs, **or** zero items → "unreadable/scanned".
   - Detect **hidden text**: white or near-background colour, font < 4 pt, text outside the page. Warn the user, and exclude it from evidence.
7. Every line gets `span_id = "s_{docVersion}_{page}_{lineNo}"`, plus `bbox` and `page`. These are the **evidence source spans**.

### 5.3 LLM structuring with citations

`resume_extract@v1` (Luna) receives `lines[]` and returns the canonical JSON. **Every value carries `span_ids`.** The deterministic validator checks that each value (normalized: case, whitespace, unicode, date formats) is contained in the text of its cited spans. Values that fail are dropped and listed for user confirmation. The user reviews the parsed resume once, in the "Resume review" screen (see [product-requirements.md](product-requirements.md) §8).

### 5.4 Canonical resume schema (complete)

This is a superset of JSON Resume ([FACT] `@jsonresume/schema` 1.3.1, MIT: https://github.com/jsonresume/resume-schema, moved to the jsonresume.org monorepo). It adds IDs, provenance, precision and evidence status. Types are shown in TypeScript style as a schema, not an implementation.

```typescript
type ISODatePartial = string;            // "2021" | "2021-03" | "2021-03-15"
type SpanId = string;                    // "s_v3_1_12"
type Provenance = { span_ids: SpanId[]; source: 'parser' | 'user_edit' | 'user_attested' | 'linkedin_export' };

interface CanonicalResume {
  schema_version: '1.0';
  resume_id: string; version_id: string; locale: string;           // e.g. "en-US"
  source_documents: SourceDocument[];                               // original files & their hashes
  personal: {
    full_name: Field<string>; headline?: Field<string>;
    emails: Field<string>[]; phones: Field<string>[];
    location?: Field<{ city?: string; region?: string; country_code?: string }>;
    links: Field<{ network: 'linkedin'|'github'|'portfolio'|'other'; url: string; display_text?: string }>[];
    work_authorization?: Field<string>;                             // only if user states it
  };
  summary?: Field<string> & { summary_id: string };
  experience: Role[];
  education: Education[];
  skills: Skill[];
  projects: Project[];
  certifications: Certification[];
  awards: SimpleItem[]; publications: SimpleItem[]; volunteering: Role[]; languages: Language[];
  additional_sections: { heading: string; items: Field<string>[] }[]; // unknown sections preserved verbatim
  parse_quality: { score: number; warnings: string[]; columns_detected: boolean; hidden_text_found: boolean };
}

interface Field<T> { value: T; prov: Provenance; confidence: number; user_confirmed: boolean }

interface Role {
  role_id: string;
  employer: Field<string>; title: Field<string>;
  location?: Field<string>; employment_type?: Field<string>;
  start: Field<ISODatePartial>; end: Field<ISODatePartial | 'present'>;
  date_precision: 'year' | 'month' | 'day';
  bullets: Bullet[];
  technologies: SkillRef[];                                         // derived from bullets (evidence-linked)
}

interface Bullet {
  bullet_id: string; text: string; prov: Provenance;
  claims: ClaimRef[];                                               // links to Evidence Store (§6)
}

interface Education {
  education_id: string; institution: Field<string>; degree?: Field<string>; field_of_study?: Field<string>;
  start?: Field<ISODatePartial>; end?: Field<ISODatePartial>; gpa?: Field<string>; honors?: Field<string>[];
}

interface Skill {
  skill_id: string; name: Field<string>;
  normalized: { canonical: string; taxonomy_id?: string; aliases: string[] };  // e.g. "k8s" → "Kubernetes"
  category?: 'language' | 'framework' | 'tool' | 'platform' | 'domain' | 'soft' | 'other';
  evidence_level: 'demonstrated' | 'listed_only';                   // demonstrated = appears in a role/project bullet
  claim_ids: string[];
}

interface Project { project_id: string; name: Field<string>; role?: Field<string>; start?: Field<ISODatePartial>;
  end?: Field<ISODatePartial|'present'>; url?: Field<string>; bullets: Bullet[]; technologies: SkillRef[] }
interface Certification { cert_id: string; name: Field<string>; issuer?: Field<string>; date?: Field<ISODatePartial>;
  expires?: Field<ISODatePartial>; credential_id?: Field<string> }
interface Language { language: Field<string>; proficiency?: Field<string> }
interface SimpleItem { item_id: string; title: Field<string>; date?: Field<ISODatePartial>; detail?: Field<string> }
type SkillRef = { skill_id: string }; type ClaimRef = { claim_id: string };
interface SourceDocument { doc_id: string; kind: 'pdf'|'docx'|'txt'|'paste'|'linkedin_pdf'|'linkedin_export';
  file_name?: string; sha256: string; pages?: number; imported_at: string }
```

**Export.** An adapter to JSON Resume is provided for interoperability, and HR Open LER-RS is a later option ([FACT] HR Open 4.5 Final, 2026-02-05: https://www.hropenstandards.org/standards).

---

## 6. Evidence Store and anti-hallucination enforcement

### 6.1 Concept

```text
JD requirement  ──►  "Kafka" (req_7, type=must, quote="experience with Kafka or Kinesis")
                         │   deterministic alias match / embedding / match_map@v1
                         ▼
Resume evidence ──►  claim_31 {type: tool, value: "Kafka", span: s_v3_1_12 "Built Kafka-based pipeline processing 2M events/day"}
                         │   allowed transformations (policy)
                         ▼
Allowed rewrite ──►  "Built a Kafka-based streaming pipeline processing 2M events/day" (claims: claim_31, claim_32[2M/day])
Forbidden       ──►  "Led Kafka migration saving 40%" (new ownership "Led", new metric "40%" → rejected)
```

### 6.2 Data model (local IndexedDB; see [database-design.md](database-design.md) §9)

| Entity | Key fields |
|---|---|
| `SourceSpan` | `span_id`, `doc_id`, `page`, `line`, `bbox`, `text`, `hidden: bool` |
| `Claim` | `claim_id`, `type ∈ {skill, tool, metric, employer, title, date_range, responsibility, achievement, certification, education, project, scope, team_size, domain}`, `value` (normalized), `raw_text`, `span_ids[]`, `role_id?`, `project_id?`, `source ∈ {parser, user_attested}`, `confidence`, `created_at` |
| `ClaimAttribute` | e.g. a metric's `{number: 2000000, unit: "events/day"}`; a scope's `{verb_strength: 'built'}` |
| `UserAttestation` | `claim_id`, `statement` (user-entered fact), `attested_at`, and a checkbox the user must tick: "I confirm this is true" |
| `EvidenceIndex` | `normalized_value` → `claim_ids` (for fast lookup); per-role scoping |

**Claim extraction** happens deterministically after parsing:

- metrics via numeric/percent/currency regexes;
- tools and skills via the taxonomy;
- employers, titles and dates from the structured fields.

An LLM assist (inside `resume_extract`) adds responsibility, achievement and scope claims, and **every one must cite spans**.

**User-attested facts.** Users can add true facts that are missing from the resume. These become first-class evidence marked `user_attested`, and they are shown differently in the diff. This is the only legitimate way to "add AWS".

### 6.3 Generation constraints (the `optimize@v1` contract)

- The model receives the resume JSON with IDs and an **allowed-claims list**. It must return, for each bullet: `source_bullet_ids[]`, `text`, `claim_ids[]` and `emphasized_req_ids[]`.
- **Allowed transformations:**
  - reorder, condense or clarify;
  - use the JD's terminology for an **existing** claim (e.g. "k8s" → "Kubernetes", or "event streaming" when the evidence says Kafka);
  - merge two bullets from the same role;
  - move emphasis;
  - reorder skills;
  - rewrite the summary using only claims present anywhere in the resume.
- **Forbidden transformations:**
  - new numbers or units;
  - new employers, titles, dates, degrees or certifications;
  - new tools or skills without a claim;
  - verb-strength upgrades beyond the evidence ("assisted/contributed/supported" → "led/owned/architected");
  - team-size or scope inflation;
  - cross-role transplant (using role A's claims in role B's bullets);
  - converting "familiar with" into "expert in";
  - changing years of experience.

### 6.4 Validation pipeline (runs server-side in the Workflow, and again in the extension)

```text
G0 Schema            Zod parse; stop_reason ∉ {refusal, max_tokens}; enum case-normalized ([FACT] Claude caveat)
G1 Referential       every claim_id / source_bullet_id exists; belongs to same role (unless role_id=summary)
G2 Number diff       numbers/percents/currency/durations in output ⊆ numbers in cited spans (normalized: 2M = 2,000,000)
G3 Entity diff       orgs, titles, degrees, certs, product/tool names (taxonomy + capitalized n-grams) in output ⊆ cited evidence ∪ JD-term-mapped-to-existing-claim
G4 Skill gate        every skill in skills list has a claim (demonstrated or listed_only; listed_only never promoted into bullets)
G5 Verb/scope ladder ownership verb rank(output) ≤ rank(evidence) per bullet (ladder: familiar<used<assisted<contributed<built<implemented<designed<led<owned)
G6 Temporal          no technology anachronism (tool release year > role end year → flag; [FACT] failure mode named in arXiv 2607.01457)
G7 Entailment (LLM)  validate_entail@v1 per changed bullet vs its evidence texts → entailed | embellished | contradicted | unsupported
G8 Style             deterministic rubric (no first person, ≤ 2 lines, starts with verb, no keyword lists inside bullets)
Result: pass → accept; fail(G2–G7) → repair@v1 once with violations → re-run G0–G7 → still fail → REVERT to original bullet
```

**Contradiction detection** spans the whole output: title and date consistency with the header, total years versus the summary's "X years" claim, and duplicated bullets.

The extension re-runs G0–G6 locally on receipt (defence in depth, and needed for BYOK mode) and runs G7 via Luna in BYOK mode.

### 6.5 User review (the last gate)

- The diff view shows original versus proposed changes, with evidence popovers linking to the source span highlighted in the original document preview.
- The user accepts each change individually, or accepts all changes that passed validation.
- Any user edit to a bullet re-runs G2–G6 locally. A user may add unsupported content only by creating a **user attestation**, which the product records explicitly.

---

## 7. Scoring engine

### 7.1 Principles

- Deterministic and explainable, versioned (`scoring@1.0`), running in `packages/scoring` in the extension (and in tests).
- No LLM produces the score. The LLM only helps classify ambiguous requirement↔evidence pairs, and its output is one input with bounded credit.
- Same inputs give the same score.

### 7.2 Requirement-level match states

| State | Credit `m_r` | Rule |
|---|---:|---|
| `strong` | 1.0 | Exact or alias match of the requirement's skill/term in **demonstrated** evidence (a role or project bullet), or an explicit degree/cert/years match |
| `partial` | 0.6 | Related evidence (taxonomy sibling, e.g. "Kinesis" for "Kafka or Kinesis"; embedding similarity ≥ τ_high; LLM mapping `partial`), **or** the skill is only listed in the skills section without bullet evidence (`listed_only`) |
| `weak` | 0.3 | Transferable or indirect evidence (embedding τ_low ≤ sim < τ_high, or LLM `weak`) |
| `none` | 0 | No evidence |
| `unknown` | excluded | Cannot be evaluated from the resume (e.g. work authorization, location when the resume states none) — **excluded from the denominator but reduces confidence** |

The thresholds τ are calibrated on the golden set in [ai-model-comparison.md](ai-model-comparison.md) §9.

### 7.3 Categories and default weights

| Category k | Requirements included | Default weight W_k |
|---|---|---:|
| Required skills & qualifications | `type=must` (skills, tools, qualifications) | 30 |
| Experience (years/seniority) | years requirements (overall and per skill), seniority level | 15 |
| Responsibilities | `type=responsibility`, matched to role bullets | 15 |
| Preferred skills | `type=preferred` | 10 |
| Job title alignment | similarity of the target title to recent titles (taxonomy + embedding), bucketed 1 / 0.6 / 0.3 / 0 | 8 |
| Keyword coverage | top-K salient JD terms present verbatim or as an alias (see §7.5) | 7 |
| Education | degree level / field requirements | 5 |
| Certifications | required or preferred certs | 5 |
| Resume structure & parseability | deterministic checks (§7.6) | 5 |
| **Location / work authorization** | **not weighted** — shown as a separate **eligibility flag** (match / mismatch / unknown) | – |
| **Semantic relevance** | **not a separate category.** Embeddings feed the `m_r` states above, which avoids double counting | – |

The weights sum to 100.

- **Fixed or variable?** **Fixed per scoring version** for the MVP, and published in-product.
- **Job-specific adaptation** comes only from the JD itself: category presence and requirement importance (see below). It is deterministic.
- **User-configurable weights** are deferred to post-MVP ("What matters to me" sliders only change the view, never the headline score).
- **Learned weights** are "Future", and require consented outcome data (interview callbacks).

**Requirement weights within a category:** `w_r = base_type × emphasis`, where

- `base_type` is `must` = 1.0, `preferred` = 0.5, `responsibility` = 0.8;
- `emphasis` ∈ [1, 1.5] rises when the term appears in the title or in multiple sections of the JD, capped.

### 7.4 Formula

For each category present in the JD (at least one known requirement):

```text
C_k = Σ_{r∈k, state≠unknown} w_r · m_r  /  Σ_{r∈k, state≠unknown} w_r            ∈ [0,1]
```

Renormalize over the categories present, so categories with no requirements drop out and their weight is redistributed:

```text
Base = 100 · Σ_{k∈present} W_k · C_k  /  Σ_{k∈present} W_k
```

A missing-must-have penalty is applied as a multiplicative gate, so a resume missing hard requirements can't score high through breadth:

```text
n_hard_missing = # of r with type=must AND hard=true (JD says "required"/"must") AND state=none
G = max(0.60, 1 − 0.07 · n_hard_missing)
Score = round(Base · G)
```

Eligibility flags (location, work authorization, clearance) are shown beside the score. They never reduce it silently.

### 7.5 Keyword coverage (anti-gaming by design)

- The term set T is the top-K (K ≤ 25) salient JD terms. Salience combines the LLM extraction with TF-IDF against a background corpus of JDs. Stop-words and generic terms are removed.
- A term t is covered if it appears in **demonstrated** evidence; it counts 0.5 if it appears only in the skills list.
- Frequency beyond two occurrences adds nothing.
- Text flagged hidden in the source (§5.2) is ignored.
- `coverage = Σ credit / |T|`. The category score is `C_kw = min(1, coverage / 0.8)`, so coverage saturates at 80% and there is no incentive to stuff every term.

### 7.6 Structure & parseability sub-score (deterministic)

Checks, each 0/1 and averaged:

- the text layer is extractable;
- single-column reading order (no gutter detected) **or** the generated template is used;
- standard section headings are present (Experience, Education, Skills);
- contact information is in the body, not in the header/footer only;
- dates are parseable for ≥ 90% of roles;
- no tables or text boxes in the output;
- file size ≤ 2.5 MB ([FACT-SECONDARY] Greenhouse cites a 2.5 MB parsing limit — third-party summaries of Greenhouse docs; verify);
- no images carrying text.

### 7.7 Confidence

```text
conf = 0.35·q_jd + 0.25·q_resume + 0.25·(1 − u) + 0.15·d
  q_jd     = JD extraction confidence (JSON-LD & DOM agree, requirement quotes valid, sections found) ∈[0,1]
  q_resume = parse_quality.score ∈[0,1]
  u        = unknown-requirement weight share ∈[0,1]
  d        = deterministic share = weight of requirements decided by exact/alias/structured rules / total weight
Label: High ≥ 0.80 · Medium 0.60–0.79 · Low < 0.60
Range: recompute Score with partial credit ∈ {0.5, 0.7} and weak ∈ {0.2, 0.4} → display "82 (78–85)"
```

### 7.8 Worked example

A JD with 6 must-haves, 4 preferred, 5 responsibilities, 5+ years, BS in CS, no certs, 18 keywords, remote US. The resume has 7 years, a BS in CS and no location.

| Category | W | C_k computation | C_k |
|---|---:|---|---:|
| Required (6 must, all w=1) | 30 | states: 1, 1, 1, 0.6, 0.6, 0 → 4.2/6 | 0.70 |
| Experience | 15 | 7 ≥ 5 → 1 | 1.00 |
| Responsibilities (5, w=0.8) | 15 | 1, 1, 0.6, 0.6, 0.3 → 3.5/5 | 0.70 |
| Preferred (4, w=0.5) | 10 | 1, 0, 0, 0.6 → 1.6/4 | 0.40 |
| Title | 8 | "Data Engineer" vs "Senior Data Engineer" → 0.6 | 0.60 |
| Keywords (18 terms) | 7 | 11 covered + 2 skills-only (×0.5) = 12/18 = 0.667 → /0.8 | 0.83 |
| Education | 5 | match | 1.00 |
| Certifications | – | not present in JD → dropped | – |
| Structure | 5 | 7 of 8 checks | 0.875 |

```text
Σ W present = 30+15+15+10+8+7+5+5 = 95
Σ W·C = 21 + 15 + 10.5 + 4 + 4.8 + 5.81 + 5 + 4.375 = 70.485
Base = 100 · 70.485 / 95 = 74.2
n_hard_missing = 1 (the 'none' must-have is marked required) → G = 0.93
Score = round(74.2 · 0.93) = 69   · Eligibility: Location unknown (resume has no location)
Confidence: q_jd .95, q_resume .9, u = .05, d = .7 → 0.3325+0.225+0.2375+0.105 = 0.90 → High
```

### 7.9 Preventing gaming

1. The score is computed by our code on our parse. Users cannot type a score.
2. Keyword saturation (§7.5), and no credit for hidden text or repetition.
3. `listed_only` skills earn partial credit only.
4. The optimizer cannot add claims (§6). The "after" score can only rise through **surfacing existing evidence**, bounded by the **evidence ceiling** (§8.3).
5. Weights are versioned and published. Changing them is a release with an eval run, not a per-user tweak.
6. The score is never presented as an ATS score ([product-requirements.md](product-requirements.md) §9).

---

## 8. Optimization pipeline and before/after

### 8.1 Pipeline steps

Step codes (S1–S6) match [cost-analysis.md](cost-analysis.md) §3.

| Step | Where | Model | Output |
|---|---|---|---|
| S1 JD analysis | API (cached by `jd_hash`) or BYOK | Luna | `job_analysis` |
| S2 Resume structuring (once per version) | API (transient) or BYOK | Luna | Canonical resume + claims |
| Match (deterministic) + S3 ambiguous mapping | Extension + API/BYOK | Code + Luna | Per-requirement states → **before score** |
| **Target selection** | Extension (code) | – | Requirements where evidence exists but is **not surfaced** (e.g. a skill only in the skills list, a claim buried in an old role, JD terminology differing from resume wording). Edit budget: summary + ≤ 8 bullets + skills order. |
| S4 Evidence-bound rewrite | Workflow step | Sol / Sonnet 5.5 | Proposed changes with claim IDs |
| Gates G0–G6 | Workflow (code) | – | Pass/fail per change |
| S5 Entailment (G7) | Workflow | Luna | Verdicts |
| S6 Repair (≤ 1) | Workflow | Strong | Fixed or reverted bullets |
| Assemble + change log | Workflow (code) | – | Optimized resume JSON + `changes[]` + `not_addressable[]` |
| **After score** | Extension (code) | – | Same engine, same weights |

### 8.2 Change log (drives the before/after screen)

```jsonc
{
  "before": { "score": 74, "confidence": "High", "range": [71, 77] },
  "after":  { "score": 88, "confidence": "High", "range": [85, 90] },
  "ceiling": 91,                                   // max achievable with current evidence
  "changed": { "summary": true, "bullets": 4, "skills_reordered": true, "sections_reordered": false },
  "added_emphasis": [ { "req_id": "req_7", "term": "Kafka", "claim_ids": ["claim_31"], "where": ["role_2.b_3"] },
                      { "req_id": "req_9", "term": "Kubernetes", "claim_ids": ["claim_40"], "where": ["skills", "role_1.b_2"] } ],
  "could_not_improve": [ { "req_id": "req_4", "term": "AWS", "reason": "no_evidence",
                           "suggestion": "If you have AWS experience, add it via 'Add a fact' (you'll confirm it's true)." } ],
  "reverted": [ { "bullet_id": "role_1.b_5", "reason": "new_metric_not_in_evidence" } ],
  "per_change": [ { "bullet_id": "role_2.b_3", "before": "…", "after": "…", "why": "Surfaces Kafka (required) using your existing pipeline work", "claim_ids": ["claim_31","claim_32"], "validation": "entailed" } ]
}
```

### 8.3 How the score increase is kept legitimate

- **Same engine, same weights, same JD analysis** for before and after. The only input that changes is the resume.
- **Evidence ceiling.** `ceiling = Score(resume where every requirement with any demonstrated or listed evidence is set to its best evidence state)`. The after score can never exceed the ceiling, and the UI shows it ("You can reach up to 91 with your current experience").
- A requirement can move from `none` to anything above zero **only** if a claim existed before optimization, for example a skill that was only listed, now surfaced in a bullet that already described that work.
- Keyword-only gains are capped by the §7.5 saturation rule.
- Requirements with `none` evidence always appear under **"Could not improve"**, with the "Add a fact" (attestation) path.

---

## 9. Resume generation and the ATS-safe template

### 9.1 Template strategy

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Preserve the user's original template | Users keep their design | PDFs can't be edited reliably in place; DOCX run-level edits risk breaking styles, text boxes and tables; many "designed" templates are what hurt parsing in the first place | **Post-MVP, DOCX only**: rewrite text within existing paragraphs (keep `w:rPr` of the first run), no structural changes, text boxes untouched |
| **Standard templates from canonical JSON** | Deterministic, testable, ATS-safe, identical DOCX and PDF | Users lose their custom design | ✅ **MVP** (2 templates: "Classic" and "Modern-minimal", both single column) |
| Both | Best of both | Double the test surface | Target for v1.x |

### 9.2 Libraries

All run **in the extension**, so no server is needed and the resume stays local.

| Output | Library | Why | Notes |
|---|---|---|---|
| DOCX | **`docx` 9.8.x** (MIT) | Programmatic OOXML in browser and Node; real Word paragraphs, styles and hyperlinks | [FACT] v9.8.1, 2026-09-28 (https://registry.npmjs.org/docx) |
| PDF | **`pdfmake` 0.3.x** (MIT) | Declarative layout; embeds TTF fonts; real text | [FACT] 0.3.11, 2026-06-12. [ASSUMPTION] No tagged-PDF output; acceptable because single-column reading order is what parsers need. Verify with a pdf.js round-trip test. |
| PDF (fallback / high-fidelity) | Cloudflare **Browser Run** HTML → Chromium PDF | [FACT] $0.09 per browser-hour (https://developers.cloudflare.com/browser-rendering/pricing/); [ASSUMPTION] Chromium can emit tagged PDF | Only if client rendering fails, and only with consent (the resume goes to the server transiently) |
| Preview | `docx-preview` (Apache-2.0) | Shows the generated DOCX in the panel | – |
| *Rejected:* pdf-lib (unmaintained upstream since 2021 — [FACT] https://registry.npmjs.org/pdf-lib); PyMuPDF (AGPL); LibreOffice DOCX→PDF (needs a container, ≈ $23/month at Scenario B, and fidelity drift); Typst WASM (28 MB compiler — too heavy for the extension) | | | |

### 9.3 Safe default ATS template

This is evidence-based; see [research-report.md](research-report.md) §16. It is **not** a claim of one universal ATS format.

- **Single column**, no tables, no text boxes, no columns, no graphics or icons, no photo.
- **Contact information in the body** (first lines), not the header/footer. [FACT] Greenhouse's unsuccessful-parse article flags headers, footers, tables, text boxes, columned layouts and graphics (https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse; content via search summary — re-read verbatim).
- **Standard headings:** Summary, Experience, Education, Skills, Projects, Certifications.
- **Dates** in "Mon YYYY – Mon YYYY" or "MM/YYYY", on the title line, right-aligned via a tab stop (not a table).
- **Fonts:** embedded common sans or serif (e.g. Inter or Source Sans / Source Serif; OFL-licensed), 10–11 pt body, 14–16 pt name.
- **Hyperlinks** as visible text URLs plus a link annotation (e.g. `linkedin.com/in/…`).
- **Bullets:** the standard "•" glyph via a Word list style (DOCX) or a plain character (PDF).
- **Output checks (automated):**
  - re-extract text with pdf.js/mammoth and assert order and fields;
  - PDF text layer present, fonts embedded;
  - file size ≤ 1 MB;
  - DOCX opens in Word, LibreOffice and Google Docs (golden-file tests);
  - optional offline check with a commercial parser: [FACT] Affinda self-serve $0.10/document (https://www.affinda.com/recruitment-ai-pricing/).
- **File naming:** `FirstName-LastName-Resume-<Company>.docx|pdf`.

---

## 10. Backend services, AI gateway, quotas and budgets

### 10.1 Services (one Worker, modular routes; see [api-design.md](api-design.md))

| Service | Endpoints | State |
|---|---|---|
| Auth | `/v1/auth/*` (Better Auth) | Postgres (users, sessions, accounts) |
| Account & usage | `/v1/me`, `/v1/usage`, `/v1/account/export`, `DELETE /v1/account` | Postgres + UserQuota DO |
| Job analysis | `POST /v1/jobs/analyze` | Postgres `job_analyses` (shared derived cache) |
| Resume structuring | `POST /v1/resumes/structure` | Transient |
| Match mapping | `POST /v1/matches/map` | Transient |
| Optimization | `POST /v1/optimizations`, `GET /v1/optimizations/:id`, `GET /v1/optimizations/:id/events` | Workflow + DO mailbox (≤ 24 h) + Postgres metadata |
| Validation | `POST /v1/validations` (re-validate user-edited bullets with G7) | Transient |
| Sync (opt-in) | `/v1/sync/*` (encrypted blobs) | R2 + Postgres metadata |
| Billing | `/v1/billing/plans`, `/v1/billing/coupons/preview`, `/v1/billing/checkout`, `/v1/webhooks/paddle` | Postgres `subscriptions`, `coupon_redemptions` |
| Config | `GET /v1/config` | KV (published from `config_versions`) |
| **Admin** (separate Worker) | `/admin/v1/*` ([api-design.md](api-design.md) §11) | Postgres (role `admin_rw`), Paddle API, KV, UserQuota DO |
| Feedback | `POST /v1/feedback` | Postgres |

### 10.2 UserQuota Durable Object (exact accounting)

- **Why a DO:**
  - [FACT] The Workers Rate Limiting binding is "permissive, eventually consistent" and "intentionally designed to not be used as an accurate accounting system" (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
  - [FACT] Durable Objects are single-threaded per object with transactional storage, at $0.15 per 1M requests (https://developers.cloudflare.com/durable-objects/platform/pricing/).
- **Operations:**
  - `reserve(kind, units, est_usd)`: checks the month/day counters, the $ budget and the concurrency lock (1 optimization in flight per user). Returns a reservation ID.
  - `settle(reservation_id, actual_usd)`.
  - `release(reservation_id)` on failure: failed jobs don't consume quota unless the provider was billed. Policy: charge quota only on success; always log cost.
- A nightly job reconciles DO counters into the Postgres `usage_ledger` (source of truth for billing disputes).

### 10.3 AI Gateway

- **[RECOMMENDATION]** Route all hosted calls through Cloudflare AI Gateway using **our own provider keys**. Core features are free; Unified Billing adds a 5% fee ([FACT] https://developers.cloudflare.com/ai-gateway/reference/pricing/).
- **Disable storage of request and response bodies**, since they contain resumes. Keep metadata analytics only. [OPEN QUESTION] Confirm the per-gateway logging controls and how logs count against Workers Logs for accounts created after 2026-09-24.
- Exact-match caching is enabled **only** for `jd_extract` requests, keyed by `jd_hash`, which gives a second cache layer after Postgres.

### 10.4 Budget enforcement

These are the [cost-analysis.md](cost-analysis.md) §13 guardrails.

- Plan quotas: Free 3 optimizations and 15 analyses per month. Pro 150 per month, 25 per day, and 500 analyses.
- Per-user AI budget: $8/month on Pro. Global daily circuit breaker.
- Per-request token caps; S4 `max_output_tokens` = 4,000; `reasoning.effort: low`.
- All of these values are **runtime config** (namespaces `plans` and `budgets`), editable from the admin panel within bounds fixed in code (§10.5).

### 10.5 Admin plane and runtime configuration

The owner asked on 2026-09-29 for an admin panel where **everything is configurable and traceable**. The full design is in [admin-panel.md](admin-panel.md). Summary:

- **Admin plane (D-18):** `apps/admin` (static SPA) and a separate `admin-api` Worker, behind Cloudflare Access, with Better Auth admin roles (Owner, Admin, Support, Finance, Analyst). Every write validates, applies and writes an `audit_log` row in one DB transaction. Impersonation is disabled.
- **Runtime config (D-19):** twelve namespaces (`plans`, `ai_routing`, `budgets`, `prompts`, `scoring`, `extraction`, `features`, `kill_switches`, `limits`, `announcements`, `retention`, `coupons_policy`), stored as immutable versions in `config_versions`.
  - Activation publishes to KV for the API and to the signed `/v1/config` for the extension. [FACT] KV propagation can take up to 60 s (https://developers.cloudflare.com/kv/concepts/how-kv-works/).
  - `ai_routing`, `prompts` and `scoring` need a passing eval run, can go out as a canary, and auto-roll back on gate-trip, cost or latency regressions.
- **Invariants (not configurable):** gates G0–G6 can't be turned off; score wording and the disclaimer; the privacy posture; extension code and permissions; infrastructure secrets. Provider API keys *are* managed in the panel, but write-only (D-21).
- **Traceability:** each request resolves a `config_snapshot_id`, stored on `optimizations` and `ai_requests`. With `prompt_version_id`, `model_id` and `request_id`, any past result can be tied to the exact configuration that produced it, without storing content.
- **Coupons (D-20):** our engine enforces per-plan %, duration, total and per-user limits, new-customer rules and a budget cap. It then attaches a non-checkout Paddle discount to a server-created Paddle transaction (sequence in [admin-panel.md](admin-panel.md) §7.4).
- **AI providers and keys (D-21):**
  - The AI router resolves each step to `{model, credential}` from `ai_routing`.
  - Keys are stored as ciphertext in `provider_credentials`. The admin's browser encrypts them with the vault public key; the API Worker holds the private key.
  - Adding a provider type needs code (an adapter); adding a provider **instance** (another OpenAI-compatible base URL), model or key doesn't.
  - Activation is rejected when a production route points at a non-production key, or a resume-carrying step points at a provider whose terms forbid personal data or allow training on inputs.
- **AI usage analytics (D-22):**
  - A Workers Cron Trigger rolls up `ai_requests` every 5 minutes.
  - Dashboards break tokens (input, cached, output, reasoning), cost, latency and quality down by step, user, model, key, plan and version.
  - An hourly rules job raises **optimization insights**, which become draft config changes (eval-gated) with their measured effect recorded afterwards.

---

## 11. Authentication

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **No account** | Zero friction; privacy | Can't meter hosted AI; no abuse control | ✅ for **local and BYOK modes** |
| **Google login** | One click; most job seekers have Google | [FACT] `getAuthToken` works only for Google accounts and ties to the Chrome profile; `launchWebAuthFlow` supports any IdP via a `https://<id>.chromiumapp.org/` redirect (https://developer.chrome.com/docs/extensions/reference/api/identity) | ✅ primary for hosted AI (via Better Auth + `launchWebAuthFlow` + PKCE) |
| Email/password | Universal | Password storage, resets, credential-stuffing surface | ❌ |
| **Magic link / email OTP** | No passwords; works for non-Google users | Email deliverability; copy/paste UX in an extension | ✅ secondary (6-digit OTP is better than a link inside a side panel) |
| Third-party OAuth (GitHub, Microsoft) | Niche | – | Later |

**Implementation (a recommendation, not code):**

- **Better Auth** (MIT) mounted in the Hono Worker, storing to Postgres. [FACT] It supports Hono, magic link, email OTP, JWT and passkeys (https://www.better-auth.com/pricing, https://github.com/better-auth/better-auth). [FACT] Neon also offers "managed Better Auth" up to 60k MAU on the free plan and 1M on Launch (https://neon.com/pricing), as an alternative.
- **Tokens:** a short-lived access JWT (15 min) kept in `chrome.storage.session`, and a refresh token (30 days, rotating, device-bound ID) in `chrome.storage.local` with `setAccessLevel(TRUSTED_CONTEXTS)`. No cookies (extension pages can't rely on first-party cookies to our API).
- **Turnstile** at sign-up. One free account per verified email or Google `sub`.
- **Is auth required for V1?** Only for hosted AI and billing. **The local mode is fully usable without an account**, which is a trust and conversion advantage.

---

## 12. Caching and Redis

| Need (brief §22) | Our solution | Redis needed? |
|---|---|---|
| JD-analysis cache | Postgres `job_analyses` (PK `jd_hash + prompt_version + tier`), plus AI Gateway exact-match cache | No |
| AI response caching (personal) | Not done: unsafe (§12 of [ai-model-comparison.md](ai-model-comparison.md)) | No |
| Burst rate limiting | Workers Rate Limiting binding (per user and IP, 10/60 s windows) | No |
| Exact quotas and budgets | UserQuota DO | No |
| Job queue | Cloudflare Workflows (+ Queues for fan-out) | No |
| Sessions | Stateless JWT + refresh rows in Postgres | No |
| Remote config | KV or static asset, cached at the edge | No |

**Do we need Redis?**

| Users | Load at the owner's heavy rate | Redis? |
|---|---|---|
| 100 | trivial | **No** |
| 1,000 | Scenario B: 10,000 optimizations/day ≈ 0.12/s average, ≈ 1–3/s peak | **No** |
| 10,000 | ≈ 10–30 requests/s peak across all endpoints | **No.** Postgres via Hyperdrive, plus DOs, handles this. |
| 100,000 | ≈ 100–300 requests/s peak | **Maybe.** Add Upstash only if profiling shows hot reads, e.g. entitlement checks, dominating DB load. [FACT] Upstash pay-as-you-go is $0.20 per 100K commands (https://upstash.com/pricing/redis). |

---

## 13. Scalability

| Tier | Architecture delta | Bottlenecks and mitigations |
|---|---|---|
| **100 users** | MVP stack as in §2; Neon Launch with scale-to-zero; one AI provider account at Tier 2+ | Cold start of Neon after 5 min idle → disable scale-to-zero once paying users exist ([FACT] Neon scale-to-zero after 5 min: https://neon.com/pricing) |
| **1,000** (≈ Scenario B at 10/day) | Same; raise OpenAI to Tier 3+, Anthropic to Build+; Neon ~0.5–1 CU always on | **Provider rate limits** (≈ 250 req/min, 1.5M tokens/min at peak — [cost-analysis.md](cost-analysis.md) §6); Anthropic monthly spend caps; DO concurrency (fine: one DO per user) |
| **10,000** | Same; Neon Scale plan or read replica for analytics; move dashboards to a warehouse (optional); second strong-model provider active–active | Provider TPM (need Tier 4–5 for Sol: 4M–40M TPM); p95 latency of the rewrite; support load; eval cost |
| **100,000** | Same code; Neon Scale with pooling; partition `ai_requests` by month; consider Upstash for entitlement caching; negotiate committed-use pricing; regional data residency options (EU) | Provider capacity and cost dominate; payment and fraud ops; Chrome Web Store review cadence |

**Why this scales without a rewrite:**

- Stateless Workers.
- Per-user DOs shard naturally.
- Workflows are durable and horizontally scaled by the platform.
- Postgres is the standard system of record.
- AI routing is abstracted.
- The client does most of the compute (parse, score, generate), so server load grows only with LLM calls.

**Portability hedge:** the API is written against Web-standard `Request/Response` (Hono), so it can move to Node containers (Cloud Run or Fargate) behind the same routes, replacing DO/Workflows with Postgres queues (pg-boss) via adapter interfaces in `packages/platform`.

---

## 14. Reliability and fallbacks

### 14.1 Retry and fallback policy

| Error class ([ai-model-comparison.md](ai-model-comparison.md) §11) | Action |
|---|---|
| Transport error / 5xx / timeout before first byte | Retry the same provider once with jittered backoff (≤ 2 s), then fall back to the next provider in the chain |
| 429 `rate_limit` / `slow_down` | Honour `Retry-After` up to 5 s; otherwise fall back immediately |
| 429 spend cap (`enforced_spend_limit_reached`), 400 usage limit, 402 (Gemini balance) | **Non-retryable.** Fall back + P1 alert |
| Refusal (`stop_reason: refusal`) | No retry on the same prompt; return "couldn't process this content"; log `refusal` |
| Truncated (`max_tokens`) | One retry with a higher cap if within budget; else partial result (sections completed) |
| Schema-invalid JSON | One retry on the same model with the validator's error list; then fall back; then graceful failure |
| Validation failure (G2–G7) | One repair; then revert the bullet (never loop) |

**Budget:** at most 2 LLM attempts per step, at most 1 provider fallback per step, and at most 6 LLM calls per optimization in total (hard stop).

### 14.2 Other resilience

| Failure | Behaviour |
|---|---|
| Side panel closed mid-job | The Workflow continues; the result waits in the DO mailbox for 24 h; the panel shows "Your optimization is ready" on reopen |
| Service worker terminated | Stateless; state lives in IndexedDB and storage; listeners are registered at top level |
| Extension crash / tab crash | Jobs are idempotent (`idempotency_key`); drafts autosave to IndexedDB every step |
| Provider outage | Circuit breaker opens at > 50% errors over 60 s (min 20 calls) → route to the fallback for 2 min, half-open probe |
| Job-portal HTML changes | JSON-LD first; adapters are remote config (hotfix without a store review); the generic extractor and selection/paste always work; extraction-failure telemetry per host (no content) alerts on spikes |
| Workflow step failure | Checkpointed steps: a retry resumes after the last completed LLM step ([FACT] https://developers.cloudflare.com/workflows/reference/pricing/ — idle waits aren't billed) |
| Postgres outage | Local mode unaffected; hosted endpoints return 503 with `Retry-After`; the DO still enforces quotas; the usage ledger reconciles later |

---

## 15. Observability

| Signal | Tool | What |
|---|---|---|
| Errors | **Sentry** (extension pages + Worker) | With `beforeSend` scrubbing: drop request bodies, strip emails and phones by regex, no breadcrumbs with DOM text. [FACT] Team $26/month (https://sentry.io/pricing/) |
| Request logs | **Workers Logs** | Structured JSON: `request_id`, route, status, latency, user hash, plan, extension version; **no content**. [FACT] 20M events/month included (https://developers.cloudflare.com/workers/platform/pricing/) |
| AI accounting | Postgres `ai_requests` → `ai_usage_hourly` / `ai_usage_daily` rollups | task, prompt version, provider, model, **key (credential)**, plan, config snapshot, tokens (in/cached/out/reasoning, estimated flag), cost, latency, attempts, fallback, validation outcome, cache hit; reconciled monthly against provider usage totals |
| Business metrics | SQL views + a lightweight dashboard (e.g. Metabase or Grafana on a read replica) | DAU/MAU, analyses, optimizations, conversions, churn |
| LLM traces | **Langfuse** | Eval and synthetic runs only; production content never sent |
| Uptime | **Better Stack** | API health, auth, provider synthetic probes; status page |
| Extension telemetry (opt-in) | Own endpoint | Extraction success per host (bool + layer), parse quality buckets, UI errors — no content |
| **Admin and config audit** | Postgres `audit_log` (append-only, hash-chained) + `config_snapshots` | Who changed what and why; which config produced each result; who viewed a user's data ([admin-panel.md](admin-panel.md) §8) |
| **Business and AI usage dashboards** | The admin panel (replaces a separate Metabase/Grafana at MVP) | **AI tokens and cost by step, user, model, key, plan and version**; per-optimization waterfall; insights and what-if; growth, revenue, coupons and campaigns, quality, admin security ([admin-panel.md](admin-panel.md) §9) |

**Dashboards and metrics:**

- Requests, latency (p50/p95 per endpoint and per AI step), error rate.
- AI cost per day, per plan and per optimization; tokens by model; model mix; fallback rate.
- JD cache hit rate; optimization success rate; revert rate; hallucination-gate trip rate by gate (G2–G7).
- Score improvement distribution; ceiling-reached rate.
- Extension errors by version; extraction failure rate by host.

**Alerts:**

| Priority | Condition |
|---|---|
| P1 | API 5xx > 2% for 5 min; provider spend-cap errors; global AI spend > 80% of the daily breaker; auth failure spike |
| P2 | p95 optimize > 120 s for 15 min; fallback rate > 20%; extraction failure on a Tier A host > 30%; G2/G3 trip rate doubles (a model drift signal) |
| P3 | Eval nightly regression |

---

## 16. Deployment

| Criterion | Cloudflare Workers | AWS serverless | GCP Cloud Run | Azure Container Apps | Vercel | Render / Railway / Fly |
|---|---|---|---|---|---|---|
| Billing while waiting on the LLM | **Not billed** (CPU time only) [FACT] | Lambda bills GB-s wall-clock [FACT] | Billed per instance, shared across concurrent requests [FACT] | Similar to Cloud Run [FACT] | Active CPU excludes I/O wait; memory-time is billed [FACT] | Always-on instance |
| Long requests | No wall-clock cap while connected; Workflows for durability [FACT] | HTTP API 30 s hard cap; REST streaming up to 15 min [FACT] | Up to 60 min [FACT] | Configurable | 300 s default, 800 s max (Pro) [FACT] | Railway: 15 min if data flows [FACT] |
| Library compatibility | Partial (128 MB isolate; `nodejs_compat`) | Full | Full | Full | Full | Full |
| Ops burden | Low | Medium–high (IAM, VPC, NAT ≈ $33/month idle [FACT]) | Medium | Medium | Low | Low |
| Lock-in | Medium (DO, Workflows) | Medium–high | Low | Low | Medium | Low |
| MVP floor | $5 + DB | ~$15–50 | ~$0–20 | ~$0–20 | $20/seat | $5–25 |

Sources for the [FACT] cells: https://developers.cloudflare.com/workers/platform/limits/, https://aws.amazon.com/lambda/pricing/, https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html, https://cloud.google.com/run/pricing, https://vercel.com/docs/functions/limitations, https://docs.railway.com/networking/public-networking/specs-and-limits (all checked 2026-09-28/29).

**[RECOMMENDATION]**

| Stage | Setup |
|---|---|
| MVP | Cloudflare Workers + Workflows + DOs + Hyperdrive → Neon + R2 + AI Gateway. Landing, account and billing pages as static assets on Workers/Pages. |
| Production | The same, plus a staging environment (separate Cloudflare env, Neon branch, separate provider projects and keys), Sentry Team, Better Stack, and budget alerts at every provider. |
| Scale | The same, plus Neon Scale and read replicas, active–active strong-model providers, and optional Upstash. The container escape hatch (§13) stays available. |

---

## 17. Privacy-first mode

**Goal:** the resume stays on the device, the backend receives nothing personal, and AI providers receive only what they need.

| Capability | Realistic? | How |
|---|---|---|
| Resume stays local | ✅ | Parse, store, score and generate all in the extension. IndexedDB records are encrypted with AES-GCM under a **non-extractable WebCrypto key**, optionally wrapped by a passphrase (PBKDF2/Argon2 → key kept in `storage.session` after unlock). [FACT] Chrome: "extension storage is not encrypted" (https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy). Local encryption protects against disk copies and backups, not against malware running as the user. |
| BYOK | ✅ | Side panel calls providers directly with the user's key (optional host permission per provider). Anthropic needs the `anthropic-dangerous-direct-browser-access: true` header ([FACT-SECONDARY] https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/). |
| Backend receives minimal data | ✅ | In privacy mode: licence check (plan), remote config fetch, and **opt-in** anonymous telemetry. No JD or resume content. |
| AI provider receives only the required data | ✅ partially | **Pseudonymize before sending:** replace name, email, phone, street address and profile URLs with placeholders (`{{NAME}}`); send roles and bullets only; re-insert locally. Employer names and project details are needed for a meaningful rewrite and are sent. [ASSUMPTION] Pseudonymization has negligible quality impact on rewriting; verify in evals. |
| User can delete all data | ✅ | "Delete everything" wipes IndexedDB, storage and keys. If hosted was ever used: `DELETE /v1/account` (see [security-threat-model.md](security-threat-model.md) §4). Provider-side logs follow provider retention: [FACT] OpenAI abuse logs up to 30 days; Anthropic none by default (except flagged); Gemini paid 55 days. |
| Fully offline AI | ⚠️ limited | Chrome built-in AI (Gemini Nano) on capable devices, for classification and extraction only (post-MVP); no offline rewrite at acceptable quality |

The default mode is **hosted, with pseudonymization on and no server-side storage of content**. That is already close to privacy-first. The main difference in privacy mode is who holds the key and whether any of our servers are in the path.

---

## 18. Failure scenarios

**Legend:** **P** = Problem · **D** = Detection · **R** = Recovery · **U** = User message · **L** = Logging (always PII-free)

| # | P | D | R | U | L |
|---|---|---|---|---|---|
| 1 | JD cannot be detected | No JSON-LD, adapter miss, generic score < threshold | Offer "Select the job text" (context menu) or paste | "We couldn't find the job description on this page. Select the text and choose *Analyze selection*, or paste it." | `extract_fail{host, layers_tried}` |
| 2 | Dynamic page not yet rendered | DOM not stable within 4 s | Wait-and-retry once on user click | "The page is still loading — try again in a moment." | `extract_timeout{host}` |
| 3 | JD collapsed behind "Show more" | Truncated heading set; text < 800 chars on a Tier B host | Ask the user to expand, or select | "Expand the full job description on the page, then click Analyze again." | `extract_partial` |
| 4 | Recommendation/similar-jobs text mixed in | Multiple titles; section headings repeat | Keep the block nearest the H1; drop lists of job cards | (silent) + "Edit detected text" link | `extract_noise_removed` |
| 5 | JD inside a cross-origin iframe | Empty main-frame text; iframe src on a known ATS | Offer to open the iframe URL in a new tab | "This job is embedded from another site. Open it in its own tab to analyze." | `extract_iframe{ats}` |
| 6 | JSON-LD and visible text disagree (stale structured data) | Similarity < 0.6 | Prefer visible text; warn | "Detected details may be outdated — please review." | `extract_conflict` |
| 7 | Unsupported page (chrome://, PDF viewer, Web Store) | `executeScript` error | Offer paste | "Chrome doesn't allow extensions on this page. Paste the job description instead." | `inject_denied{scheme}` |
| 8 | Scanned PDF (no text layer) | chars/page < 200 | Ask for DOCX or text PDF; opt-in OCR (post-MVP) | "This PDF looks like an image. Upload the DOCX or a text-based PDF (employers' systems may not read image PDFs either)." | `parse_scanned` |
| 9 | Two-column resume | Gutter detected | Column-aware ordering; user confirms sections | "We detected two columns — please check the order of your sections." | `parse_columns` |
| 10 | Garbled fonts (`cid:`) | > 5% unmapped glyphs | Ask for DOCX / re-export | "Some text in this PDF can't be read. Try exporting it again or upload a DOCX." | `parse_glyphs` |
| 11 | Contact info only in the DOCX header/footer | OOXML pass finds it outside the body | Import it; warn about ATS risk | "Your contact info is in the header — some systems skip headers. Our templates put it in the body." | `parse_header_contact` |
| 12 | Encrypted or password-protected PDF | pdf.js `PasswordException` | Ask the user to remove the password | "This PDF is password-protected." | `parse_encrypted` |
| 13 | Malicious or oversized file (zip bomb, 200-page PDF) | Size > 10 MB, pages > 10, OOXML uncompressed > 50 MB, parse time > 10 s | Reject; terminate the worker | "This file is too large or unusual to process safely." | `parse_rejected{reason}` |
| 14 | Hidden white text in the resume | Colour/size heuristics | Exclude from evidence; warn | "We found hidden text in your resume; it isn't counted and may hurt you with recruiters." | `hidden_text` |
| 15 | Resume in an unsupported language | Language detection ≠ supported | Local mode works; AI features disabled or limited | "AI optimization currently supports English resumes." | `lang_unsupported{lang}` |
| 16 | AI timeout | No first byte in 30 s / step > 120 s | Retry once, then fall back | Progress: "Taking longer than usual…" | `ai_timeout{provider, step}` |
| 17 | Hallucination (new metric or skill) | G2–G6 | Repair once; revert the bullet | Diff marks "kept original — suggested change wasn't supported by your resume" | `gate_trip{gate}` |
| 18 | Entailment check says embellished | G7 | Repair once; revert | Same as above | `gate_trip{G7}` |
| 19 | Provider unavailable | Circuit breaker open | Fallback chain | (transparent) or "Optimization is temporarily unavailable. Your quota wasn't used." | `provider_down` |
| 20 | Malformed / invalid JSON | Schema parse fails | One retry with errors → fallback | (transparent) | `schema_fail{prompt_id}` |
| 21 | Partial output (`max_tokens`) | `stop_reason` | Retry with a higher cap within budget; else keep completed sections | "We optimized part of your resume; try again for the rest." | `truncated` |
| 22 | API rate limit (provider 429) | Error class | `Retry-After` ≤ 5 s → fallback | (transparent) | `rate_limited{provider}` |
| 23 | Provider spend cap hit | 429 spend cap / 400 / 402 | Fallback + P1 alert; pause the free tier if global | "High demand — please try again shortly." | `spend_cap{provider}` |
| 24 | Prompt-injection JD | `injection_suspected`, heuristics, schema | Treat as data; strip; show extracted requirements for user review | "This job posting contains unusual instructions; we ignored them." | `injection_flag{host}` |
| 25 | Malicious resume (prompt injection or trying to get free compute) | Same detectors; quotas | Output constrained by schema; quota consumed | – | `injection_flag{resume}` |
| 26 | User exceeds quota | DO `reserve` denied | Offer upgrade or credit pack; local mode still works | "You've used this month's optimizations. Scores and exports still work." | `quota_denied{plan}` |
| 27 | Duplicate job (same JD twice) | `jd_hash` match in local history | Reuse the analysis; ask to overwrite or keep a version | "You analyzed this job on Sep 20 — reuse or re-run?" | `dup_job` |
| 28 | Duplicate submit (double click) | Idempotency key | Return the existing optimization ID | (none) | `idempotent_hit` |
| 29 | Unsupported portal (Tier B) | Host list | Generic + selection; notice about limitations | "We read only what you asked us to on this page." | `tier_b_use{host}` (count only) |
| 30 | DOCX generation failure | Exception / validation of the output ZIP | Retry with the minimal template; else export TXT | "DOCX export failed; download PDF or TXT instead." | `gen_docx_fail{template}` |
| 31 | PDF generation failure | Exception / text round-trip mismatch | Retry; offer server rendering with consent | "PDF export failed — try again or use DOCX." | `gen_pdf_fail` |
| 32 | Generated file fails the ATS round-trip check | Re-extraction order or fields mismatch | Fall back to the Classic template | (silent) | `roundtrip_fail{template}` |
| 33 | Side panel closed during optimization | SSE disconnect | Workflow continues; mailbox 24 h | "Your optimization finished while you were away." | `sse_disconnect` |
| 34 | Offline / network failure | `fetch` fails | Local mode continues; queue nothing sensitive | "You're offline — local scoring still works." | `offline` |
| 35 | Auth token expired / refresh fails | 401 | Silent refresh → re-login | "Please sign in again." | `auth_refresh_fail` |
| 36 | Extension version too old | 426 from API | Prompt to reload/update | "Update required — click to reload." | `version_block{v}` |
| 37 | Remote config invalid | Bundled JSON Schema validation fails | Keep the last known-good or bundled default | (silent) | `config_invalid` |
| 38 | BYOK key invalid / no credit | 401 / 402 / 429 from the provider | Show the provider's error; don't retry | "Your OpenAI key was rejected (insufficient credit). Check your provider account." | `byok_error{provider, code}` (no key) |
| 39 | Score confidence Low | conf < 0.6 | Show the range and reasons | "Low confidence: the job description is short or some requirements can't be checked." | `low_conf` |
| 40 | Chrome storage quota / eviction | `QuotaExceededError` | Request `navigator.storage.persist()`; prune old artifacts | "Storage is full — remove old versions?" | `storage_quota` |
| 41 | Payment webhook missed | Reconciliation job diff | Paddle API re-sync | – | `billing_drift` |
| 42 | Model drift after a silent provider update | Weekly eval / gate-trip spike | Pin the fallback model; roll back the prompt | – | `drift_alert` |
| 43 | Bad config activated from the admin panel | Canary metrics (gate trips, cost, latency, errors) vs baseline | Auto-rollback to the previous version; alert | (transparent) | `config_rollback{namespace, version}` |
| 44 | Coupon code leaked (redemption spike) | Redemptions/hour > 5× the 7-day average | Auto-pause if enabled; alert the owner | "This code is no longer available." | `coupon_spike{coupon_id}` |
| 45 | Coupon reserved but checkout abandoned | Reservation past 60 min | Sweeper releases the use | – | `coupon_release` |
| 46 | Our redemptions and Paddle `times_used` disagree | Nightly reconcile | Investigate; re-sync from Paddle | – | `coupon_drift` |
| 47 | One of our provider keys is rejected (revoked, expired, out of credit) | 401/403/402 from the provider on a credential | Mark the key unhealthy; use the route's next fallback (another key or model); P1 alert to the Owner | (transparent) or "Optimization is temporarily unavailable. Your quota wasn't used." | `credential_error{credential_id, class}` |
| 48 | Analytics rollup delayed | Rollup watermark > 15 min behind | Dashboards show a "data as of" banner; the job catches up idempotently | (admin only) | `rollup_lag{minutes}` |

---

## 19. Recommended tech stack

| Layer | Choice | Why this technology? |
|---|---|---|
| **Chrome extension framework** | **WXT** (MIT, Vite-based) + TypeScript | [FACT-SECONDARY] Active MV3 framework with side panel support; 0.21.4 released 2026-08-11 (https://wxt.dev/, via a 2026 comparison article). Handles manifest, HMR and multi-entry builds. [OPEN QUESTION] Validate in the PoC against plain Vite. |
| Extension UI | **React 18/19 + Tailwind CSS**; Zustand (state); TanStack Query (API) | Large ecosystem, agent-friendly; small bundle with tree-shaking |
| Local storage | **IndexedDB** via `idb` wrapper + WebCrypto AES-GCM | Large, binary-safe, extension-origin, encryptable |
| Parsing | pdfjs-dist 6.3, mammoth 1.13, JSZip | See §5 |
| Generation | `docx` 9.8, `pdfmake` 0.3, `docx-preview` | See §9 |
| Validation | **Zod** (shared schemas, also emits JSON Schema) | One schema source for API, prompts and UI |
| **Backend** | **TypeScript + Hono on Cloudflare Workers** | CPU-billed (LLM waits are almost free), global, Web-standard APIs → portable |
| Orchestration / queue | **Cloudflare Workflows** (+ Queues) | Durable steps, retries without re-running completed LLM calls ([FACT] pricing page) |
| Quotas / locks / progress | **Durable Objects** | Exact, strongly consistent per-user state |
| **Database** | **PostgreSQL (Neon)** + **Hyperdrive**; **Drizzle ORM** + SQL migrations | Relational + JSONB; branching for CI; portable. [FACT] Neon Launch $0.106/CU-h (https://neon.com/pricing) |
| Cache | Postgres + AI Gateway cache + KV for config; **no Redis** | §12 |
| **AI** | `packages/ai` router over the Vercel AI SDK provider adapters; OpenAI (Luna/Sol) + Anthropic (Sonnet 5.5) + Google (Flash-Lite, paid); Cloudflare AI Gateway | [ai-model-comparison.md](ai-model-comparison.md) |
| File storage | **R2** (opt-in sync only; client-side encrypted) | Zero egress; cheap |
| **Auth** | **Better Auth** (Hono, Postgres) with Google via `launchWebAuthFlow` + email OTP (Resend) | No per-MAU fee; MIT; flexible |
| **Payments** | **Paddle** (MoR); alternative: Stripe Managed Payments (Canada is eligible) | Cheapest all-in merchant of record on international cards; handles global tax for a Canada-based seller ([cost-analysis.md](cost-analysis.md) §11.4) |
| Email | **Resend** | Simple API; free tier then $20/month |
| **Monitoring** | Sentry, Workers Logs, Better Stack, Langfuse (evals) | §15 |
| **Deployment** | Cloudflare (Wrangler), Neon branches per PR | §16 |
| **CI/CD** | GitHub Actions: lint, typecheck, unit, integration (Miniflare/Workers test pool), Playwright E2E with the unpacked extension, promptfoo evals, CodeQL + dependency audit + secret scan; release via the Chrome Web Store API | [implementation-roadmap.md](implementation-roadmap.md) §4 |
| Web (landing / account / billing) | Astro or Next.js static export on Workers static assets | Minimal; SEO for acquisition |
| **Admin panel** | React SPA with **Refine or react-admin** (open-source admin frameworks) on Workers static assets, plus a charting library (e.g. Apache ECharts or Recharts; check licences) for the AI usage dashboards; `admin-api` = Hono Worker; **Cloudflare Access** (free ≤ 50 users) + Better Auth admin plugin; WebCrypto for the browser-side key vault | Fast CRUD without giving a vendor DB access; same stack ([admin-panel.md](admin-panel.md) §3) |
| Monorepo tooling | **pnpm workspaces + Turborepo** | Shared packages between extension and API |

---

## 20. Monorepo folder structure

```text
job-match-optimizer/
├── apps/
│   ├── extension/                 # WXT MV3 extension
│   │   ├── entrypoints/
│   │   │   ├── background.ts      # service worker: router, context menus, commands, injection
│   │   │   ├── sidepanel/         # React app (main UI)
│   │   │   ├── options/           # settings, BYOK, privacy, data export/delete
│   │   │   ├── workspace/         # full-page resume workspace & large diff
│   │   │   └── offscreen/         # pdf.js/docx workers when panel closed
│   │   ├── injected/extractJob.ts # self-contained extraction function (no imports at runtime)
│   │   ├── lib/                   # storage (idb+crypto), messaging (zod), api client, auth
│   │   └── public/                # icons, fonts (OFL), pdf.worker (bundled)
│   ├── api/                       # Hono on Cloudflare Workers
│   │   ├── src/routes/            # auth, me, usage, jobs, resumes, matches, optimizations, validations, sync, billing, config, feedback
│   │   ├── src/workflows/         # OptimizeWorkflow
│   │   ├── src/durable/           # UserQuota DO
│   │   ├── src/middleware/        # authn, rate limit, version gate, request id, error envelope
│   │   └── wrangler.toml
│   ├── web/                       # landing, privacy policy, Limited Use statement, account/billing + checkout page (Paddle.js)
│   ├── admin/                     # admin SPA (Refine/react-admin): users, coupons, plans, config, traces, audit
│   └── admin-api/                 # Hono Worker /admin/v1 behind Cloudflare Access; config publisher; Paddle sync
├── packages/
│   ├── shared/                    # zod schemas (API, messages, canonical resume, job analysis), error codes, constants
│   ├── job-extraction/            # layers L1–L5, adapter config schema, normalizer, jd_hash
│   ├── resume/                    # parsing (pdf layout, docx+ooxml, txt), canonical schema helpers, generation (docx, pdf), templates
│   ├── evidence/                  # claim extraction, evidence index, gates G0–G6, verb ladder, number/entity normalizers
│   ├── scoring/                   # engine, weights (versioned), taxonomy lookups, confidence, ceiling, explanations
│   ├── taxonomy/                  # skills + aliases (data), title families (data)
│   ├── ai/                        # router, providers (openai, anthropic, google, openai-compatible), prompts/<id>/v<N>/, budgets, error classes
│   ├── platform/                  # adapters: quota store, job runner, kv (CF impl + Node impl for portability)
│   ├── config/                    # namespace Zod schemas + hard bounds (code-reviewed), snapshot hashing, compiler/publisher
│   ├── billing/                   # plans, coupon engine (rules, reservations), Paddle adapter (Stripe adapter later)
│   ├── audit/                     # audit writer (same-transaction), hash chain, verifier
│   ├── analytics/                 # ai_requests → hourly/daily rollups, insight rules, what-if re-pricing, provider reconcile
│   ├── vault/                     # browser-side key encryption (admin) + Worker-side decryption; key rotation re-wrap
│   ├── db/                        # drizzle schema, migrations, seed
│   └── ui/                        # shared React components (diff view, evidence popover, score gauge)
├── evals/
│   ├── datasets/                  # golden JDs (with licence/source), synthetic resumes, labels
│   ├── suites/                    # promptfoo configs: smoke, full, adversarial
│   └── scorers/                   # custom metric implementations
├── tests/
│   ├── e2e/                       # Playwright with unpacked extension, fixture job pages (saved HTML)
│   ├── fixtures/                  # resumes (malformed, scanned, 2-col, huge), JD pages (SPA, iframe, malicious)
│   └── load/                      # k6 scripts for API
├── infrastructure/
│   ├── cloudflare/                # wrangler envs, DO/Workflow bindings, WAF rules
│   ├── neon/                      # branch policies, roles
│   └── runbooks/                  # incident, key rotation, deletion, CWS release
├── docs/
│   ├── research/                  # these research documents
│   ├── adr/                       # architecture decision records (one per D-xx)
│   └── api/                       # generated OpenAPI
├── .github/workflows/             # ci.yml, evals.yml, release-extension.yml, deploy-api.yml
├── turbo.json · pnpm-workspace.yaml · package.json
└── CLAUDE.md / AGENTS.md          # coding-agent rules (no-hallucination, security, contracts-first)
```

Improvements over the brief's layout:

- A separate `evidence` package (the core product invariant) and a `taxonomy` package (data).
- A `platform` package holding adapters for portability.
- A top-level `evals/`.
- `db/`, split from the API.
- `docs/adr`.
- An agent rules file.
