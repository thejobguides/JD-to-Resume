# AI Model Comparison — AI Resume / Job Match Optimizer

**Purpose.** This document covers the AI side of the product:

- current provider research (OpenAI, Anthropic, Google Gemini, OpenRouter, other hosts, local and on-device models);
- a model-selection matrix per task;
- the multi-model architecture;
- BYOK vs hosted vs hybrid;
- the "use an already-open ChatGPT/Claude/Gemini tab" question;
- AI cost optimization;
- the evaluation framework;
- the prompt architecture and versioning;
- the AI router design.

Last updated: 2026-09-29 · Companion docs: [cost-analysis.md](cost-analysis.md) (all dollar figures), [architecture.md](architecture.md), [security-threat-model.md](security-threat-model.md), [api-design.md](api-design.md)

**Labels:** **[FACT]** verified with the source URL and date · **[ASSUMPTION]** · **[ESTIMATE]** · **[RECOMMENDATION]** · **[OPEN QUESTION]**

> **Price volatility warning.** Late September 2026 is in the middle of a price war. Anthropic shipped Claude Opus 5.5 on 2026-09-22 and Claude Sonnet 5.5 on 2026-09-28. OpenAI shipped GPT-6 Sol and Luna on 2026-09-22 at half the GPT-5.6 price. Gemini 3.x Flash prices double on 2027-01-01. Re-verify every price before committing to a plan price.

---

## Table of contents

