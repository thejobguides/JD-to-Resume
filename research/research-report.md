# AI Resume / Job Match Optimizer — Research Report

Last updated: 2026-09-29 · Status: **research and planning only; no code has been written.**

**How to read this report.** This is the master document. Each section below gives the conclusions, key numbers and decisions. The details, calculations and full source lists are in the companion documents:

- [architecture.md](architecture.md): engineering blueprint (extension, extraction, parsing, Evidence Store, scoring, generation, backend, reliability, failure scenarios, stack, folder layout)
- [ai-model-comparison.md](ai-model-comparison.md): providers, model matrix, BYOK/hosted, the ChatGPT-tab question, evals, prompts, router
- [cost-analysis.md](cost-analysis.md): all cost math, scenarios, unit economics
- [security-threat-model.md](security-threat-model.md): privacy, compliance, BYOK keys, prompt injection, threat model
- [competitive-analysis.md](competitive-analysis.md): market, pricing, positioning
- [product-requirements.md](product-requirements.md): PRD, portal support, legal constraints, UX screens, features
- [api-design.md](api-design.md): API contracts
- [database-design.md](database-design.md): schemas, retention, local storage
- [admin-panel.md](admin-panel.md): admin panel, runtime configuration, coupons, traceability *(added 2026-09-29 at the owner's request)*
- [implementation-roadmap.md](implementation-roadmap.md): phases, CI/CD, testing, coding-agent plan and prompts
- [sources.md](sources.md): bibliography, conflicts, stale-risk facts

**Owner decisions recorded on 2026-09-29** (these supersede the earlier assumptions):

| # | Decision | Effect |
|---|---|---|
| OD-1 | "Luna-heavy / Sol-heavy" mean **OpenAI GPT-6 Luna / GPT-6 Sol** | The cost scenarios in §25 stand as calculated |
| OD-2 | The owner/seller is based in **Canada** | Payments: Paddle stays the recommendation, and **Stripe Managed Payments is now a valid alternative** (§30). Privacy: **PIPEDA, Quebec Law 25 and CASL** apply (§18, §20). India DPDP applies only if we target Indian users. |
| OD-3 | **No LinkedIn scraping.** Users provide their LinkedIn profile by **downloading it themselves** ("Save to PDF" or the "Download your data" archive) and uploading it | This matches the MVP design (§13, §20). LinkedIn job posts go in via select/paste (plus click-to-read generic extraction only if counsel approves). |
| OD-4 | An **admin panel** is in scope, and **"everything should be configurable and traceable"** from it | A new admin plane: a separate Worker behind Cloudflare Access; versioned runtime config with rollback; an append-only, hash-chained audit log; per-request config snapshots ([admin-panel.md](admin-panel.md)). **Challenge:** a few invariants stay code-only: truthfulness gates, score wording, privacy posture, extension code and permissions, secrets (§11, §37). |
| OD-5 | **Coupon codes**: usable once, **% off**, **set per plan** (monthly, quarterly, …) | Our own coupon engine: per-plan % and duration, total and per-user limits, new-customer rule, dates, budget cap, bulk codes. It is backed by one non-checkout Paddle discount per plan rule. 100% codes are replaced by complimentary grants (§30). |
| OD-6 | **AI provider API keys** (OpenAI, NVIDIA's free models, …) entered in the admin panel, and **which model + key runs each step** chosen there | A provider registry (incl. OpenAI-compatible hosts), a **write-only key vault** (encrypted in the admin's browser, decryptable only by the API Worker), and model + key per step with fallbacks and canaries ([admin-panel.md](admin-panel.md) §6.5). **Challenge:** [FACT] NVIDIA's free API is trial-only (no production), forbids personal data, and lets NVIDIA use content to improve its models. So NVIDIA keys are for **evals with synthetic data only**, and a rule in code blocks them from production routes (§7). |
| OD-7 | A proper **AI usage dashboard**: tokens at every step, per user, visualized to guide optimization | Dashboards by step, user, model, key, plan and version; per-optimization waterfall; rule-based **insights** ("what to optimize next") with estimated savings; a **what-if** re-pricing simulator; monthly reconcile with provider totals ([admin-panel.md](admin-panel.md) §9) |

**Label legend:**

- **[FACT]** verified against the cited source, with the date checked (2026-09-28 or 2026-09-29).
- **[ASSUMPTION]** believed but not verified.
- **[ESTIMATE]** derived; the calculation is shown or linked.
- **[RECOMMENDATION]** our advice.
- **[OPEN QUESTION]** needs the owner, counsel or data to resolve.

---

## Table of contents

1. [Executive Summary](#1-executive-summary)
2. [Product Definition](#2-product-definition)
3. [Key Assumptions](#3-key-assumptions)
4. [Market / Competitive Research](#4-market--competitive-research)
5. [Chrome Extension Research](#5-chrome-extension-research)
6. [Job Portal Research](#6-job-portal-research)
7. [AI Provider Research](#7-ai-provider-research)
8. [AI Model Comparison](#8-ai-model-comparison)
9. [BYOK vs Hosted AI](#9-byok-vs-hosted-ai)
10. [Architecture Options](#10-architecture-options)
11. [Recommended Architecture](#11-recommended-architecture)
12. [Scoring Engine](#12-scoring-engine)
13. [Resume Parsing](#13-resume-parsing)
14. [Evidence System](#14-evidence-system)
15. [Resume Optimization](#15-resume-optimization)
16. [Resume Generation](#16-resume-generation)
17. [Security](#17-security)
18. [Privacy](#18-privacy)
19. [Prompt Injection Protection](#19-prompt-injection-protection)
20. [Platform / Legal Considerations](#20-platform--legal-considerations)
21. [Database](#21-database)
22. [API Design](#22-api-design)
23. [Caching](#23-caching)
24. [Scalability](#24-scalability)
25. [Cost Model](#25-cost-model)
26. [Monitoring](#26-monitoring)
27. [Testing](#27-testing)
28. [Failure Scenarios](#28-failure-scenarios)
29. [Competitive Differentiation](#29-competitive-differentiation)
30. [Business Model](#30-business-model)
31. [Recommended Tech Stack](#31-recommended-tech-stack)
32. [Folder Structure](#32-folder-structure)
33. [Development Roadmap](#33-development-roadmap)
34. [Coding Agent Strategy](#34-coding-agent-strategy)
35. [Risks](#35-risks)
36. [Open Questions](#36-open-questions)
37. [Final Recommendation](#37-final-recommendation)
- [Final Decision Gate](#final-decision-gate)
- [FINAL RECOMMENDED PLAN](#final-recommended-plan)

---

## 1. Executive Summary

**Verdict: build it, but as a *trust* product, not a "tailoring" product.** The research supports a production-grade Chrome side-panel extension that extracts the job you're viewing, gives an explainable Job Match Score, and proposes resume edits that **only surface evidence the user already has**, with every change validated by code.

**Why not "just another AI tailor":**

- [FACT] Dozens of Chrome Web Store extensions already do JD → score → tailored resume, mostly with under 1,000 users each.
- [FACT] Simplify gives keyword scoring away free (500K users).
- [FACT-SECONDARY] ChatGPT added resume tailoring and download for all tiers in June 2026.
- [FACT] LinkedIn Premium Career ($39.99/month) and Indeed Career Scout bundle AI fit and tailoring.
- **Tailoring is a commodity. Trustworthy tailoring is not.** [FACT] Preprints report 50–97% of outputs containing unsupported claims in weakly guarded LLM hiring pipelines (arXiv 2608.26171), and [FACT] employers are worried about deception (Greenhouse: "32% have claimed AI skills they don't actually have").

**What we'd build (MVP):**

- A side panel. No popup and no injected UI.
- `activeTab`-only permissions, so no scary install warning.
- **Local-first:** resume parsing, scoring and DOCX/PDF generation all happen in the extension, and resume content is **not stored on our servers**.
- A thin Cloudflare Workers backend: auth, quotas, AI orchestration and billing.
- A multi-model AI setup:
  - **GPT-6 Luna** ($0.10/$0.50 per 1M tokens) for extraction and checks;
  - **GPT-6 Sol or Claude Sonnet 5.5** ($2/$10) for the rewrite, decided by a factuality bake-off;
  - **deterministic code** for scoring and hallucination gates.
- An **admin panel** (OD-4 to OD-7) covering support, plans and limits, **coupons per plan**, feature flags and kill switches, a full audit trail, and an **AI usage dashboard** (tokens and cost by step, user, model and key). **API keys and the model per step**, plus prompt and scoring configuration, move into the panel in the first month after launch.

**Key numbers** ([cost-analysis.md](cost-analysis.md)):

- AI cost ≈ **$0.048 per optimization** (range $0.030–$0.108). Infrastructure costs less than $0.001.
- At 1 optimization per user per day: ≈ **$184 / $1,540 / $14,700 per month** for 100 / 1,000 / 10,000 users.
- With a Free / $19 Pro / $45-per-quarter plan and 4% conversion: gross margin ≈ **54% at 1,000 MAU** and **65% at 10,000 MAU** (assumptions stated in §30).

**The owner's assumptions this research challenges:**

1. **Using an open ChatGPT/Claude/Gemini tab is not viable.** It is prohibited by provider terms and by a **July 2026 Chrome Web Store policy**, and it is unreliable.
2. **LinkedIn/Indeed-specific extractors carry real terms-of-service risk.** The MVP supports those sites via user-initiated generic reading plus select/paste, pending counsel review.
3. **Redis isn't needed** below ~100k users.
4. **Infrastructure isn't the cost problem.** Model output tokens, the free tier and payment fees are.
5. **"Luna" and "Sol" are real OpenAI tiers**, and Sol isn't the flagship.
6. **Scenario A (30 optimizations per user per day) needs hard caps.** At about $45 per user per month in AI alone, it is otherwise unaffordable.
7. **"Everything configurable" should stop at the invariants.** Turning off the truthfulness gates, the score wording or the privacy posture from a web form would put the product's core promise one misclick away ([admin-panel.md](admin-panel.md) §2).

8. **Free NVIDIA API keys can't power the product.** Their terms allow trial use only, forbid personal data, and let NVIDIA use submitted content to improve its models. They are useful for **free evals** of open models on synthetic data ([admin-panel.md](admin-panel.md) §6.5.1).

**Timeline** ([ESTIMATE]): about **20 weeks** to public launch for one engineer with coding agents, or about 13 weeks with two. The admin panel, coupons and the AI usage dashboard (OD-4 to OD-7) add about 4 weeks to the earlier 16-week estimate.

---

## 2. Product Definition

- **Problem.** Job seekers need to tailor resumes per job, but manual tailoring is slow. Generic AI tailoring invents facts. And "ATS scores" are opaque and often over-claimed.
- **Product.** A Chrome side panel that:
  1. detects or accepts the JD;
  2. scores the user's resume against it with an explainable, deterministic **Job Match Score** plus confidence;
  3. shows what matches, what is missing or weak, and what is present but **not surfaced**;
  4. optimizes by rewriting only with evidence-backed claims;
  5. validates every change;
  6. shows before, after and the **evidence ceiling**;
  7. exports ATS-safe DOCX and PDF.
- **Never:** invent skills, experience, companies, projects, achievements, metrics, certifications or responsibilities. Never call the score an ATS score.
- **Target users:** active job seekers (primary), early-career and career switchers (secondary, 18+), and privacy-minded power users (BYOK).
- **Single purpose** (for the Chrome Web Store): "Help job seekers tailor their own resume to a job description they are viewing, with an explainable match score and truthful, evidence-based edits."

Details: [product-requirements.md](product-requirements.md) §1–4.

---

## 3. Key Assumptions

| # | Assumption | Label | How to validate |
|---|---|---|---|
| A1 | Users will pay for *truthful* tailoring despite free ChatGPT tailoring | [ASSUMPTION] | Beta conversion; surveys |
| A2 | Most Tier A career pages embed JobPosting JSON-LD or microdata | [ASSUMPTION] backed by samples ([FACT] Lever, Ashby, Workday-open, iCIMS-iframe, SmartRecruiters microdata; Greenhouse none) | Extraction telemetry |
| A3 | Typical paid usage ≈ 30 optimizations/month; typical token counts as in [cost-analysis.md](cost-analysis.md) §3 | [ASSUMPTION] | PoC measurements |
| A4 | Users accept standard ATS-safe templates for the MVP | [ASSUMPTION] | Template requests |
| A5 | The owner is **Canada-based** and selling globally in English | **Confirmed by the owner (OD-2)** | – |
| A6 | Free→paid conversion ≈ 4% (range 2–6%) | [ASSUMPTION] | Beta |
| A7 | Users are 18+ | [ASSUMPTION] and policy (Gemini terms require 18+) | Age gate |
| A8 | "Luna-heavy/Sol-heavy" refer to OpenAI GPT-6 Luna/Sol | **Confirmed by the owner (OD-1)** | – |

---

## 4. Market / Competitive Research

The market clusters into:

- JD-match scanners (Jobscan, Resume Worded, Jobalytics);
- AI builders (Teal, Rezi, Enhancv, Kickresume, BOLD brands);
- autofill copilots (Simplify 500K, Jobright 300K, Teal 200K, Careerflow 200K, Huntr 90K);
- auto-apply bots (LazyApply);
- platform-native and general LLMs (ChatGPT, LinkedIn Premium, Indeed);
- a long tail of tiny tailoring extensions.

| Product | Core | Extension users (CWS) | Price (list) |
|---|---|---:|---|
| Jobscan | Match rate + ATS tips | 10K | $49.95/mo; $89.95/qtr (SECONDARY) |
| Teal | Workspace + tracker | 200K (stale since 2025-06) | $29/mo; $13/wk (SECONDARY) |
| Simplify | Autofill + tracker (+ AI) | 500K | Free; $39.99/mo; $89.99/3 mo |
| Huntr | Tracker + AI | 90K | $40/mo; $90/qtr |
| Careerflow | LinkedIn optimizer + tracker | 200K | $23.99/mo … $172.99/yr |
| Rezi | AI builder | 2K | $29/mo; $149 lifetime |
| Jobright | Matching + auto-apply | 300K | ~$39.99/mo (SECONDARY) |
| LinkedIn Premium Career | Platform AI | native | $39.99/mo |

**Findings:**

- The monthly price median is ≈ $40, and the quarterly norm is ≈ $90 per 3 months.
- The strongest review complaints are **billing traps** (trial → recurring; 28-day billing), then AI quality.
- No mainstream product offers per-claim evidence, a transparent score formula, local-first privacy or BYOK.
- [FACT] Kickresume found only **3.5%** of its AI users used tailoring, while 64% used "checking". The score is the hook; tailoring is the upsell.

Details: [competitive-analysis.md](competitive-analysis.md).

---

## 5. Chrome Extension Research

All [FACT]s below are from developer.chrome.com, checked 2026-09-29.

- **The MV3 service worker is ephemeral.** It is terminated after 30 s idle, after 5 minutes on one event, or if a `fetch()` response takes more than 30 s. Long AI work must not run in it.
- **The side panel** (Chrome 114+) is a full extension page with all APIs. It persists across tabs and opens on action click via `setPanelBehavior`. `sidePanel.open()` needs a user gesture.
- **The popup closes on blur** and is capped at 800×600, so it is unsuitable for a 30–60 s flow.
- **Storage:** `storage.session` lives in memory and isn't exposed to content scripts. `local` and `sync` are exposed until `setAccessLevel(TRUSTED_CONTEXTS)` is called. "Extension storage is not encrypted". DevTools can view storage from Chrome 132.
- **Permissions:** `activeTab`, `scripting`, `sidePanel`, `storage`, `contextMenus`, `offscreen` and `identity` show **no install warning**. Host permissions do.
- **No remotely hosted code.** Remote *config* is allowed if the execution paths are predetermined. Calling remote services with data is allowed.
- **The minimum CSP** is `script-src 'self' 'wasm-unsafe-eval'`.
- **Structured-clone messaging** is opt-in from Chrome 148, which lets `File`/`Blob` objects cross contexts.
- **CWS policy:**
  - In-UI disclosure and consent is required even for local-only data.
  - Limited Use was tightened in July 2026 to "strictly necessary".
  - **A new policy bans extensions that circumvent AI services' protections** (announced July 1, 2026; enforced from August 1, 2026).
  - The registration fee is $5; review takes "a few days … up to a few weeks".
- **Chrome built-in AI** (Gemini Nano Prompt API) is available to extensions from Chrome 138. It needs ≥ 22 GB free disk and more than 4 GB VRAM or 16 GB RAM, so it is optional only.

**UX recommendation:** a **Side panel** for the core flow, plus a **full-page workspace** for heavy editing. No popup and no injected UI in the MVP. Details: [architecture.md](architecture.md) §3.

---

## 6. Job Portal Research

| Platform | Method | Reliability | Terms | MVP tier |
|---|---|---|---|---|
| Greenhouse | DOM (server-rendered) + public unauthenticated Job Board API | High | Public API; third-party terms unclear | A |
| Lever | JSON-LD + public Postings API ("may be scraped by third parties") | High | Permissive | A |
| Ashby | JSON-LD + public API (CORS `*`) | High | Public API | A |
| SmartRecruiters | Microdata + public Posting API | High | Public API | A |
| Workday | JSON-LD when the posting is open (SPA) | Medium–high | No public API; don't use internal endpoints | A |
| iCIMS | JSON-LD inside an iframe | Medium | Unreviewed | A |
| Career pages (generic) | JSON-LD → generic → selection | Medium | Varies | A |
| LinkedIn | Generic on click / select-paste | Medium | [FACT] UA §8.2 bans "browser plugins and add-ons ... to scrape or copy"; its help page bans extensions that "scrape, modify the appearance of, or automate" | **B** (counsel) |
| Indeed | Same | Medium | [FACT] "crawl, scrape, extract data from, reproduce, duplicate, copy ... any part of the Site" is prohibited | **B** |
| Glassdoor / ZipRecruiter / Wellfound | Same | Medium | Anti-scraping (ZipRecruiter: "automated, manual, or other non-automated means") | **B** |
| Naukri | Paste only | – | [FACT] Bans even manual extraction without written authorization | **B (paste)** |

- **A generic extractor works** when layered: JSON-LD/microdata → site adapter → readability heuristic → user selection/paste → LLM structuring with verbatim-quote validation.
- **DOM alone is not sufficient** because of SPAs, iframes, collapsed text, "similar jobs" noise and hidden text.

Details: [product-requirements.md](product-requirements.md) §5–6; [architecture.md](architecture.md) §4.

---

## 7. AI Provider Research

| Provider | Relevant models (per 1M tokens, in/out) | Strengths | Cautions |
|---|---|---|---|
| **OpenAI** | gpt-6-luna $0.10/$0.50; gpt-6-sol $2/$10; gpt-6-astra $10/$50 | Strict Structured Outputs; cheap Luna; Batch/Flex 50% off | Floating (dateless) model IDs; 30-day abuse logs; `store:false` needed; fine-tuning closed to new users |
| **Anthropic** | claude-sonnet-5-5 $2/$10 (released 2026-09-28); opus-5-5 $4/$20; haiku-4-5 $1/$5 (retiring ≥ 2026-10-15) | Pinned snapshots; **no content retention by default** (except the Fable/Mythos models); GA JSON outputs | ~30% more tokens per text; spend caps pause usage until next month |
| **Google Gemini** | 3.1-flash-lite $0.25/$1.50; 3.8-flash $0.75/$3.75 → **$1.50/$7.50 from 2027-01-01** | Cheap; long context | Free tier forbids personal data and allows human review; 18+ and "not for consumer use" clauses; unpublished rate limits; no GA 3.x Pro |
| **OpenRouter** | Pass-through prices; 5.5% credit fee | Many models, easy fallback | Extra processor for personal data; variable structured-output enforcement; first-party endpoints non-ZDR |
| **NVIDIA API Catalog** (build.nvidia.com; OD-6) | Free trial keys for many open models; ~40 requests/min [SECONDARY] | $0 for experiments; OpenAI-compatible [ASSUMPTION] | [FACT] Trial terms: "without use ... in production"; no personal data; content used "to improve NVIDIA products and services, including AI models". Production needs NVIDIA AI Enterprise (from $4,500/GPU/year). **Evals with synthetic data only.** |
| **Local / open-weight** | Workers AI Llama 8B $0.045/$0.384; Chrome Gemini Nano (free, on-device) | Privacy, $0 marginal cost | No cost advantage over Luna; weaker quality; hardware limits |

All [FACT]s are sourced in [ai-model-comparison.md](ai-model-comparison.md) §2–3 and [sources.md](sources.md) §1.

---

## 8. AI Model Comparison

The multi-model design:

- **Deterministic code** handles scoring, keyword matching, and number/entity/skill diffs.
- **The cheap model (Luna)** handles JD and resume structuring, ambiguous matching and entailment checks.
- **The strong model (Sol or Sonnet 5.5)** does only the evidence-bound rewrite and repair.

| Task | Primary | Fallback | Cost per call | Recommendation |
|---|---|---|---:|---|
| JD parsing | JSON-LD mapping + gpt-6-luna | gemini-3.1-flash-lite (paid) | $0.00067 | Primary Luna |
| Resume parsing | Layout code + Luna with span citations | Haiku 4.5 → 5.5 | $0.0013 per version | Primary Luna |
| Skill extraction | Taxonomy/alias code | Luna (recall) | $0 | Code first |
| Requirement classification | Luna (inside JD parsing) | – | included | Luna |
| Semantic matching | Embeddings + Luna for ambiguous pairs | – | $0.0007 | Luna |
| Resume optimization | **gpt-6-sol** (start) | **claude-sonnet-5-5** | $0.045 (Sol) / ≈ $0.059 (Sonnet) | Bake-off decides |
| Bullet rewriting | Same as optimization | – | – | – |
| Hallucination detection | **Code gates G0–G6** + Luna entailment | Cross-vendor sampling offline | $0.0008 | Code first |
| Final quality review | Rubric code + Luna flags | – | ~$0.001 | No extra strong pass |

Details: [ai-model-comparison.md](ai-model-comparison.md) §7.

---

## 9. BYOK vs Hosted AI

**Decision:** how to pay for and route AI.

- **Options considered:** (A) BYOK; (B) hosted; (C) hybrid.
- **Pros:**
  - A: our AI cost is $0, maximum privacy, attractive to power users.
  - B: frictionless, monetizable, quality-controlled.
  - C: combines both, plus a no-AI local mode.
- **Cons:**
  - A: poor mainstream UX (developer account, billing, key); Gemini's terms clash with consumer use; support burden.
  - B: we carry AI cost and abuse risk.
  - C: three code paths.
- **Cost** ([cost-analysis.md](cost-analysis.md) §8.4): BYOK ≈ $30–150/month infra only at 100–10k users. Hosted ≈ $0.048 per optimization.
- **Risk:**
  - A: key theft on a compromised profile.
  - B: denial-of-wallet.
  - C: complexity.
- **Recommendation: C, Hybrid.** Free local deterministic mode, plus hosted AI (Free quota and Pro), plus a BYOK annual plan.
- **Reason:** local mode builds trust and acquisition at ~$0 cost; hosted is the revenue path; BYOK serves privacy users. One shared `packages/ai` pipeline with pluggable transports keeps the complexity manageable.

### The "already-open ChatGPT / Claude / Gemini tab" question

| Question | Answer |
|---|---|
| Technically possible? | Yes, with host permissions (UI automation or cookie-bearing requests) |
| Officially supported? | **No.** [FACT] OpenAI Terms prohibit "Automatically or programmatically extract data or Output". Anthropic prohibits non-API automated access and says "developers may not collect, store, or intermediate Claude.ai credentials or session tokens". Google prohibits automated access against machine-readable instructions and bypassing protections. |
| Reliable? | **No.** [UNOFFICIAL] ChatGPT's Sentinel/Turnstile "blocked conversation tools since 2026-09-08" |
| Security concerns? | Access to the user's AI accounts and chat history; a job page → AI tab injection path; account bans |
| Platform/terms concerns? | Provider terms, plus the **CWS July 2026 policy against circumventing AI services' protections**, which puts the **whole listing** at risk |
| Appropriate for production? | **No. Don't build it.** |

Official APIs, UI automation, private endpoints, extension messaging and session reuse are distinguished in [ai-model-comparison.md](ai-model-comparison.md) §6.1.

**Legitimate alternatives:**

- BYOK;
- hosted AI;
- Chrome built-in AI;
- a user-driven "Copy prompt → paste answer → we validate" fallback;
- an MCP app or connector as a future distribution channel.

---

## 10. Architecture Options

**Decision:** overall system shape.

| Option | Pros | Cons | Cost (Scenario B infra) | Risk |
|---|---|---|---|---|
| **O1. Local-first extension + thin serverless AI backend (Cloudflare Workers + Neon)** | Privacy by design; CPU-billed LLM waits; no resume storage; scales with no servers | Workers runtime limits (128 MB); Cloudflare-specific pieces (Durable Objects, Workflows) | ≈ $105–205/month ([FACT]-based estimate) | Medium lock-in (hedged via a platform adapter) |
| O2. Server-centric (resumes stored and processed server-side; AWS Lambda + RDS) | Familiar; central history | Stores personal data (breach and compliance surface); Lambda bills LLM wait (≈ $143/month at Scenario B); API Gateway HTTP 30 s cap; NAT costs | ≈ $220–280/month | Higher privacy risk |
| O3. Single Node container + managed Postgres (Railway/Render/Fly) | Simplest ops; any library | Single region; you handle HA and scaling | ≈ $20–85/month | Scaling work later |
| O4. Extension-only, BYOK-only (no backend) | $0 infra; maximum privacy | No monetization of hosted AI; no quotas; mainstream UX poor | ~$0 | Commercial viability |

- **Recommendation: O1**, with O3 as the documented escape hatch (the same Hono code runs on Node).
- **Reason:** it best matches truthfulness, privacy and cost, and needs no rewrite to scale.

Details: [architecture.md](architecture.md) §1, §16.

---

## 11. Recommended Architecture

```text
Chrome (trusted: extension origin)                                   Cloudflare edge
┌───────────────────────────────────────────────┐   HTTPS+JWT   ┌──────────────────────────────────────────────┐
│ Side Panel (React): onboarding, resume mgr,   │──────────────►│ API Worker (Hono): auth(Better Auth), usage,  │
│ job analysis, score, optimize, diff, export   │               │ jobs/analyze (jd_hash cache), resumes/struct, │
│ packages: job-extraction, resume(parse+gen),  │◄──── SSE ─────│ matches/map, optimizations, billing, config   │
│ evidence(gates), scoring, ai(BYOK direct)     │               │ OptimizeWorkflow (durable steps)              │
│ IndexedDB (AES-GCM) · storage.session secrets │               │ UserQuota Durable Object (exact quotas, $cap) │
│ SW: router, context menu, executeScript       │               │ AI Router → AI Gateway → OpenAI/Anthropic/Goo │
│ Injected extractJob (isolated world, 1-shot)  │               │ Hyperdrive → Neon Postgres (metadata only)    │
└───────────────────────────────────────────────┘               │ R2 (opt-in encrypted sync)                    │
      │ BYOK privacy mode: side panel → provider directly       └──────────────────────────────────────────────┘
      ▼                                                          Paddle · Resend · Sentry · Better Stack · Langfuse(evals)
 [Job page (untrusted)]
```

| Component | Role |
|---|---|
| Injected `extractJob` | One-shot, user-initiated read of the active tab (JSON-LD → adapter → generic); strips hidden text; returns ≤ 200 KB |
| Service worker | Thin router: context menus, commands, injection, message validation |
| Side panel | All UI plus local parse, score and generate; BYOK direct calls |
| IndexedDB | Encrypted local system of record for resumes, evidence, jobs and outputs |
| API Worker | Stateless: auth, quotas, AI orchestration, billing, remote config |
| OptimizeWorkflow | Checkpointed rewrite → gates → entailment → repair → result mailbox (≤ 24 h) |
| UserQuota DO | Exact counters, per-user AI $ budget, concurrency lock, progress stream |
| AI Router + AI Gateway | Model selection, budgets, retries/fallbacks, cost logging; gateway caching and analytics (body logging off) |
| Neon Postgres | Accounts, subscriptions, usage, `ai_requests` metadata, shared derived JD cache; **no resume content** |
| R2 | Opt-in client-side-encrypted sync only |
| Paddle / Resend / Sentry / Better Stack / Langfuse | Payments (merchant of record) / email / errors (scrubbed) / uptime / eval tracing (synthetic data only) |
| **Admin plane** (OD-4 to OD-7) | `apps/admin` SPA + a separate `admin-api` Worker behind Cloudflare Access; roles; audit log in the same transaction as every write; versioned config published to KV and the signed extension config; coupon engine + Paddle discount sync; **provider registry + write-only key vault + model/key per step**; **AI usage analytics** ([admin-panel.md](admin-panel.md)) |

**Admin and configuration decision** (D-18 to D-20 in [architecture.md](architecture.md) §1):

- **Options:** a custom SPA + separate Worker; a low-code tool on the database; admin routes in the public API; vendor dashboards only.
- **Recommendation:** the custom SPA + separate Worker.
- **Reason:** "configurable and traceable" needs one validated, audited choke point. A low-code tool writing straight to the database would bypass the rules, the Paddle sync and the audit log, and would hand DB credentials to another vendor.
- **Cost:** ≈ $0–5/month and about 4 engineer-weeks before launch (admin MVP, coupons, AI usage dashboard), plus 2.5 weeks for Admin v1 after launch.
- **Risk:** admin account takeover, mitigated by Access + MFA, roles, step-up and audited reads ([security-threat-model.md](security-threat-model.md) #22–30).

Full sequence and component detail: [architecture.md](architecture.md) §2 and §10.5.

---

## 12. Scoring Engine

The engine is deterministic and explainable, and **no LLM produces the score**.

| Element | Design |
|---|---|
| Requirement states | strong 1.0 · partial 0.6 (related evidence or skills-list only) · weak 0.3 · none 0 · **unknown** (excluded from the denominator; lowers confidence) |
| Categories (weights) | Required 30 · Experience 15 · Responsibilities 15 · Preferred 10 · Title 8 · Keywords 7 · Education 5 · Certifications 5 · Structure 5. Location and work authorization are **eligibility flags**, not weighted. "Semantic relevance" feeds the states rather than being a separate category (avoids double counting). |
| Formula | `C_k = Σ w_r m_r / Σ w_r` (known requirements only); `Base = 100·Σ W_k C_k / Σ W_k` over categories present; `Score = round(Base · max(0.60, 1 − 0.07·n_hard_missing))` |
| Keywords | Top-K ≤ 25 salient JD terms; demonstrated = 1, skills-only = 0.5; saturates at 80% coverage; hidden text ignored |
| Confidence | `0.35·q_jd + 0.25·q_resume + 0.25·(1−unknown_share) + 0.15·deterministic_share`: High ≥ 0.8, Medium 0.6–0.79, Low < 0.6; a range from partial-credit sensitivity |
| Weights | **Fixed per scoring version** (published). Job-specific only via the JD's own signals (required vs preferred, emphasis). User-configurable views later; learned weights in the future (needs consented outcome data). |
| Anti-gaming | Code computes the score on our parse; keyword saturation; partial credit for skills-list-only; the optimizer can't add claims; after-score ≤ **evidence ceiling** |

Worked example ([architecture.md](architecture.md) §7.8): Base 74.2 × gate 0.93 → **69/100, Confidence High (0.90)**.

---

## 13. Resume Parsing

| Input | Approach (in the extension) | Key facts |
|---|---|---|
| PDF | pdfjs-dist 6.3 (Apache-2.0) in a worker with `isEvalSupported:false`, plus a deterministic layout pass (lines, **column/gutter detection**, headings, bullets, dates, quality gate, hidden-text detection) | [FACT] PDFs store only characters and positions, so reading order must be reconstructed. CVE-2024-4367 was fixed in 4.2.67. |
| DOCX | mammoth 1.13 plus a custom OOXML pass for **headers/footers**, hyperlinks and text boxes | [FACT] mammoth doesn't extract headers/footers and "performs no sanitisation" |
| TXT / paste | Direct | Universal fallback |
| Scanned PDF | Detect → ask for DOCX or a text PDF; opt-in cloud OCR after the MVP (~$1.50 per 1,000 pages) | [FACT] tesseract.js doesn't read PDFs and loads WASM from CDNs by default, so it would have to be bundled (~30 MB) |
| LinkedIn | User's own "Save to PDF" or data-export ZIP (**no URL fetch**) | [FACT] LinkedIn offers both to members |

- **No AGPL libraries** (PyMuPDF, scribe.js). Recruiter-side commercial parsers (Affinda at $0.10/document) are used only as an **offline check** of our generated files.
- The LLM (Luna) maps lines to the **canonical schema**, and **every value cites span IDs**. Code rejects values not found in their cited spans.
- The schema is a superset of JSON Resume, adding IDs, provenance, date precision, evidence level and parse quality. The full schema is in [architecture.md](architecture.md) §5.4.

---

## 14. Evidence System

```text
JD requirement "Kafka" (req_7, must, verbatim quote)
   → evidence claim_31 {tool: Kafka, span s_v3_1_12 "Built Kafka-based pipeline processing 2M events/day"}
   → allowed rewrite: "Built a Kafka-based streaming pipeline processing 2M events/day" (claims 31, 32)
   → forbidden: "Led Kafka migration saving 40%" (new ownership + new metric) → rejected → repaired or reverted
```

**Stores:**

- `SourceSpan` (line, page, bbox, hidden flag).
- `Claim` (skill, tool, metric, employer, title, date range, responsibility, achievement, certification, education, project, scope), each with `span_ids`.
- `UserAttestation`: user-added true facts, recorded explicitly.
- `EvidenceIndex`.

**Enforcement:**

| Gate | What it checks |
|---|---|
| G0 | Schema validity and `stop_reason` |
| G1 | Referential integrity: IDs exist and stay within the same role |
| G2 | **Number diff** |
| G3 | **Entity diff** (organizations, titles, degrees, certifications, tools) |
| G4 | Skill gate |
| G5 | **Verb/scope ladder** (e.g. no "assisted → led") |
| G6 | Temporal anachronism |
| G7 | LLM **entailment** per changed bullet (Luna) |

After the gates:

- One **repair** attempt, then **revert to the original** bullet.
- Contradiction checks (e.g. "10 years" vs dates).
- **User review** with evidence popovers.

Why this is designed in layers: [FACT] layered defences in a 2026 preprint cut hallucinations from 2.48–5.36 to 0.04–0.24 per resume (arXiv 2607.01457), while prompt-only guardrails left fabrication in 50% of outputs (arXiv 2608.26171).

Details: [architecture.md](architecture.md) §6.

---

## 15. Resume Optimization

**Pipeline:**

1. JD analysis (cached).
2. Deterministic match plus ambiguous mapping → **before** score.
3. **Target selection**: requirements where evidence exists but isn't surfaced. The edit budget is the summary, up to 8 bullets and the skills order.
4. Rewrite with the strong model.
5. Gates G0–G6.
6. Entailment (G7).
7. Repair (at most one), or revert.
8. Assemble the change log.
9. **After** score from the same engine and weights.

**How the gain stays legitimate:**

- Same engine and same JD analysis for before and after.
- After ≤ the **evidence ceiling**, which is shown to the user.
- A requirement moves from `none` to above zero only if prior evidence existed.
- Keyword gains saturate.
- Unfixable requirements are listed under **"Could not improve (no evidence)"** with an "Add a fact" path.

Example output:

```text
Before 69 → After 84 · Ceiling 91
Changed: Summary · 4 bullets · Skills order
Added emphasis: Kafka · Kubernetes · Airflow
Could not improve: AWS certification — no evidence found  [Add a fact]
Kept original (1): suggestion wasn't supported by your resume
```

Details: [architecture.md](architecture.md) §8; [product-requirements.md](product-requirements.md) §8.9, §9.

---

## 16. Resume Generation

| Question | Answer |
|---|---|
| Preserve the original template, use standard templates, or both? | **MVP: two standard single-column ATS-safe templates** generated from canonical JSON. Original-DOCX preservation (text edits in place, styles kept) comes in v1.x. Editing original PDFs in place is not reliable. |
| DOCX library | **`docx` 9.8** (MIT), in the extension |
| PDF library | **`pdfmake` 0.3** (MIT), in the extension; round-trip checked with pdf.js |
| HTML → PDF | Cloudflare Browser Run ($0.09 per browser-hour) as a fallback, with consent |
| DOCX → PDF | LibreOffice needs a container (≈ $23/month at Scenario B) and drifts in fidelity; not in the MVP |
| Rejected | pdf-lib (unmaintained upstream since 2021), PyMuPDF (AGPL), Typst WASM (28 MB) |

**Safe default template** (evidence-based; there is no universal ATS format):

- Single column; no tables, text boxes, graphics, icons or photo.
- Contact details in the body, not the header or footer.
- Standard headings; consistent "Mon YYYY" dates; embedded standard fonts at 10–11 pt.
- Visible URLs.
- A real text layer.

Evidence: [FACT-SECONDARY] Greenhouse's unsuccessful-parse article flags headers, footers, tables, text boxes, columns and graphics.

**Verification:** pdf.js and mammoth round-trip; opens in Word, Google Docs and LibreOffice; optional offline Affinda parse. Details: [architecture.md](architecture.md) §9.

---

## 17. Security

- **Extension:**
  - Minimal permissions (no host permissions at install).
  - Strict CSP; no remote code or `eval`.
  - One-shot isolated-world injection; Zod-validated messages.
  - `storage.local` locked to trusted contexts; secrets in `storage.session`.
  - React/DOMPurify rendering; explicit `externally_connectable`; no web-accessible resources.
- **Files:** patched pdf.js with eval disabled; workers with timeouts; size, page and zip-bomb limits; no external relationships; reject `.docm`.
- **API:**
  - Short-lived JWT plus rotating refresh tokens with reuse detection.
  - Bearer auth, so no CSRF surface; CORS allowlist.
  - **No server-side URL fetching (so no SSRF)**.
  - Secrets in Cloudflare, per environment; signed remote config.
  - Postgres row-level security as defence in depth; PII-free logs.
- **Supply chain and publishing:**
  - Lockfile, OSV and CodeQL scans.
  - Hardware 2-step verification on the Chrome Web Store account.
  - CI publishing with approval and deferred publish.
  - [FACT] Cyberhaven (Dec 2024): a phished OAuth consent led to a malicious update; 35+ extensions and 2.6M users were affected in the campaign.

The threat model covers 30 threats, including all 15 from the brief and 9 for the admin panel, coupons and provider keys (#22–30), with likelihood, impact, mitigation and residual risk. See [security-threat-model.md](security-threat-model.md) §11.

---

## 18. Privacy

| Question | Answer |
|---|---|
| What do we store? | Account, subscription, usage ledger, `ai_requests` metadata (90 days), optimization metadata and scores (12 months), a shared derived JD cache (30 days), feedback |
| What do we NOT store? | Resume files, resume text or JSON, evidence, generated resumes (unless the user opts into encrypted history), JD text tied to users, prompts or completions, BYOK keys |
| Retention | As above. Deletion within ≤ 24 h, backups within ≤ 7 days (Neon restore window) |
| Encrypt resumes? | Yes: AES-GCM locally with a non-extractable WebCrypto key (optional passphrase); sync and history client-side encrypted; per-job encryption for transient workflow state |
| Do AI providers get raw resumes? | **No.** They get parsed, **pseudonymized** text (placeholders for name, email, phone, address and URLs), only the sections in scope, under business API terms (no training), with `store:false`. Never free tiers or Fable models. Request ZDR when eligible. |
| Can users delete everything? | Yes: one-click local wipe; account deletion cascade; export available |
| Regulations | **Canada (the owner's jurisdiction): PIPEDA applies** — consent, safeguards, access rights, breach reporting at "real risk of significant harm", breach records. Its replacement, Bill C-36, was tabled in June 2026 but is not law ([FACT-SECONDARY]). **Quebec Law 25:** a PIA before sending Quebec users' data outside Quebec (our processors are US-hosted), plus a designated person in charge. **CASL** for marketing email. Also: GDPR/UK GDPR practices from day one (DPAs, rights, DPIA advisable). India DPDP applies only if we target Indian users (Rules notified Nov 2025; full compliance by 2027-05-13/14, [FACT]). CCPA thresholds ($26.625M revenue or 100k consumers) are likely not met at launch; rights are honoured anyway. CWS Limited Use and in-UI consent. |
| Data residency | No guarantees in the MVP (disclosed). Canadian law doesn't require in-Canada hosting for private-sector data, but Quebec's transfer PIA is required. [FACT] OpenAI offers a Canada residency region (storage only, not processing). EU and Canada options later if B2B demand appears. |

Details: [security-threat-model.md](security-threat-model.md) §3–4; [database-design.md](database-design.md) §7.

---

## 19. Prompt Injection Protection

The JD, resume and LinkedIn content are **untrusted data**. Defence in depth:

1. **Architecture.** The LLM has no tools, browsing, secrets or authority. Code computes the score, and outputs are validated against evidence, so an injection can't add claims or change the score formula.
2. **Extraction hygiene.** Remove hidden and zero-size text, zero-width and bidi characters, comments and scripts.
3. **Framing.** Random-boundary delimiters plus **datamarking** (spotlighting). [FACT] This reduces static attacks to ~1% attack success, but adaptive attacks exceed 95%, so it is only one layer.
4. **Strict schemas.** Requirement quotes must be verbatim substrings; claim IDs must exist.
5. **Detection.** Heuristics plus an `injection_suspected` flag.
6. **Rendering.** Output is shown as text only.
7. **Human review** of requirements and diffs.
8. **Monitoring.** An adversarial CI suite that must have 0 successes.

[FACT] OWASP LLM 2025: LLM01 Prompt Injection is ranked first; LLM07 says "System prompts are not security controls". Our prompts contain no secrets.

Details: [security-threat-model.md](security-threat-model.md) §7.

---

## 20. Platform / Legal Considerations

These are issues for counsel, not legal advice.

- **LinkedIn / Indeed / Glassdoor / ZipRecruiter / Wellfound / Naukri terms** prohibit scraping or copying, sometimes including manual copying for unauthorized purposes. User-initiated reading of the active page is **untested** territory.
  - **MVP stance:** Tier B uses generic extraction on click, or select/paste. No site-specific code; no injected UI; no automation; no server-side fetching. Naukri is paste-only.
  - Case context ([FACT-SECONDARY]): hiQ v. LinkedIn (2022 CFAA ruling, then a consent judgment against hiQ for breach of contract); Meta v. Bright Data (2024); LinkedIn v. Proxycurl (2025).
- **ATS vendors** (Greenhouse, Lever, Ashby, SmartRecruiters) publish public job APIs, a lower-risk profile, but the terms for third-party consumption are unclear.
- **Trademarks:** no third-party names or logos in our name or listing; nominative text plus a non-affiliation disclaimer ([FACT] LinkedIn brand policy; CWS impersonation policy).
- **AI provider terms:** official APIs only. Gemini's 18+ and "not for consumer use" clauses affect BYOK.
- **Chrome Web Store:** single purpose, Limited Use, consent, the AI-guardrail circumvention ban, keyword spam, "claimed functionalities that are not possible" (so no "real ATS score" claims).
- **Other:** copyright and database rights in the shared JD-analysis cache; EU AI Act classification; DPDP/GDPR specifics; tax setup for a Canada-based seller (GST/HST/QST; merchant-of-record payouts — ask a CPA); PIPEDA / Quebec Law 25 / CASL specifics; consumer-protection substantiation of score claims.

The full list is in [security-threat-model.md](security-threat-model.md) §14.

---

## 21. Database

**Decision:** PostgreSQL (Neon via Hyperdrive), MongoDB, or SQLite/local-only?

- **Options:**
  - Postgres: relational integrity, JSONB, portable, [FACT] Neon Launch at $0.106/CU-hour with no minimum.
  - MongoDB: documents, [FACT] Atlas Flex $8–30.
  - D1/SQLite: [FACT] 10 GB per-database cap and single-threaded.
- **Recommendation: Postgres (Neon).** The local mode keeps personal content in IndexedDB.
- **Reason:** money, quotas and joins favour relational; it is portable; branch-per-PR helps CI.
- **Risk:** serverless connection handling, mitigated by Hyperdrive.

**Tables:**

- `users`, `auth_*`
- `plans`, `subscriptions`, `subscription_events`, `credit_grants`
- `usage_ledger`, `ai_usage_daily`
- `resumes` and `resume_versions` (metadata only)
- `job_analyses` (shared derived cache), `jobs`, `match_results` (numbers only)
- `optimizations` (metadata; encrypted output only if the user opts in)
- `ai_providers`, `ai_models` (a price book with source URLs)
- `prompt_versions`
- `ai_requests` (metadata, partitioned monthly, 90-day retention)
- `feedback`, `sync_blobs`, `deletion_requests`, `audit_log`, `eval_runs`
- `provider_keys` (future only)

Estimated size is ≈ 1.4 GB at 1k users and ≈ 14 GB at 10k. Full DDL, ER diagram, row-level security, encryption and retention: [database-design.md](database-design.md).

---

## 22. API Design

**Endpoints** (`/v1`):

- `auth/*` (Google via `launchWebAuthFlow` + PKCE; email OTP)
- `me`, `usage`, `config` (signed remote config)
- `jobs/analyze` (JD cache)
- `resumes/structure` (transient)
- `matches/map` (ambiguous mapping only; **scoring runs locally**)
- `optimizations` (async, with `Idempotency-Key`) plus `/{id}` and `/{id}/events` (SSE)
- `validations`
- `resumes` (metadata)
- `sync/*` (ciphertext)
- `feedback`
- `account/*` (export, delete, sessions)
- `billing/*`
- `webhooks/paddle`

**Conventions:** an error envelope with codes (e.g. `quota_exceeded`, `ai_unavailable`, `extension_outdated` 426); burst rate limits plus exact plan quotas; charged only on success; no bodies in logs.

It also defines the extension's internal message contracts and the BYOK direct-call contract (including the Anthropic browser header). Mapping from the brief's endpoint names: [api-design.md](api-design.md) §1.

---

## 23. Caching

| Cache | Mechanism | Value |
|---|---|---|
| **JD analysis ("500 users, same JD")** | Normalize the JD → SHA-256 → Postgres `job_analyses` (unique by hash + prompt version + tier) + AI Gateway exact-match cache | One LLM call per unique JD. **Consistency** (every user sees the same requirements) and **latency** (~50 ms vs ~4 s). Saves < 1% of cost on Luna, ~7% on Sol-heavy. |
| Prompt caching | Static prefix first; OpenAI/Anthropic 0.1× reads | ≈ −8% cost |
| Resume structuring | Once per resume version (local) | Avoids repeat parsing |
| Semantic caching of rewrites | **Not used**: outputs are personal | – |
| Remote config | Edge-cached, signed | Hotfix extractors without a store review |
| Redis | **Not needed** below ~100k users | [architecture.md](architecture.md) §12 |

---

## 24. Scalability

| Users | Architecture | Bottlenecks |
|---|---|---|
| 100 | MVP stack; Neon scale-to-zero (disable once paying) | Cold starts |
| 1,000 (≈ Scenario B at 10 per day: 10,000/day) | Same; OpenAI Tier 3+, Anthropic Build+ | **Provider rate limits** (≈ 250 req/min, 1.5M tokens/min peak) and Anthropic spend caps |
| 10,000 | Same; Neon Scale or a read replica; two strong providers active–active | Provider tokens/min; p95 rewrite latency; support |
| 100,000 | Same code; partitions and roll-ups; optional Upstash; committed-use pricing; EU option | Provider capacity and cost; fraud and ops |

- **Scenario A** (60 × 30/day = 54,000/month) is a quota and cost stress, not an infrastructure one.
- **Scenario B** (1,000 × 10/day = 300,000/month) is ~0.12 optimizations/s on average and ~1–3/s at peak. Postgres, Durable Objects and Workers handle this trivially.
- **Why no rewrite is needed:** stateless Workers, per-user DOs, durable Workflows, Postgres, client-side compute, and a platform adapter with a Node fallback.

Details: [architecture.md](architecture.md) §13; [cost-analysis.md](cost-analysis.md) §6.

---

## 25. Cost Model

**Per optimization (AI)** ([ESTIMATE], token math in [cost-analysis.md](cost-analysis.md) §3–5):

| Routing | Cost |
|---|---|
| **Hybrid $0.048** | Conservative $0.030 · Worst $0.108 |
| Luna-heavy | $0.0092 |
| Sol-heavy | $0.092 |
| BYOK | $0 to us |

Analysis only: $0.0014. Infrastructure: < $0.001.

**Master table (Hybrid; "job" = one optimization):**

| Users | Jobs/User/Day | Jobs/Month | AI Cost | Infra Cost | Total |
|---:|---:|---:|---:|---:|---:|
| 100 | 1 | 3,000 | $144 | $40 | **$184** |
| 1,000 | 1 | 30,000 | $1,440 | $100 | **$1,540** |
| 10,000 | 1 | 300,000 | $14,400 | $300 | **$14,700** |
| 1,000 | 10 | 300,000 | $14,400 | $300 | **$14,700** |

The same at 1 job/user/day under other routings:

| Users | Luna-heavy | Sol-heavy | BYOK (us) |
|---:|---:|---:|---:|
| 100 | $68 | $316 | $30 |
| 1,000 | $376 | $2,860 | $60 |
| 10,000 | $3,060 | $27,900 | $150 |

**Owner scenarios:** A ≈ **$2,680/month** (~$44.70 per user); B ≈ **$14,700/month**.

**Infra line items at 1,000 users:** Workers $5–6, Neon ~$20, Sentry $26, Resend $20, Langfuse $29, domain ~$1, Chrome Web Store $5 one-time. Payment processing is ~7.6% on a $19 plan (Paddle).

**Sensitivity:**

| Change | Effect |
|---|---|
| Rewrite reasoning 1k → 3k tokens | +42% |
| Claude Sonnet 5.5 instead of Sol | +27% (tokenizer) |
| Gemini Flash at 2027 prices | +67% |
| Prompt caching | −8% |

---

## 26. Monitoring

| What | How |
|---|---|
| Errors | Sentry (extension + Worker) with PII scrubbing |
| Request logs | Workers Logs, structured and content-free |
| AI cost, tokens, models, fallback rate, cache hit | `ai_requests` → 5-minute rollups → the **admin AI usage dashboard** (OD-7): tokens by type and cost by step, user, model, key, plan and version; per-optimization waterfall; insights and what-if ([admin-panel.md](admin-panel.md) §9) |
| Quality | Gate-trip rates (G2–G7), revert rate, "not true" reports, score-gain distribution, ceiling-reached rate |
| Extension health | Opt-in telemetry: extraction success per host and layer, parse-quality buckets, UI errors |
| Uptime | Better Stack probes + status page |
| LLM traces | Langfuse for evals and synthetic data only |

**Alerts:**

- **P1:** 5xx above 2%, provider spend cap, global AI spend above 80% of the daily breaker.
- **P2:** p95 optimize above 120 s, fallback rate above 20%, Tier A extraction failure above 30%, gate-trip spike (drift).
- **P3:** nightly eval regression.

Details: [architecture.md](architecture.md) §15.

---

## 27. Testing

| Layer | Tools | Highlights |
|---|---|---|
| Unit and property tests | Vitest, fast-check | Score within [0,100]; adding evidence never lowers the score; gates never pass a new number |
| Contract tests | Zod + recorded provider fixtures | Success, refusal, truncation, 429, 5xx and spend-cap handling per provider |
| API integration | Workers test pool + Neon branch per PR | Exact quota accounting under 100 concurrent reservations; idempotency; complete deletion |
| E2E | Playwright with the unpacked extension | User stories US-1…US-13 (plus US-14…US-16 for the admin panel); in BYOK mode, zero requests reach our API |
| AI evals | promptfoo + custom scorers | Golden set of ≥ 120 JDs, 24 resumes and 300 pairs. **Hard gates:** span fidelity 1.0; hallucination ≤ 0.5% of changed bullets; 0 successful injections. CI blocks on failure. |
| Generation | pdf.js/mammoth round-trip; LibreOffice render | Field order preserved; fonts embedded; Unicode handled |
| Security | CodeQL, OSV, gitleaks, custom XSS, file and spoofing tests | – |
| Performance | k6 at 3× Scenario B peak; panel performance traces | – |

Fixture lists:

- **24 unusual JD pages:** SPA, iframe, collapsed text, noise, malicious hidden text, zero-width characters, 60k characters, stale JSON-LD.
- **24 malformed resumes:** two-column, header contact, scanned, `cid:` glyphs, encrypted, zip-bomb, `.docm`, PDF JavaScript, hidden white text, 200 pages, 0 bytes.

See [implementation-roadmap.md](implementation-roadmap.md) §5.

---

## 28. Failure Scenarios

There are **48 scenarios**, each with Problem / Detection / Recovery / User message / Logging, in [architecture.md](architecture.md) §18. Summary:

| Group | Scenarios |
|---|---|
| Extraction (1–7) | No JD detected; SPA not rendered; collapsed JD; noise mixed in; cross-origin iframe; JSON-LD vs visible-text conflict; restricted page |
| Parsing (8–15) | Scanned PDF; two columns; garbled glyphs; header contact; encrypted; malicious or oversized file; hidden text; unsupported language |
| AI (16–25) | Timeout; hallucination (gates); embellishment; provider down; malformed JSON; truncation; 429; spend cap; malicious JD; malicious resume |
| Product and ops (26–48) | Quota exceeded; duplicate job; double submit; Tier B portal; DOCX failure; PDF failure; round-trip failure; panel closed mid-job; offline; auth expiry; outdated extension; invalid remote config; BYOK key errors; low confidence; storage quota; missed billing webhook; model drift; bad admin config (auto-rollback); coupon leak; abandoned coupon reservation; coupon drift vs Paddle; one of our provider keys rejected; analytics rollup delayed |

**Principles:**

- No endless retries: at most 2 attempts and 1 fallback per step, and at most 6 LLM calls per optimization.
- Quota is **charged only on success**.
- Local features keep working when hosted AI fails.
- Every failure is logged without content.

---

## 29. Competitive Differentiation

1. **Truth as the product.** Per-claim evidence, validation gates, a "could not improve" list, and an "Add a fact" attestation path. None of the mainstream competitors checked offers this.
2. **An honest, explainable score.** Published weights, confidence and range, the evidence ceiling, and never called an "ATS score". This contrasts with [FACT] Jobscan's "ranking weights" and Jobright's "passes ATS" claims.
3. **Privacy by architecture.** Local-first, no stored resume content, BYOK. This contrasts with [FACT] Simplify's and Jobright's store disclosures, which include PII and "website content".
4. **In-context on any site.** A side panel beside the JD, plus universal select/paste.
5. **Honest billing.** No weekly traps and no silent trial conversion. This addresses [FACT] billing complaints at Zety, Resume.io and Teal.

**What not to copy:** autofill or auto-apply (Simplify owns it, and it carries terms-of-service risk), proprietary score names, trademarked names, and unverifiable claims.

Details: [competitive-analysis.md](competitive-analysis.md) §8–9.

---

## 30. Business Model

**Decision: pricing and packaging.**

- **Options:** free, freemium, subscription, BYOK, pay-per-use, lifetime, weekly.
- **Recommendation: Hybrid freemium.**

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | Unlimited local scoring and export; 15 AI analyses and 3 AI optimizations per month |
| **Pro** | **$19/month** or **$45/quarter** (the default) | 150 optimizations/month, 25/day, $8 AI budget |
| Credit pack | $12 for 25 | No subscription |
| BYOK | $39/year | Unlimited with the user's own key |

- **Reason:** below the market median ($40/month), sustainable with caps, honest.
- **Risk:** the free-tier AI cost and a conversion rate that is still an assumption.

**Model** ([ESTIMATE]; assumptions: 4% conversion, $16 blended ARPU, paid users 30 optimizations/month, free users at 50% of quota, Paddle 5% + $0.50):

| MAU | Paying | Revenue | AI | Infra | Fees | Gross margin |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 4 | $64 | $14 | $40 | $5 | ≈ 8% |
| 1,000 | 40 | $640 | $141 | $100 | $52 | ≈ 54% |
| 10,000 | 400 | $6,400 | $1,405 | $300 | $520 | ≈ 65% |

At 10,000 MAU the margin is ≈ 37% at 2% conversion and ≈ 75% at 6%. These figures exclude labour, marketing, legal and support.

**Payments** (Canada-based seller, OD-2): **Paddle** as merchant of record (5% + $0.50, ≈ $1.45 on a $19 charge). Alternative: **Stripe Managed Payments**, where Stripe is the merchant of record. [FACT] Canada is an eligible business location, and it adds 3.5% on top of Stripe CA's standard 2.9% + CA$0.30 (+0.8% on international cards), ≈ $1.72 on a US$19 charge. Stripe Billing + Tax (not a merchant of record, ≈ $1.15) comes later, once a CPA manages the GST/HST/QST and foreign VAT registrations. See [cost-analysis.md](cost-analysis.md) §11.4.

**Coupons (OD-5)** ([admin-panel.md](admin-panel.md) §7; [cost-analysis.md](cost-analysis.md) §11.5):

- **What a coupon can set:**
  - the **% off per plan** (e.g. 20% on monthly, 30% on quarterly);
  - a **duration**: first payment, N billing periods, or forever;
  - **total uses** (1 = a single-use code) and **uses per user** (default 1);
  - new-customers-only, valid dates, and a discount budget;
  - single, shared or bulk codes.
- **Why our own engine:** [FACT] Paddle's discount usage limit is "a total limit for the discount, rather than a per-customer limit", and a discount has one amount. So our engine checks the rules, then applies a non-checkout Paddle discount (one per plan rule) by ID to a Paddle transaction created on our server.
- **Economics [ESTIMATE]:** 30% off stays clearly profitable: $24.87 contribution per quarter at typical use. 50% off the quarterly plan can lose $2.83 on a capped heavy user, so deep discounts carry a lower AI budget. Shared codes are capped at 50%, and free access uses complimentary grants rather than 100% codes.

Details: [cost-analysis.md](cost-analysis.md) §11; [competitive-analysis.md](competitive-analysis.md) §7.

---

## 31. Recommended Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Extension | **WXT + TypeScript + React + Tailwind**; Zustand; TanStack Query | MV3 side-panel support, Vite build speed, ecosystem and agent familiarity |
| Local data | IndexedDB (`idb`) + WebCrypto AES-GCM | Large, binary-safe, encrypted, extension-origin |
| Parsing | pdfjs-dist 6.3, mammoth 1.13, JSZip | Permissive licences; run in the browser; provenance-friendly |
| Generation | `docx` 9.8, `pdfmake` 0.3, `docx-preview` | Client-side, MIT/Apache, deterministic |
| Contracts | **Zod** (→ JSON Schema, OpenAPI) | One schema source for API, prompts and UI |
| Backend | **Hono on Cloudflare Workers** | CPU-billed, so LLM waits are nearly free; Web-standard; portable |
| Orchestration | **Cloudflare Workflows** + Queues | Durable steps; no re-running completed LLM calls |
| Quotas / progress | **Durable Objects** | Exact, consistent per-user state |
| Database | **PostgreSQL (Neon) + Hyperdrive + Drizzle** | Relational, JSONB, branching, portable |
| Cache / queue | Postgres + AI Gateway + KV; **no Redis** | Load doesn't justify Redis |
| AI | `packages/ai` router over the Vercel AI SDK adapters; OpenAI Luna/Sol + Anthropic Sonnet 5.5 + Gemini Flash-Lite (paid); Cloudflare AI Gateway | Multi-model, fallbacks, cost control |
| File storage | R2 (opt-in, ciphertext) | Zero egress |
| Auth | **Better Auth** (Google via `launchWebAuthFlow` + email OTP via Resend) | No per-user fee; flexible |
| Payments | **Paddle** (alternative: Stripe Managed Payments) | Merchant of record for a Canada-based seller; handles global sales tax |
| Monitoring | Sentry, Workers Logs, Better Stack, Langfuse (evals) | Cheap; no PII in third-party logs |
| Deployment | Cloudflare (Wrangler) + Neon | Same at every stage |
| CI/CD | GitHub Actions: lint, typecheck, unit, integration, Playwright E2E, promptfoo evals, CodeQL/OSV/gitleaks, manifest and bundle policy checks, CWS API draft upload | Covers the risks that matter |
| Monorepo | pnpm + Turborepo | Shared packages between extension and API |
| Admin panel | React SPA (Refine or react-admin) + a Hono `admin-api` Worker; Cloudflare Access (free ≤ 50 users) + Better Auth admin plugin | Same stack; one audited choke point; no vendor DB access |

Details: [architecture.md](architecture.md) §19.

---

## 32. Folder Structure

```text
job-match-optimizer/
├── apps/{extension (WXT: background, sidepanel, options, workspace, offscreen, injected/extractJob), api (Hono: routes, workflows, durable, middleware), web, admin (SPA), admin-api (Hono Worker)}
├── packages/{shared (zod contracts), job-extraction, resume (parse+generate), evidence (claims+gates), scoring, taxonomy, ai (router, providers, prompts), platform (adapters), config (namespaces+bounds), billing (plans+coupons+Paddle), audit (hash-chained log), db (drizzle), ui}
├── evals/{datasets, suites, scorers}
├── tests/{e2e, fixtures, load}
├── infrastructure/{cloudflare, neon, runbooks}
├── docs/{research, adr, api}
├── .github/workflows/
└── CLAUDE.md / AGENTS.md
```

Compared with the brief's layout, this adds dedicated `evidence`, `taxonomy`, `platform` and `db` packages, a top-level `evals/`, ADRs and an agent-rules file.

The full annotated tree is in [architecture.md](architecture.md) §20.

---

## 33. Development Roadmap

| Phase | Duration (1 engineer + agents) | Key deliverables | Exit criteria |
|---|---|---|---|
| 0: Research & decisions | 1 week (remaining) | ADRs; counsel engaged; provider accounts; dataset v0 | Open questions answered |
| 1: Proof of concept | 3 weeks | Platform tests (activeTab, CORS, download, messaging); extraction on 30 fixtures; parsing; scoring v0; **model bake-off**; DOCX/PDF round-trip | Measured token counts; strong-model choice; ≤ 2% post-gate fabrication |
| 2: MVP | 11 weeks | Contracts; evidence gates; AI router; API/auth/quota/workflow; billing; all 13 screens; evals in CI; privacy features; **Admin MVP (2 wk) + coupons (1 wk) + AI usage dashboard (1 wk)** | All MVP user stories (US-1…US-16, US-18 dashboard parts) and eval thresholds met; coupon tests pass in the Paddle sandbox |
| 3: Hardening | ≈ 3.25 weeks | Security review (30 threats, including admin); observability; load and chaos tests; closed beta (50–100 users) + recruiter panel | ≥ 70% "helped me tailor"; ≤ 0.5% "not true" |
| 4: Launch | 2 weeks | CWS submission (review days to weeks), production cut-over, content | No open P1 incidents |
| 5: Scale | Ongoing | **Admin v1** in the first month (2.5 wk): provider registry + key vault + **model/key per step**; prompt, scoring and extractor config with eval gates and canaries; traces explorer; insights and what-if. Then: auto-detect on Tier A; BYOK Gemini; cover letters; template preservation; languages; MCP app | Driven by metrics |

That is **about 20 weeks to launch**, or about 13 weeks with two engineers. It was 16 weeks before OD-4 to OD-7. Building Admin v1 before launch too would make it about 22.5 weeks. The critical path runs through the bake-off → evidence gates → API → extension UI → security review → beta → CWS review.

Details: [implementation-roadmap.md](implementation-roadmap.md) §2–3.

---

## 34. Coding Agent Strategy

**Is the proposed 6-agent split (extension, backend, AI, parsing, testing, infra) optimal? Not as stated.**

- Starting all six in parallel without frozen contracts causes schema drift.
- A separate "testing" agent produces tests that mirror the implementation.
- Infrastructure is too small to be its own lane.
- The core invariants (evidence gates and scoring) need their own owners.

**Recommended approach:**

1. **Step 0 (one agent, sequential, human-reviewed):** scaffold plus the **frozen Zod contracts** and the agent rules file.
2. **Parallel lanes** in separate git worktrees, each owning its directories:
   - A: job extraction
   - B: resume parse and generate
   - C: scoring and taxonomy
   - D1: evidence gates
   - D2: AI router and evals
   - E: API, database and infra
3. **Lane F: extension UI**, once the package APIs are stable. **Lane G: admin + coupons** (apps/admin, apps/admin-api, packages/config, billing and audit), once Lane E has the schema, auth and webhooks. This is the natural lane for a second engineer.
4. **An adversarial verifier agent** that writes only tests and findings.
5. **Integrator:** a human plus one agent.

**Rules:** never add unevidenced content; contracts are read-only; no AGPL, remote code or eval; no content in logs; small PRs with acceptance tests.

Ready-to-paste prompts for each phase and lane (P0 scaffold, P1.1 platform tests, P1.5 bake-off, Lanes A–F, verifier, security review, load/chaos testing, CWS listing and compliance) are in [implementation-roadmap.md](implementation-roadmap.md) §7.

---

## 35. Risks

| # | Risk | Type | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| R1 | Residual AI fabrication reaches users | Technical | Medium | High | Evidence gates, entailment, revert-on-fail, user review, adversarial evals, weekly drift runs |
| R2 | JD extraction brittleness (SPAs, iframes, site changes) | Technical | High | Medium | JSON-LD first; remote config adapters; generic + selection/paste; per-host telemetry |
| R3 | Provider changes (floating GPT-6 IDs, price moves, Haiku retirement, rate/spend caps) | Technical | High | Medium | Router + fallbacks; price book; tier raises; evals |
| R4 | PDF/DOCX parsing quality on designed resumes | Technical | Medium | Medium | Column detection; user review; ask for DOCX; round-trip-tested templates |
| R5 | Chrome Web Store rejection or takedown (permissions, data disclosure, portal complaints) | Platform | Medium | High | Minimal permissions; consent UI; consistent disclosures; Tier B restraint; no trademarks |
| R6 | Job portals (LinkedIn/Indeed) act against the extension or its users | Legal/Business | Medium | High | Counsel review; no LinkedIn-specific code, UI injection or automation; select/paste |
| R7 | Commoditization: ChatGPT, LinkedIn and Indeed bundle tailoring for free | Business | High | High | Trust positioning; in-context UX on any site; privacy; document quality; low COGS |
| R8 | Low willingness to pay or conversion (Kickresume: tailoring used by only 3.5% of its AI users) | Business | Medium | High | The free score as the hook; credit packs; beta pricing tests |
| R9 | Distribution: pure tailoring extensions don't scale organically on the CWS | Business | High | Medium | Content/SEO on honest ATS education; communities; partnerships; MCP app channel |
| R10 | Privacy incident or compliance gap (DPDP May 2027, GDPR) | Legal | Low | High | No content stored; encryption; DPAs; deletion tooling; DPIA |
| R11 | Developer-account takeover or supply-chain compromise | Security | Low–Medium | High | Hardware keys; OAuth-consent hygiene; CI publishing with approval; minimal dependencies |
| R12 | Denial-of-wallet or quota abuse | Cost | Medium | Medium | Exact quotas, $ budgets, circuit breakers, Turnstile |
| R13 | Admin account takeover or a bad config change (e.g. a model or budget change that raises fabrications or cost) | Security / Operational | Low–Medium | High | Access + MFA, roles, step-up; bounds in code; invariants not configurable; eval gate; canary + auto-rollback; audit log with a hash chain |
| R14 | Coupon leakage or deep discounts erode margin | Business | Medium | Medium | Per-user limits, new-customer rule, end dates, discount budgets, ≤ 50% on shared codes, spike alerts; track full-price renewal per campaign |
| R15 | Free or trial AI keys (e.g. NVIDIA) end up serving real users' resumes, breaching provider terms and our privacy policy | Legal / Compliance | Medium | High | Key scope + provider data-policy flags + a rule in code that rejects such routes; synthetic-only evals for those providers; audited, alerted flag changes |
| R16 | Our provider keys are stolen and abused (denial of wallet) | Security | Low | High | Write-only vault (browser-side encryption; only the API Worker decrypts); provider spend caps; per-key soft budgets; spike alerts |

---

## 36. Open Questions

1. ~~Luna/Sol meaning~~. **Resolved (OD-1):** GPT-6 Luna/Sol.
2. ~~Owner location~~. **Resolved (OD-2):** Canada. Still open: the legal entity type (incorporated or sole proprietor), the GST/HST/QST approach, and Paddle vs Stripe Managed Payments.
3. **LinkedIn/Indeed job pages after counsel review:** is click-to-read generic extraction acceptable, or paste-only? LinkedIn *profile* import is **resolved (OD-3)**: user-downloaded PDF or export only.
4. **Strong-model default:** Sol vs Sonnet 5.5, via the Phase 1 bake-off.
5. **Real token counts, latency and costs** from the proof of concept.
6. Does `openPanelOnActionClick` grant `activeTab`? Is CORS to our API OK without a host permission? Is a Blob download OK without the `downloads` permission? (Phase 1 tests.)
7. Should JD-analysis cache hits count toward the Free quota?
8. Age gate: 18+ globally?
9. Copyright and database-rights implications of the shared derived JD cache.
10. How strong is demand for preserving the user's original template?
11. Conversion rate and customer-acquisition cost; beta needed.
12. Whether to pursue OpenAI ZDR / Modified Abuse Monitoring at launch.
13. **Paddle sandbox checks for coupons:** do recurring discounts on 3-month prices last N periods including the first? What happens to a discount on a plan switch? Is a discount that expires mid-checkout still honoured? Is tax computed after the discount? How are $0 checkouts handled? ([admin-panel.md](admin-panel.md) §12.)
14. **Counsel (coupons and prices):** Competition Act "regular price" claims, CASL consent for emailing codes, and notice before moving existing subscribers to a new price.
15. How many admins at launch? This decides whether the second-approver rule is on.
16. **NVIDIA (OD-6):** does the hosted catalog return token `usage` and support JSON-Schema output for the models we'd test? Is there a pay-per-token NVIDIA option with production terms and a DPA? Only relevant if an open model wins our evals.
17. The per-optimization **cost target** for dashboard insights (default $0.06) and the **reference model** for the "shadow cost" of free models.

---

## 37. Final Recommendation

**Build it, as an evidence-grounded, privacy-first side-panel product with an honest score.**

- Start with a **three-week PoC** that retires the four biggest unknowns:
  1. platform behaviours (activeTab, CORS, downloads);
  2. extraction on Tier A pages;
  3. parsing designed resumes;
  4. **post-gate fabrication rate by model**.
- Only then commit to the 11-week MVP (7 weeks of product + 4 weeks of admin panel, coupons and the AI usage dashboard).
- Use free NVIDIA keys only to evaluate open models on synthetic data. Production traffic goes to providers whose terms allow it.
- Make operations configurable and traceable from the admin panel, but keep the truthfulness gates, the score wording and the privacy posture in code.
- Don't compete on autofill or auto-apply. Don't automate AI chat tabs. Don't ship LinkedIn-specific code before counsel review.
- Price below the market with hard caps, and make truthfulness visible in every screen.

---

# Final Decision Gate

**1. Should I build this product?**
**Yes, conditionally.** Build it as a *trust-first* product (evidence-grounded, honest score, privacy by design), not as a generic AI tailor, which is already commoditized and increasingly free. Proceed past Phase 1 only if the bake-off shows post-gate fabrication ≤ 2%, with a clear path to ≤ 0.5%, and Tier A extraction ≥ 90%.

**2. What should the MVP contain?**

- Side-panel extension with `activeTab`-only permissions.
- JD detection on Tier A sites (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, iCIMS, JSON-LD career pages), plus a generic extractor and **select/paste anywhere**.
- Resume upload and parse (PDF/DOCX/TXT, plus the LinkedIn PDF or export), with a review step.
- A deterministic, explainable **Job Match Score** with confidence and a breakdown.
- A missing / weak / not-surfaced analysis.
- **Evidence-bound optimization** with gates G0–G7, a diff, accept/reject/edit, and an "Add a fact" path.
- Before/after with the ceiling and a "could not improve" list.
- DOCX and PDF export in two ATS-safe templates.
- A local mode with no account.
- Hosted AI with quotas; Google/OTP sign-in; Paddle billing.
- Consent, export and delete; evals in CI.

**3. What should NOT be in the MVP?**

- Autofill or auto-apply.
- ChatGPT/Claude/Gemini tab automation.
- LinkedIn/Indeed-specific extractors or injected UI.
- Cover letters, interview prep, job and application tracking, salary comparison, LinkedIn profile optimization.
- Original-template preservation.
- Multi-language AI.
- Server-side resume storage; Redis; OCR; local LLMs; OpenRouter in production; mobile.

**4. What is the recommended tech stack?**

- WXT + React + TypeScript extension; IndexedDB + WebCrypto; pdf.js, mammoth, `docx`, pdfmake.
- Hono on Cloudflare Workers + Workflows + Durable Objects + Hyperdrive → **Neon Postgres** (Drizzle); R2.
- Cloudflare AI Gateway; `packages/ai` router (OpenAI + Anthropic + Gemini paid tier).
- Better Auth (Google + email OTP; Resend).
- Paddle.
- Sentry, Better Stack, Langfuse (evals).
- GitHub Actions; pnpm + Turborepo.

See §31.

**5. Which AI provider and model should I start with?**
**OpenAI:** `gpt-6-luna` for extraction, mapping and entailment checks ($0.10/$0.50), and `gpt-6-sol` for the evidence-bound rewrite ($2/$10), with reasoning effort `low` and strict Structured Outputs. Wire **Anthropic `claude-sonnet-5-5`** from day one as the rewrite challenger and fallback. It has privacy advantages (no default retention, pinned snapshots) but costs ~1.3× per job because of its tokenizer. **Pick the long-term rewrite default from the Phase 1 factuality bake-off.** Gemini 3.1 Flash-Lite (paid tier only) is the cheap-tier fallback.

**6. Should I use BYOK, hosted AI, or hybrid?**
**Hybrid:**

- Free deterministic local mode (no account, no AI).
- **Hosted AI** as the main product (Free quota → Pro).
- **BYOK** as a $39/year privacy/power plan that calls providers directly from the side panel.

Do **not** use browser-session reuse of ChatGPT/Claude/Gemini.

**7. What is the expected cost for 100 users?**
**≈ $184/month**: 100 users × 1 optimization/day = 3,000 per month, giving $144 AI (Hybrid at $0.048) + ~$40 infra. The range is ≈ $130 (conservative) to ≈ $365 (worst case). With the realistic freemium mix (4 paid users), it is ≈ **$59/month** in total cost of goods ([cost-analysis.md](cost-analysis.md) §11.3).

**8. What is the expected cost for 1,000 users?**
**≈ $1,540/month** at 1 optimization per user per day: 30,000/month → $1,440 AI + ~$100 infra. At the owner's heavy rate of 10 per day (Scenario B), it is ≈ **$14,700/month**. With a realistic freemium mix, ≈ **$293/month** against ≈ $640 revenue.

**9. What is the expected cost for 10,000 users?**
**≈ $14,700/month** at 1 optimization per user per day: 300,000/month → $14,400 AI + ~$300 infra. Luna-heavy would be ≈ $3,060; Sol-heavy ≈ $27,900. With a realistic freemium mix, ≈ **$2,225/month** against ≈ $6,400 revenue (≈ 65% gross margin).

**10. What are the three biggest technical risks?**

1. **Residual AI fabrication**, mitigated by evidence gates, entailment, revert-on-fail, evals and user review.
2. **JD extraction brittleness** across SPAs, iframes and site changes, mitigated by JSON-LD first, remote adapters and select/paste.
3. **Provider volatility**: floating GPT-6 IDs, price changes, retirements and rate/spend caps. Mitigated by the router, fallbacks, price book and drift evals.

**11. What are the three biggest business risks?**

1. **Commoditization.** ChatGPT, LinkedIn and Indeed bundle tailoring for free.
2. **Platform and legal action or Chrome Web Store rejection**, involving LinkedIn/Indeed terms, CWS data and AI policies.
3. **Distribution and willingness to pay.** Pure tailoring extensions stay small on the CWS, and tailoring was used by only 3.5% of one builder's AI users.

**12. What is the fastest path to a production-quality MVP?**

1. Phase 0: 1 week of decisions and counsel, **in parallel** with Phase 1 prep.
2. A **3-week PoC** focused on the risky parts (platform tests, extraction fixtures, parsing, **bake-off with gates**).
3. **Freeze contracts**, then run **parallel agent lanes** for 11 weeks, including the admin MVP, coupons and the AI usage dashboard.
4. About 3.25 weeks of hardening and closed beta.
5. CWS submission with deferred publishing.

Throughout: reuse managed services, render and parse client-side (no document servers), no Redis, no custom auth crypto, and a Paddle merchant of record. **≈ 20 weeks for one engineer** (≈ 16 without the admin panel, coupons and AI dashboard). Admin v1 (API keys and model per step, prompt and scoring config, insights) follows in the first month after launch.

**13. What architecture can scale without rewriting the product?**
The **local-first extension + stateless Workers API + per-user Durable Objects + durable Workflows + Postgres + provider-agnostic AI router**. Client-side compute (parse, score, generate) means server load grows only with LLM calls. Postgres and the Web-standard Hono API keep a container migration path (Cloud Run or Fargate plus pg-boss) behind the `packages/platform` adapters.

**14. What should I build first?**

1. **Step 0:** monorepo + **Zod contracts** (canonical resume, job analysis, API DTOs, messages) + agent rules.
2. **Then:**
   - The **evidence and validation core**: claim extraction + gates G0–G6 + seeded fabrication tests.
   - The **model bake-off** that uses it.
   - In parallel, the extension platform tests and Tier A extraction fixtures.

Truthfulness is the product. Prove it before building screens.

---

# FINAL RECOMMENDED PLAN

This is a concise blueprint for an implementing agent. All details are in the linked docs.

**Guardrails (always):**

- Never generate or accept resume content without a `claim_id` backed by source spans or a user attestation.
- Never call the score an ATS score.
- Minimal permissions; no remote code; no `eval`.
- No resume or JD content in server storage or logs.
- No LinkedIn/Indeed-specific code or UI injection until counsel approves.
- No AI-chat tab automation.

**Build order:**

1. **Contracts & scaffold** ([implementation-roadmap.md](implementation-roadmap.md) §7 P0)
   - pnpm/Turborepo monorepo as in [architecture.md](architecture.md) §20.
   - `packages/shared` Zod schemas: canonical resume ([architecture.md](architecture.md) §5.4), `ExtractedJob`/`JobAnalysis` (§4.5–4.6), API DTOs and errors ([api-design.md](api-design.md) §4, §6), and messages (§8).
   - CI skeleton; `CLAUDE.md` rules; ADRs D-01…D-20; admin API, config-namespace and coupon DTOs.
   - *Accept when* the example payloads validate and typecheck and tests pass.
2. **PoC** (3 weeks)
   - Extension platform tests (activeTab via side panel, CORS without a host permission, Blob download, structured-clone messaging).
   - Tier A extraction on 30 fixtures.
   - Parsing on 10 resumes (two-column, header contact).
   - Scoring v0 (reproduce the 69/High example).
   - **Bake-off** of gpt-6-sol vs claude-sonnet-5-5 vs gpt-6-luna with gates G0–G7 on 30 pairs.
   - DOCX/PDF round-trip.
   - *Accept when* extraction ≥ 90%, parsing ≥ 90%, post-gate fabrication ≤ 2%, measured tokens and costs are recorded, and the strong model is chosen.
3. **Core packages**, in parallel lanes and worktrees:
   - `evidence` (claims, gates G0–G6, verb ladder, normalizers; ≥ 95% seeded-fabrication catch; ≤ 5% false positives).
   - `scoring` (exact formula §12 / [architecture.md](architecture.md) §7).
   - `ai` (router, 6 versioned prompts, providers, budgets, fallbacks, cost logging; Hosted and Direct transports).
   - `job-extraction` (layers L0–L5; 24 fixtures).
   - `resume` (parse + two templates; 24 malformed fixtures; round-trip ≥ 98%).
4. **Backend**
   - Hono Worker: all [api-design.md](api-design.md) §6 endpoints.
   - Better Auth (Google via `launchWebAuthFlow` + PKCE; email OTP + Turnstile).
   - UserQuota DO (exact quotas, $ budget, concurrency, SSE).
   - OptimizeWorkflow (encrypted step state; 24 h mailbox).
   - Neon schema and migrations with row-level security and retention jobs ([database-design.md](database-design.md) §3–7).
   - Paddle checkout and webhooks.
   - Signed remote config, published from versioned config.
   - *Accept when* 100-way concurrent quota exactness, idempotency, complete deletion and PII-free logs all pass.
5. **Admin plane and coupons** ([admin-panel.md](admin-panel.md) §11, Lane G)
   - `admin-api` Worker behind Cloudflare Access; roles; step-up; no impersonation.
   - Audit log written in the same transaction as every write, hash-chained; audited personal-data reads.
   - Config framework (versions, bounds, diff, publish, rollback) with the `plans`, `features`, `kill_switches`, `limits` and `announcements` namespaces.
   - Users and support view with a timeline; credits and complimentary grants.
   - Coupon engine: per-plan %, duration, total and per-user limits, new-customer rule, dates, budget, bulk codes; Paddle non-checkout discounts; reservations; reconcile.
   - **AI usage dashboard:** 5-minute rollups; tokens by type and cost by step, user (masked), model, key, plan and version; per-optimization waterfall; AI alerts; monthly reconcile with provider totals.
   - *Accept when* US-13…US-16 and the dashboard parts of US-18 pass, the coupon tests pass in the Paddle sandbox, and every admin write has an audit row.
6. **Extension UI**
   - All 13 screens ([product-requirements.md](product-requirements.md) §8).
   - Encrypted IndexedDB.
   - Side panel as the main surface, plus the workspace page.
   - Diff with evidence popovers and local re-validation.
   - Export; consent and privacy controls; BYOK mode.
   - "Have a code?" coupon entry on the Upgrade screen.
   - *Accept when* E2E passes for US-1…US-13, the copy lint passes, and BYOK sends zero requests to our API.
7. **Evals and quality**
   - Golden set of 120 JDs, 24 resumes and 300 pairs.
   - promptfoo smoke suite on PRs, full suite nightly, drift run weekly.
   - Hard gates: span fidelity 1.0; hallucination ≤ 0.5%; 0 injection successes; formatting ≥ 98%.
8. **Hardening and beta**
   - Security review against 30 threats (including admin #22–30); observability and alerts; k6 at 3× Scenario B.
   - Closed beta of 50–100 users plus a recruiter panel.
   - *Accept when* ≥ 70% say "helped me tailor" and "not true" reports are ≤ 0.5% of changed bullets.
9. **Launch**
   - CWS listing (single purpose, permission justifications, consistent privacy tab, no brand lists, no "ATS score"), privacy policy and Limited Use statement.
   - Provider tiers raised; spend caps and budgets; deferred publish; on-call.
10. **After launch**
   - **Admin v1** in the first month:
     - provider registry and write-only key vault;
     - **model + key per step** with the data-policy rule (NVIDIA trial keys: evals only);
     - prompt, scoring and extractor config with eval gates, canaries and auto-rollback;
     - traces explorer, insights engine and what-if simulator (US-17, US-18).
   - Tier A auto-detect (optional permissions); BYOK Gemini; local embeddings.
   - Evidence-bound cover letters; DOCX template preservation.
   - Languages; the MCP app channel; a Tier B roadmap per counsel.

**Budget targets:**

- ≤ $0.06 AI per optimization expected.
- Pro: 150/month and 25/day caps, $8 AI budget.
- Free: 3 optimizations and 15 analyses per month.
- Global daily spend breaker.
- Infra ≈ $40 / $100 / $300 per month at 100 / 1k / 10k users.
