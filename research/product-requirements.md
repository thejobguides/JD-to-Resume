# Product Requirements (PRD) — AI Resume / Job Match Optimizer

**Purpose.** This document defines *what* we build and *why*:

- the product definition, users and goals;
- the quality standard;
- job-portal support tiers;
- platform and legal constraints;
- the UX surface and all 13 screens;
- score language and disclaimers;
- the before/after experience;
- feature prioritization;
- MVP user stories with acceptance criteria.

[architecture.md](architecture.md) defines *how*.

Last updated: 2026-09-29 · Companion docs: [research-report.md](research-report.md), [competitive-analysis.md](competitive-analysis.md), [architecture.md](architecture.md), [security-threat-model.md](security-threat-model.md), [implementation-roadmap.md](implementation-roadmap.md)

**Labels:** **[FACT]** · **[ASSUMPTION]** · **[RECOMMENDATION]** · **[OPEN QUESTION]**

---

## Table of contents

1. [Product definition](#1-product-definition)
2. [Goals, non-goals, success metrics](#2-goals-non-goals-success-metrics)
3. [Key assumptions](#3-key-assumptions)
4. [Product quality standard](#4-product-quality-standard)
5. [Job-portal support matrix](#5-job-portal-support-matrix)
6. [Platform and legal considerations](#6-platform-and-legal-considerations)
7. [UX surface decision](#7-ux-surface-decision)
8. [Screens](#8-screens)
9. [Score language, disclaimers, and the before/after spec](#9-score-language-disclaimers-and-the-beforeafter-spec)
10. [Feature prioritization](#10-feature-prioritization)
11. [MVP user stories and acceptance criteria](#11-mvp-user-stories-and-acceptance-criteria)
12. [Open questions](#12-open-questions)

---

## 1. Product definition

**Working name:** AI Resume / Job Match Optimizer (store name TBD). Avoid "ATS" and third-party brands in the name; see §6.

**One-line value proposition:** *"See how well your resume matches the job you're viewing, and get truthful, evidence-backed edits that surface what you've already done. Nothing invented."*

**Target users:**

| Segment | Need | Priority |
|---|---|---|
| Active job seekers (mid-career, tech and knowledge work), applying to 5–30 jobs per week | Tailor quickly without lying; understand gaps | **Primary** |
| Early-career / students | Know what employers want; structure the resume | Secondary (18+ only; see [security-threat-model.md](security-threat-model.md) §13) |
| Career switchers | Map transferable evidence to new roles honestly | Secondary |
| Privacy-sensitive / power users | Local processing, BYOK | Niche (BYOK plan) |

**Jobs to be done:**

1. "When I find a job, tell me quickly whether I'm a fit and what's missing."
2. "Help me tailor my resume for this job in minutes, **without making things up**."
3. "Give me a clean file I can upload that application systems can read."

**Single purpose** (for the Chrome Web Store): *"Help job seekers tailor their own resume to a job description they are viewing, with an explainable match score and truthful, evidence-based edits."* [FACT] The CWS requires a narrow single purpose (https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq).

---

## 2. Goals, non-goals, success metrics

**Goals (MVP):**

- G1. Detect or accept a JD on Tier A sites and on any site via selection or paste.
- G2. Produce an explainable Job Match Score with a confidence rating and a requirement-level breakdown.
- G3. Produce an optimized resume in which **every change is traceable to the user's own evidence**.
- G4. Export ATS-safe DOCX and PDF.
- G5. Work in a meaningful local mode without an account.

**Non-goals (MVP):**

- Auto-apply or form autofill.
- Cover letters.
- Interview prep.
- Job tracking beyond a simple history.
- LinkedIn profile optimization.
- Preserving custom templates.
- Non-English AI.
- Mobile.
- Any automation of job-portal or AI-chat websites.

**Success metrics:**

| Metric | Target (first 90 days after launch) | Label |
|---|---|---|
| Hallucination rate (fabricated claims in accepted outputs, measured via user "not true" reports + sampled audits) | ≤ 0.5% of changed bullets | [RECOMMENDATION] |
| Activation: resume uploaded + first score within 10 min of install | ≥ 60% | [ASSUMPTION] benchmark |
| Optimize → export rate | ≥ 50% | [ASSUMPTION] |
| Share of changes accepted by users | ≥ 60% | [ASSUMPTION] |
| "This actually helped me tailor my resume" (in-product survey, agree/strongly agree) | ≥ 70% | [RECOMMENDATION] |
| Free → paid conversion | 2–6% (plan on 4%) | [ASSUMPTION] ([cost-analysis.md](cost-analysis.md) §11.3) |
| CWS rating | ≥ 4.5 | [ASSUMPTION] |
| p95 optimization time | ≤ 90 s | [ESTIMATE] |

---

## 3. Key assumptions

All are to be validated in beta.

| # | Assumption | Validation |
|---|---|---|
| A1 | Users value **truthful** tailoring enough to pay when ChatGPT does it for free | Beta surveys; conversion; "not true" reports |
| A2 | JSON-LD/structured data exists on most Tier A pages | Extraction telemetry per host |
| A3 | Users accept a standard template instead of their own design | Template-preservation requests; export rates |
| A4 | Typical paid user: ~30 optimizations/month | Usage data ([cost-analysis.md](cost-analysis.md) §3) |
| A5 | Users will use the side panel (discoverability) | Activation funnel |
| A6 | Tier B (LinkedIn/Indeed) users are satisfied with select/paste | Satisfaction by host |
| A7 | ~~Owner location~~ **Confirmed 2026-09-29: Canada-based**; the market is global English-speaking (Canada, US, UK, EU, India …) | Resolved ([cost-analysis.md](cost-analysis.md) §11.4) |
| A8 | Users are 18+ | Age gate |

---

## 4. Product quality standard

The target outcome: users say "This actually helped me tailor my resume", not "It just changed some keywords". The brief's priorities are ranked in order.

| Rank | Priority | How it is enforced | How it is measured |
|---|---|---|---|
| 1 | **Truthfulness** | Evidence Store + gates G0–G7 + revert-on-fail + user review; "Add a fact" attestation is the only way to add new facts ([architecture.md](architecture.md) §6) | Hallucination rate; validator recall; user "not true" reports |
| 2 | **Relevance** | Targets only JD requirements with existing evidence; edit budget ≤ 8 bullets + summary + skills order | Human rubric (relevance 1–5); requirement-surfacing rate |
| 3 | **Clarity** | Style rubric (one idea per bullet, starts with a verb, ≤ 2 lines, no jargon lists) | Rubric; readability checks |
| 4 | **Evidence** | Every change shows its evidence popover and "why" | % of changes with evidence (must be 100%) |
| 5 | **Readability** | No keyword stuffing (saturation rule, [architecture.md](architecture.md) §7.5); natural phrasing | Blind human ratings; stuffing detector |
| 6 | **ATS compatibility** | Single-column templates; round-trip text-extraction tests | Formatting correctness ≥ 98% |
| 7 | **Human recruiter readability** | Concise bullets with outcomes (when evidenced); consistent tense | Recruiter panel review in beta (5–10 recruiters) |

Anti-patterns that are **prohibited in product copy and behaviour**:

- "Beat the ATS" or "guaranteed interviews".
- Adding skills the user doesn't have.
- Hiding the ceiling.
- Showing a score jump without explaining why it moved.

---

## 5. Job-portal support matrix

Evidence comes from the platform-legal research notes (checked 2026-09-29).

| Platform | Extraction method | Reliability | Restrictions (terms) | Maintenance cost | MVP tier |
|---|---|---|---|---|---|
| **Greenhouse** (job-boards / boards.greenhouse.io, embeds via `gh_jid`) | DOM (`.job__description`), server-rendered; no JSON-LD in sample; official public Job Board API exists (unauthenticated GET) | High | [FACT] "Job Board data is publicly available, so authentication is not required for any GET endpoints" (https://developers.greenhouse.io/job-board.html). Terms for third-party consumption not located → counsel. | Low | **A** |
| **Lever** (jobs.lever.co) | JSON-LD JobPosting + DOM; Postings API | High | [FACT] Published postings "may be scraped by third parties" (https://github.com/lever/postings-api) | Low | **A** |
| **Ashby** (jobs.ashbyhq.com) | JSON-LD (SPA shell) ; public posting API (CORS `*`) | High | [FACT] Public posting API documented (https://developers.ashbyhq.com/docs/public-job-posting-api) | Low | **A** |
| **SmartRecruiters** | Microdata JobPosting; public Posting API | High | [FACT] Public postings need no auth (https://developers.smartrecruiters.com/docs/posting-api) | Low | **A** |
| **Workday** (*.myworkdayjobs.com) | JSON-LD when the posting is open (sampled 5 tenants); SPA shell | Medium–high | No public jobs API found; don't use the internal `/wday/cxs/` endpoints. Employer terms vary → counsel. | Medium | **A** |
| **iCIMS** (careers-*.icims.com) | JSON-LD **inside an iframe** (`in_iframe=1`) | Medium | robots allows; terms not reviewed | Medium | **A** |
| **Company career pages** (custom) | JSON-LD (Google for Jobs incentive) → generic extractor → selection | Medium | Varies; the employer usually wants distribution | Low | **A** (generic) |
| **LinkedIn Jobs** | *Generic extractor on explicit click* or **selection/paste**; **no LinkedIn-specific code in MVP** | Medium (SPA; logged-in) | [FACT] UA §8.2: no "browser plugins and add-ons ... to scrape or copy the Services"; help page: no extensions that "scrape, modify the appearance of, or automate activity on LinkedIn's website" (https://www.linkedin.com/legal/user-agreement, https://www.linkedin.com/help/linkedin/answer/a1341387). [FACT] Crawling terms prohibit automated crawling. | High (frequent UI changes) | **B** (pending counsel) |
| **Indeed** | Same as LinkedIn | Medium | [FACT] ToS: "Use any automated system ... to access, data-mine ... You may not crawl, scrape, extract data from, reproduce, duplicate, copy ... any part of the Site" (https://www.indeed.com/legal, updated 2026-07-17); the job-seeker licence is "personal, non-commercial" | High | **B** (pending counsel) |
| **Glassdoor** | Same | Medium | [FACT] ToU: no "software or automated agents ... to scrape, strip, or mine data" (Wayback 2026-09-21 of https://www.glassdoor.com/about/terms/) | High | **B** |
| **ZipRecruiter** | Same | Medium | [FACT-SECONDARY] Prohibits "crawling" or "scraping", "whether by automated, manual, or other non-automated means" (search summary of the ZipRecruiter terms) | High | **B** |
| **Wellfound** | Same | Medium | [FACT] Terms prohibit "automated or non-automated harvesting ... or 'scraping'" and commercial use of content (https://wellfound.com/terms) | Medium | **B** |
| **Naukri** | **Paste only** (recommended) | – | [FACT] Forbids even "manual process" extraction "for a purpose which has not been authorised in writing"; robots block user-triggered AI fetchers (https://www.naukri.com/termsconditions) | – | **B (paste)** |
| **Generic page / PDF JD / email** | Selection → context menu; paste | High (user-driven) | – | None | Always |

**Can a generic extractor work?** Yes, for most pages, when combined with JSON-LD and selection fallback ([architecture.md](architecture.md) §4). Site adapters add reliability on Tier A sites and are delivered as remote flat config.

**Site detection:** host/path rules plus DOM fingerprints select the adapter ([architecture.md](architecture.md) §4.4).

---

## 6. Platform and legal considerations

This is not legal advice. The consolidated list for counsel is in [security-threat-model.md](security-threat-model.md) §14.

| Area | Constraint / risk | Product decision |
|---|---|---|
| **Chrome Web Store** | Single purpose; minimal permissions; privacy policy; **in-UI disclosure + consent**; Limited Use (July 2026 update: "strictly necessary"); no remote code; no keyword spam or impersonation; the **July 2026 AI-guardrails policy** ([FACT] https://developer.chrome.com/blog/cws-policy-updates-2026) | activeTab-only MVP; consent screen before upload; no ChatGPT-tab automation; no brand lists in the listing |
| **LinkedIn** | UA §8.2 (scrape/copy, overlay/modify, bots, deep-linking, trademark); crawling terms; the extension-prohibition help page; enforcement history (hiQ judgment 2022; Proxycurl 2025) | No injected UI on linkedin.com; no LinkedIn-specific selectors in the MVP; extraction only on explicit click (or select/paste); never fetch LinkedIn server-side. **Owner decision (2026-09-29): no LinkedIn scraping. Users provide their LinkedIn profile by downloading it themselves ("Save to PDF" or the "Download your data" archive) and uploading it**; LinkedIn job posts go in by select/paste. |
| **Indeed / Glassdoor / ZipRecruiter / Wellfound / Naukri** | Broad no-copy/no-scrape terms; personal non-commercial licences | Same as LinkedIn; Naukri is paste-only |
| **ATS vendors** (Greenhouse, Lever, Ashby, SmartRecruiters) | Public APIs and public postings, but terms for third-party use are unclear | Tier A; never submit applications; no bulk fetching |
| **Workday / iCIMS** | Employer-hosted; no public API | Read the active page only on click; no internal endpoints |
| **Trademarks** | [FACT] LinkedIn brand policy; CWS impersonation policy | Plain-text nominative references only ("works on job pages from sites such as …") + a non-affiliation disclaimer; no logos |
| **AI providers** | Business API terms; no consumer-UI automation ([ai-model-comparison.md](ai-model-comparison.md) §6) | Official APIs only |
| **Claims** | Score claims must not imply a real ATS score (FTC-style deception risk) | §9 copy rules |

**Honest answer on LinkedIn:** the owner likely expects LinkedIn to be the #1 source. The research does not support shipping a LinkedIn-specific extractor without legal review. **The MVP supports LinkedIn through user-initiated generic reading plus select/paste. Counsel reviews this before any LinkedIn-specific code.** This is a real product trade-off and is recorded as a top business risk ([research-report.md](research-report.md) §35).

---

## 7. UX surface decision

| Surface | Verdict | Reason |
|---|---|---|
| Popup | ❌ | [FACT] Closes when focus leaves; max 800×600 |
| **Side panel** | ✅ Primary | Persistent beside the JD; full extension-page capabilities ([architecture.md](architecture.md) §3.2) |
| Injected page UI | ❌ (MVP) | LinkedIn prohibits modifying appearance; needs host permissions; security surface |
| Full extension page | ✅ Secondary | "Resume workspace": large diff, resume management, edits |

**Entry points:**

- Toolbar icon (opens the side panel).
- Keyboard shortcut (Alt+J).
- Right-click → "Analyze selected text as job description".
- The "Analyze this page" button inside the panel.

---

## 8. Screens

The side panel is ~360–480 px wide. Every screen has empty, loading and error states. All text is rendered as plain text (no HTML from untrusted sources).

### 8.1 First-time setup

```text
┌──────────────────────────────┐
│ Job Match Optimizer          │
│ Tailor your resume truthfully│
│ ─────────────────────────────│
│ 1 Upload your resume         │
│ 2 Open a job & click Analyze │
│ 3 Review evidence-based edits│
│                              │
│ How your data is handled  ▸  │  → expands: stored on this device; sent to AI only when you
│ [ ] I'm 18 or older          │     optimize (hosted) — to OpenAI/Anthropic under business terms,
│ [Get started]                │     pseudonymized; nothing sold; delete anytime
└──────────────────────────────┘
```

- **Purpose:** onboarding plus **CWS-compliant disclosure and consent** (the consent must be an affirmative action — [FACT] user-data FAQ).
- **States:** consent declined → the product can't process resumes; explain why.
- **Actions:** Get started → Resume upload.

### 8.2 Resume upload

```text
┌──────────────────────────────┐
│ Add your resume              │
│ ┌──────────────────────────┐ │
│ │  Drop PDF/DOCX/TXT here  │ │
│ │  or [Choose file]        │ │
│ └──────────────────────────┘ │
│ [Paste text instead]         │
│ Import from LinkedIn ▸       │ → "Save your profile as PDF (LinkedIn → Me → Save to PDF) or
│                              │    upload your LinkedIn data export ZIP" (no URL fetch)
│ Stays on this device.        │
└──────────────────────────────┘
```

- **Loading:** a "Reading your resume…" progress bar.
- **Errors:** scanned PDF, encrypted, too large, unsupported type ([architecture.md](architecture.md) §18, #8–15).
- **Then:** the resume review screen, which is part of this step: a parsed view with section headers, roles and bullets, low-confidence fields highlighted for confirmation, warnings (two columns detected, header contact, hidden text), and [Looks right] / [Fix].

### 8.3 Resume management

This screen is in the workspace page, with a compact version in the panel.

- A list of resumes with labels and a default marker; versions (uploaded / edited / optimized for <Company>) with dates.
- Actions: rename, set default, view, duplicate, delete, export JSON, "Add a fact" (attestations list).
- **Empty state:** "No resumes yet."

### 8.4 Job detection

```text
┌──────────────────────────────┐
│ This page                    │
│ Senior Data Engineer         │
│ Acme · Remote (US)           │
│ Source: Lever (structured) ✓ │
│ [Analyze this job]           │
│ Wrong job? [Edit text] [Use selection] [Paste] │
└──────────────────────────────┘
```

- **States:** detected with high confidence; detected with low confidence ("Please check the details"); not detected (select or paste, [architecture.md](architecture.md) §18 #1); restricted page; Tier B notice ("We only read this page when you click Analyze").
- Duplicate job → "You analyzed this on Sep 20 — reuse or re-run?"

### 8.5 Job analysis

- Requirements grouped as Must-have / Preferred / Responsibilities / Education / Certifications / Experience, each with its verbatim quote.
- Salary, location and work mode when stated.
- The user can edit a requirement's type or delete a requirement, which re-scores.
- An `injection_suspected` banner if flagged.

### 8.6 Match score

```text
┌──────────────────────────────┐
│ Job Match Score   69  (66–72)│
│ Confidence: High        ⓘ    │  ⓘ → "An estimate of how well your resume aligns with this
│ ███████████████░░░░░░        │      job's stated requirements. Real application systems
│ Required skills   70%  ▸     │      differ; no tool can know an employer's ranking."
│ Experience       100%  ▸     │
│ Responsibilities  70%  ▸     │
│ Preferred         40%  ▸     │
│ Title fit         60%  ▸     │
│ Keywords          83%  ▸     │
│ Education        100%        │
│ Resume structure  88%  ▸     │
│ Eligibility: Location — not stated on your resume │
│ You could reach up to 91 with your current experience │
│ [Optimize resume]            │
└──────────────────────────────┘
```

Each category expands to its requirements and their state (✓ strong, ◐ partial, · weak, ✗ none, ? unknown), each linked to evidence.

### 8.7 Missing skills

This covers gaps and weak spots:

- **Missing** (no evidence): e.g. "AWS certification (preferred)". Actions: "I have this → Add a fact" (attestation form with a truthfulness checkbox), or "Skill-gap note" (future).
- **Weak** (partial evidence): e.g. "Kubernetes: you deployed to EKS; consider describing production operation if true".
- **Not surfaced** (evidence exists but is hidden): e.g. "Kafka appears only in Skills; your Globex pipeline bullet shows it". These are what Optimize will fix.

### 8.8 Optimize resume

- **Options:** focus (auto / pick requirements), tone (concise/standard), sections allowed (summary, bullets, skills order).
- **Progress:** Queued → Rewriting → Checking every change against your resume → Done. Show the elapsed time. The user may close the panel; the result is waiting when they come back.
- **Quota display:** "2 of 3 free optimizations left".
- **Errors:** quota exceeded (upsell + local mode), AI unavailable (quota not charged), partial result.

### 8.9 Before/after comparison

```text
┌──────────────────────────────┐
│ Before 69  →  After 84       │
│ Ceiling 91 (with your current experience)
│ Changed: Summary · 4 bullets · Skills order │
│ Emphasized: Kafka · Kubernetes · Airflow     │
│ Could not improve: AWS certification (no evidence) [Add a fact] │
│ Kept original (1): suggestion wasn't supported by your resume   │
│ ─────────────────────────────│
│ Globex — Data Engineer       │
│ − Built Kafka-based pipeline processing 2M events/day
│ + Built a Kafka-based streaming pipeline processing 2M events/day
│   Why: surfaces Kafka (required). Evidence ▸ [✓ Accept] [✗ Reject] [✎ Edit] │
│ … [Accept all verified] [Open in workspace] │
└──────────────────────────────┘
```

- Editing a bullet re-runs the local gates. An unsupported edit prompts "Add a fact?".

### 8.10 Download

- Choose the template (Classic / Modern-minimal) and format (DOCX, PDF, both); preview (docx-preview / PDF canvas).
- Filename: `First-Last-Resume-Acme.pdf`.
- A checklist: single column ✓, contact in body ✓, text-selectable PDF ✓.
- **Errors:** generation failure → alternative format ([architecture.md](architecture.md) §18 #30–32).

### 8.11 Settings

Includes the privacy and data controls:

- Account (sign in/out, sessions), plan.
- Privacy: telemetry opt-in, history opt-in, "Delete all local data", "Delete account", "Export my data".
- Local encryption passphrase (optional).
- Default template; language.
- Supported sites auto-detect (optional host permission prompt, v1.1).

### 8.12 AI provider settings

- **Mode:**
  - "Hosted (recommended)".
  - "Bring your own key (privacy mode)", with provider (OpenAI / Anthropic / Google paid), key field (masked), [Test], "Remember on this device (encrypted)" and [Forget key].
  - "Local only (no AI)".
- **Guidance:** create a restricted key with a spending limit. The Gemini free tier is **not allowed** (its terms forbid personal data).
- Shows the models used per task (read-only in the MVP).

### 8.13 Usage / billing

- This month: optimizations used/limit, analyses, credits; reset date.
- Plan cards: Free / Pro monthly $19 / Pro quarterly $45 / Credit pack $12 (25) / BYOK $39/yr. No weekly plans; cancel anytime; the renewal date is shown ([competitive-analysis.md](competitive-analysis.md) §7). Plans, prices, limits and badges come from runtime config, so they can be changed in the admin panel without a store release.
- **Coupon code:** a small "Have a code?" link under the plan cards (no permanent code box). After a valid code, each eligible card shows the before and after price and plain terms, e.g. *"30% off your first 2 quarters, then $45.00 every 3 months."* Ineligible plans say *"This code doesn't apply to this plan."* Errors are specific: expired, already used, new customers only, and so on ([admin-panel.md](admin-panel.md) §7.7).
- An active discount shows its end date and the full price after it ends.
- Manage billing (Paddle portal).

---

## 9. Score language, disclaimers, and the before/after spec

### 9.1 Terminology

| Use | Never use |
|---|---|
| Job Match Score, Resume Compatibility Score, JD Alignment Score, Estimated ATS compatibility (only for the structure/parseability sub-score) | "ATS score", "Your Workday/Greenhouse score", "ATS-approved", "passes ATS", "beat the ATS", "guaranteed" |

### 9.2 Standard disclaimer

Shown on the score screen via ⓘ and in the store listing:

> "The Job Match Score estimates how well your resume aligns with this job's stated requirements. Employers' application systems work differently: many store and parse resumes for recruiters to search, some rank or filter candidates, and knockout questions may screen applications. No tool can know how a specific employer ranks candidates."

This is supported by [FACT] evidence in [competitive-analysis.md](competitive-analysis.md) §5:

- Greenhouse: "never uses AI to ... auto-reject".
- Greenhouse Talent Matching sorts candidates against employer-set criteria.
- Lever Talent Fit ranks candidates.
- Workday HiredScore grades candidates.
- A 2025 study of 25 recruiters found 92% of their systems don't auto-reject on content, while 100% use knockout questions.

### 9.3 Before/after rules

1. The before and after scores use the same engine, weights, JD analysis and scoring version ([architecture.md](architecture.md) §8.3).
2. Always show the **ceiling** and the **"Could not improve"** list.
3. Show the reason for every change and its evidence.
4. Reverted suggestions are disclosed ("Kept original (N)").
5. Never animate or exaggerate score gains. Show the ranges when confidence is below High.

---

## 10. Feature prioritization

| Feature | Tier | Rationale |
|---|---|---|
| JD detection (Tier A + generic) + selection/paste | **Must** | Core loop |
| Resume upload/parse (PDF, DOCX, TXT) + review | **Must** | Core |
| Explainable Job Match Score + confidence + breakdown | **Must** | Core; free, local |
| Missing/weak/not-surfaced analysis | **Must** | The core insight |
| Evidence-bound optimization + validation + diff + accept/reject | **Must** | Core value; truthfulness |
| Before/after with ceiling and "could not improve" | **Must** | Brief §15 |
| DOCX + PDF export (2 ATS-safe templates) | **Must** | Brief §14 |
| Local mode without an account | **Must** | Trust, acquisition |
| Hosted AI with quotas + Google/OTP sign-in + Paddle | **Must** | Monetization |
| Privacy controls (export, delete, consent) | **Must** | Compliance |
| **Admin panel MVP**: users and support, credits and complimentary access, plans and limits, feature flags, kill switches, banners, audit log, user timeline *(owner request, 2026-09-29)* | **Must** (before paid launch) | Running a paid product without it means unaudited database edits ([admin-panel.md](admin-panel.md)) |
| **Coupon codes**: % off per plan (monthly, quarterly, BYOK, credit pack), single-use or limited, per-user limit, duration, dates, budget cap, bulk codes *(owner request)* | **Must** (before paid launch) | Launch promotions and partner codes ([admin-panel.md](admin-panel.md) §7) |
| **AI usage dashboard**: tokens (input, cached, output, reasoning) and cost by step, user, model, key, plan and version; per-optimization waterfall; AI cost alerts *(owner request)* | **Must** (before launch) | Cost control and the next optimizations depend on it ([admin-panel.md](admin-panel.md) §9) |
| **Admin v1**: provider registry + **write-only API-key vault** (OpenAI, Anthropic, Google, OpenAI-compatible hosts such as NVIDIA); **model + key per step**; prompt, scoring and extractor config with eval gates, canary and auto-rollback; traces explorer; insights and what-if simulator *(owner request)* | **Should** (first month after launch) | Faster, safer operations; until then keys are Cloudflare secrets and routing is git + deploy |
| **Multiple resumes + versions** | **Should** | Needed quickly by real users; low cost (local) |
| BYOK (OpenAI/Anthropic) | **Should** | Differentiator for a niche; low cost |
| "Add a fact" attestations | **Should** (strongly) | The honest path to add missing facts |
| Job history / bookmarking (local) | **Should** | Cheap; supports reuse |
| Skill-gap analysis (learning suggestions) | Nice to have | Needs content sources |
| Auto-detect on Tier A (optional host permission) | Nice to have (v1.1) | Convenience |
| Cover letter generation (evidence-bound) | Nice to have (v1.2) | Adjacent JTBD; same evidence engine |
| Original DOCX template preservation | Nice to have (v1.x) | Frequently requested [ASSUMPTION] |
| Multiple languages (UI + AI) | Future | Evals per language needed |
| LinkedIn profile optimization | Future | Legal and product scope creep |
| Application tracking / job tracker | Future | Crowded (Teal, Huntr, Simplify) |
| Interview prep | Future | Different product |
| Salary comparison | Future | Needs data sources/licences |
| Analytics dashboard (personal) | Future | Low value early |
| MCP app / ChatGPT app / Claude connector | Future | Distribution channel ([ai-model-comparison.md](ai-model-comparison.md) §6.3) |
| Auto-apply / autofill | **Never (for this product)** | ToS and brand risk; competitors own it |

---

## 11. MVP user stories and acceptance criteria

| # | Story | Acceptance criteria |
|---|---|---|
| US-1 | As a new user, I understand and consent to data handling before uploading | Consent screen shown before any file read; the 18+ checkbox is required; consent version stored locally (and server-side if signed in); declining blocks processing with an explanation |
| US-2 | As a user, I upload a PDF/DOCX/TXT resume and see it parsed correctly | ≥ 95% contact and ≥ 92% role/date accuracy on the golden set; 2-column detection warning shown; scanned PDF detected with guidance; each parsed field links to its source line |
| US-3 | As a user on a Tier A job page, I click the icon and the job is detected | Title, company and description extracted on ≥ 95% of the Tier A fixture pages within 4 s; the user can edit or override |
| US-4 | As a user on any page, I can select the JD text and analyze it | The context menu item appears on selection; the panel opens with the text; works on LinkedIn/Indeed without site-specific code |
| US-5 | As a user, I see a Job Match Score with confidence and a breakdown | Deterministic: same inputs give the same score; the breakdown sums correctly; unknown requirements shown; disclaimer ⓘ present; no "ATS score" wording anywhere (lint test on copy) |
| US-6 | As a user, I see what's missing, weak and not surfaced | Every requirement is in exactly one state with evidence links; "could not improve" lists every `none` requirement |
| US-7 | As a user, I optimize and receive only evidence-backed changes | 0 fabricated claims on the golden validation set; every change has claim IDs and a "why"; reverted suggestions disclosed; p95 ≤ 90 s |
| US-8 | As a user, I compare before/after and accept or reject changes | After score ≤ ceiling; per-change accept/reject; edits re-validated locally; attestation flow for new facts |
| US-9 | As a user, I download DOCX and PDF | Both open in Word/Google Docs/Acrobat; round-trip extraction recovers contact, sections, titles and dates in order (≥ 98%); PDF text-selectable, fonts embedded |
| US-10 | As a free user, I know my quota and can upgrade | Usage visible; the quota-exceeded state keeps local features working; checkout completes via Paddle; the plan updates within 60 s of the webhook |
| US-11 | As a user, I can delete everything | Local wipe in one click; account deletion completes ≤ 24 h (backups ≤ 7 days, disclosed); confirmation email |
| US-12 | As a privacy-focused user, I use my own API key without our servers seeing my resume | With BYOK, no content requests reach our API (verified by E2E network assertions); the key is held in `storage.session` by default |
| US-13 | As a buyer with a coupon code, I see exactly what I'll pay before checkout | The preview shows the % off, duration and the full price afterwards, per eligible plan; the Paddle checkout total matches the preview (pre-tax); per-user and total limits hold under 50 concurrent attempts on the last use; an abandoned checkout releases the use within 60 min |
| US-14 | As the owner, I create a coupon with a different % per plan and limits | Create a single-use, shared or bulk coupon with per-plan % and duration, total and per-user limits, dates and a budget; a Paddle discount per plan rule is created automatically; % off, plans and duration can't be edited after the first redemption; every action has an audit row with a reason |
| US-15 | As support, I can trace what happened to a user without seeing their resume | The timeline shows sign-up, billing, coupons, grants, usage and optimizations with config snapshot, model, prompt version, cost and gate counts; no resume or job text anywhere; viewing the profile and revealing the email are audited |
| US-16 | As the owner, I change a setting and can undo it | Every config change is a new version with a diff, reason and actor; AI, prompt and scoring changes need a passing eval; a rollback restores the previous version in one click and takes effect within ~60 s; bounds reject unsafe values (e.g. an AI budget above 50% of the plan price) |
| US-17 | As the owner, I add an AI provider key and choose the model and key for each step | Add a key: the plaintext never leaves the browser unencrypted (verified by request capture) and is never shown again. "Test" returns ok/latency/error class. The routing matrix sets primary, fallbacks and canary per step. A route using a non-production key (e.g. an NVIDIA trial key) or a provider without `personal_data_allowed` on a resume-carrying step is **rejected with the reason**. Models need a passing eval for that step. Every action is audited. |
| US-18 | As the owner, I see where tokens and money go and what to optimize next | Dashboards show tokens by type and cost by step, user (masked), model, key, plan and prompt/config version for any date range, with period comparison. One optimization opens as a per-call waterfall. Totals match `ai_requests` exactly and the provider's usage within 3% (monthly reconcile). Insights list the estimated monthly impact, and accepting one creates an eval-gated draft config. The what-if simulator re-prices past traffic on another model. |

---

## 12. Open questions

1. Final product and store name, plus a trademark search.
2. LinkedIn: **profile import decided (2026-09-29)** — user-downloaded PDF or data export only, no scraping. Still open: whether counsel is comfortable with click-to-read generic extraction of LinkedIn/Indeed *job pages*, or whether those go paste-only (§6).
3. Is the 18+ gate required globally, or only where Gemini is used or by local law?
4. Which recruiter panel validates "human recruiter readability" in beta?
5. Should cache hits on JD analysis count toward the Free quota? ([api-design.md](api-design.md) §6.4)
6. How strongly do users need their original template preserved? Measure in beta.