1. [Summary of decisions](#1-summary-of-decisions)
2. [Provider research](#2-provider-research)
3. [Local and on-device models](#3-local-and-on-device-models)
4. [What should and should not use an LLM](#4-what-should-and-should-not-use-an-llm)
5. [BYOK vs hosted vs hybrid](#5-byok-vs-hosted-vs-hybrid)
6. [The already-open ChatGPT / Claude / Gemini tab question](#6-the-already-open-chatgpt--claude--gemini-tab-question)
7. [Model-selection matrix](#7-model-selection-matrix)
8. [Hallucination: evidence from the literature](#8-hallucination-evidence-from-the-literature)
9. [Evaluation framework](#9-evaluation-framework)
10. [Prompt architecture](#10-prompt-architecture)
11. [AI router and provider abstraction](#11-ai-router-and-provider-abstraction)
12. [AI cost optimization](#12-ai-cost-optimization)
13. [Open questions](#13-open-questions)

---

## 1. Summary of decisions

| ID | Decision | Recommendation |
|---|---|---|
| AI-1 | Single model or multi-model? | **Multi-model, plus deterministic code.** A cheap model handles extraction, classification and entailment checks. A strong model does only the evidence-bound rewrite. Code does all scoring, keyword matching and validation. |
| AI-2 | Cheap tier | **OpenAI `gpt-6-luna`** ($0.10 / $0.50 per 1M tokens), primary. Fallback: **Gemini 3.1 Flash-Lite, paid tier only** ($0.25 / $1.50) or Claude Haiku 4.5 until Haiku 5.5 ships. |
| AI-3 | Strong tier | **Start with `gpt-6-sol` ($2 / $10)** and run **`claude-sonnet-5-5` ($2 / $10)** as the challenger and fallback. Choose the long-term default from the factuality bake-off in Phase 1 (§9). |
| AI-4 | OpenRouter | **Not in the production path for resume data.** Use it for benchmarking many models cheaply and as an emergency fallback. |
| AI-5 | Local models | **Not in the MVP core.** Chrome built-in AI (Gemini Nano) becomes an optional progressive enhancement for privacy mode after the MVP. Small in-browser embedding models are an option for BYOK/local mode. |
| AI-6 | BYOK / hosted / hybrid | **Hybrid:** a free deterministic local mode, plus hosted AI (Free quota + Pro), plus BYOK (annual plan). Hosted AI is the primary revenue path. |
| AI-7 | Use an open ChatGPT/Claude/Gemini tab | **No.** It is technically possible but explicitly prohibited or unsupported, unreliable, and a Chrome Web Store removal risk. Offer a user-driven "Copy prompt → paste answer → we validate" fallback after the MVP. |
| AI-8 | Prompts | Six separate, versioned prompts with strict JSON schemas and a server-side registry. No single giant prompt. |
| AI-9 | Evaluation | A golden dataset of ≥ 120 job descriptions and ≥ 24 resumes; automated metrics; a CI gate on every prompt or model change. |
| AI-10 | Who picks models and keys? *(owner request, 2026-09-29)* | **The admin panel.** It has a provider registry (incl. any **OpenAI-compatible** host), a write-only key vault, and the **model + key for each step** in the `ai_routing` config. Every change passes a data-policy rule in code and the eval gate ([admin-panel.md](admin-panel.md) §6.5). |
| AI-11 | NVIDIA free API keys (build.nvidia.com) | **Evals and prototyping only, with synthetic data.** [FACT] The trial terms forbid production use and personal data, and allow NVIDIA to use content to improve its models (§2.5). If an open model wins our evals, run it in production on a host with production terms and a DPA. |

---

## 2. Provider research

### 2.1 OpenAI

All facts checked 2026-09-29 against the Markdown versions of the official docs.

**Pricing** (per 1M tokens, "short context" ≤ 272K input; source: https://developers.openai.com/api/docs/pricing):

| Model | Input | Cached input | Cache write | Output | Batch / Flex (in / out) | Positioning (official models page) |
|---|---:|---:|---:|---:|---|---|
| gpt-6-astra | 10.00 | 1.00 | 12.50 | 50.00 | 5.00 / 25.00 | "Our most capable model, built for the hardest end-to-end work" |
| **gpt-6-sol** | **2.00** | 0.20 | 2.50 | **10.00** | 1.00 / 5.00 | "Built to power complex coding and agentic workflows" |
| **gpt-6-luna** | **0.10** | 0.01 | 0.125 | **0.50** | 0.05 / 0.25 | "Our most efficient model for focused, high-volume tasks" |
| gpt-5.6-sol (promo) | 4.00 | 0.40 | 5.00 | 20.00 | 2.00 / 10.00 | Previous generation flagship |
| gpt-5.6-terra | 2.00 | 0.20 | 2.50 | 12.00 | 1.00 / 6.00 | Mid tier |
| gpt-5.6-luna | 0.20 | 0.02 | 0.25 | 1.20 | 0.10 / 0.60 | Cost-sensitive |
| text-embedding-3-small | 0.02 | – | – | – | – | Embeddings |
| omni-moderation-latest | Free | – | – | – | – | Moderation |

**Specs.** GPT-6 Luna, Sol and Astra all have a 1,050,000-token context window, 922,000 max input and 128,000 max output. Knowledge cutoffs: Sol 2026-04-20, Luna 2026-05-18, Astra 2026-04-30. Luna and Sol support reasoning effort `none` through `max`, with **`medium` as the default**. [FACT] https://developers.openai.com/api/docs/models/gpt-6-luna.md, /gpt-6-sol.md

**Capabilities that matter for this product:**

- **[FACT] Structured Outputs** "ensures the model will always generate responses that adhere to your supplied JSON Schema" in strict mode. It is supported in the Responses, Chat Completions and Batch APIs. Limits: 5,000 properties, 10 nesting levels, 1,000 enum values. The first request with a new schema adds latency. Refusals come back in a separate field. (https://developers.openai.com/api/docs/guides/structured-outputs.md)
- **[FACT] Function calling on Chat Completions** works for GPT-6 Luna/Sol only with `reasoning_effort: none`. The docs direct you to the Responses API instead. **Implication:** use the Responses API with `store: false`.
- **[FACT] Only a dateless snapshot exists** (`gpt-6-luna`). The model can change behaviour under the same ID. **Implication:** pin quality with our own regression evals, and log the `model` value and response ID on every call.
- **[FACT] Prompt caching** is on by default, with a minimum cacheable prefix of 1,024 tokens. Reads cost 0.1× input and writes 1.25× (GPT-5.6+). The cache lives "at least 30 minutes". (https://developers.openai.com/api/docs/guides/prompt-caching.md)
- **[FACT] Fine-tuning is winding down.** "OpenAI is winding down the fine-tuning platform. The platform is no longer accessible to new users." (pricing page)
- **[FACT] Data handling:**
  - "data sent to the OpenAI API is not used to train or improve OpenAI models" by default.
  - Abuse-monitoring logs are kept "for up to 30 days".
  - `/v1/responses` keeps 30 days of application state unless `store: false`.
  - Zero Data Retention needs sales approval.
  - The Batch API is **not** eligible for Zero Data Retention.
  - India data residency covers storage only, not processing.
  (https://developers.openai.com/api/docs/guides/your-data.md)
- **[FACT] Rate limits** for gpt-6-luna and gpt-6-sol, by usage tier:

| Usage tier | gpt-6-luna (requests/min, tokens/min) | gpt-6-sol (requests/min, tokens/min) |
|---|---|---|
| Tier 1 | 500 / 500K | 500 / 500K |
| Tier 2 | 5,000 / 2M | 5,000 / 1M |
| Tier 3 | 5,000 / 4M | 5,000 / 2M |
| Tier 4 | 10,000 / 10M | 10,000 / 4M |
| Tier 5 | 30,000 / 180M | 15,000 / 40M |

  Tiers are unlocked by total spend: $5 → Tier 1, $50 → Tier 2, $100 → Tier 3, $250 → Tier 4, $1,000 → Tier 5. A `429 slow_down` can occur even within limits when traffic ramps too fast. (https://developers.openai.com/api/docs/guides/rate-limits.md)

**Suitability** (brief §4 asks per task):

- **JD extraction, resume parsing, classification:** Luna. Pinned in our evals with `effort: none/low`.
- **Semantic matching:** Luna, after deterministic matching has run.
- **Rewriting:** Sol, candidate default.
- **Final quality review:** Luna runs the entailment checks; Sol reviews only flagged items.

### 2.2 Anthropic (Claude API)

Source: https://platform.claude.com/docs/en/models/overview.md and /about-claude/pricing.md (checked 2026-09-29).

| Model | API ID | In / out ($ per 1M) | Cache hit | Batch | Context / max output | Speed (vendor label) | Retire not before |
|---|---|---:|---:|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | 10 / 50 | 0.25 | 5 / 25 | 1M / 128K | Slower | 2027-09-01 |
| Claude Opus 5.5 | `claude-opus-5-5` | 4 / 20 | 0.20 | 2 / 10 | 1M / 128K | Moderate | 2027-09-22 |
| **Claude Sonnet 5.5** | `claude-sonnet-5-5` | **2 / 10** | 0.20 | 1 / 5 | 1M / 128K | Fast | 2027-09-28 |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | 1 / 5 | 0.10 | 0.5 / 2.5 | 200K / 64K | Fastest | **2026-10-15** |

- **[FACT] Sonnet 5.5 was released 2026-09-28.** Anthropic's claims: "generates outputs 30%+ faster than Sonnet 5" and "costs up to 30% less per task" (https://www.anthropic.com/claude-sonnet-5-5). These are vendor claims; verify them on our own evals.
- **[FACT] Haiku 5.5** "will join the Claude 5.5 family in the coming weeks". Its price has not been announced.
- **[FACT] Pinned snapshots.** "Every Claude model ID is a pinned snapshot, including the dateless IDs". This makes regression testing easier than with OpenAI's floating IDs.
- **[FACT] Tokenizer.** Claude 4.7+ models produce "approximately 30% more tokens for the same text". **At the same list price, Sonnet 5.5 costs about 1.3× what Sol costs per job** (see [cost-analysis.md](cost-analysis.md) §12).
- **[FACT] Structured outputs are generally available**, via JSON outputs (`output_config.format`) and strict tool use. Limitations:
  - No numeric or string-length constraints and no recursive schemas.
  - "don't guarantee the capitalization of string enum ... values", so compare enums case-insensitively.
  - Check for `stop_reason: "refusal"` or `"max_tokens"` before parsing.
  - Schemas are cached for 24 hours, so **never put personal data in a schema**.
  (https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md)
- **[FACT] Breaking change in Sonnet 5.5:** "Forced tool use returns an error". Use `output_config.format` for JSON instead.
- **[FACT] Data retention:**
  - "Conversation content ... is not retained by default; the exception is Covered Models" (the Fable and Mythos models require 30-day retention).
  - The Batch API keeps data for 29 days.
  - Flagged content may be kept for up to 2 years.
  - "Retained data is never used for model training without your express permission."
  (https://platform.claude.com/docs/en/manage-claude/api-and-data-retention.md)
  - **This is a privacy advantage over OpenAI's default 30-day abuse logs.** It applies to Sonnet and Opus, but not to Fable.
- **[FACT] Rate limits and spend caps:**
  - Start tier: 1,000 RPM, 2M input tokens/min and 400K output tokens/min per model, with a **$500/month spend cap**. Build tier: $1,000 cap.
  - Hitting the cap returns 429 `enforced_spend_limit_reached`, and usage pauses until the 1st of the next month.
  - Cached input tokens do not count toward the input-token limit.
  (https://platform.claude.com/docs/en/api/rate-limits.md)
- **[FACT-SECONDARY] Browser calls.** Direct calls from a browser need the `anthropic-dangerous-direct-browser-access: true` header (https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/, checked 2026-09-29). [FACT] CORS is not supported for organizations with Zero Data Retention.

**Suitability:**

- Sonnet 5.5 is a strong candidate for the evidence-bound rewrite: pinned snapshots, no default retention, fast.
- Haiku 4.5 retires soon, so don't design around it.
- Avoid the Fable models for resume data because of their required 30-day retention.

### 2.3 Google Gemini API

Source: https://ai.google.dev/gemini-api/docs/pricing (checked 2026-09-29; Markdown version `.md.txt`).

| Model | Status | In / out ($ per 1M) | Notes |
|---|---|---|---|
| gemini-3.8-flash | Stable, new | 0.75 / 3.75 **until 2026-12-31, then 1.50 / 7.50** | Thinking is on by default (`medium`) |
| gemini-3.5-flash-lite | Stable | 0.30 / 2.50 | "document parsing ... simple data extraction" |
| **gemini-3.1-flash-lite** | Stable | **0.25 / 1.50** | Cheapest Gemini text model available to a new project |
| gemini-3.1-pro-preview | **Preview only** | 2 / 12 (≤ 200K context) | No GA Gemini 3.x Pro exists |
| gemini-2.5-flash-lite | Access-restricted | 0.10 / 0.40 | "limiting access to the 2.5 models to users who have actively used them" |

**Terms and limits:**

- **[FACT] Free tier terms.** The unpaid tier's inputs and outputs are used "to improve, and develop Google products", "human reviewers may read ... your API input and output", and "**Do not submit sensitive, confidential, or personal information to the Unpaid Services.**" Also: "You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom." (https://ai.google.dev/gemini-api/terms, effective 2026-03-23)
- **[FACT] Age requirement.** The terms say "You must be 18 years of age or older" and forbid services "likely to be accessed by individuals under the age of 18". [OPEN QUESTION for counsel] Job seekers include some under-18 users.
- **[FACT] Not for consumer use.** "Use of Google AI Studio and Gemini API is for developers building ... for professional or business purposes, not for consumer use." [OPEN QUESTION for counsel] Consumer BYOK with a personal Gemini key may conflict with this.
- **[FACT] Abuse-monitoring retention is 55 days.** Guaranteed zero retention requires Vertex AI. (https://ai.google.dev/gemini-api/docs/usage-policies, /docs/zdr)
- **[FACT] Implicit caching** needs a prefix of ≥ 4,096 tokens on 3.x models, so our prompts will rarely hit it.
- **[FACT] Structured output** is a JSON Schema subset. The docs say "always validate values in your application".
- **[FACT] Rate limits** are no longer published per model, and "Specified rate limits are not guaranteed". There is a spend-based limit of $10 per 10 minutes at Tier 1, and billing Tier 1 caps monthly spend at $250. (https://ai.google.dev/gemini-api/docs/rate-limits)

**Suitability:** Gemini 3.1 Flash-Lite is a reasonable **fallback** for the cheap tier on the **paid tier only**. Never send resume text to the free tier. The 2027 price increase and unpublished rate limits make Gemini a weaker primary choice.

### 2.4 OpenRouter

Sources: https://openrouter.ai/docs/faq, /docs/guides/overview/auth/byok, /docs/guides/routing/provider-selection, /docs/guides/features/structured-outputs, /docs/guides/privacy/data-collection (checked 2026-09-29).

- **[FACT] Pricing.** "We pass through the pricing of the underlying providers; there is no markup on inference pricing". There is a **5.5% fee on card credit purchases** (minimum $0.80). BYOK is free up to $25,000/month of list-price usage, then 5%.
- **[FACT] Structured outputs vary.** "Support is determined per endpoint ... exact compliance is not guaranteed on every endpoint". Use `require_parameters: true`.
- **[FACT] Data retention routing.** Enabling ZDR routing for the OpenAI group "Removes first-party OpenAI endpoints (Azure remains available)", and similarly for Anthropic and AI Studio. First-party endpoints routed through OpenRouter are therefore treated as non-ZDR.
- **[FACT] Open-weight hosts vary widely.** 30-minute uptime for `openai/gpt-oss-120b` ranged from 41% to 100% across providers, with quantizations from fp4 to fp16.
- **[FACT-conflict] Price metadata can be wrong.** OpenRouter lists `openai/gpt-5.6-sol` at $2/$10 on the OpenAI endpoint, while OpenAI's page says $4/$20. Always reconcile router metadata against provider invoices.

| Option | Verdict |
|---|---|
| Direct provider SDKs behind our own `AIProvider` interface | **[RECOMMENDATION] Default.** Full access to provider-specific features (`store:false`, cache breakpoints, `output_config`), a direct data-processing agreement with each vendor, and no extra processor handling personal data. |
| Vercel AI SDK (`ai`, Apache-2.0, v7.x) as the adapter layer | **[RECOMMENDATION] Use under our router.** It runs in-process with no extra network hop, validates schemas (Zod), and runs in Workers and extension pages (useful for BYOK). |
| LiteLLM proxy | Viable at scale. [FACT] PyPI releases 1.82.7 and 1.82.8 were malicious for ~40 minutes on 2026-03-24 (https://docs.litellm.ai/blog/security-update-march-2026). Pin hashes if used. |
| OpenRouter | **Evals, exploration, emergency fallback only.** |
| Cloudflare AI Gateway | **Yes, in front of direct providers** with our own keys: free caching, rate limiting and analytics. Turn off request/response body logging (see [architecture.md](architecture.md) §10.3). |

### 2.5 Other hosted options (cheap open-weight inference)

- **[FACT] Cloudflare Workers AI prices** (https://developers.cloudflare.com/workers-ai/platform/pricing/, checked 2026-09-28): Llama 3.1 8B $0.045 / $0.384; Llama 3.3 70B $0.293 / $2.253; Mistral Small 24B $0.351 / $0.555; bge-m3 embeddings $0.012.
- **[ASSUMPTION]** Groq, Together, Fireworks, DeepSeek and the Mistral API price 7–70B open models from about $0.05 to $1 per 1M tokens. These were **not re-verified this session**.
- **Verdict:** at $0.10 / $0.50, GPT-6 Luna already costs about the same as hosted 8B models, with strict structured outputs and better instruction following. **Open-weight hosting does not save money for us at MVP scale** and adds variance in quality and reliability.
- **NVIDIA API Catalog (build.nvidia.com), free keys**, raised by the owner on 2026-09-29. [FACT] From the NVIDIA API Trial Terms of Service, v. September 19, 2025 (https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf):
  - §1.2: "limited trial purposes only and without use of the API Service or Generated Content in production";
  - §2.6(a): no "personal data (unless expressly permitted by an API Service)";
  - §3.3: NVIDIA collects "User Content and Generated Content to improve NVIDIA products and services, including AI models".
  - [FACT] NVIDIA's FAQ: free access "is for prototyping, research, development and testing purposes only". Production needs NVIDIA AI Enterprise, "start[ing] at $4500 per GPU per year" (https://docs.api.nvidia.com/nim/docs/product).
  - [FACT-SECONDARY] About 40 requests/minute on the free tier.
  - [ASSUMPTION] It is OpenAI-compatible at `https://integrate.api.nvidia.com/v1`.
  - **Verdict:** a **free eval sandbox** for open models on synthetic resumes and public JDs. It can **never** be in a production route; the admin panel enforces this ([admin-panel.md](admin-panel.md) §6.5.3).

---

## 3. Local and on-device models

### 3.1 Chrome built-in AI (Gemini Nano)

Source: https://developer.chrome.com/docs/ai/prompt-api and /docs/ai/built-in-apis (checked 2026-09-29).

- **[FACT] Availability.** The Prompt API is available to extensions from Chrome 138 and on the web from Chrome 148. Chrome stable is at 154.
- **[FACT] Hardware requirements.** Windows, macOS 13+, Linux or Chromebook Plus. **≥ 22 GB free disk**, and either a GPU with > 4 GB VRAM or a CPU with ≥ 16 GB RAM and 4 cores. Not available on Android or iOS.
- **[FACT] Features.** `responseConstraint` gives structured output via JSON Schema or regex. Languages are limited to en, ja, es, de and fr. "No data is sent to Google or any third party".
- **[ASSUMPTION]** A large share of job seekers' laptops will not meet the hardware bar. Output also varies by device and model version, which makes evaluation hard.
- **Verdict:** use it post-MVP as an **optional enhancement** in privacy mode, for section classification, local skill-phrase extraction and language detection. Never make it the only path for scoring or rewriting.

### 3.2 In-browser WASM models (Transformers.js / ONNX, WebLLM)

- **[ASSUMPTION]** (not re-verified this session) Small sentence-embedding models such as MiniLM, bge-small or gte-small, at roughly 20–130 MB, run in a browser worker with acceptable latency for scoring a few hundred short phrases.
- **[FACT] Remote code rules.** WASM must be bundled because MV3 forbids remotely hosted code. Extension pages need `'wasm-unsafe-eval'` in their CSP (https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy). Model weights are data, not code, so they may be downloaded on first use.
- **Verdict:** for **privacy/BYOK mode** after the MVP, a local embedding model enables semantic matching without sending anything out. Generative 1–8B models in the browser are too heavy and too weak for evidence-bound rewriting.

### 3.3 Self-hosted open models on GPUs

- **[ESTIMATE]** A single always-on GPU instance costs hundreds of dollars a month (not re-verified). Scenario B's entire expected Luna bill is about $2,760/month for 300,000 optimizations.
- **Verdict:** not economically justified before very high scale, and it adds operational burden. Revisit only if volume exceeds roughly 5M optimizations a month or if a data-residency customer requires it.

### 3.4 Can small or local models handle our cheap tasks?

| Task | Local / small model feasible? | Notes |
|---|---|---|
| Keyword extraction | **Yes**, and deterministic code is often better | Use a taxonomy plus n-gram matching; see §4 |
| Resume section classification | Yes (heuristics, then a small model) | Headings dictionary plus font cues handle ~90% [ASSUMPTION] |
| Skill extraction | Partially | Taxonomy matching gives precision; an LLM helps recall on novel terms |
| Semantic matching | Yes, with embeddings | Needs calibrated thresholds on our dataset |
| Evidence-bound rewriting | **No** at MVP quality | Strong hosted model plus validation |

---

## 4. What should and should not use an LLM

| Should **NOT** use an LLM (deterministic code) | **Should** use an LLM |
|---|---|
| Final score computation, weights, normalization, confidence | Structuring free-text JDs into requirement objects (S1) |
| Exact, alias and taxonomy skill matching | Structuring resume lines into schema fields with span citations (S2) |
| Keyword coverage and anti-stuffing saturation | Deciding whether ambiguous requirements are satisfied by evidence (S3) |
| Years-of-experience arithmetic and date parsing | Evidence-bound rewriting of the summary and bullets (S4) |
| Number, entity, date and new-skill diffs between the original and the rewrite (hallucination gate 1) | Entailment and "scope inflation" judgements on changed bullets (S5) |
| Schema validation, referential integrity of evidence IDs | Repairing bullets that failed validation (S6) |
| JSON-LD / DOM extraction, site detection, text cleanup | – |
| DOCX/PDF generation, template layout | – |
| Quotas, routing, retries, caching | – |
| Prompt-injection heuristics such as hidden-text removal (a classifier is optional) | – |

Why the split matters: an LLM "ATS score" would be unexplainable, would drift across model versions, and would be easy to game. The brief explicitly forbids it.

---

## 5. BYOK vs hosted vs hybrid

### 5.1 Option A — Bring Your Own Key

| Dimension | Analysis |
|---|---|
| Security | The key lives in the extension. [FACT] "extension storage is not encrypted" (https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy), and DevTools can view `chrome.storage` from Chrome 132. **Mitigation:** keep the key in `storage.session` (memory only, not exposed to content scripts) by default, offer an optional encrypted "remember" setting, and call providers from the side panel only, never from content scripts. The full analysis is in [security-threat-model.md](security-threat-model.md) §5. |
| UX | Poor for mainstream job seekers, who must create a developer account, add billing and paste a key. [FACT] Gemini's terms say the API is "not for consumer use", and its free tier forbids personal data. Good for power users and privacy-sensitive users. |
| Cost to us | Tokens $0. Infra is small (licence and config only). Support cost is **not** zero: key errors, provider 429s and 402s all reach our support. |
| Cost to user | ≈ $0.048 per optimization on the Hybrid route ([cost-analysis.md](cost-analysis.md)), plus the provider's minimum prepayment (e.g. Gemini: $5 minimum prepay; OpenAI Tier 1 at $5). |
| Commercial viability | Small segment. [FACT] No mainstream competitor offers BYOK (competitive notes). It is a differentiator for trust, but not a primary revenue line. |
| Support burden | Medium: provider-specific errors, CORS/header quirks, model deprecations. |

### 5.2 Option B — Our hosted AI

| Dimension | Analysis |
|---|---|
| Infrastructure | Workers API → AI router → AI Gateway → providers. Long rewrites run as Workflows jobs with progress updates. See [architecture.md](architecture.md). |
| Cost | $0.048 per optimization expected, $0.108 worst case ([cost-analysis.md](cost-analysis.md) §4–5). |
| Rate limits | Provider account tiers must be raised before launch (OpenAI Tier 3+, Anthropic Build+). |
| Abuse prevention | Accounts are required for hosted AI. Exact quotas, per-user dollar budgets, Turnstile, disposable-email blocking. |
| Billing | Paddle subscriptions plus credit packs. |
| Scalability | Stateless Workers; the bottleneck is provider rate limits. |

### 5.3 Option C — Hybrid (**recommended**)

| Mode | Who it's for | What runs where |
|---|---|---|
| **Local (free, no account)** | Everyone, first run | JD extraction, resume parsing, deterministic match score, missing and weak evidence list, DOCX/PDF export of the *original* structured resume in a clean template. No LLM. |
| **Hosted AI (Free quota → Pro)** | Mainstream users | Adds LLM requirement structuring, semantic mapping and the evidence-bound rewrite with validation. |
| **BYOK (annual)** | Power and privacy users | The same AI pipeline, but called directly from the side panel with the user's key. Nothing goes to our backend. |

**Why hybrid:**

1. The local mode delivers real value with zero AI cost and zero privacy exposure. That drives installs and trust.
2. Hosted AI is the monetizable, frictionless path.
3. BYOK serves the privacy segment at near-zero cost to us.

**Risk:** three code paths to support. **Mitigation:** one shared `packages/ai` pipeline with pluggable transport (hosted vs direct), and one shared scoring package.

---

## 6. The already-open ChatGPT / Claude / Gemini tab question

Full evidence is in the chrome-extension and platform-legal research notes (checked 2026-09-29).

### 6.1 Five different mechanisms

| # | Mechanism | Official? | Reliability | Verdict |
|---|---|---|---|---|
| 1 | **Official API** with our key or the user's key | Yes | High | ✅ Use this |
| 2 | **Extension-to-extension messaging** with an official AI extension (e.g. Claude in Chrome) | No public interface. [FACT] The Claude in Chrome docs describe no third-party integration. | N/A | ❌ |
| 3 | **Web UI automation**: a content script types into chatgpt.com and reads the DOM | No | Low: breaks on DOM changes, A/B tests, bot checks | ❌ |
| 4 | **Unofficial scraping** of private endpoints (e.g. `/backend-api/conversation`) | No | Very low: bot-defence tokens change | ❌ |
| 5 | **Browser session reuse**: send cookie-bearing requests as the user | No, and **explicitly forbidden** by Anthropic | Very low | ❌ |

### 6.2 Answers to the brief's six questions

1. **Technically possible?** Yes, with host permissions on those sites. [FACT] Extension requests to hosts it has permission for are treated as same-site, so the user's cookies get sent (https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies).
2. **Officially supported?** **No.**
   - [FACT] OpenAI Terms (effective 2026-01-01) prohibit "Automatically or programmatically extract data or Output" and "bypass any protective measures" (https://openai.com/policies/row-terms-of-use/).
   - [FACT] Anthropic Consumer Terms prohibit access "through automated or non-human means ... Except when you are accessing our Services via an Anthropic API Key" (https://www.anthropic.com/legal/consumer-terms).
   - [FACT] Anthropic says "developers may not collect, store, or intermediate Claude.ai credentials or session tokens" (https://code.claude.com/docs/en/legal-and-compliance).
   - [FACT] Google Terms prohibit "using automated means to access content ... in violation of the machine-readable instructions", and gemini.google.com's robots.txt disallows `/app/` (https://policies.google.com/terms).
3. **Reliable?** **No.** [UNOFFICIAL-SOURCE] ChatGPT's Sentinel/Turnstile challenge "blocked conversation tools since 2026-09-08" (https://github.com/robotlearning123/gpt2agent). Earlier session-reuse extensions accumulated "pass Cloudflare check" failures (https://github.com/wong2/chatgpt-google-extension/issues).
4. **Security concerns?** Yes:
   - It needs broad access to the user's AI accounts and chat history.
   - It creates a job page → AI tab prompt-injection path.
   - The user's AI account could be suspended.
   - The extension becomes a high-value target for attackers.
5. **Platform or terms concerns?** Yes. [FACT] A **Chrome Web Store policy dated July 1, 2026 (enforced from August 1, 2026)** "explicitly disallow[s] extensions designed to circumvent safety guardrails, usage restrictions, or other protective measures implemented by AI-powered services" (https://developer.chrome.com/blog/cws-policy-updates-2026). This puts the **entire listing** at risk, not just the feature.
6. **Appropriate for production?** **No. [RECOMMENDATION] Do not build it.**

### 6.3 Legitimate alternatives

- **(a) Free deterministic mode.** No AI needed.
- **(b) BYOK.** Official APIs.
- **(c) Hosted AI.**
- **(d) Optional Chrome built-in AI.** The only officially supported "no API key" LLM path for an extension (§3.1).
- **(e) "Copy prompt" hand-off.** The extension assembles an evidence-tagged prompt. The *user* pastes it into any chatbot and pastes the answer back. The extension then validates the answer against the Evidence Store before accepting any change. This is user-driven with no automation, costs us nothing, and keeps our truthfulness checks. The UX is clunky, so treat it as a post-MVP fallback.
- **(f) MCP apps or connectors** (ChatGPT Apps SDK, Claude custom connectors, Gemini custom MCP): the reverse direction, where the user's own chatbot calls *our* tools. [FACT] Constraints:
  - OpenAI apps "must not display subscription plans, initiate new subscriptions, or promote upgrades" (https://developers.openai.com/apps-sdk/app-submission-guidelines).
  - Gemini custom MCP is US-only, English-only, personal accounts only (https://support.google.com/gemini/answer/17209137).
  - This is a **post-MVP distribution channel**, not the extension's AI backend.

---

## 7. Model-selection matrix

Ratings: Quality, Latency and Reliability are 1–5 [ASSUMPTION]s to be replaced by Phase 1 eval results. Costs are [FACT] list prices, and per-call costs use the token counts in [cost-analysis.md](cost-analysis.md) §3.

| # | Task | Model | Quality | Cost per call | Latency | Reliability | Recommendation |
|---|---|---|---:|---:|---:|---:|---|
| 1 | **JD parsing** (S1) | gpt-6-luna, `effort: none`, strict schema | 4 | $0.00067 | 5 (~2–4 s) | 4 | **Primary** |
| | | gemini-3.1-flash-lite (paid tier) | 3–4 | $0.0019 | 5 | 3 (unpublished rate limits) | Fallback |
| | | Deterministic JSON-LD mapping | 5 where present | $0 | 5 | 5 | **Always run first.** The LLM fills gaps and classifies. |
| 2 | **Resume parsing** (S2) | Deterministic layout (pdf.js/mammoth) → gpt-6-luna for field mapping with span citations | 4 | $0.0013 per version | 4 | 4 | **Primary.** The validator rejects any value not found in the cited spans. |
| | | claude-haiku-4-5 → Haiku 5.5 | 4 | $0.013 | 5 | 4 (retiring) | Fallback |
| 3 | **Skill extraction** | Taxonomy + alias dictionary + n-grams (deterministic) | 4 (precision) | $0 | 5 | 5 | **Primary** |
| | | gpt-6-luna for novel terms (inside S1/S2) | 4 (recall) | included | – | 4 | Complement |
| 4 | **Requirement classification** (must / preferred / responsibility / education / cert / years / location) | gpt-6-luna within S1 | 4 | included | – | 4 | **Primary.** Section-heading cues ("Requirements", "Nice to have") are applied deterministically first. |
| 5 | **Semantic matching** (S3) | Embeddings (text-embedding-3-small or bge-m3) + thresholds, then gpt-6-luna for ambiguous pairs | 4 | $0.0007 | 4 | 4 | **Primary** |
| | | gpt-6-sol for all pairs | 5 | $0.014 | 3 | 4 | Not justified |
| 6 | **Resume optimization** (S4) | **gpt-6-sol**, `effort: low`, strict schema with evidence IDs | 4–5 (TBD) | $0.045 | 3 (~20–45 s) | 4 | **Start here** |
| | | **claude-sonnet-5-5**, JSON outputs | 4–5 (TBD) | ≈ $0.059 (1.3× tokens) | 3–4 | 4 (pinned snapshot) | **Challenger / fallback.** Pick the winner by factuality. |
| | | gpt-6-luna | 3 (TBD) | $0.004 | 4 | 4 | Only if it passes factuality thresholds (Luna-heavy) |
| | | gpt-6-astra / claude-opus-5-5 | 5 | $0.23 / $0.12 | 2–3 | 4 | Not justified at MVP |
| 7 | **Bullet rewriting** (inside S4, and S6 repair) | Same as #6 | – | – | – | – | Same model as S4 for a consistent voice |
| 8 | **Hallucination detection** (S5) | **Deterministic diffs first** (numbers, entities, new skills, dates, verb-strength), then gpt-6-luna entailment per changed bullet | 4 | $0.0008 | 4 | 4 | **Primary** |
| | | Cross-vendor judge (claude-haiku / sonnet) on a sample | 5 | varies | 3 | 4 | Offline QA sampling, not per request |
| 9 | **Final quality review** | Deterministic rubric (length, verb start, no first person, tense, duplication) + Luna flags; Sol reviews only flagged bullets | 4 | ~$0.001 | 4 | 4 | **Primary.** No extra strong-model pass per request. |

**Is multi-model appropriate?** Yes:

- ~95% of cost sits in one step (S4), so a strong model is paid for only where writing quality matters.
- Deterministic code owns everything that must be explainable (score) or safe (validation).
- A different model family can run offline factuality audits, which reduces shared blind spots.

**Cost of the design:** two to three providers' data-processing agreements, adapters, and eval matrices.

---

## 8. Hallucination: evidence from the literature

- **[FACT] Fabrication is the default in weakly guarded pipelines.** arXiv 2608.26171 (Takano, v2 2026-09-16), a single-author preprint that is not peer-reviewed: "the baseline ... produced at least one unsupported claim in 96.7% of outputs". Prompt guardrails cut the density by 86%, but "50.0% of outputs still contained a fabrication". (https://arxiv.org/abs/2608.26171)
- **[FACT] Layered defences work.** arXiv 2607.01457 (Indukuri & Agrawal, 2026-07-01), a preprint on 25 synthetic resumes: failure modes are "anachronistic technology injection, cross-domain terminology contamination, structural mutation, and content fabrication". A five-layer defence reduced hallucinations from 2.48–5.36 to **0.04–0.24 per resume**. (https://arxiv.org/abs/2607.01457)
- **[FACT] Honesty is a market issue.** Greenhouse's 2025 report found "32% have claimed AI skills they don't actually have" (https://www.greenhouse.com/blog/greenhouse-2025-workforce-hiring-report).
- **Implication:** prompts alone are insufficient. Our design needs structural constraints (evidence IDs, schema), deterministic gates, entailment checks, a repair loop, fail-safe reverts and user review. See [architecture.md](architecture.md) §6.

---

## 9. Evaluation framework

### 9.1 Benchmark dataset ("golden set")

| Component | Size | Composition | Labels |
|---|---|---|---|
| Job descriptions | **≥ 120** (MVP), growing to 300 | 12 role families (SWE, data, PM, design, marketing, sales, finance, ops, healthcare, education, customer support, early-career) × seniority (entry/mid/senior) × source (Greenhouse, Lever, Ashby, Workday, iCIMS, SmartRecruiters, generic career pages, pasted text from LinkedIn/Indeed by the user) × quirks (no sections, bullet-less prose, multi-location, salary ranges, non-English (5%), **10 adversarial prompt-injection JDs**) | Requirement list with type (must/preferred/responsibility/edu/cert/years/location), normalized skills, years, title, company, salary |
| Resumes | **≥ 24** (MVP), growing to 60 | **Synthetic or consented only.** Formats: 1-column PDF, **2-column PDF**, Canva-style PDF, DOCX with header contact, DOCX with tables and text boxes, **scanned PDF**, TXT, LinkedIn "Save to PDF" export. Levels: student, career-switcher, mid, senior, gaps, non-linear careers. | Gold canonical JSON (fields and bullets) with span IDs; gold evidence claims (skills, metrics, employers, dates, certs) |
| JD×resume pairs | **≥ 300** labelled pairs | Stratified: strong fit, partial fit, poor fit | Per-requirement gold match state (0 / 0.3 / 0.6 / 1 / unknown); expert overall fit (1–5) |
| Rewrite judgements | ≥ 100 optimized outputs per model candidate | – | Per-bullet: entailed / embellished / fabricated; readability 1–5; relevance 1–5 |

**Sourcing and licensing:**

- **[RECOMMENDATION]** Collect JD text only through official public job-board APIs (Greenhouse, Lever and Ashby explicitly allow public reads) or by manual copy for internal testing. Store it with source URL and date.
- Do **not** crawl LinkedIn or Indeed.
- Generate resumes synthetically or recruit consenting volunteers with written consent.
- [OPEN QUESTION] Check the licences of public Kaggle resume/JD datasets before use. Many are scraped and unsuitable.

### 9.2 Metrics

| Metric | Definition | MVP threshold |
|---|---|---|
| **Requirement Recall (JD)** | matched gold requirements / total gold requirements (fuzzy match on normalized text) | ≥ 0.90 |
| **Requirement Precision (JD)** | correct extracted requirements / total extracted | ≥ 0.90 |
| **Requirement Type Accuracy** | correct type / matched requirements | ≥ 0.85 (must vs preferred ≥ 0.90) |
| **Skill Extraction F1** | F1 of normalized skills vs gold (JD and resume separately) | ≥ 0.85 |
| **Resume Field Accuracy** | exact-match rate for name, email, phone, titles, employers, dates, education | ≥ 0.95 contact, ≥ 0.92 roles/dates |
| **Span Fidelity** | extracted values whose text appears in the cited span | **1.00** (hard gate) |
| **Match Accuracy** | agreement of per-requirement match state with gold (weighted κ) | κ ≥ 0.70 |
| **Score Calibration** | Spearman ρ between Job Match Score and expert fit ratings | ρ ≥ 0.70 |
| **Hallucination Rate (bullet level)** | fabricated or unsupported bullets / changed bullets, **after validation** | **≤ 0.5%** (target 0) |
| **Hallucination Rate (resume level)** | outputs with ≥ 1 fabricated claim / outputs | ≤ 2% |
| **Validator Recall** | fabricated claims caught by the validator / injected fabrications (on a seeded set) | ≥ 0.95 |
| **Resume Factuality** | entailed claims / total claims in the output | ≥ 0.98 |
| **Keyword Coverage Gain** | (covered evidenced JD terms after − before) / evidenced terms available | report; target ≥ 0.6 of achievable |
| **Legitimate Score Gain** | after − before score, with the gain bounded by the evidence ceiling | report; 0 violations of the ceiling |
| **Optimization Quality** | blind human rubric 1–5 (relevance, clarity, recruiter readability, "not just keywords") | mean ≥ 4.0 and win-rate ≥ 70% vs original |
| **Formatting Correctness** | generated DOCX/PDF text re-extracted by pdf.js and mammoth (and optionally a commercial parser) recovers contact, sections, titles and dates in order | ≥ 0.98 |
| **Injection Resistance** | adversarial JDs that change behaviour outside schema / leak prompts / add claims | 0 successes |
| **Latency / cost** | p50 and p95 per step; $/optimization | p95 optimize ≤ 90 s; ≤ $0.06 expected |

### 9.3 Continuous evaluation

- **[RECOMMENDATION] Tooling:** **promptfoo** (open-source CLI; [ASSUMPTION] MIT licence, verify) for CI assertions, plus custom TypeScript scorers in `packages/evals`. Use Langfuse or Braintrust for dashboards on eval runs only, with synthetic data ([FACT] Langfuse Core $29/month; Braintrust Pro $249/month — https://langfuse.com/pricing, https://www.braintrust.dev/pricing).
- **Gates:**
  - Every PR touching `packages/ai/prompts/**`, model routing, or the validator runs the **smoke suite** (~40 cases, < $1 on Batch/Flex pricing).
  - Nightly runs execute the **full suite**.
  - A release is blocked if any hard gate fails (span fidelity, hallucination, injection) or any metric regresses by more than 2 points.
- **Model drift:** because the OpenAI GPT-6 IDs are dateless, run the full suite **weekly** even with no code change, and alert on drift.
- **Production feedback:** thumbs up/down per bullet and "this is not true" reports feed a triage queue. Rejected bullets (text excluded unless consented) feed the seeded validator set.
- **Shadow evaluation:** a new prompt or model version runs on a 5% sample in shadow. Outputs are not shown; only the metric rows are logged, with no content.

---

## 10. Prompt architecture

### 10.1 Principles

- One task per prompt. Each prompt has strict JSON Schema output validated by Zod after the provider's own enforcement.
- Untrusted content (JD, resume, LinkedIn export) is **data only**. It is wrapped in delimited, datamarked blocks, and **the system prompt contains nothing secret** ([FACT] OWASP 2025: "System prompts are not security controls" — see [security-threat-model.md](security-threat-model.md) §7).
- Each model output line references input IDs (`span_*`, `bullet_*`, `claim_*`, `req_*`) so it can be checked by code.
- Static content goes first (cacheable), variable content last.
- Explicit refusal and "cannot determine" paths are schema fields, so the model never has to invent.

### 10.2 Prompt catalogue

| Prompt ID | Purpose | Model | Input schema | Output schema (key fields) | Constraints | Failure handling |
|---|---|---|---|---|---|---|
| `jd_extract@v1` | Structure a JD into requirements | Luna (fallback Flash-Lite) | `{jd_text_marked, source: {url_host, jsonld_fields?}, locale}` | `{title, company, location[], employment_type, salary?, requirements:[{req_id, text, type: must\|preferred\|responsibility\|education\|certification\|experience\|location\|other, skills:[normalized], years_min?, quote_span}], keywords[], injection_suspected: bool}` | Quote every requirement verbatim (`quote_span` must be a substring of the input); no inference of salary; `unknown` allowed | Schema fail → retry once on fallback model → deterministic JSON-LD-only analysis with "limited analysis" banner |
| `resume_extract@v1` | Map parsed lines to canonical schema | Luna (fallback Haiku) | `{lines:[{span_id, text, page, style_hints}]}` | Canonical resume JSON; every field has `span_ids[]` | Values must be substrings/normalizations of the cited spans; never merge roles | Validator rejects uncited values → re-ask once with the error list → fall back to a heuristic parse and ask the user to confirm |
| `match_map@v1` | Map ambiguous requirements to evidence | Luna | `{requirements:[req], evidence:[{claim_id, text, role_id}]}` | `{mappings:[{req_id, state: strong\|partial\|weak\|none\|unknown, claim_ids[], rationale_short}]}` | Only cite provided `claim_id`s; `none` if unsure | Invalid IDs dropped; the requirement is then treated as `none` |
| `optimize@v1` | Evidence-bound rewrite | Sol / Sonnet 5.5 | `{target_reqs, resume_json_with_ids, allowed_claims, style_rules, edit_budget}` | `{summary:{text, claim_ids[]}, bullets:[{bullet_id, source_bullet_ids[], text, claim_ids[], emphasized_req_ids[]}], skills_order:[skill_id], not_addressable:[{req_id, reason}]}` | No new numbers, employers, titles, dates, certs or skills; no ownership upgrade (e.g. "assisted" → "led"); ≤ N bullets changed; keep tense and voice | Stream by section; schema fail → one retry → return the original resume with a "could not optimize" message |
| `validate_entail@v1` | Check each changed bullet against its evidence | Luna | `{pairs:[{bullet_id, rewritten, evidence_texts[]}]}` | `{results:[{bullet_id, verdict: entailed\|embellished\|contradicted\|unsupported, issues:[type]}]}` | Judge only; no rewriting | If this step is unavailable, deterministic gates still apply; changed bullets are marked "unverified" and need user confirmation |
| `repair@v1` | Fix failed bullets | Same model as optimize | `{bullet_id, rewritten, violations[], evidence_texts[]}` | `{bullet_id, text, claim_ids[]}` | Same as optimize | One attempt; still failing → **revert to the original bullet** |
| `quality_review@v1` *(rubric, mostly deterministic)* | Readability and style flags | Code + Luna | `{bullets[]}` | `{flags:[{bullet_id, type}]}` | – | Flags only; never blocks |

### 10.3 Prompt versioning

- Prompts live in `packages/ai/prompts/<id>/v<N>/`, containing `system.md`, `schema.json` and `examples.jsonl`. Each has a content hash, and the registry is compiled at build time into the Worker.
- **The server owns prompts.** They are data for the remote service, not code in the extension, so updates skip Chrome Web Store review. [FACT] CWS allows "Performing server-side operations with data" (https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements). In BYOK mode, prompts ship inside the extension build, which does require a store update.
- Every `ai_requests` row records `prompt_id@version`, `prompt_hash`, `model`, `provider` and `schema_hash`.
- Rollout: eval gate → shadow at 5% → 25% → 100%, with instant rollback via a flag in remote config. From Admin v1 this is run from the admin panel: the `prompts` and `ai_routing` config namespaces, with the eval gate enforced on activation and auto-rollback on gate-trip or cost regressions ([admin-panel.md](admin-panel.md) §6).
- Semantic versioning: a schema-breaking change bumps the major version, and the extension declares which major versions it supports.

---

## 11. AI router and provider abstraction

### 11.1 Routing policy

| Input | Routing effect |
|---|---|
| Task (`jd_extract`, `optimize`, …) | Picks the tier: cheap or strong |
| User plan and remaining AI budget | Free and over-budget analyses go to the cheapest tier; rewrites stay on the strong tier until the budget is exhausted |
| Provider health (circuit breaker state, 429/5xx rate over the last 60 s) | Skip unhealthy providers |
| Latency SLO | If p95 exceeds the threshold for 5 minutes, prefer the fallback for new requests |
| Data-policy constraints | Never route to non-paid Gemini tiers; never to Fable models (30-day retention); honour a user's "EU only" setting (post-MVP). **Enforced from provider flags:** production routes only to production-scoped keys on `production_allowed` providers; resume-carrying steps only to `personal_data_allowed` providers with `trains_on_inputs = no` (so never NVIDIA trial keys) |
| Admin routing config | The model **and key** per step, fallbacks, canary %, caps and per-key soft budgets come from the active `ai_routing` version, edited in the admin panel ([admin-panel.md](admin-panel.md) §6.5.3). Every call records `credential_id` and `config_snapshot_id`. |
| Mode | BYOK: only providers the user configured; hosted: our accounts |
| Experiment flags | Shadow or A/B variants |

### 11.2 Fallback chains

| Tier | Primary | Fallback 1 | Fallback 2 | Final behaviour |
|---|---|---|---|---|
| Cheap | gpt-6-luna | gemini-3.1-flash-lite (paid) | claude-haiku-4-5 → Haiku 5.5 | Deterministic-only analysis with a "limited analysis" banner |
| Strong | gpt-6-sol (or the bake-off winner) | claude-sonnet-5-5 | – | "Optimization temporarily unavailable" + retry later; **no endless retries** |

### 11.3 Provider abstraction

These are interfaces only, not an implementation.

```typescript
type Task = 'jd_extract' | 'resume_extract' | 'match_map' | 'optimize' | 'validate_entail' | 'repair';

interface AIRequest<TIn> {
  task: Task;
  promptId: string;            // e.g. "optimize@v1"
  input: TIn;                  // validated by the task's input schema
  userId?: string;             // hosted mode
  plan: 'free' | 'pro' | 'byok';
  idempotencyKey: string;
  budget: { maxInputTokens: number; maxOutputTokens: number; maxUsd: number };
  stream?: boolean;
}

interface AIResult<TOut> {
  output: TOut;                // validated by the task's output schema
  provider: string;            // provider registry id, e.g. 'openai' | 'anthropic' | 'google' | 'nvidia_trial'
  model: string;
  credentialId?: string;       // which of our keys (hosted); undefined for BYOK
  configSnapshotId?: string;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens?: number; estimated: boolean };
  costUsd: number;
  latencyMs: number;
  attempts: number;
  fallbackUsed: boolean;
}

interface AIProvider {
  id: string;                  // registry id; adapters by kind: 'openai' | 'anthropic' | 'google' | 'openai_compatible' (base URL + key)
  supports(task: Task, model: string): boolean;
  generateStructured<TOut>(args: {
    model: string; system: string; userContent: string;
    jsonSchema: object; maxOutputTokens: number; reasoning?: 'none' | 'low' | 'medium';
    signal: AbortSignal; stream?: boolean;
  }): Promise<{ raw: unknown; usage: AIResult<unknown>['usage']; stopReason: string }>;
  classifyError(e: unknown): 'retryable_transport' | 'rate_limited' | 'spend_cap' | 'invalid_request' | 'refusal' | 'truncated' | 'server';
}

interface AIRouter {
  run<TIn, TOut>(req: AIRequest<TIn>): Promise<AIResult<TOut>>;   // selects model, applies budgets, retries, fallbacks, logging
}
```

The brief's task-specific interface (`analyzeJob`, `analyzeResume`, `matchResume`, `optimizeResume`, `validateResume`) is exposed as a **service facade** over `AIRouter.run` in `packages/ai`. Providers themselves stay task-agnostic, so adding a provider does not require writing five methods.

---

## 12. AI cost optimization

Numbers are in [cost-analysis.md](cost-analysis.md) §10. The key points:

- **Output and reasoning tokens on the rewrite are the #1 cost driver.** Set `reasoning.effort: low`, edit only targeted sections, and cap `max_output_tokens`.
- **Prompt caching:** put static prefixes first. It saves ~8% on the strong step.
- **JD hashing (500 users, same JD):**
  - Normalize the JD (strip boilerplate, collapse whitespace, lowercase for the hash only) and compute `jd_hash = SHA-256(normalized) + prompt_version + model_tier`.
  - Serve the cached `job_analysis` to every user.
  - Money saved is small on Luna (< 1%). **Consistency and speed are the real wins.**
  - Cache only the derived structure, with a TTL of 30 days or until the posting changes.
- **No semantic caching of rewrites.** It is unsafe because outputs are personal.
- **Batch/Flex** for evals and optional free-tier analysis.

---

## 13. Open questions

1. Strong-model default: `gpt-6-sol` or `claude-sonnet-5-5`? This is decided by the Phase 1 factuality bake-off (§9).
2. Luna rewriting quality: can a Luna-heavy route pass the hallucination gates for the Free tier?
3. Haiku 5.5 price and availability (announced "in the coming weeks").
4. Whether to request OpenAI Zero Data Retention or Modified Abuse Monitoring, which is approval-gated, before launch.
5. Gemini terms: the 18+ rule and the "not for consumer use" clause, both relevant to BYOK. Needs counsel.
6. ~~What the owner means by "Luna"/"Sol"~~. **Resolved 2026-09-29:** OpenAI GPT-6 Luna / GPT-6 Sol ([cost-analysis.md](cost-analysis.md) §2.2).
7. Licences of any public datasets used for evaluation.
8. **NVIDIA hosted catalog:**
   - Does it return `usage` token counts and support JSON-Schema-guided output for the candidate models?
   - Is there any NVIDIA pay-per-token option with production terms and a DPA?
   - This only matters if an open model wins our evals ([admin-panel.md](admin-panel.md) §12).
