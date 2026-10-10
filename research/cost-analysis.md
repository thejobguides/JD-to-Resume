# Cost Analysis — AI Resume / Job Match Optimizer

**Purpose.** This document contains the cost model everything else relies on. It covers AI token costs per step, cost per optimization, infrastructure cost at each scale, the owner's two stress scenarios, the four requested routing scenarios ("Luna-heavy", "Sol-heavy", Hybrid, BYOK), unit economics and gross margin, sensitivity analysis and budget guardrails. Every unit price cites an official source with the date it was checked. All derived numbers show their calculation.

Last updated: 2026-09-29 · Status: research / planning (no code) · Companion docs: [research-report.md](research-report.md), [ai-model-comparison.md](ai-model-comparison.md), [architecture.md](architecture.md), [competitive-analysis.md](competitive-analysis.md)

**Labels:** **[FACT]** verified with the source URL and date · **[ASSUMPTION]** · **[ESTIMATE]** (calculation shown) · **[RECOMMENDATION]** · **[OPEN QUESTION]**

---

## Table of contents

1. [Headline numbers](#1-headline-numbers)
2. [Verified unit prices](#2-verified-unit-prices)
3. [Pipeline and token assumptions](#3-pipeline-and-token-assumptions)
4. [Cost per optimization, by routing scenario](#4-cost-per-optimization-by-routing-scenario)
5. [Conservative, expected and worst-case scenarios](#5-conservative--expected--worst-case)
6. [Owner stress scenarios A and B](#6-owner-stress-scenarios-a-and-b)
7. [Infrastructure cost by scale](#7-infrastructure-cost-by-scale)
8. [Master cost table (brief §48)](#8-master-cost-table-brief-48)
9. [Cost per active user](#9-cost-per-active-user)
10. [AI cost optimization levers and their real value](#10-ai-cost-optimization-levers-and-their-real-value)
11. [Unit economics, pricing and gross margin (brief §38)](#11-unit-economics-pricing-and-gross-margin-brief-38)
12. [Sensitivity analysis](#12-sensitivity-analysis)
13. [Budget guardrails](#13-budget-guardrails)
14. [Challenges to the owner's assumptions](#14-challenges-to-the-owners-assumptions)
15. [Open questions](#15-open-questions)

---

## 1. Headline numbers

| Metric | Value | Label |
|---|---|---|
| AI cost per optimization — **Hybrid (recommended)**: GPT-6 Luna for extraction/validation and GPT-6 Sol for rewriting | **$0.048** expected (range $0.030–$0.108) | [ESTIMATE] §4–5 |
| AI cost per optimization — **Luna-heavy** | **$0.0092** | [ESTIMATE] §4 |
| AI cost per optimization — **Sol-heavy** | **$0.092** | [ESTIMATE] §4 |
| AI cost per optimization — **BYOK** | **$0 to us** (user pays ≈ $0.048 on their own key) | [ESTIMATE] §4 |
| AI cost of an analysis only (score, no rewrite) | **$0.0014** | [ESTIMATE] §4.3 |
| Non-AI infrastructure per optimization | **< $0.001** | [ESTIMATE] §7 |
| Total monthly cost: 100 / 1,000 / 10,000 users, each doing 1 optimization per day, Hybrid | **≈ $184 / $1,540 / $14,700** | [ESTIMATE] §8 |
| Scenario A (54,000 optimizations/month) | **≈ $2,680/month** ($2,592 AI + ~$90 infra) | [ESTIMATE] §6 |
| Scenario B (300,000 optimizations/month) | **≈ $14,700/month** ($14,400 AI + ~$300 infra) | [ESTIMATE] §6 |
| Recommended Pro price | $19/month or $45/quarter, with a hard cap of 150 optimizations/month | [RECOMMENDATION] §11 |
| Gross margin at 1,000 / 10,000 monthly active users (4% paid conversion) | ≈ 54% / 65% | [ESTIMATE] §11 |
| Coupons: contribution per period with 30% off (monthly / quarterly), typical use | $10.62 / $24.87 (worst case $4.24 / $5.73); 50% off quarterly can go negative for capped heavy users | [ESTIMATE] §11.5 |

The main takeaway is that **cost is almost entirely the strong-model rewrite step, plus payment fees and the free tier.** Servers, database, Redis and CDN each cost less than a tenth of a cent per optimization. The design choices that actually move cost are:

1. which model does the rewrite;
2. how many output and reasoning tokens it produces;
3. how many rewrites the validator sends back for repair;
4. per-user quotas;
5. free-tier limits.

---

## 2. Verified unit prices

### 2.1 LLM token prices (USD per 1M tokens)

| Model | Input | Cached input | Output | Batch in / out | Source (checked 2026-09-29) |
|---|---:|---:|---:|---|---|
| **OpenAI `gpt-6-luna`** | **0.10** | 0.01 (cache write 0.125) | **0.50** | 0.05 / 0.25 | [FACT] https://developers.openai.com/api/docs/pricing |
| **OpenAI `gpt-6-sol`** | **2.00** | 0.20 (write 2.50) | **10.00** | 1.00 / 5.00 | [FACT] same |
| OpenAI `gpt-6-astra` (flagship) | 10.00 | 1.00 | 50.00 | 5.00 / 25.00 | [FACT] same |
| OpenAI `gpt-5.6-luna` | 0.20 | 0.02 | 1.20 | 0.10 / 0.60 | [FACT] same |
| OpenAI `gpt-5.6-sol` (promo) | 4.00 | 0.40 | 20.00 | 2.00 / 10.00 | [FACT] same (promo "at least through November 21, 2026") |
| OpenAI `text-embedding-3-small` | 0.02 | – | – | – | [FACT] same |
| **Anthropic `claude-sonnet-5-5`** | **2.00** | 0.20 (5-min write 2.50) | **10.00** | 1.00 / 5.00 | [FACT] https://platform.claude.com/docs/en/about-claude/pricing |
| Anthropic `claude-opus-5-5` | 4.00 | 0.20 | 20.00 | 2.00 / 10.00 | [FACT] same |
| Anthropic `claude-haiku-4-5` | 1.00 | 0.10 | 5.00 | 0.50 / 2.50 | [FACT] same (retirement "not sooner than 2026-10-15") |
| Google `gemini-3.8-flash` | 0.75 → **1.50 from 2027-01-01** | 0.075 → 0.15 | 3.75 → **7.50** | 0.375 / 1.875 | [FACT] https://ai.google.dev/gemini-api/docs/pricing |
| Google `gemini-3.1-flash-lite` | 0.25 | 0.025 | 1.50 | 0.125 / 0.75 | [FACT] same |
| Cloudflare Workers AI `bge-m3` embeddings | 0.012 | – | – | – | [FACT] https://developers.cloudflare.com/workers-ai/platform/pricing/ (checked 2026-09-28) |

Caveats that affect the model:

- **[FACT] The Claude tokenizer produces more tokens for the same text.** Claude 4.7 and later models "produce approximately 30% more tokens for the same text" (https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-09-29). Claude Sonnet 5.5 and GPT-6 Sol have the same list price, so **the same job costs about 1.3× more on Sonnet 5.5**. The sensitivity analysis in §12 accounts for this.
- **[FACT] Gemini 3.x Flash prices double on 2027-01-01.** Any Gemini-based projection past Q4 2026 must use the 2027 column.
- **[FACT] Reasoning and thinking tokens are billed as output.** Gemini says so explicitly: "Output price (including thinking tokens)". [ASSUMPTION] OpenAI's hidden reasoning tokens are also billed as output (standard OpenAI practice; see [ai-model-comparison.md](ai-model-comparison.md)).
- **[FACT] Current prices are unstable.** OpenAI cut GPT-6 Sol and Luna prices by 50% versus GPT-5.6 on 2026-09-22, and GPT-5.6 has a reported price increase scheduled for November. **Re-check prices before any pricing decision.**

### 2.2 "Luna" and "Sol" are real model tiers

- **[FACT]** OpenAI names its GPT-5.6 and GPT-6 model sizes Luna, Terra and Sol, "from smallest to largest". GPT-6 Astra is the flagship above Sol. Currently available: `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, plus the GPT-5.6 Luna/Terra/Sol models. There is no GPT-6 Terra yet. Sources: https://developers.openai.com/api/docs/models and https://simonwillison.net/2026/Jul/9/gpt-5-6/ (checked 2026-09-29).
- **[DECISION — confirmed by the owner on 2026-09-29]** **"Luna-heavy" means most calls go to `gpt-6-luna`**, and **"Sol-heavy" means most calls go to `gpt-6-sol`**. These are the GPT-6 tiers, not GPT-5.6. Note that Sol is *not* OpenAI's top model; Astra is.

### 2.3 Infrastructure and SaaS unit prices

The full table with 63 line items and sources is in the infra research notes. The prices below drive this model. All were checked 2026-09-28 or 2026-09-29.

| Item | Price | Included | Source |
|---|---|---|---|
| Cloudflare Workers Paid | $5/month minimum; $0.30/M requests; $0.02/M CPU-ms | 10M requests, 30M CPU-ms | [FACT] https://developers.cloudflare.com/workers/platform/pricing/ |
| Cloudflare Workflows steps | $0.80 per 100k steps | 500k/month | [FACT] https://developers.cloudflare.com/workflows/reference/pricing/ |
| Cloudflare Durable Objects | $0.15/M requests | 1M/month | [FACT] https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Cloudflare R2 | $0.015/GB-month, zero egress | 10 GB | [FACT] https://developers.cloudflare.com/r2/pricing/ |
| Cloudflare Browser Run (HTML→PDF fallback) | $0.09/browser-hour | 10 h/month | [FACT] https://developers.cloudflare.com/browser-rendering/pricing/ |
| Cloudflare AI Gateway (caching, rate limiting, analytics) | $0 when you use your own provider keys; Unified Billing carries a 5% fee | – | [FACT] https://developers.cloudflare.com/ai-gateway/reference/pricing/ |
| Neon Postgres, Launch plan | $0.106/CU-hour; $0.35/GB-month | no minimum | [FACT] https://neon.com/pricing (checked 2026-09-29) |
| Sentry | Developer free; Team $26/month; Business $80/month | 5k errors (free) | [FACT] https://sentry.io/pricing/ |
| Resend (email) | Free 3,000/month (100/day); Pro $20/month for 50k | – | [FACT] https://resend.com/pricing |
| Langfuse Cloud (LLM tracing) | Hobby free (50k units); Core $29/month; $8 per extra 100k units | – | [FACT] https://langfuse.com/pricing |
| Better Stack (uptime monitoring) | Free (10 monitors); Responder $29/month | – | [FACT] https://betterstack.com/pricing |
| Paddle (merchant of record) | 5% + $0.50 per transaction; custom pricing under $10 | – | [FACT] https://www.paddle.com/pricing |
| Chrome Web Store | $5 one-time | – | [FACT] https://developer.chrome.com/docs/extensions/whats-new (Apr 30 2026 entry mentions "the $5 registration fee") |
| Domain (.com via Cloudflare Registrar) | $10.46/year (≈ $11.17 after 2026-11-01) | – | [FACT, third-party tracker] https://cfdomainpricing.com/ |

---

## 3. Pipeline and token assumptions

The pipeline itself is described in [architecture.md](architecture.md) §8. The token counts below are **[ASSUMPTION]s** that must be replaced with measured values from the Phase 1 proof of concept.

Basis for these counts:

- A typical job description is 600–1,000 words.
- A typical resume is 1–2 pages, about 500–900 words.
- The strict-schema system prompts are 1,200–2,000 tokens.
- OpenAI tokenizers average ~0.75 words per token.

### 3.1 Per-step tokens, expected case

| # | Step | Model tier | Input tokens | Output tokens | Runs per optimization | Notes |
|---|---|---|---:|---:|---:|---|
| S1 | JD structuring: requirements, skills, experience, etc. | Cheap | 2,700 (1,500 prompt+schema, 1,200 JD) | 800 | 1.0 (no cache credit in the expected case) | Cacheable by `jd_hash` across users |
| S2 | Resume structuring: lines → canonical JSON with span IDs | Cheap | 3,000 | 2,000 | 0.1 (one per resume version, amortized over ~10 optimizations) | Runs only when the resume changes |
| S3 | Semantic mapping of JD requirements to resume evidence (only for ambiguous items) | Cheap | 3,600 | 700 | 1.0 | Exact and deterministic matches never reach the LLM |
| S4 | Evidence-bound rewrite: summary, targeted bullets, skills ordering | **Strong** | 6,300 | 2,000 visible + **1,000 reasoning** | 1.0 | Largest cost driver |
| S5 | Entailment check on changed bullets only | Cheap | 5,000 | 600 | 1.0 | Deterministic checks run first (see [architecture.md](architecture.md) §6.4) |
| S6 | Repair of bullets that failed validation | Strong | 3,000 | 800 + 1,000 reasoning | **0.2** (20% of runs need one repair) | One repair attempt, then fall back to the original bullet |
| S7 | Embeddings of requirement and skill phrases | Embedding | ~3,000 | – | 1.0 | Short phrases only |

### 3.2 Totals per optimization, expected case

| Tier | Input tokens | Output tokens (incl. reasoning) | Calculation |
|---|---:|---:|---|
| Cheap | **11,600** | **2,300** | In: 2,700 + 0.1×3,000 + 3,600 + 5,000 = 11,600. Out: 800 + 0.1×2,000 + 700 + 600 = 2,300 |
| Strong | **6,900** | **3,160** | In: 6,300 + 0.2×3,000 = 6,900. Out: (2,000 + 1,000) + 0.2×800 = 3,160. The repair step's reasoning tokens are excluded here and included in §5's worst case. |
| Embedding | 3,000 | – | |

---

## 4. Cost per optimization, by routing scenario

Formula: `cost = Σ (input_tokens × input_price + output_tokens × output_price) / 1,000,000`.

### 4.1 Hybrid (recommended): Luna for cheap steps, Sol for strong steps

| Component | Calculation | Cost |
|---|---|---:|
| Cheap input on Luna | 11,600 × $0.10 / 1M | $0.00116 |
| Cheap output on Luna | 2,300 × $0.50 / 1M | $0.00115 |
| Strong input on Sol | 6,900 × $2.00 / 1M | $0.01380 |
| Strong output on Sol | 3,160 × $10.00 / 1M | $0.03160 |
| Embeddings | 3,000 × $0.02 / 1M | $0.00006 |
| **Total** | | **$0.0478 ≈ $0.048** |

The strong step is **95%** of the cost ($0.0454 of $0.0478).

### 4.2 The four requested scenarios (brief §48)

| Scenario | Routing | Calculation | $/optimization |
|---|---|---|---:|
| **Luna-heavy** | Every step on Luna, including the rewrite; Sol only for repairs (S6) | Luna in (11,600 + 6,300) × 0.10 = $0.00179; Luna out (2,300 + 2,000 + 1,000) × 0.50 = $0.00265; Sol repair in 600 × 2 = $0.0012; Sol repair out (160 + 200 reasoning) × 10 = $0.0036 | **$0.0092** |
| **Sol-heavy** | Every step on Sol | In (11,600 + 6,900) × 2 = $0.0370; Out (2,300 + 3,160) × 10 = $0.0546 | **$0.092** |
| **Hybrid** | §4.1 | – | **$0.048** |
| **BYOK** | The same Hybrid routing, but on the user's own key | Our cost is $0; the user's provider bill is ≈ $0.048 | **$0 to us** |
| *Reference: frontier-heavy (Astra / Opus-class)* | Every step on `gpt-6-astra` | 5× Sol-heavy | *≈ $0.46* |

**[ASSUMPTION]** Luna-heavy quality is unproven for evidence-bound rewriting. The research found that fabrication is common in weakly guarded resume pipelines (see [ai-model-comparison.md](ai-model-comparison.md) §8). Luna-heavy is therefore a **cost floor to benchmark against, not a recommended default**. It becomes viable only if Luna passes the factuality thresholds in [ai-model-comparison.md](ai-model-comparison.md) §9.

### 4.3 Other billable units

| Unit | Steps | Calculation (Luna) | Cost |
|---|---|---|---:|
| Job analysis only (score, no rewrite) | S1 + S3 | (2,700 + 3,600) × 0.10 + (800 + 700) × 0.50, all / 1M | **$0.0014** |
| Resume structuring (once per resume version) | S2 | 3,000 × 0.10 + 2,000 × 0.50, / 1M | **$0.0013** |
| JD analysis when the shared cache hits | – | $0 (a Postgres lookup) | $0 |

---

## 5. Conservative / expected / worst-case

For the Hybrid route:

- **Conservative** means lean usage: shorter documents, good caching, fewer repairs.
- **Expected** is the base case from §3–4.
- **Worst-case** means large documents, heavy reasoning, many repairs, and retries.

| Driver | Conservative | Expected | Worst-case |
|---|---|---|---|
| Document token multiplier | 0.7× | 1.0× | 1.5× |
| Rewrite reasoning tokens | 500 | 1,000 | 3,000 |
| Repair rate (S6) | 10% | 20% | 50% (with 1,000 reasoning tokens per repair) |
| JD cache hit rate | 50% | 0% | 0% |
| Transport and 5xx retries | 0% | 0% | +10% |
| **Strong-model cost** | in 4,620 × 2 = $0.0092; out 1,956 × 10 = $0.0196 | $0.0454 | in 11,700 × 2 = $0.0234; out 7,100 × 10 = $0.0710 |
| **Cheap-model cost** | in 7,175 × 0.1 = $0.0007; out 1,330 × 0.5 = $0.0007 | $0.0023 | in 17,400 × 0.1 = $0.0017; out 3,450 × 0.5 = $0.0017 |
| **Total per optimization** | **≈ $0.030** | **≈ $0.048** | (0.0234 + 0.0710 + 0.0034) × 1.1 = **≈ $0.108** |

Worst-case strong tokens: input 6,300 × 1.5 = 9,450, plus repairs 0.5 × 3,000 × 1.5 = 2,250, giving 11,700. Output 3,000 visible + 3,000 reasoning, plus repairs 0.5 × (1,200 + 1,000) = 1,100, giving 7,100.

---

## 6. Owner stress scenarios A and B

| Scenario | Optimizations/month | AI, Hybrid expected | AI range (conservative to worst) | Infra (§7) | **Total, expected** | Per user |
|---|---:|---:|---:|---:|---:|---:|
| A: 60 users × 30/day | 54,000 | 54,000 × $0.048 = **$2,592** | $1,620 – $5,832 | ≈ $90 | **≈ $2,680** | **≈ $44.70/user/month** |
| B: 1,000 users × 10/day | 300,000 | 300,000 × $0.048 = **$14,400** | $9,000 – $32,400 | ≈ $300 | **≈ $14,700** | **≈ $14.70/user/month** |

The same scenarios under the other routings:

| Scenario | Luna-heavy | Sol-heavy | BYOK (our cost) |
|---|---:|---:|---:|
| A | 54,000 × 0.0092 = $497 + $90 = **$587** | 54,000 × 0.092 = $4,968 + $90 = **$5,058** | ≈ **$60** (infra only; calls go directly to the provider) |
| B | 300,000 × 0.0092 = $2,760 + $300 = **$3,060** | $27,600 + $300 = **$27,900** | ≈ **$150** |

**Bottlenecks** (details in [architecture.md](architecture.md) §13):

- **[ESTIMATE] Scenario B's peak rate** is about 250 LLM requests/min and ~1.5M tokens/min, assuming 30% of daily traffic falls in the peak hour and 5 calls per optimization. That fits OpenAI usage Tier 2–3 for Luna and Tier 3+ for Sol ([FACT] tier limits: https://developers.openai.com/api/docs/models/gpt-6-sol).
- **A brand-new Tier-1 account** (500 requests/min, 500K tokens/min) would be throttled at launch. Pre-purchase credits to reach Tier 3 before launch.
- **[FACT] Anthropic spend caps.** The Start tier caps monthly spend at $500 and Build at $1,000. Hitting the cap returns 429 `enforced_spend_limit_reached` and pauses usage until the 1st of next month (https://platform.claude.com/docs/en/api/rate-limits.md). Scenario B on a Claude primary would exceed Build within a few days, so **raise tiers before launch**.

**Scenario A is not a "small-user" scenario.** Thirty optimizations per user per day is roughly one every 16 minutes of an 8-hour day. At $19/month, an uncapped Scenario A user costs ~$45/month in AI alone. **Per-plan hard caps are mandatory** (§13).

---

## 7. Infrastructure cost by scale

Recommended stack: Cloudflare Workers + Workflows + Durable Objects + Hyperdrive → Neon Postgres + R2 + AI Gateway + Sentry + Resend + Better Stack + Paddle (see [architecture.md](architecture.md) §19). "Users" means monthly active users. The two right-hand columns cover Scenarios A and B.

| Line item | 100 users | 1,000 users | 10,000 users | Scenario A (54k opt/mo) | Scenario B (300k opt/mo) |
|---|---:|---:|---:|---:|---:|
| Workers Paid base | $5 | $5 | $5 | $5 | $5 |
| Workers CPU, Workflows steps, Queues, DOs | $0 | ~$1 | ~$15 | ~$1 | ~$15 |
| Browser Run PDF fallback (assumes 20% of PDFs rendered server-side, 3 s each) | $0 | $0 | ~$2 | $0 | ~$3 |
| Neon Postgres (Launch) | ~$7 | ~$20 | ~$90 | ~$20 | ~$90 |
| R2 (only for opt-in history) | $0 | $0 | ~$1 | $0 | ~$1 |
| Embeddings (Workers AI / OpenAI) | $0 | ~$1 | ~$6 | ~$2 | ~$18 |
| Sentry | $26 (Team) | $26 | $80 (Business) | $26 | $80 |
| Email (Resend) | $0 | $20 | $20 | $0 | $20 |
| LLM tracing (Langfuse, eval + sampled traces) | $0 | $29 | ~$45 | $29 | ~$45 |
| Uptime and status page (Better Stack) | $0 | $0 | $29 | $0 | $29 |
| Domain (amortized) | $1 | $1 | $1 | $1 | $1 |
| Payment platform fixed fee | $0 | $0 | $0 | $0 | $0 |
| **Monthly infra total** | **≈ $40** | **≈ $100** | **≈ $300** | **≈ $85–90** | **≈ $300** |
| One-time costs | $5 (Chrome Web Store) | – | – | – | – |

All monthly figures are [ESTIMATE]s built from the [FACT] unit prices in §2.3. The CPU-ms, Workflows steps and database sizes assumed here are listed in the infra research notes: 700 ms CPU and 6 Workflow steps per optimization, 30 KB of metadata rows, and no stored resume content.

**Stack comparison for Scenario B** ([ESTIMATE], from the infra notes):

| Stack | Scenario B cost | Why |
|---|---|---|
| Cloudflare-native | ≈ $105–205 | Billed on CPU time, so waiting 60 s for an LLM response costs almost nothing |
| AWS Lambda + API Gateway + RDS | ≈ $220–280 | Lambda bills wall-clock time spent waiting on LLMs: ≈ $143/month at 512 MB. A NAT gateway adds ≈ $33/month idle ([FACT] https://aws.amazon.com/vpc/pricing/). |
| Single Node container + managed Postgres (Railway, Render or Fly) | ≈ $20–85 | Also cheap. The trade-off is ops and single-region hosting, not cost. |

**Items excluded above** (they scale with revenue, or are optional):

- Payment processing (§11).
- Customer-support tooling.
- Legal and privacy-counsel fees ([OPEN QUESTION] budget $2–5k one-time for privacy policy, terms and a review of job-portal terms).
- Optional cloud OCR: ≈ $0.003 per 2-page scanned resume on Textract, Google or Azure ([FACT] https://aws.amazon.com/textract/pricing/, https://cloud.google.com/document-ai/pricing).

---

## 8. Master cost table (brief §48)

A "job" is one optimization. The Hybrid cost per job is $0.048, which includes that job's analysis. "Users" means active job seekers. All values are USD per month [ESTIMATE]s. **1 job/user/day is the expected planning rate. 10 jobs/user/day is the owner's heavy rate, and quotas would cap it in practice.**

### 8.1 Hybrid (recommended)

| Users | Jobs/User/Day | Jobs/Month | AI Cost | Infra Cost | Total |
|---:|---:|---:|---:|---:|---:|
| 100 | 1 | 3,000 | $144 | $40 | **$184** |
| 1,000 | 1 | 30,000 | $1,440 | $100 | **$1,540** |
| 10,000 | 1 | 300,000 | $14,400 | $300 | **$14,700** |
| 100 | 10 | 30,000 | $1,440 | $100 | **$1,540** |
| 1,000 | 10 | 300,000 | $14,400 | $300 | **$14,700** |
| 10,000 | 10 | 3,000,000 | $144,000 | ~$1,500 | **$145,500** |

### 8.2 Luna-heavy ($0.0092/job)

| Users | Jobs/User/Day | Jobs/Month | AI Cost | Infra Cost | Total |
|---:|---:|---:|---:|---:|---:|
| 100 | 1 | 3,000 | $28 | $40 | **$68** |
| 1,000 | 1 | 30,000 | $276 | $100 | **$376** |
| 10,000 | 1 | 300,000 | $2,760 | $300 | **$3,060** |
| 1,000 | 10 | 300,000 | $2,760 | $300 | **$3,060** |
| 10,000 | 10 | 3,000,000 | $27,600 | ~$1,500 | **$29,100** |

### 8.3 Sol-heavy ($0.092/job)

| Users | Jobs/User/Day | Jobs/Month | AI Cost | Infra Cost | Total |
|---:|---:|---:|---:|---:|---:|
| 100 | 1 | 3,000 | $276 | $40 | **$316** |
| 1,000 | 1 | 30,000 | $2,760 | $100 | **$2,860** |
| 10,000 | 1 | 300,000 | $27,600 | $300 | **$27,900** |
| 1,000 | 10 | 300,000 | $27,600 | $300 | **$27,900** |
| 10,000 | 10 | 3,000,000 | $276,000 | ~$1,500 | **$277,500** |

### 8.4 BYOK (AI billed to the user's own provider account)

| Users | Jobs/User/Day | Jobs/Month | AI Cost (us) | Infra Cost | Total (us) | User's own AI bill |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 1 | 3,000 | $0 | $30 | **$30** | ≈ $1.44/user/month |
| 1,000 | 1 | 30,000 | $0 | $60 | **$60** | ≈ $1.44/user/month |
| 10,000 | 1 | 300,000 | $0 | $150 | **$150** | ≈ $1.44/user/month |
| 10,000 | 10 | 3,000,000 | $0 | ~$400 | **~$400** | ≈ $14.40/user/month |

BYOK infra is lower because, in privacy-first BYOK mode, LLM calls go directly from the side panel to the provider. Our backend handles only licence checks, remote config and opt-in telemetry.

---

## 9. Cost per active user

| Usage profile | Optimizations/month | Analyses/month | AI per user (Hybrid) | AI per user (Luna-heavy) | AI per user (Sol-heavy) |
|---|---:|---:|---:|---:|---:|
| Free user at 50% of quota (3 optimizations, 15 analyses) | 1.5 | 7.5 | 1.5×0.048 + 7.5×0.0014 = **$0.083** | $0.024 | $0.34 |
| Typical paid user | 30 | 60 | 30×0.048 + 60×0.0014 = **$1.52** | $0.36 | $4.42 |
| Pro user at the hard cap | 150 | 500 | 150×0.048 + 500×0.0014 = **$7.90** | $2.08 | $27.60 |
| Owner Scenario A user | 900 | – | **$43.20** | $8.28 | $82.80 |

In the Sol-heavy column, analyses run on Sol at ≈ $0.028 each: (6,300 × 2 + 1,500 × 10) / 1M.

Adding infra from §7 gives a total of roughly **$0.40/user at 100 users, $0.10 at 1,000 and $0.03 at 10,000**.

---

## 10. AI cost optimization levers and their real value

| Lever | How it works | Savings on Hybrid ($0.048) | Verdict |
|---|---|---|---|
| **Cap output and reasoning tokens on the rewrite** | Rewrite only targeted sections (summary, ≤ 8 bullets, skills order). Set `reasoning.effort: low`. Cap `max_output_tokens`. | Cutting 1,000 reasoning tokens saves $0.010 (−21%) | **[RECOMMENDATION] #1 lever.** [FACT] Luna/Sol default reasoning effort is `medium` (https://developers.openai.com/api/docs/models/gpt-6-sol). |
| **Prompt caching** of the static system prompt and schema (≥ 1,024 tokens) | [FACT] OpenAI caches automatically. Cache reads cost 0.1× input; writes cost 1.25× on GPT-5.6+ (https://developers.openai.com/api/docs/guides/prompt-caching.md). Anthropic reads cost 0.1× and 5-minute writes 1.25×. | ~2,000 cached tokens on the strong step save ~2,000 × $2 × 0.9 / 1M = $0.0036 (−7.5%) | **Yes.** Put static content first and variable content last. Note that Gemini's implicit cache needs ≥ 4,096 tokens ([FACT] https://ai.google.dev/gemini-api/docs/caching), so it will rarely trigger for us. |
| **Shared JD-analysis cache** (normalized JD → SHA-256 → structured analysis) | If 500 users analyze the same job, run the JD step once and serve the other 499 from Postgres | Luna JD step costs $0.00067 per miss, so a 50% hit rate saves ~$0.0003 (−0.7%). On Sol-heavy it saves ~$0.0067 (−7%). | **Yes, but for consistency and speed more than money.** Every user sees the same requirement list for the same job, and a hit returns in ~50 ms instead of ~4 s. Cache derived structure only; see [security-threat-model.md](security-threat-model.md) §3 for the legal question. |
| **Resume preprocessing** | Parse once per resume version. Send only relevant sections and IDs, not raw files. | Already in the base case (S2 × 0.1). Trimming irrelevant roles reduces S4 input by ~20%, saving $0.0025. | **Yes** |
| **Deterministic first** | Exact, alias and taxonomy matching, plus scoring, handled in code. Only ambiguous requirements go to S3. | Keeps S3 small (already assumed) | **Yes, core design** |
| **Model routing by task** | Cheap model for extraction, classification and entailment; strong model only for the rewrite | Hybrid vs Sol-heavy saves 48% | **Yes, core design** |
| **Batch API** (50% off, 24 h) | [FACT] https://developers.openai.com/api/docs/guides/batch.md | Not for interactive use. Halves eval-suite and bulk JD pre-analysis cost. | Evals only |
| **Flex processing** | [FACT] Batch pricing on synchronous calls, but slower and may be unavailable (https://developers.openai.com/api/docs/guides/flex-processing.md) | Could halve the cost of the free tier's analyses | Consider for the free tier after measuring latency |
| **Semantic caching of rewrites** | Reuse outputs for "similar" prompts | Unsafe, because rewrites are specific to one person's resume | **No.** Wrong outputs would cross between users and resumes. |
| **Request dedup and idempotency** | An idempotency key per optimization means a double-click never bills twice | Prevents 2× spikes | **Yes** |
| **Cancel on close** | Abort the provider stream if the user cancels | Small | **Yes** |
| **Free NVIDIA API keys** (build.nvidia.com), raised by the owner on 2026-09-29 | Free trial access to hosted open models | Would be −100% on the steps routed there, **but it can't be used**: [FACT] the trial terms allow "limited trial purposes only and without use ... in production", forbid personal data, and let NVIDIA use content to improve its models ([admin-panel.md](admin-panel.md) §6.5.1) | **No for production. Yes for free evals** on synthetic data, to shortlist open models |
| **Open models on a production-licensed host** | Run an open model that wins our evals on a host whose terms allow production use and personal data, with a DPA | Cheap steps: little gain, because Luna already costs about the same as hosted 8B models ([ai-model-comparison.md](ai-model-comparison.md) §2.5). Rewrite step: large gain *if* an open model matched Sol on factuality (unproven). | **Evaluate after launch** using the dashboard's what-if simulator and evals ([admin-panel.md](admin-panel.md) §9.6) |
| **Measure, then optimize** | The admin AI usage dashboard shows cost and tokens by step, model, key and user; rule-based insights estimate the savings of each lever | Enables the levers above with evidence | **Yes** (OD-7) |

---

## 11. Unit economics, pricing and gross margin (brief §38)

### 11.1 Market price anchors

Source: [competitive-analysis.md](competitive-analysis.md). Checked 2026-09-28 and 2026-09-29.

- **Monthly paid tiers** cluster between $23.99 and $49.95. The median is ≈ $39.99 (Simplify $39.99, Huntr $40, Teal $29, Rezi $29, Jobscan $49.95).
- **Quarterly plans** cluster at ≈ $26–33 per month (e.g. Simplify $89.99 per 3 months, labelled "Most Popular").
- **LinkedIn Premium Career** costs $39.99/month ([FACT] https://premium.linkedin.com/careers/career).
- **ChatGPT resume tailoring** is included free ([FACT-SECONDARY], see the competitive notes). That puts a low ceiling on what users will pay for plain tailoring.

### 11.2 Recommended plans

This is a [RECOMMENDATION]; decision rationale is in [competitive-analysis.md](competitive-analysis.md) §7.

| Plan | Price | Includes | AI cost at full use | Paddle fee | Contribution at full use |
|---|---|---|---:|---:|---:|
| **Free** | $0 | Unlimited local match scoring (deterministic, no LLM); 15 AI job analyses/month; 3 AI optimizations/month; DOCX+PDF export | $0.165 | – | −$0.165 |
| **Pro (monthly)** | $19 | 150 optimizations/month (hard cap), 500 analyses, 25 optimizations/day cap, history sync | ≤ $7.90 | 5% + $0.50 = $1.45 | ≥ $9.65 |
| **Pro (quarterly, default)** | $45 per 3 months (≈ $15/month) | Same as monthly | ≤ $23.70 per quarter | $2.75 | ≥ $18.55 per quarter |
| **Credit pack** (no subscription) | $12 for 25 optimizations | Credits never expire | $1.20 | $1.10 | $9.70 |
| **BYOK (annual)** | $39/year | Unlimited optimizations with the user's own key; local-only mode | $0 | $2.45 | $36.55 |

**Why these prices:**

- They sit below the market median, which supports the "honest, no traps" positioning. There is no weekly plan and no trial that silently converts.
- They are high enough to absorb capped heavy users.
- **[FACT] Paddle requires custom pricing for products under $10** (https://www.paddle.com/pricing). That is why BYOK is sold annually and the credit pack is ≥ $10.

### 11.3 Revenue, cost and margin by scale

**Assumptions** (all [ASSUMPTION], clearly not measured):

- "Users" means monthly active users (MAU).
- Base-case paid conversion is **4%** of MAU. Freemium tools typically see 2–5%; we have no data of our own.
- Blended paid ARPU is **$16/month** (a mix of $19 monthly and $15 effective quarterly).
- Paid users average 30 optimizations and 60 analyses per month, costing $1.52 in AI.
- Free users use 50% of their quota, costing $0.083.
- Payment fee per paid user per month is 5% × $16 + $0.50 = $1.30. This slightly overstates quarterly billers, which is conservative.
- BYOK revenue is excluded as immaterial.

| MAU | Paid users | Revenue | AI cost | Infra | Payment fees | Total COGS | **Gross margin** |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 4 | 4 × 16 = **$64** | 4×1.52 + 96×0.083 = **$14** | $40 | $5 | $59 | **≈ 8%** |
| 1,000 | 40 | **$640** | 40×1.52 + 960×0.083 = **$141** | $100 | $52 | $293 | **≈ 54%** |
| 10,000 | 400 | **$6,400** | 400×1.52 + 9,600×0.083 = **$1,405** | $300 | $520 | $2,225 | **≈ 65%** |

Sensitivity to conversion rate, at 10,000 MAU:

| Conversion | Revenue | COGS | Gross margin |
|---|---:|---:|---:|
| 2% | $3,200 | ≈ $2,025 | ≈ 37% |
| 6% | $9,600 | ≈ $2,425 | ≈ 75% |

**Interpretation.** At 100 MAU the fixed tooling (Sentry, domain, database) dominates, so run it on free tiers until about 500 MAU. From about 1,000 MAU the product is gross-margin positive under the stated assumptions. **Free-tier AI is the largest cost line at scale:** $797 of the $1,405 at 10,000 MAU. The free tier's size is the main lever on margin.

These margins exclude labour, marketing, legal and support. **[OPEN QUESTION]** Customer-acquisition cost is unknown. Chrome Web Store organic discovery for this category is dominated by extensions with 100K+ users ([FACT] store counters in the competitive notes).

### 11.4 Payment processor choice and fees

- **[DECISION — confirmed by the owner on 2026-09-29] The owner (seller) is based in Canada.** This replaces the earlier India assumption, which was based on the session timezone. [OPEN QUESTION] Is the business incorporated (federally or provincially) or a sole proprietorship? This affects tax registration; ask a Canadian CPA.

**Payment options for a Canada-based seller** ([FACT] prices checked 2026-09-29):

| Option | Fee formula | Fee on a US$19 charge to a US card (international for a Canadian Stripe account) | Merchant of record? | Notes |
|---|---|---|---|---|
| **Paddle** | 5% + $0.50 | **$1.45 (7.6%)** | **Yes** | [FACT] https://www.paddle.com/pricing. Canada is not on Paddle's restricted-seller list. Custom pricing below $10. |
| **Stripe Managed Payments** (Stripe as merchant of record) | Standard Stripe CA fee (2.9% + CA$0.30, +0.8% international card, +2% if currency is converted) **+ 3.5%**, plus Billing 0.7% for subscriptions | 2.9% + 0.8% + 3.5% + 0.7% = 7.9% ($1.50) + CA$0.30 (≈ $0.22) = **≈ $1.72 (9.1%)**, or ≈ $2.10 if USD is converted to CAD | **Yes** | [FACT] Stripe CA pricing: https://stripe.com/en-ca/pricing. [FACT] Canada is an eligible Managed Payments business location (https://docs.stripe.com/payments/managed-payments/eligibility). [FACT-SECONDARY] GA in 2026; Checkout / Payment Links only. [ASSUMPTION] A USD bank account avoids the 2% conversion; verify. [ASSUMPTION] The 0.7% Billing pay-as-you-go rate applies to CA accounts (the CA page shows only contract pricing). |
| Stripe Billing + Stripe Tax (Stripe is *not* merchant of record) | 2.9% + 0.8% + 0.7% + 0.5% + CA$0.30 | ≈ **$1.15 (6.0%)** | **No** | Cheapest, but **you** register, collect and file sales tax/VAT/GST where required: Canadian GST/HST (plus QST for Quebec customers) and foreign digital-services VAT/GST obligations. Needs a CPA. |
| Lemon Squeezy | 5% + $0.50 (+ extras) | ≈ $1.45+ | Yes | [FACT] Its stated direction is migrating users to Stripe Managed Payments (https://www.lemonsqueezy.com/blog/2026-update), so skip it |

- **[RECOMMENDATION] Keep Paddle as merchant of record for launch.** It is the cheapest all-in merchant-of-record option on international cards, and it takes on global sales-tax compliance, fraud and chargebacks. **Stripe Managed Payments is now a valid alternative** because Canada is eligible. Choose it if you prefer the Stripe ecosystem; it costs about 1–1.5 percentage points more on US cards. Move to Stripe Billing + Stripe Tax (not a merchant of record) only once revenue justifies a CPA managing tax registrations.
- The cost model in §11.3 keeps the Paddle fee (5% + $0.50).
- *Superseded note:* the earlier analysis for an India-based seller (Stripe India invite-only; Managed Payments not available in India; Razorpay as a non-merchant-of-record option) no longer applies. It is kept in the infra research notes for reference.

### 11.5 Coupons and discounts (owner request, 2026-09-29)

The design is in [admin-panel.md](admin-panel.md) §7. Coupons can set a **% off per plan** (monthly, quarterly, BYOK, credit pack), a duration (first payment, N billing periods, or forever), and total and per-user limits.

Contribution per billing period **[ESTIMATE]**, using §11.2–11.3: Paddle fee 5% + $0.50 on the discounted amount; typical paid-user AI cost $1.52/month; worst case capped at $7.90/month.

| Plan and discount | Customer pays | Paddle fee | Contribution (typical) | Contribution (worst case) |
|---|---:|---:|---:|---:|
| Pro monthly, none | $19.00 | $1.45 | $16.03 | $9.65 |
| Pro monthly, 20% | $15.20 | $1.26 | $12.42 | $6.04 |
| Pro monthly, 30% | $13.30 | $1.17 | $10.62 | $4.24 |
| Pro monthly, 50% | $9.50 | $0.98 | $7.01 | $0.63 |
| Pro quarterly, none | $45.00 | $2.75 | $37.69 | $18.55 |
| Pro quarterly, 20% | $36.00 | $2.30 | $29.14 | $10.00 |
| Pro quarterly, 30% | $31.50 | $2.08 | $24.87 | $5.73 |
| Pro quarterly, 50% | $22.50 | $1.63 | $16.32 | **−$2.83** |
| Complimentary grant (instead of a 100% code) | $0 | $0 | −$1.52/month | −$7.90/month |

**Findings:**

- Discounts up to 30% stay comfortably positive even for capped heavy users.
- **50% off the quarterly plan can lose money on a capped heavy user.** Guardrail: for discounts above 40% on the quarterly plan, set a lower AI budget during the discounted periods, e.g. $4/month.
- 100% codes are replaced by **complimentary grants** that end automatically.
  - [OPEN QUESTION] Paddle's handling of $0 subscription checkouts isn't documented in the pages checked.
  - Grants also keep $0 "subscriptions" out of revenue metrics.
- **The fee floor hurts small charges.** The $0.50 fixed part of Paddle's fee is 5% of a $9.50 charge but only 2% of a $22.50 one. Deep discounts on the monthly plan are therefore the least efficient.
- **Base case:** the §11.3 margins assume no coupons. **[ASSUMPTION] Upper-bound scenario:** in a month where 30% of *all* paid users are in a 30%-off first period, blended ARPU falls ≈ 9% and the 10,000-MAU gross margin falls from ≈ 65% to ≈ 62%. It recovers as those users renew at full price. What matters is the full-price renewal rate of coupon users, which the admin panel reports per campaign.

**Guardrails** (the `coupons_policy` config, with hard caps in code): shared codes ≤ 50% off; "forever" discounts need the Owner role; every coupon needs an end date and a discount budget; redemption-spike alerts ([admin-panel.md](admin-panel.md) §7.9).

**Admin panel running cost [ESTIMATE]:** ≈ $0–5/month extra. It is a static SPA plus a second Worker on the existing Workers Paid plan, KV at admin volumes, and [FACT] Cloudflare Access free for up to 50 users (https://www.cloudflare.com/plans/zero-trust-services/). It doesn't change the infrastructure figures in §7–8.

---

## 12. Sensitivity analysis

Effect on the Hybrid expected cost of $0.048 per optimization:

| Change | New $/optimization | Δ |
|---|---:|---:|
| Tokens −50% | ≈ $0.024 | −50% |
| Tokens +50% | ≈ $0.072 | +50% |
| Rewrite reasoning 1,000 → 3,000 tokens | $0.068 | +42% |
| Rewrite reasoning 1,000 → 0 (`effort: none`) | $0.038 | −21% |
| Repair rate 20% → 50% | $0.055 | +15% |
| Strong model = Claude Sonnet 5.5 (same list price, ≈ 1.3× tokens) | ≈ $0.061 | +27% |
| Strong model = Claude Opus 5.5 ($4/$20, 1.3× tokens) | ≈ $0.12 | +150% |
| Strong model = `gpt-5.6-sol` promo ($4/$20) | ≈ $0.093 | +94% |
| *(Ruled out by the owner on 2026-09-29)* If the GPT-5.6 tiers had been meant ("Luna-heavy" on 5.6-luna $0.20/$1.20) | Luna-heavy ≈ $0.021 | +125% |
| Cheap tier = Gemini 3.8 Flash from 2027 ($1.50/$7.50) | ≈ $0.080 | +67% |
| Cheap tier = Gemini 3.1 Flash-Lite ($0.25/$1.50) | ≈ $0.052 | +8% |
| Prompt caching of 2k static tokens on all calls | ≈ $0.044 | −8% |
| OpenAI regional processing (+10%, e.g. EU residency) | ≈ $0.053 | +10% |

"Heavy-user tail" risk:

- **[ESTIMATE]** Without caps, if 5% of paid users behave like Scenario A (900/month), paid-user AI cost rises from $1.52 to 0.95 × 1.52 + 0.05 × 43.20 = **$3.60** per paid user. That is 22% of ARPU.
- The 150/month and 25/day caps bound this at $7.90.

---

## 13. Budget guardrails

These are [RECOMMENDATION]s, all enforced server-side. Details are in [architecture.md](architecture.md) §10.4 and [security-threat-model.md](security-threat-model.md) §6.

1. **Per-user quotas**, held as exact counters in a Durable Object or Postgres (see [architecture.md](architecture.md) §10.2):
   - Free: 3 optimizations and 15 analyses per month.
   - Pro: 150 optimizations/month, 25/day, and 500 analyses.
   - [FACT] OpenAI advises apps to "set a usage limit for individual users ... Consider implementing a hard cap" (https://developers.openai.com/api/docs/guides/rate-limits.md).
2. **A per-user AI dollar budget** of $8/month on Pro. After 80% of it is spent, the router moves remaining analyses to Luna. Rewrites stay on the strong tier until the budget is exhausted, then are blocked with a clear message.
3. **Per-request caps:**
   - `max_output_tokens` per step (S4 ≤ 4,000).
   - Input size caps: JD ≤ 20k characters; resume ≤ 6 pages or 25k characters.
   - One repair attempt only.
   - Retries only on transport errors or 5xx, never on semantic failure, with a maximum of 2.
4. **Global circuit breaker.** A daily global AI spend ceiling (e.g. 2× the trailing 7-day average) triggers an alert at 80% and a free-tier pause at 100%.
5. **Provider-side caps.** Project-level spend limits at each provider, with separate keys and projects for production, staging and evals.
   - [FACT] Anthropic spend limits return a non-retryable 400 or 429 (https://platform.claude.com/docs/en/api/rate-limits.md). Treat that as a failover signal, not a retry.
6. **Abuse controls:**
   - One free account per verified email and Google identity.
   - Disposable-email blocking.
   - Cloudflare Turnstile on sign-up (see [security-threat-model.md](security-threat-model.md) §6).
7. **Cost telemetry.** Every LLM call writes one `ai_requests` row: model, tokens, cost, cache hit, prompt version. Build a daily cost dashboard with per-plan and per-user top-N.

---

## 14. Challenges to the owner's assumptions

1. **"Cost modeling should focus on backend, database, Redis and CDN"** — not really. Each of those costs under $0.001 per optimization. Model tokens, repair rate, reasoning effort, the free tier and payment fees are what matter (§1, §7).
2. **"If 500 users analyze the same JD, caching saves a lot"** — it saves little money on a cheap extraction model (< 1% of cost). Do it for **consistency and latency**, not cost (§10).
3. **"Scenario A is a small deployment"** — at ~$45 per user per month in AI it is a stress test, and only hard caps make it survivable (§6).
4. **"Sol-heavy means frontier"** — Sol is OpenAI's mid-to-large tier. Astra is the flagship and costs 5× more (§2.2).
5. **"BYOK is free for us"** — our token bill is $0, but support is not. Users' key errors, provider rate limits and billing problems land on our support queue, and BYOK has a small addressable market (§11.2, [ai-model-comparison.md](ai-model-comparison.md) §5).

## 15. Open questions

1. ~~Luna/Sol meaning~~. **Resolved 2026-09-29:** GPT-6 Luna/Sol (§2.2).
2. What real token counts will the proof of concept measure? Replace §3.
3. Which strong model wins on factuality: `gpt-6-sol` or `claude-sonnet-5-5`? Latency and cost follow from that choice (§12).
4. ~~Owner location~~. **Resolved 2026-09-29:** Canada. Still open: the legal entity type and GST/HST/QST registration strategy, to confirm with a Canadian CPA (§11.4).
5. Paid conversion rate and customer-acquisition cost. Only beta data can answer these (§11.3).
6. Will GPT-6 prices hold? OpenAI and Google both have scheduled or promotional price changes in Q4 2026 and Q1 2027.
7. What is the full-price renewal rate of coupon users? It decides whether campaigns pay off (§11.5). The admin panel reports it per campaign.
8. Paddle behaviour for $0 checkouts, recurring discounts on 3-month prices, and discounts on plan switches: test in the sandbox ([admin-panel.md](admin-panel.md) §12).
