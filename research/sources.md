# Sources — AI Resume / Job Match Optimizer Research

**Purpose.** This is the bibliography for the whole research set. For each important source it gives the URL, publisher type, date checked, which claims it supports and a verification status. It also explains conflicts between sources and lists stale-risk facts that must be re-checked before decisions or public claims. Appendix A lists **every** URL referenced across the research notes and documents.

Last updated: 2026-09-29

**Verification status:**

- **VERIFIED:** fetched from the official or primary page on the date shown.
- **CORRECTED:** an earlier note was wrong and has been fixed.
- **SECONDARY:** confirmed only via a third-party page or search summary.
- **UNOFFICIAL:** a community or unofficial source, cited as evidence of behaviour only.
- **UNVERIFIED:** could not be confirmed.

**Research method note.** Research ran on 2026-09-28 (interrupted by a usage limit) and resumed on 2026-09-29. Some official pages blocked automated fetches: tealhq.com, app.jobscan.co, openai.com/policies (403), glassdoor.com (bot wall), help.openai.com. Where that happened, the fact is labelled SECONDARY or was read via an archive or reader proxy of the same URL, as noted. **Two domains (privacy/compliance and security/AI-evaluation) were researched in a shorter, targeted pass** because of usage limits. Their facts are fewer and are labelled accordingly.

---

## Table of contents

1. [AI providers, models and pricing](#1-ai-providers-models-and-pricing)
2. [Chrome platform and Chrome Web Store policy](#2-chrome-platform-and-chrome-web-store-policy)
3. [Job portals, ATS APIs and platform terms](#3-job-portals-ats-apis-and-platform-terms)
4. [Legal, case law and regulation](#4-legal-case-law-and-regulation)
5. [Competitors, market and demand](#5-competitors-market-and-demand)
6. [Infrastructure and SaaS pricing](#6-infrastructure-and-saas-pricing)
7. [Resume parsing, generation and ATS formatting](#7-resume-parsing-generation-and-ats-formatting)
8. [Security, prompt injection and evaluation](#8-security-prompt-injection-and-evaluation)
9. [Conflicts between sources](#9-conflicts-between-sources)
10. [Stale-risk facts](#10-stale-risk-facts)
11. [Appendix A: complete URL list](#appendix-a--complete-list-of-urls-referenced-in-the-research-notes-and-documents)

---

## 1. AI providers, models and pricing

| # | Title | URL | Publisher | Checked | Supports | Status |
|---|---|---|---|---|---|---|
| 1.1 | OpenAI API pricing | https://developers.openai.com/api/docs/pricing | Official | 2026-09-29 | gpt-6-luna $0.10/$0.50; gpt-6-sol $2/$10; gpt-6-astra $10/$50; GPT-5.6 prices; cache and batch prices; fine-tuning winding down | VERIFIED |
| 1.2 | OpenAI models catalog / model pages | https://developers.openai.com/api/docs/models ; /models/gpt-6-luna.md ; /gpt-6-sol.md ; /gpt-6-astra.md | Official | 2026-09-29 | Luna/Sol/Astra descriptions, 1.05M context, 128K output, reasoning effort default `medium`, rate limits per tier, dateless snapshots | VERIFIED |
| 1.3 | OpenAI Structured Outputs guide | https://developers.openai.com/api/docs/guides/structured-outputs.md | Official | 2026-09-29 | Strict JSON Schema adherence, limits, first-call latency | VERIFIED |
| 1.4 | OpenAI prompt caching guide | https://developers.openai.com/api/docs/guides/prompt-caching.md | Official | 2026-09-29 | 1,024-token minimum, 0.1× reads, 1.25× writes, ≥ 30-minute lifetime | VERIFIED |
| 1.5 | OpenAI Batch / Flex guides | https://developers.openai.com/api/docs/guides/batch.md ; /flex-processing.md | Official | 2026-09-29 | 50% discount, 24 h window, not ZDR-eligible; Flex trade-offs | VERIFIED |
| 1.6 | OpenAI "your data" guide | https://developers.openai.com/api/docs/guides/your-data.md | Official | 2026-09-29 | No training by default; 30-day abuse logs; `store` retention; ZDR approval; residency regions (India storage only) | VERIFIED |
| 1.7 | OpenAI rate limits guide | https://developers.openai.com/api/docs/guides/rate-limits.md | Official | 2026-09-29 | Usage tiers; `slow_down`; "set a usage limit for individual users" | VERIFIED |
| 1.8 | GPT-6 Sol and Luna announcement | https://community.openai.com/t/announcing-gpt-6-sol-and-gpt-6-luna-in-the-api-codex-and-chatgpt/1399925 | Official forum | 2026-09-29 | Launch 2026-09-22; 50% lower prices | VERIFIED |
| 1.9 | Simon Willison on GPT-5.6 (Luna/Terra/Sol) | https://simonwillison.net/2026/Jul/9/gpt-5-6/ | Third party | 2026-09-29 | Naming "from smallest to largest"; launch prices (conflict, §9) | SECONDARY |
| 1.10 | Anthropic models overview | https://platform.claude.com/docs/en/models/overview.md | Official | 2026-09-29 | Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5 specs; pinned snapshots; ~30% more tokens from the tokenizer | VERIFIED |
| 1.11 | Anthropic pricing | https://platform.claude.com/docs/en/about-claude/pricing.md | Official | 2026-09-29 | Prices, cache multipliers, batch, `inference_geo` 1.1× | VERIFIED |
| 1.12 | Claude Sonnet 5.5 page | https://platform.claude.com/docs/en/models/sonnet-5-5/overview.md ; https://www.anthropic.com/claude-sonnet-5-5 | Official | 2026-09-29 | Release 2026-09-28; breaking changes (forced tool use errors); Haiku 5.5 "coming weeks" | VERIFIED |
| 1.13 | Anthropic structured outputs | https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md | Official | 2026-09-29 | GA; limitations; enum capitalization caveat; schema caching 24 h | VERIFIED |
| 1.14 | Anthropic rate limits | https://platform.claude.com/docs/en/api/rate-limits.md | Official | 2026-09-29 | Tiers; spend caps; 429 `enforced_spend_limit_reached` | VERIFIED |
| 1.15 | Anthropic API data retention | https://platform.claude.com/docs/en/manage-claude/api-and-data-retention.md | Official | 2026-09-29 | Not retained by default; Covered Models 30 days; batch 29 days; flagged up to 2 years | VERIFIED |
| 1.16 | Anthropic model deprecations | https://platform.claude.com/docs/en/about-claude/model-deprecations.md | Official | 2026-09-29 | Haiku 4.5 retirement "not sooner than 2026-10-15"; 60-day notice | VERIFIED |
| 1.17 | Anthropic browser CORS header | https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/ | Third party | 2026-09-29 | `anthropic-dangerous-direct-browser-access: true` | SECONDARY |
| 1.18 | Gemini API pricing | https://ai.google.dev/gemini-api/docs/pricing | Official | 2026-09-29 | 3.8 Flash promo until 2026-12-31 then 2×; 3.1 Flash-Lite $0.25/$1.50; thinking tokens billed as output | VERIFIED |
| 1.19 | Gemini models page | https://ai.google.dev/gemini-api/docs/models | Official | 2026-09-29 | 2.5 models access-restricted for new projects; no GA 3.x Pro | VERIFIED |
| 1.20 | Gemini API Additional Terms | https://ai.google.dev/gemini-api/terms | Official | 2026-09-29 | Free-tier data use and human review; "Do not submit ... personal information"; EEA/UK paid-only; 18+; "not for consumer use" | VERIFIED |
| 1.21 | Gemini usage policies / ZDR / caching / rate limits | https://ai.google.dev/gemini-api/docs/usage-policies ; /docs/zdr ; /docs/caching ; /docs/rate-limits | Official | 2026-09-29 | 55-day abuse logs; ZDR via Vertex; 4,096-token implicit cache minimum; unpublished limits | VERIFIED |
| 1.22 | OpenRouter docs (FAQ, BYOK, routing, structured outputs, data collection) | https://openrouter.ai/docs/faq ; /docs/guides/overview/auth/byok ; /docs/guides/routing/provider-selection ; /docs/guides/features/structured-outputs ; /docs/guides/privacy/data-collection | Official | 2026-09-29 | 5.5% credit fee; BYOK allowance; variable structured-output support; ZDR routing | VERIFIED |
| 1.23 | Vercel AI SDK structured data | https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data | Official | 2026-09-29 | Schema validation across providers | VERIFIED |
| 1.24 | LiteLLM security update | https://docs.litellm.ai/blog/security-update-march-2026 | Official | 2026-09-29 | Malicious PyPI releases on 2026-03-24 | VERIFIED |
| 1.25 | Cloudflare Workers AI pricing | https://developers.cloudflare.com/workers-ai/platform/pricing/ | Official | 2026-09-28 | Open-model token prices; bge-m3 $0.012 | VERIFIED |
| 1.26 | NVIDIA API Trial Terms of Service (v. September 19, 2025) | https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf | Official | 2026-09-29 | §1.2 trial only, "without use ... in production"; §2.6(a) no personal data; §3.3 content used "to improve NVIDIA products and services, including AI models"; §4.8 no circumvention | VERIFIED (text extracted from the PDF) |
| 1.27 | NVIDIA NIM API FAQ | https://docs.api.nvidia.com/nim/docs/product | Official | 2026-09-29 | Free access "for prototyping, research, development and testing purposes only"; production needs NVIDIA AI Enterprise, from $4,500/GPU/year | VERIFIED (fetched) |
| 1.28 | NVIDIA NIM free-tier limits guide | https://decodethefuture.org/en/nvidia-nim-api-pricing-limits-guide/ | Third party | 2026-09-29 | ~40 requests/minute; credits; production licensing summary | SECONDARY |

## 2. Chrome platform and Chrome Web Store policy

| # | Title | URL | Checked | Supports | Status |
|---|---|---|---|---|---|
| 2.1 | Service worker lifecycle | https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle | 2026-09-29 | 30 s idle, 5 min per event, 30 s `fetch` response termination rules | VERIFIED |
| 2.2 | chrome.sidePanel API | https://developer.chrome.com/docs/extensions/reference/api/sidePanel | 2026-09-29 | Chrome 114+; `open()` needs a user gesture; per-tab panels; `openPanelOnActionClick` | VERIFIED |
| 2.3 | Add a popup | https://developer.chrome.com/docs/extensions/develop/ui/add-popup | 2026-09-29 | Popup closes on focus loss | VERIFIED |
| 2.4 | chrome.storage API | https://developer.chrome.com/docs/extensions/reference/api/storage | 2026-09-29 | Quotas; `session` is in memory; access levels; recommended for sensitive data | VERIFIED |
| 2.5 | User privacy guidance | https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy | 2026-09-29 | "extension storage is not encrypted" | VERIFIED |
| 2.6 | Storage and cookies | https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies | 2026-09-29 | Not cleared with browsing data; same-site treatment of cookies | VERIFIED |
| 2.7 | Content scripts / isolated worlds | https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts | 2026-09-29 | Isolated world; CSP; web-accessible resources exposure | VERIFIED |
| 2.8 | Messaging | https://developer.chrome.com/docs/extensions/develop/concepts/messaging | 2026-09-29 | Treat content-script messages as attacker-crafted; JSON serialization; 64 MiB | VERIFIED |
| 2.9 | Structured-clone messaging | https://developer.chrome.com/blog/structured-clone-messaging | 2026-09-29 | Chrome 148 opt-in manifest key | VERIFIED |
| 2.10 | activeTab | https://developer.chrome.com/docs/extensions/develop/concepts/activeTab | 2026-09-29 | No install warning; gesture types | VERIFIED |
| 2.11 | Permissions list / warnings / optional permissions | https://developer.chrome.com/docs/extensions/reference/permissions-list ; /develop/concepts/permission-warnings ; /reference/api/permissions | 2026-09-29 | Which permissions warn; optional host permissions | VERIFIED |
| 2.12 | chrome.offscreen | https://developer.chrome.com/docs/extensions/reference/api/offscreen | 2026-09-29 | Reasons; one document at a time; runtime-only API | VERIFIED |
| 2.13 | chrome.identity | https://developer.chrome.com/docs/extensions/reference/api/identity | 2026-09-29 | `getAuthToken` vs `launchWebAuthFlow`; `chromiumapp.org` redirect | VERIFIED |
| 2.14 | MV3 CSP | https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy | 2026-09-29 | Most permissive allowed is `'wasm-unsafe-eval'` | VERIFIED |
| 2.15 | Remote hosted code | https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code | 2026-09-29 | No remote JS/WASM; data allowed | VERIFIED |
| 2.16 | CWS MV3 requirements | https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements | 2026-09-29 | Remote config allowed; no remote interpreter; server-side operations allowed | VERIFIED |
| 2.17 | CWS Program Policies | https://developer.chrome.com/docs/webstore/program-policies/policies | 2026-09-29 | Limited Use; disclosure; keyword spam; unauthorized-access ban; 2SV | VERIFIED |
| 2.18 | CWS User Data FAQ | https://developer.chrome.com/docs/webstore/program-policies/user-data-faq | 2026-09-29 | In-UI consent; "website content" is user data; encryption at rest wording | VERIFIED |
| 2.19 | CWS policy updates (July 2026) | https://developer.chrome.com/blog/cws-policy-updates-2026 | 2026-09-29 | "strictly necessary"; **AI-guardrail circumvention ban** (enforced from Aug 1, 2026) | VERIFIED |
| 2.20 | CWS quality guidelines FAQ | https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq | 2026-09-29 | Single purpose; injected toolbars discouraged | VERIFIED |
| 2.21 | CWS review process | https://developer.chrome.com/docs/webstore/review-process | 2026-09-29 | "within a few days ... up to a few weeks" (page last updated 2021) | VERIFIED (may be stale) |
| 2.22 | Extensions "What's new" | https://developer.chrome.com/docs/extensions/whats-new | 2026-09-29 | $5 registration fee mention; DevTools storage view (Chrome 132); `browser` namespace (148) | VERIFIED |
| 2.23 | Built-in AI / Prompt API | https://developer.chrome.com/docs/ai/prompt-api ; /docs/ai/built-in-apis | 2026-09-29 | Availability; hardware requirements; languages | VERIFIED |
| 2.24 | Update lifecycle | https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle | 2026-09-29 | Updates wait until the extension is idle | VERIFIED |
| 2.25 | Chromium milestone schedule | https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=154 | 2026-09-29 | Chrome 154 stable on 2026-09-22 | VERIFIED |
| 2.26 | WXT framework | https://wxt.dev/ | 2026-09-29 | MV3 framework; 0.21.4 (via a comparison article) | SECONDARY |

## 3. Job portals, ATS APIs and platform terms

| # | Title | URL | Checked | Supports | Status |
|---|---|---|---|---|---|
| 3.1 | LinkedIn User Agreement (effective 2025-11-03) | https://www.linkedin.com/legal/user-agreement | 2026-09-29 | §8.2 prohibitions (plugins/add-ons scraping, copying, overlays, bots, trademark) | VERIFIED |
| 3.2 | LinkedIn prohibited software and extensions | https://www.linkedin.com/help/linkedin/answer/a1341387 | 2026-09-29 | Bans extensions that "scrape, modify the appearance of, or automate activity" | VERIFIED |
| 3.3 | LinkedIn crawling terms / robots.txt | https://www.linkedin.com/legal/crawling-terms ; https://www.linkedin.com/robots.txt | 2026-09-29 | Automated crawling prohibited without permission | VERIFIED |
| 3.4 | LinkedIn brand policies | https://brand.linkedin.com/policies | 2026-09-29 | No confusing use of the brand | VERIFIED |
| 3.5 | LinkedIn Save to PDF / Download your data | https://www.linkedin.com/help/linkedin/answer/a541960 ; /a1339364 | 2026-09-29 | Legitimate profile import paths; 200 PDFs/month; English-only | VERIFIED (a conflict with an older snippet saying 100 is noted) |
| 3.6 | LinkedIn DMA portability APIs | https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-3rd-party/ | 2026-09-29 | EEA-only third-party portability; business verification | VERIFIED |
| 3.7 | Indeed Terms of Service (2026-07-17) | https://www.indeed.com/legal | 2026-09-29 | Scraping/extraction bans; personal non-commercial licence; "Permitted AI Connector" beta | VERIFIED |
| 3.8 | Indeed robots.txt | https://www.indeed.com/robots.txt | 2026-09-29 | Disallows /viewjob etc. | VERIFIED |
| 3.9 | Glassdoor Terms of Use (Wayback 2026-09-21) | https://web.archive.org/web/20260921192649/https://www.glassdoor.com/about/terms/ | 2026-09-29 | No automated agents to scrape or mine | VERIFIED (archive) |
| 3.10 | Naukri T&C | https://www.naukri.com/termsconditions | 2026-09-29 | Bans automated **and manual** extraction without written authorization | VERIFIED |
| 3.11 | Wellfound terms | https://wellfound.com/terms | 2026-09-29 | Anti-harvesting; load-based automation clause | VERIFIED |
| 3.12 | ZipRecruiter terms (via search summary) | https://www.ziprecruiter.com/terms (summary via https://www.ziprecruiter.global/) | 2026-09-29 | Scraping "whether by automated, manual, or other non-automated means" | SECONDARY |
| 3.13 | Greenhouse Job Board API | https://developers.greenhouse.io/job-board.html | 2026-09-29 | Unauthenticated GETs; `gh_jid` | VERIFIED |
| 3.14 | Lever Postings API | https://github.com/lever/postings-api | 2026-09-29 | Published jobs "may be scraped by third parties"; CORS limited | VERIFIED |
| 3.15 | Ashby public job posting API | https://developers.ashbyhq.com/docs/public-job-posting-api | 2026-09-29 | Public API; CORS `*` (observed) | VERIFIED |
| 3.16 | SmartRecruiters Posting API | https://developers.smartrecruiters.com/docs/posting-api | 2026-09-29 | Public postings unauthenticated; 10 rps per credential | VERIFIED |
| 3.17 | Google JobPosting structured data | https://developers.google.com/search/docs/appearance/structured-data/job-posting | 2026-09-29 | Required properties; why JSON-LD is common | VERIFIED |
| 3.18 | Observed page structures (Lever, Ashby, Workday ×5, iCIMS, SmartRecruiters, Greenhouse) | e.g. https://jobs.lever.co/leverdemo/681fbc53-1e34-4a46-8677-3a78118674eb ; https://careers-americas.icims.com/jobs/26266/… | 2026-09-29 | JSON-LD / microdata / iframe observations | VERIFIED (sampled) |
| 3.19 | OpenAI Terms of Use (2026-01-01) | https://openai.com/policies/row-terms-of-use/ | 2026-09-29 | "Automatically or programmatically extract data or Output" is prohibited | VERIFIED via a reader proxy (direct 403) |
| 3.20 | Anthropic Consumer Terms | https://www.anthropic.com/legal/consumer-terms | 2026-09-29 | No automated access except via an API key | VERIFIED |
| 3.21 | Claude Code legal and compliance | https://code.claude.com/docs/en/legal-and-compliance | 2026-09-29 | No intermediating Claude.ai credentials or session tokens | VERIFIED |
| 3.22 | Google Terms of Service (2026-07-30) | https://policies.google.com/terms | 2026-09-29 | No automated access against machine-readable instructions; no bypassing protections | VERIFIED |
| 3.23 | ChatGPT Apps SDK submission guidelines | https://developers.openai.com/apps-sdk/app-submission-guidelines | 2026-09-29 | Apps must not promote subscriptions | VERIFIED |
| 3.24 | Gemini custom MCP apps | https://support.google.com/gemini/answer/17209137 | 2026-09-29 | US-only, 18+, personal accounts | VERIFIED |
| 3.25 | Claude custom connectors | https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp | 2026-09-29 | Connectors run from Anthropic's cloud | VERIFIED |
| 3.26 | Session-reuse breakage evidence | https://github.com/robotlearning123/gpt2agent ; https://github.com/wong2/chatgpt-google-extension/issues | 2026-09-29 | Sentinel/Turnstile blocks; Cloudflare-check failures | UNOFFICIAL |

## 4. Legal, case law and regulation

| # | Title | URL | Checked | Supports | Status |
|---|---|---|---|---|---|
| 4.1 | hiQ v. LinkedIn (9th Cir. 2022) | https://law.justia.com/cases/federal/appellate-courts/ca9/17-16783/17-16783-2022-04-18.html | 2026-09-28 | CFAA and public data; later consent judgment (law-firm summaries) | VERIFIED (opinion); SECONDARY (settlement terms) |
| 4.2 | Mobley v. Workday summaries | https://www.dwt.com/blogs/employment-labor-and-benefits/2025/05/ai-hiring-age-discrimination-federal-court-workday ; https://www.hklaw.com/… ; https://clearinghouse.net/case/44074/ | 2026-09-29 | Collective conditionally certified 2025-05-16 | SECONDARY |
| 4.3 | DPDP Rules 2025 (PIB) | https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf | 2026-09-29 | Rules notified November 2025 | VERIFIED (search result of the official PDF) |
| 4.4 | DPDP enforcement timeline analysis | https://www.amsshardul.com/insight/enforcement-of-the-dpdp-act-and-notification-of-the-dpdp-rules/ | 2026-09-29 | Dates 14 Nov 2025 / 14 Nov 2026 / 14 May 2027 | SECONDARY (law firm) |
| 4.5 | CCPA monetary threshold (CPPA) | https://www.cppa.ca.gov/regulations/cpi_adjustment.html | 2026-09-29 | $26,625,000 threshold | VERIFIED (search summary of the official page) |
| 4.7 | Canadian privacy reform: Bill C-36 (tabled 2026-06-15; PIPEDA still in force) | https://teresascassa.substack.com/p/canadas-new-privacy-reform-bill-bill ; https://fusioncomputing.ca/pipeda-compliance-small-business-canada/ ; https://openparliament.ca/bills/44-1/C-27/ | 2026-09-29 | PIPEDA in force; C-27 died January 2025; C-36 not yet law | SECONDARY |
| 4.8 | Quebec Law 25: PIA before transfers outside Quebec | https://cloud.google.com/security/compliance/quebeclaw25 ; https://www.mccarthy.ca/en/insights/blogs/techlex/quebec-privacy-regulators-guide-law-25-compliant-privacy-impact-assessments | 2026-09-29 | Transfer PIA requirement, including cloud processors | SECONDARY |
| 4.6 | SEC filing: Workday / HiredScore | https://www.sec.gov/Archives/edgar/data/1327811/000132781124000032/wday-02262024x991.htm | 2026-09-29 | Acquisition intent (2024-02-26) | SECONDARY (via search) |

## 5. Competitors, market and demand

| # | Title | URL | Checked | Supports | Status |
|---|---|---|---|---|---|
| 5.1 | Jobscan homepage | https://www.jobscan.co/ | 2026-09-28 | "ranking weights" claim; 75% target | VERIFIED |
| 5.2 | Jobscan vs Teal / vs Simplify (Jobscan blog) | https://www.jobscan.co/blog/jobscan-vs-teal/ ; /jobscan-vs-simplify/ | 2026-09-28/29 | Jobscan and Teal prices; Simplify details | SECONDARY (competitor-authored) |
| 5.3 | Rezi pricing | https://www.rezi.ai/pricing | 2026-09-28 | Free / $29 / $149 lifetime | VERIFIED |
| 5.4 | Simplify pricing (help centre) | https://help.simplify.jobs/articles/5623502-whats-included-in-simplify-features-and-pricing | 2026-09-28 | $19.99/wk, $39.99/mo, $89.99/3 mo | VERIFIED |
| 5.5 | Huntr pricing | https://huntr.co/pricing | 2026-09-28 | Free / $40 / $90 / $160 | VERIFIED |
| 5.6 | Careerflow pricing (homepage) | https://www.careerflow.ai/ | 2026-09-29 | Weekly, monthly, quarterly and yearly tiers | VERIFIED |
| 5.7 | Enhancv pricing | https://enhancv.com/pricing/ | 2026-09-29 | $39 / $69 / $99 | VERIFIED |
| 5.8 | Kickresume pricing / AI data | https://www.kickresume.com/en/pricing/ ; https://www.kickresume.com/en/press/ai-job-search-data/ | 2026-09-29 | $9 / $18 / $48; tailoring 3.5% of AI users | VERIFIED |
| 5.9 | Chrome Web Store listings (40+ extensions) | https://chromewebstore.google.com/detail/<id> (IDs in [competitive-analysis.md](competitive-analysis.md) §6 and the notes) | 2026-09-29 | User counts, ratings, update dates | VERIFIED |
| 5.10 | Trustpilot pages (Zety, Resume.io, Jobscan, Teal, Simplify, Jobright, LazyApply) | https://www.trustpilot.com/review/<domain> | 2026-09-29 | Complaint themes | VERIFIED (summarized) |
| 5.11 | Greenhouse AI for candidates / Talent Matching FAQ | https://my.greenhouse.com/blogs/how-does-greenhouse-use-ai-heres-everything-candidates-need-to-know ; https://support.greenhouse.io/hc/en-us/articles/41131886674075-Talent-Matching-FAQ | 2026-09-29 | No auto-reject; AI match categories | VERIFIED |
| 5.12 | Lever AI innovations | https://www.lever.co/blog/levers-ai-innovations-are-here | 2026-09-29 | Talent Fit ranks candidates | VERIFIED |
| 5.13 | Workday AI recruiting | https://www.workday.com/en-us/products/talent-management/ai-recruiting.html | 2026-09-29 | HiredScore grading | VERIFIED |
| 5.14 | iCIMS AI | https://www.icims.com/products/ai-recruiting-software/ | 2026-09-29 | Ranking with recruiter control | VERIFIED |
| 5.15 | Enhancv recruiter study | https://enhancv.com/blog/does-ats-reject-resumes/ | 2026-09-29 | 92% no auto-reject; 100% knockout questions (n=25) | VERIFIED (vendor study) |
| 5.16 | HBS Hidden Workers | https://www.library.hbs.edu/working-knowledge/how-to-tap-the-talent-automated-hr-platforms-miss | 2026-09-29 | > 90% use a recruitment management system for first cut or ranking | VERIFIED |
| 5.17 | ATS myths (Preptel origin) | https://blog.hiringthing.com/applicant-tracking-system-myths | 2026-09-29 | "75% rejected" myth origin | VERIFIED |
| 5.18 | Jobscan Fortune 500 ATS report | https://www.jobscan.co/blog/fortune-500-use-applicant-tracking-systems/ | 2026-09-29 | ATS market shares | VERIFIED (vendor) |
| 5.19 | Greenhouse 2025 Workforce report | https://www.greenhouse.com/blog/greenhouse-2025-workforce-hiring-report | 2026-09-29 | 32% claimed AI skills they lack | VERIFIED |
| 5.20 | BLS JOLTS | https://www.bls.gov/news.release/jolts.nr0.htm | 2026-09-29 | Hires 5.1M (July 2026) | VERIFIED |
| 5.21 | LinkedIn Premium Career | https://premium.linkedin.com/careers/career | 2026-09-29 | $39.99/month | VERIFIED |
| 5.22 | ChatGPT career features (press) | https://the-decoder.com/openai-turns-chatgpt-into-a-career-platform-with-job-search-and-cv-editor/ | 2026-09-29 | Resume tailor/download for all tiers | SECONDARY |
| 5.23 | Indeed Career Scout | https://www.indeed.com/news/releases/indeed-introduces-new-suite-of-hiring-products-career-scout-talent-scout-premium-sponsored-jobs-and-indeed-connect | 2026-09-29 | Tailoring in the Indeed app | VERIFIED |

## 6. Infrastructure and SaaS pricing

| # | Title | URL | Checked | Supports | Status |
|---|---|---|---|---|---|
| 6.1 | Cloudflare Workers pricing / limits | https://developers.cloudflare.com/workers/platform/pricing/ ; /limits/ | 2026-09-28 | $5 base; CPU billing; no wall-clock limit while connected | VERIFIED |
| 6.2 | Cloudflare Workflows / Queues / DOs / Hyperdrive / R2 / KV / D1 pricing | https://developers.cloudflare.com/workflows/reference/pricing/ ; /queues/… ; /durable-objects/… ; /hyperdrive/… ; /r2/pricing/ ; /kv/… ; /d1/… | 2026-09-28 | Unit prices; D1 10 GB cap | VERIFIED |
| 6.3 | Cloudflare AI Gateway pricing | https://developers.cloudflare.com/ai-gateway/reference/pricing/ | 2026-09-28 | Free core; 5% Unified Billing; logging change 2026-09-24 | VERIFIED |
| 6.4 | Cloudflare Browser Run pricing | https://developers.cloudflare.com/browser-rendering/pricing/ | 2026-09-28 | $0.09/browser-hour | VERIFIED |
| 6.5 | Cloudflare Rate Limiting binding | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ | 2026-09-28 | Eventually consistent; not for accounting | VERIFIED |
| 6.6 | AWS Lambda / API Gateway / VPC / RDS / SQS / ElastiCache prices | https://aws.amazon.com/lambda/pricing/ ; https://aws.amazon.com/api-gateway/pricing/ ; https://aws.amazon.com/vpc/pricing/ ; AWS Price List CSV/JSON feeds | 2026-09-28/29 | Unit prices; HTTP API 30 s cap; REST streaming | VERIFIED (some CORRECTED, §9) |
| 6.7 | Google Cloud Run / Cloud SQL pricing | https://cloud.google.com/run/pricing ; https://cloud.google.com/sql/pricing | 2026-09-29 | Request-based billing; free tier; 60-minute timeout | VERIFIED (CORRECTED an earlier "swap" suspicion) |
| 6.8 | Azure Retail Prices API | https://prices.azure.com/api/retail/prices | 2026-09-29 | Container Apps; App Service; Azure OpenAI multipliers | VERIFIED |
| 6.9 | Vercel pricing / limits | https://vercel.com/pricing ; https://vercel.com/docs/functions/limitations | 2026-09-29 | Pro $20; 800 s max; Active CPU excludes I/O wait | VERIFIED |
| 6.10 | Railway / Render / Fly.io pricing | https://railway.com/pricing ; https://render.com/pricing ; https://fly.io/pricing/ | 2026-09-29 | Plans and limits | VERIFIED |
| 6.11 | Neon pricing | https://neon.com/pricing | 2026-09-29 | Launch $0.106/CU-h; $0.35/GB-month; managed Better Auth; 7-day restore | VERIFIED |
| 6.12 | Supabase / MongoDB Atlas pricing | https://supabase.com/pricing ; https://www.mongodb.com/pricing | 2026-09-29 | Tiers | VERIFIED |
| 6.13 | Upstash / Redis Cloud pricing | https://upstash.com/pricing/redis ; https://redis.io/pricing/ | 2026-09-29 | $0.20 per 100K commands | VERIFIED |
| 6.14 | Auth pricing (Clerk, Auth0, Firebase, Identity Platform, Better Auth) | https://clerk.com/pricing ; https://auth0.com/pricing ; https://firebase.google.com/pricing ; https://cloud.google.com/identity-platform/pricing ; https://www.better-auth.com/pricing | 2026-09-29 | MAU/MRU pricing | VERIFIED |
| 6.15 | Email pricing (Resend, Postmark, SES) | https://resend.com/pricing ; https://postmarkapp.com/pricing ; https://aws.amazon.com/ses/pricing/ | 2026-09-29 | Tiers | VERIFIED |
| 6.16 | Payments (Stripe US/IN, Billing, Tax, Managed Payments; Paddle; Lemon Squeezy; Razorpay) | https://stripe.com/pricing ; https://stripe.com/in/pricing ; https://stripe.com/billing/pricing ; https://stripe.com/tax/pricing ; https://docs.stripe.com/payments/managed-payments/eligibility ; https://www.paddle.com/pricing ; https://www.lemonsqueezy.com/blog/2026-update ; https://razorpay.com/pricing/ | 2026-09-29 | Fee comparisons; India eligibility | VERIFIED (Stripe US via a domain-restricted search snippet) |
| 6.17 | Observability pricing (Sentry, Grafana, Axiom, Better Stack, Datadog, Langfuse, Helicone, LangSmith, Braintrust) | https://sentry.io/pricing/ ; https://grafana.com/pricing/ ; https://axiom.co/pricing ; https://betterstack.com/pricing ; https://www.datadoghq.com/pricing/ ; https://langfuse.com/pricing ; https://www.helicone.ai/pricing ; https://www.langchain.com/pricing ; https://www.braintrust.dev/pricing | 2026-09-29 | Tiers | VERIFIED |
| 6.18 | Job SaaS (Inngest, Trigger.dev, Step Functions); pg-boss; Graphile Worker | https://www.inngest.com/pricing ; https://trigger.dev/pricing ; https://aws.amazon.com/step-functions/pricing/ ; https://github.com/timgit/pg-boss ; https://worker.graphile.org/ | 2026-09-29 | Pricing and fit | VERIFIED |
| 6.20 | Stripe Canada pricing | https://stripe.com/en-ca/pricing | 2026-09-29 | 2.9% + CA$0.30; +0.8% international cards; +2% currency conversion | VERIFIED |
| 6.22 | Paddle: create and manage discounts | https://developer.paddle.com/build/products/offer-discounts-promotions-coupons/ | 2026-09-29 | Discount fields (`type`, `amount`, `code`, `enabled_for_checkout`, `recur`, `maximum_recurring_intervals`, `usage_limit`, `restrict_to`, `expires_at`); usage limit is "a total limit ... rather than a per-customer limit"; non-checkout discounts applied only by ID; flat discounts are currency-specific | VERIFIED (fetched) |
| 6.23 | Paddle.js `Checkout.open()` | https://developer.paddle.com/paddle-js/methods/paddle-checkout-open/ | 2026-09-29 | `discountId` / `discountCode`; `transactionId`; `settings.showAddDiscounts` (default `true`) | VERIFIED (fetched) |
| 6.24 | Paddle: create a price | https://developer.paddle.com/api-reference/prices/create-price/ | 2026-09-29 | `billing_cycle` = interval (day/week/month/year) + frequency (≥ 1); quarterly = month × 3 | VERIFIED (search summary of the official page) |
| 6.25 | Stripe: coupons and promotion codes | https://docs.stripe.com/billing/subscriptions/coupons | 2026-09-29 | `percent_off`; `duration` once/repeating/forever with `duration_in_months`; `max_redemptions` across all customers; promotion-code customer and first-time-order restrictions | VERIFIED (fetched) |
| 6.26 | Cloudflare Zero Trust plans | https://www.cloudflare.com/plans/zero-trust-services/ | 2026-09-29 | Access free for up to 50 users; pay-as-you-go $7/user/month | SECONDARY (search summaries consistent with the official page) |
| 6.27 | Better Auth admin plugin | https://better-auth.com/docs/plugins/admin | 2026-09-29 | Roles and permissions; ban ("Banned users cannot sign in"); impersonation | VERIFIED (search summary of the official docs) |
| 6.28 | Cloudflare KV: how KV works | https://developers.cloudflare.com/kv/concepts/how-kv-works/ | 2026-09-29 | Eventually consistent; changes "may take up to 60 seconds or more" to reach other locations | VERIFIED (search summary of the official docs) |
| 6.21 | Stripe Managed Payments (Canada eligible; +3.5%; GA 2026) | https://docs.stripe.com/payments/managed-payments/eligibility ; https://stripe.com/managed-payments ; https://dodopayments.com/blogs/stripe-managed-payments-fees-explained | 2026-09-29 | Merchant-of-record option for a Canada-based seller | VERIFIED (eligibility) / SECONDARY (GA status, stacked-fee explanation) |
| 6.19 | Domain pricing | https://cfdomainpricing.com/ ; https://domainnamewire.com/2026/04/23/breaking-verisign-raising-wholesale-com-prices/ | 2026-09-29 | .com $10.46 → ≈ $11.17 | SECONDARY |

## 7. Resume parsing, generation and ATS formatting

| # | Title | URL | Checked | Supports | Status |
|---|---|---|---|---|---|
| 7.1 | npm registry (pdfjs-dist, mammoth, docx, pdfmake, pdf-lib, @cantoo/pdf-lib, tesseract.js, @jsonresume/schema, …) | https://registry.npmjs.org/<pkg> | 2026-09-29 | Versions, licences, dates | VERIFIED |
| 7.2 | PyPI JSON API (pymupdf AGPL, pdfplumber, docling, marker, …) | https://pypi.org/pypi/<pkg>/json | 2026-09-29 | Versions, licences | VERIFIED |
| 7.3 | pdf.js API source | https://github.com/mozilla/pdf.js/blob/master/src/display/api.js | 2026-09-29 | `getTextContent`, `getAnnotations`, `getStructTree` | VERIFIED |
| 7.4 | pdfminer.six docs; PyMuPDF docs | https://pdfminersix.readthedocs.io/en/latest/topic/converting_pdf_to_text.html ; https://pymupdf.readthedocs.io/en/latest/recipes-text.html | 2026-09-29 | PDF reading-order problems | VERIFIED |
| 7.5 | mammoth.js README / issue #9 | https://github.com/mwilliamson/mammoth.js ; /issues/9 | 2026-09-29 | No headers/footers; no sanitization | VERIFIED |
| 7.6 | tesseract.js README | https://github.com/naptha/tesseract.js | 2026-09-29 | No PDF support; CDN defaults | VERIFIED |
| 7.7 | OCR pricing (Textract, Document AI, Azure DI, Mistral OCR) | https://aws.amazon.com/textract/pricing/ ; https://cloud.google.com/document-ai/pricing ; Azure Retail Prices API ; https://docs.mistral.ai/models/ocr-4-1 | 2026-09-29 | ~$1.50 per 1,000 pages | VERIFIED |
| 7.8 | Commercial parsers (Affinda, Textkernel, RChilli, Daxtra) | https://www.affinda.com/recruitment-ai-pricing/ ; https://developer.textkernel.com/tx-platform/v10/transaction-cost/ ; https://www.rchilli.com/pricing ; https://www.daxtra.com/resume-cv-parsing/ | 2026-09-29 | $0.10/document (Affinda) | VERIFIED |
| 7.9 | JSON Resume schema; HR Open Standards | https://github.com/jsonresume/resume-schema ; https://www.hropenstandards.org/standards | 2026-09-29 | Schema basis | VERIFIED |
| 7.10 | Greenhouse unsuccessful resume parse | https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse | 2026-09-29 | Parse-failure causes (headers/footers, tables, columns, graphics) | SECONDARY (search summary; re-read verbatim) |
| 7.11 | LlamaParse / Reducto pricing | https://developers.llamaindex.ai/llamaparse/general/pricing/ ; https://reducto.ai/pricing | 2026-09-29 | Per-page costs | VERIFIED |

## 8. Security, prompt injection and evaluation

| # | Title | URL | Checked | Supports | Status |
|---|---|---|---|---|---|
| 8.1 | OWASP LLM Top 10 2025 (summaries) | https://www.invicti.com/blog/web-security/owasp-top-10-risks-llm-security-2025 ; https://checkmarx.com/learn/breaking-down-the-owasp-top-10-for-llm-applications/ | 2026-09-29 | LLM01 prompt injection; LLM07 system prompt leakage | SECONDARY (summaries of the OWASP list; primary: genai.owasp.org, not fetched) |
| 8.2 | Microsoft spotlighting paper / MSRC blog | https://ceur-ws.org/Vol-3920/paper03.pdf ; https://www.microsoft.com/en-us/msrc/blog/2025/07/how-microsoft-defends-against-indirect-prompt-injection-attacks | 2026-09-29 | Datamarking effectiveness and limits | SECONDARY (search summary) |
| 8.3 | pdf.js CVE-2024-4367 advisory | https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq | 2026-09-29 | Fixed in 4.2.67; `isEvalSupported:false` | VERIFIED (search summary of the advisory) |
| 8.4 | Cyberhaven extension compromise | https://www.nightfall.ai/blog/heres-what-we-can-learn-from-the-cyberhaven-incident ; https://rhisac.org/threat-intelligence/cyberhaven-extension-compromise-part-of-broader-campaign-affecting-multiple-chrome-extensions/ | 2026-09-29 | Phished OAuth consent → malicious update; 35+ extensions, 2.6M users | SECONDARY |
| 8.5 | Fabrication in LLM hiring pipelines | https://arxiv.org/abs/2608.26171 | 2026-09-29 | 96.7% baseline unsupported claims; 50% after prompt guardrails | VERIFIED (preprint, not peer-reviewed) |
| 8.6 | Grounded optimization for resumes | https://arxiv.org/abs/2607.01457 | 2026-09-29 | Failure modes; five-layer defence results | VERIFIED (preprint) |

---

## 9. Conflicts between sources

| # | Conflict | Sources | Resolution |
|---|---|---|---|
| C1 | GPT-5.6 prices: launch Luna $1/$6, Sol $5/$30 vs today's $0.20/$1.20 and $4/$20 | Willison 2026-07-09 vs the OpenAI pricing page | Post-launch "promotional" cuts; **the official page wins**. Shows price volatility. |
| C2 | `openai/gpt-5.6-sol` on OpenRouter $2/$10 vs OpenAI $4/$20 | OpenRouter models API vs the OpenAI pricing page | Unresolved; the official page is authoritative; reconcile against invoices |
| C3 | Greenhouse "doesn't rate candidates" (Jan 2025) vs Talent Matching categories (later) | Greenhouse blog vs support FAQ | Product evolution: Greenhouse sorts against employer criteria but doesn't auto-reject |
| C4 | HBS (> 90% use a recruitment management system for first cut or ranking) vs Enhancv (92% don't auto-reject) | HBS 2021 vs Enhancv 2025 | Both true: ranking and filtering ≠ autonomous rejection; knockouts do reject |
| C5 | Simplify "1,000,000+ job seekers" vs a 500K store counter (Jobright similar) | Store description vs store counter | Different denominators; use the store counter for extension reach |
| C6 | LinkedIn Save to PDF limit 100 vs 200 per month | Older search snippet vs the live help page | The live page (200) wins |
| C7 | LinkedIn DMA portability: "EU/EEA and Switzerland" vs "European Economic Area" | Help page vs Microsoft Learn docs | Switzerland treated as unverified for the third-party API |
| C8 | Lambda Arm price: official page fetch showed the x86 figure | Official page fetch vs secondary sources | **CORRECTED** via the AWS price-list feed: Arm $0.0000133334/GB-s |
| C9 | Cloud Run free-tier vCPU/GiB figures appeared swapped | Fetch helper vs prior knowledge | **CORRECTED/VERIFIED:** 180,000 vCPU-s, 360,000 GiB-s, 2M requests |
| C10 | Affinda "~$800/month base" vs "$0.10/document self-serve" | Third-party summary vs the official page | The official page wins |
| C11 | CWS AI-guardrail policy present in the July 2026 blog but not found on the main policy page (footer dated 2025-05-22) | Blog vs policy page | The blog is the authoritative announcement; the policy page may lag |
| C12 | Writer/Rewriter origin trials "Chrome 137–148" vs Chrome 154 current | Chrome AI docs | Treat as not production-available |
| C13 | Jobscan annual plan / free-scan count vary across reviews | Third-party reviews | Treated as SECONDARY |
| C14 | "Sol-heavy" read as frontier vs Sol not being the flagship | Owner's brief vs the OpenAI catalog | **Resolved on 2026-09-29:** the owner confirmed GPT-6 Luna/Sol ([cost-analysis.md](cost-analysis.md) §2.2) |
| C15 | The owner's location was inferred as India (session timezone) | Research environment vs the owner | **Resolved on 2026-09-29:** the owner is in Canada; the payment and privacy sections were updated |
| C16 | Paddle `maximum_recurring_intervals`: the guide's example ("set for 4 billing periods applies to the initial transaction and the next 3 renewals") vs a summarizer's reading that the value counts only *additional* periods | Paddle discounts guide (6.22) vs the fetch helper's paraphrase | **The quoted example wins:** N includes the first payment. Still confirm in the sandbox on a 3-month price ([admin-panel.md](admin-panel.md) §7.3). |
| C17 | NVIDIA trial terms §2.3 ("NVIDIA will not store or use User Content or Generated Content at the end of each API Service session") vs §3.3(iv) (collects "User Content and Generated Content to improve NVIDIA products and services, including AI models") | Same document (1.26) | **Treated conservatively:** assume inputs may be used for model improvement (`trains_on_inputs = yes`). It doesn't change the verdict, because production use and personal data are forbidden anyway. |

---

## 10. Stale-risk facts

Re-check these before pricing decisions, public copy or launch.

| Fact | Why it's at risk | Re-check |
|---|---|---|
| All LLM prices (OpenAI GPT-6/5.6, Anthropic 5.5, Gemini 3.x) | Price war; GPT-5.6 increase in November; Gemini doubles on 2027-01-01 | Monthly, and before any plan-price change |
| Claude Haiku 4.5 availability / Haiku 5.5 launch | Retirement "not sooner than 2026-10-15"; Haiku 5.5 "coming weeks" | Before Phase 2 |
| OpenAI dateless GPT-6 snapshots | Behaviour can change silently | Weekly eval drift run |
| CWS policies (Limited Use, AI guardrails) | Updated July 2026; enforcement evolves | Before each submission |
| Chrome APIs (`sidePanel`, messaging serialization, built-in AI) | Two-week release cadence | Each quarter |
| Job-portal terms (LinkedIn, Indeed 2026-07-17, Naukri 2026-08-09) | Frequent updates | Before launch; every 6 months |
| DPDP phase dates (Nov 2026 consent managers; May 2027 full compliance) | Rules may be amended | Quarterly |
| Canadian privacy reform (Bill C-36 could replace PIPEDA) | Bill at second reading as of Sept 2026 | Quarterly |
| Payment-provider terms (Paddle pricing; Stripe Managed Payments fees and eligibility — Canada eligible as of 2026-09-29; Lemon Squeezy migration) | Fast-moving | Before billing implementation |
| Competitor pricing | Frequent, geo-localized | Before publishing comparisons |
| AI Gateway logging and billing change (2026-09-24) | Just changed | At implementation |
| Paddle discount semantics (per-customer limits absent; non-checkout discounts; recurring intervals; `showAddDiscounts`) | API evolves; the coupon design depends on it | Before P2.10, with sandbox tests |
| Cloudflare Access free tier (≤ 50 users) | Plan changes | Before the admin build |
| NVIDIA API Catalog trial terms and free-tier limits (v. 2025-09-19 read on 2026-09-29) | Terms "updated from time to time"; limits unpublished | Before any NVIDIA use, and before approving any open-model host |

---
## Appendix A — Complete list of URLs referenced in the research notes and documents

Auto-compiled on 2026-09-29 from all research notes and documents (459 unique URLs), grouped by domain category. Every URL was referenced by a researcher who checked it on 2026-09-28 or 2026-09-29 unless the citing document labels it otherwise (see the verification status in the curated tables above and inline labels in each document).

### A.1 AI providers, models & pricing (82)

- <https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data>
- <https://ai.google.dev/gemini-api/docs/billing>
- <https://ai.google.dev/gemini-api/docs/caching>
- <https://ai.google.dev/gemini-api/docs/embeddings>
- <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview>
- <https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite>
- <https://ai.google.dev/gemini-api/docs/models>
- <https://ai.google.dev/gemini-api/docs/openai>
- <https://ai.google.dev/gemini-api/docs/pricing.md.txt>
- <https://ai.google.dev/gemini-api/docs/pricing>
- <https://ai.google.dev/gemini-api/docs/rate-limits>
- <https://ai.google.dev/gemini-api/docs/structured-output>
- <https://ai.google.dev/gemini-api/docs/thinking>
- <https://ai.google.dev/gemini-api/docs/usage-policies>
- <https://ai.google.dev/gemini-api/docs/zdr>
- <https://ai.google.dev/gemini-api/terms>
- <https://api.anthropic.com/>
- <https://api.openai.com/>
- <https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf>
- <https://blog.google/innovation-and-ai/products/gemini-app/gemini-spark-updates-june-2026/>
- <https://chatgpt.com/robots.txt>
- <https://code.claude.com/docs/en/legal-and-compliance>
- <https://community.openai.com/t/announcing-gpt-6-sol-and-gpt-6-luna-in-the-api-codex-and-chatgpt/1399925>
- <https://decodethefuture.org/en/nvidia-nim-api-pricing-limits-guide/>
- <https://developers.openai.com/api/docs/guides/batch.md>
- <https://developers.openai.com/api/docs/guides/fast-mode.md>
- <https://developers.openai.com/api/docs/guides/flex-processing.md>
- <https://developers.openai.com/api/docs/guides/prompt-caching.md>
- <https://developers.openai.com/api/docs/guides/rate-limits.md>
- <https://developers.openai.com/api/docs/guides/structured-outputs.md>
- <https://developers.openai.com/api/docs/guides/your-data.md>
- <https://developers.openai.com/api/docs/models/gpt-5.6-luna>
- <https://developers.openai.com/api/docs/models/gpt-6-astra.md>
- <https://developers.openai.com/api/docs/models/gpt-6-luna.md>
- <https://developers.openai.com/api/docs/models/gpt-6-luna>
- <https://developers.openai.com/api/docs/models/gpt-6-sol.md>
- <https://developers.openai.com/api/docs/models/gpt-6-sol>
- <https://developers.openai.com/api/docs/models>
- <https://developers.openai.com/api/docs/pricing.md>
- <https://developers.openai.com/api/docs/pricing>
- <https://developers.openai.com/apps-sdk/app-submission-guidelines>
- <https://developers.openai.com/plugins/deploy/submission>
- <https://docs.api.nvidia.com/nim/docs/product>
- <https://docs.litellm.ai/blog/security-update-march-2026>
- <https://docs.mistral.ai/models/ocr-4-1>
- <https://gemini.google.com/robots.txt>
- <https://generativelanguage.googleapis.com/>
- <https://generativelanguage.googleapis.com/v1beta/models/>
- <https://generativelanguage.googleapis.com/v1beta/openai/>
- <https://gigazine.net/gsc_news/en/20260827-claude-chrome-available/>
- <https://github.com/BerriAI/litellm>
- <https://help.openai.com/en/articles/6825453-chatgpt-release-notes>
- <https://learn.chatgpt.com/docs/auth>
- <https://mistral.ai/news/ocr-4/>
- <https://openai.com/policies/row-terms-of-use/>
- <https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints>
- <https://openrouter.ai/api/v1/models>
- <https://openrouter.ai/docs/api_reference/limits>
- <https://openrouter.ai/docs/faq>
- <https://openrouter.ai/docs/guides/features/structured-outputs>
- <https://openrouter.ai/docs/guides/overview/auth/byok>
- <https://openrouter.ai/docs/guides/privacy/data-collection>
- <https://openrouter.ai/docs/guides/routing/model-fallbacks>
- <https://openrouter.ai/docs/guides/routing/provider-selection>
- <https://platform.claude.com/docs/en/about-claude/model-deprecations.md>
- <https://platform.claude.com/docs/en/about-claude/pricing.md>
- <https://platform.claude.com/docs/en/about-claude/pricing>
- <https://platform.claude.com/docs/en/api/rate-limits.md>
- <https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md>
- <https://platform.claude.com/docs/en/manage-claude/api-and-data-retention.md>
- <https://platform.claude.com/docs/en/models/overview.md>
- <https://platform.claude.com/docs/en/models/sonnet-5-5/overview.md>
- <https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/>
- <https://simonwillison.net/2026/Jul/9/gpt-5-6/>
- <https://simonwillison.net/2026/Sep/22/opus-and-sol-and-luna/>
- <https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>
- <https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome>
- <https://techcrunch.com/2025/05/27/openai-may-soon-let-you-sign-in-with-chatgpt-for-other-apps/>
- <https://techcrunch.com/2026/09/22/openai-launches-gpt-6-sol-and-luna/>
- <https://www.anthropic.com/claude-sonnet-5-5>
- <https://www.anthropic.com/legal/consumer-terms>
- <https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546>

### A.2 Chrome platform & Chrome Web Store policy (72)

- <https://chromewebstore.google.com/detail/>
- <https://chromewebstore.google.com/detail/careerflow-ai-job-applica/iadokddofjgcgjpjlfhngclhpmaelnli>
- <https://chromewebstore.google.com/detail/huntr-job-search-tracker/mihdfbecejheednfigjpdacgeilhlmnf?hl=en>
- <https://chromewebstore.google.com/detail/jobright-autofill-%E2%80%93-insta/odcnpipkhjegpefkfplmedhmkmmhmoko>
- <https://chromewebstore.google.com/detail/jobscan-job-search-tracke/apppjobnbahbomhgmcgolplkpigjlofl>
- <https://chromewebstore.google.com/detail/simplify-copilot-autofill/pbanhockgagggenencehbnadejlgchfc>
- <https://chromewebstore.google.com/detail/teal-job-search-companion/opafjjlpbiaicbbgifbejoochmmeikep>
- <https://chromewebstore.google.com/search/resume%20tailor>
- <https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=148>
- <https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=154>
- <https://developer.chrome.com/blog/cws-policy-updates-2026>
- <https://developer.chrome.com/blog/extensions-io-2026>
- <https://developer.chrome.com/blog/structured-clone-messaging>
- <https://developer.chrome.com/docs/ai/built-in>
- <https://developer.chrome.com/docs/ai/built-in-apis>
- <https://developer.chrome.com/docs/ai/prompt-api>
- <https://developer.chrome.com/docs/ai/proofreader-api>
- <https://developer.chrome.com/docs/ai/rewriter-api>
- <https://developer.chrome.com/docs/ai/writer-api>
- <https://developer.chrome.com/docs/extensions/ai>
- <https://developer.chrome.com/docs/extensions/develop/concepts/activeTab>
- <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>
- <https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>
- <https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle>
- <https://developer.chrome.com/docs/extensions/develop/concepts/messaging>
- <https://developer.chrome.com/docs/extensions/develop/concepts/network-requests>
- <https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings>
- <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics>
- <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events>
- <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- <https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies>
- <https://developer.chrome.com/docs/extensions/develop/migrate/improve-security>
- <https://developer.chrome.com/docs/extensions/develop/migrate/known-issues>
- <https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline>
- <https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code>
- <https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy>
- <https://developer.chrome.com/docs/extensions/develop/ui>
- <https://developer.chrome.com/docs/extensions/develop/ui/add-popup>
- <https://developer.chrome.com/docs/extensions/develop/ui/options-page>
- <https://developer.chrome.com/docs/extensions/how-to/integrate/oauth>
- <https://developer.chrome.com/docs/extensions/reference/api/action>
- <https://developer.chrome.com/docs/extensions/reference/api/contextMenus>
- <https://developer.chrome.com/docs/extensions/reference/api/downloads>
- <https://developer.chrome.com/docs/extensions/reference/api/identity>
- <https://developer.chrome.com/docs/extensions/reference/api/offscreen>
- <https://developer.chrome.com/docs/extensions/reference/api/permissions>
- <https://developer.chrome.com/docs/extensions/reference/api/runtime>
- <https://developer.chrome.com/docs/extensions/reference/api/scripting>
- <https://developer.chrome.com/docs/extensions/reference/api/sidePanel>
- <https://developer.chrome.com/docs/extensions/reference/api/storage>
- <https://developer.chrome.com/docs/extensions/reference/api/tabs>
- <https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy>
- <https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable>
- <https://developer.chrome.com/docs/extensions/reference/manifest/sandbox>
- <https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources>
- <https://developer.chrome.com/docs/extensions/reference/permissions-list>
- <https://developer.chrome.com/docs/extensions/whats-new>
- <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- <https://developer.chrome.com/docs/webstore/program-policies/api-use>
- <https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property>
- <https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>
- <https://developer.chrome.com/docs/webstore/program-policies/permissions>
- <https://developer.chrome.com/docs/webstore/program-policies/policies>
- <https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq>
- <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>
- <https://developer.chrome.com/docs/webstore/publish>
- <https://developer.chrome.com/docs/webstore/register>
- <https://developer.chrome.com/docs/webstore/review-process>
- <https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/permission_warnings/index.md>
- <https://support.google.com/chrome/thread/13959323>
- <https://www.security.com/threat-intelligence/chrome-extension-credentials>
- <https://wxt.dev/>

### A.3 Job portals, ATS APIs & platform terms (76)

- <http://schema.org/JobPosting>
- <https://api.ashbyhq.com/posting-api/job-board/>
- <https://api.ashbyhq.com/posting-api/job-board/Ashby>
- <https://api.eu.lever.co/v0/postings/>
- <https://api.lever.co/v0/postings/>
- <https://api.lever.co/v0/postings/leverdemo?mode=json&limit=2>
- <https://api.linkedin.com/rest/memberSnapshotData?q=criteria>
- <https://api.smartrecruiters.com/v1/companies/>
- <https://bestjobsearchapps.com/articles/en/linkedin-premium-cost-in-2026-pricing-for-job-seekers-and-employers>
- <https://boards-api.greenhouse.io/v1/boards/>
- <https://boards-api.greenhouse.io/v1/boards/greenhouse/jobs>
- <https://boards.greenhouse.io/embed/job_board/js?for=>
- <https://boards.greenhouse.io/robots.txt>
- <https://brand.linkedin.com/policies>
- <https://careers-americas.icims.com/jobs/26266/software-engineer-intern,-2027-summer-u.s./job>
- <https://careers-markon.icims.com/jobs/8693/junior-software-engineer/job?in_iframe=1>
- <https://developers.ashbyhq.com/docs/public-job-posting-api>
- <https://developers.google.com/search/docs/appearance/structured-data/job-posting>
- <https://developers.greenhouse.io/job-board.html>
- <https://developers.smartrecruiters.com/docs/posting-api>
- <https://developers.smartrecruiters.com/docs/rate-limiting.md>
- <https://developers.smartrecruiters.com/reference/v1listpostings.md>
- <https://docs.greenhouse.io/job-board.html>
- <https://github.com/lever/postings-api>
- <https://help.lever.co/hc/en-us/articles/28081525270685-Talent-Fit-AI-Brief>
- <https://job-boards.greenhouse.io/greenhouse/jobs/8021661>
- <https://job-boards.greenhouse.io/robots.txt>
- <https://jobs.ashbyhq.com/>
- <https://jobs.ashbyhq.com/Ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2>
- <https://jobs.lever.co/>
- <https://jobs.lever.co/acme/123>
- <https://jobs.lever.co/leverdemo/681fbc53-1e34-4a46-8677-3a78118674eb>
- <https://jobs.smartrecruiters.com/>
- <https://jobs.smartrecruiters.com/smartrecruiters/744000148454651>
- <https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2>
- <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-3rd-party/?view=li-dma-data-portability-2026-08>
- <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/shared/member-snapshot-api?view=li-dma-data-portability-2026-08>
- <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/shared/snapshot-domain?view=li-dma-data-portability-2026-08>
- <https://my.greenhouse.com/blogs/how-does-greenhouse-use-ai-heres-everything-candidates-need-to-know>
- <https://premium.linkedin.com/careers/career>
- <https://support.greenhouse.io/hc/en-us/articles/200721644-Choose-a-careers-page-integration-option>
- <https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse>
- <https://support.greenhouse.io/hc/en-us/articles/24315491395227-AI-ML-Security-Privacy>
- <https://support.greenhouse.io/hc/en-us/articles/41131886674075-Talent-Matching-FAQ>
- <https://support.greenhouse.io/hc/en-us/articles/46365908766875-Embed-a-Greenhouse-job-board-on-your-career-site>
- <https://web.archive.org/web/20260921192649/https://www.glassdoor.com/about/terms/>
- <https://wellfound.com/robots.txt>
- <https://wellfound.com/terms>
- <https://www.engadget.com/linkedins-ai-job-coach-can-write-your-cover-letters-and-edit-your-resume-130033553.html>
- <https://www.eweek.com/news/ai-job-applications-linkedin/>
- <https://www.glassdoor.com/about/terms/>
- <https://www.greenhouse.com/blog/greenhouse-2025-workforce-hiring-report>
- <https://www.greenhouse.com/newsroom/an-ai-trust-crisis-70-of-hiring-managers-trust-ai-to-make-faster-and-better-hiring-decisions-only-8-of-job-seekers-call-it-fair>
- <https://www.hrdive.com/news/hiring-in-an-ai-doom-loop-greenhouse/753679/>
- <https://www.icims.com/copilot/>
- <https://www.icims.com/products/ai-recruiting-software/>
- <https://www.indeed.com/legal>
- <https://www.indeed.com/news/releases/>
- <https://www.indeed.com/news/releases/indeed-introduces-new-suite-of-hiring-products-career-scout-talent-scout-premium-sponsored-jobs-and-indeed-connect>
- <https://www.indeed.com/robots.txt>
- <https://www.jobscan.co/blog/lever-ats/>
- <https://www.jobsistant.com/guides/linkedin-2026-ai-changes>
- <https://www.lever.co/blog/levers-ai-innovations-are-here>
- <https://www.linkedin.com/help/linkedin/answer/a1339364/downloading-your-account-data>
- <https://www.linkedin.com/help/linkedin/answer/a1341387>
- <https://www.linkedin.com/help/linkedin/answer/a541960>
- <https://www.linkedin.com/help/linkedin/answer/a6214075>
- <https://www.linkedin.com/legal/crawling-terms>
- <https://www.linkedin.com/legal/l/portability-api-terms>
- <https://www.linkedin.com/legal/user-agreement>
- <https://www.linkedin.com/robots.txt>
- <https://www.naukri.com/cloudgateway-bpe/ugs/v0/naukri/JS/consent/policy/fullContent?policyType=TNC&platform=desktop>
- <https://www.naukri.com/robots.txt>
- <https://www.naukri.com/termsconditions>
- <https://www.sec.gov/Archives/edgar/data/1327811/000132781124000032/wday-02262024x991.htm>
- <https://www.workday.com/en-us/products/talent-management/ai-recruiting.html>

### A.4 Legal, case law & regulation (9)

- <https://clearinghouse.net/case/44074/>
- <https://law.justia.com/cases/federal/appellate-courts/ca9/17-16783/17-16783-2022-04-18.html>
- <https://policies.google.com/terms>
- <https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf>
- <https://www.amsshardul.com/insight/enforcement-of-the-dpdp-act-and-notification-of-the-dpdp-rules/>
- <https://www.cppa.ca.gov/regulations/cpi_adjustment.html>
- <https://www.dwt.com/>
- <https://www.dwt.com/blogs/employment-labor-and-benefits/2025/05/ai-hiring-age-discrimination-federal-court-workday>
- <https://www.hklaw.com/en/insights/publications/2025/05/federal-court-allows-collective-action-lawsuit-over-alleged>

### A.5 Competitors, market & demand (60)

- <https://aivario.com/tools/resume-io>
- <https://app.jobscan.co/plan>
- <https://applyarc.com/compare/teal-pricing>
- <https://blog.hiringthing.com/applicant-tracking-system-myths>
- <https://campustechnology.com/articles/2025/09/10/openai-to-launch-ai-powered-jobs-platform-by-mid-2026.aspx>
- <https://enhancv.com/blog/does-ats-reject-resumes/>
- <https://enhancv.com/blog/resume-io-review/>
- <https://enhancv.com/pricing/>
- <https://help.simplify.jobs/articles/5623502>
- <https://help.simplify.jobs/articles/5623502-whats-included-in-simplify-features-and-pricing>
- <https://huntr.co/pricing>
- <https://jobright.ai/>
- <https://jobright.ai/pricing>
- <https://lazyapply.com/>
- <https://makerstack.co/reviews/jobscan-review/>
- <https://novoresume.com/career-blog/resume-report-2026>
- <https://novoresume.com/pricing>
- <https://outapply.com/blog/jobright-ai-pricing>
- <https://pitchmeai.com/blog/jobscan-pricing-plans>
- <https://pitchmeai.com/blog/resume-worded-pricing-premium-worth-it>
- <https://resufit.com/blog/zety-review-pricing-is-it-worth-it/>
- <https://resumap.io/compare/novoresume>
- <https://resume.io/pricing>
- <https://resumeworded.com/buy-pro>
- <https://resumeworded.com/pricing>
- <https://sidsaladi.substack.com/p/build-your-own-ai-resume-tailor-a>
- <https://the-decoder.com/openai-turns-chatgpt-into-a-career-platform-with-job-search-and-cv-editor/>
- <https://www.atsresumeai.com/compare/is-jobscan-worth-it>
- <https://www.bls.gov/news.release/jolts.nr0.htm>
- <https://www.bold.com/about/>
- <https://www.careerflow.ai/>
- <https://www.careerflow.ai/pricing>
- <https://www.cnbc.com/2025/10/29/recruiters-are-drinking-through-a-fire-hose-of-job-applications-experts-say.html>
- <https://www.jobscan.co/>
- <https://www.jobscan.co/blog/fortune-500-use-applicant-tracking-systems/>
- <https://www.jobscan.co/blog/jobscan-vs-simplify/>
- <https://www.jobscan.co/blog/jobscan-vs-teal/>
- <https://www.jobscan.co/blog/resume-keyword-stuffing/>
- <https://www.jobscan.co/pricing>
- <https://www.kickresume.com/en/press/ai-job-search-data/>
- <https://www.kickresume.com/en/pricing/>
- <https://www.library.hbs.edu/working-knowledge/how-to-tap-the-talent-automated-hr-platforms-miss>
- <https://www.paritydeals.com/stripe-managed-payments-vs-lemon-squeezy-fees/>
- <https://www.remotejobassistant.com/blog/careerflow-review>
- <https://www.remotejobassistant.com/blog/sonara-ai-review>
- <https://www.resumly.ai/answers/what-happened-to-sonara-ai>
- <https://www.rezi.ai/pricing>
- <https://www.soundcv.com/blog/novoresume-review-2026>
- <https://www.soundcv.com/blog/zety-review-2026>
- <https://www.tealhq.com/pricing>
- <https://www.trustpilot.com/review/jobright.ai>
- <https://www.trustpilot.com/review/jobscan.co>
- <https://www.trustpilot.com/review/lazyapply.com>
- <https://www.trustpilot.com/review/resume.io>
- <https://www.trustpilot.com/review/rezi.ai>
- <https://www.trustpilot.com/review/simplify.jobs>
- <https://www.trustpilot.com/review/tealhq.com>
- <https://www.trustpilot.com/review/zety.com>
- <https://www.wobo.ai/blog/jobright-review/>
- <https://zplatform.ai/ai-reviews/jobright-ai/>

### A.6 Infrastructure, databases, auth, email, payments, observability pricing (119)

- <https://auth0.com/pricing>
- <https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-api-gateway-integration-timeout-limit-29-seconds/>
- <https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/>
- <https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis/>
- <https://aws.amazon.com/api-gateway/pricing/>
- <https://aws.amazon.com/cloudwatch/pricing/>
- <https://aws.amazon.com/cognito/pricing/>
- <https://aws.amazon.com/elasticache/pricing/>
- <https://aws.amazon.com/fargate/pricing/>
- <https://aws.amazon.com/kms/pricing/>
- <https://aws.amazon.com/lambda/pricing/>
- <https://aws.amazon.com/rds/aurora/pricing/>
- <https://aws.amazon.com/rds/postgresql/pricing/>
- <https://aws.amazon.com/s3/pricing/>
- <https://aws.amazon.com/secrets-manager/pricing/>
- <https://aws.amazon.com/ses/pricing/>
- <https://aws.amazon.com/sqs/pricing/>
- <https://aws.amazon.com/step-functions/pricing/>
- <https://aws.amazon.com/textract/pricing/>
- <https://aws.amazon.com/vpc/pricing/>
- <https://axiom.co/pricing>
- <https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/>
- <https://azure.microsoft.com/en-us/pricing/details/container-apps/>
- <https://azure.microsoft.com/pricing/details/app-service/linux/>
- <https://azure.microsoft.com/pricing/details/container-apps/>
- <https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/elasticache/USD/current/elasticache.json>
- <https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/lambda/USD/current/lambda.json>
- <https://better-auth.com/docs/plugins/admin>
- <https://betterstack.com/pricing>
- <https://cfdomainpricing.com/>
- <https://clerk.com/pricing>
- <https://cloud.google.com/document-ai/pricing>
- <https://cloud.google.com/identity-platform/pricing>
- <https://cloud.google.com/run/pricing>
- <https://cloud.google.com/sql/pricing>
- <https://developer.paddle.com/api-reference/prices/create-price/>
- <https://developer.paddle.com/build/products/offer-discounts-promotions-coupons/>
- <https://developer.paddle.com/paddle-js/methods/paddle-checkout-open/>
- <https://developers.cloudflare.com/ai-gateway/reference/pricing/>
- <https://developers.cloudflare.com/browser-rendering/>
- <https://developers.cloudflare.com/browser-rendering/pricing/>
- <https://developers.cloudflare.com/containers/pricing/>
- <https://developers.cloudflare.com/d1/platform/limits/>
- <https://developers.cloudflare.com/d1/platform/pricing/>
- <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- <https://developers.cloudflare.com/hyperdrive/platform/pricing/>
- <https://developers.cloudflare.com/kv/concepts/how-kv-works/>
- <https://developers.cloudflare.com/kv/platform/pricing/>
- <https://developers.cloudflare.com/queues/platform/pricing/>
- <https://developers.cloudflare.com/r2/pricing/>
- <https://developers.cloudflare.com/workers-ai/platform/pricing/>
- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
- <https://developers.cloudflare.com/workflows/reference/pricing/>
- <https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html>
- <https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html>
- <https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html>
- <https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-pricing.html>
- <https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html>
- <https://docs.cloud.google.com/run/docs/configuring/request-timeout>
- <https://docs.fly.io/about/pricing/>
- <https://docs.railway.com/networking/public-networking/specs-and-limits>
- <https://docs.stripe.com/billing/subscriptions/coupons>
- <https://docs.stripe.com/payments/managed-payments/eligibility>
- <https://docs.stripe.com/payments/managed-payments>
- <https://domainnamewire.com/2026/04/23/breaking-verisign-raising-wholesale-com-prices/>
- <https://firebase.google.com/pricing>
- <https://fly.io/docs/about/pricing/>
- <https://fly.io/pricing/>
- <https://github.com/better-auth/better-auth>
- <https://github.com/graphile/worker>
- <https://grafana.com/pricing/>
- <https://instances.vantage.sh/aws/rds/db.t4g.micro>
- <https://langfuse.com/pricing>
- <https://lucia-auth.com/>
- <https://neon.com/pricing>
- <https://postmarkapp.com/pricing>
- <https://prices.azure.com/api/retail/prices>
- <https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.csv>
- <https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSQueueService/current/us-east-1/index.csv>
- <https://railway.com/pricing>
- <https://razorpay.com/docs/payments/subscriptions/>
- <https://razorpay.com/docs/payments/subscriptions/faqs/?locale=en-US>
- <https://razorpay.com/pricing/>
- <https://redis.io/pricing/>
- <https://render.com/docs/free>
- <https://render.com/pricing>
- <https://resend.com/pricing>
- <https://selfhost.dev/blog/aws-rds-cost-breakdown-2026/>
- <https://sentry.io/pricing/>
- <https://stripe.com/billing/pricing>
- <https://stripe.com/in/pricing>
- <https://stripe.com/pricing>
- <https://stripe.com/tax/pricing>
- <https://supabase.com/pricing>
- <https://support.stripe.com/questions/managed-payments-pricing>
- <https://trigger.dev/pricing>
- <https://upstash.com/pricing/redis>
- <https://vercel.com/blog/vercel-acquires-better-auth>
- <https://vercel.com/docs/functions/limitations>
- <https://vercel.com/pricing>
- <https://worker.graphile.org/>
- <https://www.better-auth.com/pricing>
- <https://www.braintrust.dev/pricing>
- <https://www.cloudflare.com/plans/zero-trust-services/>
- <https://www.cloudflare.com/products/registrar/>
- <https://www.cloudzero.com/blog/lambda-pricing/>
- <https://www.datadoghq.com/pricing/>
- <https://www.helicone.ai/pricing>
- <https://www.inngest.com/pricing>
- <https://www.langchain.com/pricing>
- <https://www.lemonsqueezy.com/blog/2026-update>
- <https://www.lemonsqueezy.com/pricing>
- <https://www.mongodb.com/pricing>
- <https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid>
- <https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle>
- <https://www.paddle.com/pricing>
- <https://www.usage.ai/blogs/aws/reserved-instances/rds/storage-cost/>

### A.7 Resume parsing / generation libraries & ATS formatting (34)

- <https://developer.textkernel.com/tx-platform/v10/faq/>
- <https://developer.textkernel.com/tx-platform/v10/transaction-cost/>
- <https://developers.llamaindex.ai/llamaparse/general/pricing/>
- <https://github.com/datalab-to/marker>
- <https://github.com/jsonresume/resume-schema>
- <https://github.com/mehmet-kozan/pdf-parse>
- <https://github.com/mozilla/pdf.js/blob/master/src/display/api.js>
- <https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq>
- <https://github.com/mwilliamson/mammoth.js>
- <https://github.com/mwilliamson/mammoth.js/issues/9>
- <https://github.com/mwilliamson/mammoth.js#security>
- <https://github.com/naptha/tesseract.js>
- <https://github.com/unjs/unpdf>
- <https://github.com/VolodymyrBaydalka/docxjs>
- <https://huggingface.co/docling-project/docling-models>
- <https://huggingface.co/ibm-granite/granite-docling-258M>
- <https://pdfminersix.readthedocs.io/en/latest/topic/converting_pdf_to_text.html>
- <https://pymupdf.readthedocs.io/en/latest/about.html>
- <https://pymupdf.readthedocs.io/en/latest/recipes-text.html>
- <https://pypi.org/project/gemini-webapi>
- <https://pypi.org/pypi/>
- <https://pypi.org/pypi/pymupdf/json>
- <https://reducto.ai/pricing>
- <https://registry.npmjs.org/>
- <https://registry.npmjs.org/@cantoo%2fpdf-lib>
- <https://registry.npmjs.org/ai/latest>
- <https://registry.npmjs.org/docx>
- <https://registry.npmjs.org/pdf-lib>
- <https://registry.npmjs.org/pdfjs-dist/latest>
- <https://www.affinda.com/recruitment-ai-pricing/>
- <https://www.daxtra.com/resume-cv-parsing/>
- <https://www.hropenstandards.org/standards>
- <https://www.llamaindex.ai/pricing>
- <https://www.rchilli.com/pricing>

### A.8 Security, prompt injection & evaluation (8)

- <https://arxiv.org/abs/2607.01457>
- <https://arxiv.org/abs/2608.26171>
- <https://ceur-ws.org/Vol-3920/paper03.pdf>
- <https://checkmarx.com/learn/breaking-down-the-owasp-top-10-for-llm-applications/>
- <https://rhisac.org/threat-intelligence/cyberhaven-extension-compromise-part-of-broader-campaign-affecting-multiple-chrome-extensions/>
- <https://www.invicti.com/blog/web-security/owasp-top-10-risks-llm-security-2025>
- <https://www.microsoft.com/en-us/msrc/blog/2025/07/how-microsoft-defends-against-indirect-prompt-injection-attacks>
- <https://www.nightfall.ai/blog/heres-what-we-can-learn-from-the-cyberhaven-incident>

### A.9 Other (9)

- <https://claude.ai/robots.txt>
- <https://github.com/HanaokaYuzu/Gemini-API>
- <https://github.com/leetanshaj/openai-sentinel>
- <https://github.com/robotlearning123/gpt2agent>
- <https://github.com/taskforcesh/bullmq>
- <https://github.com/timgit/pg-boss>
- <https://github.com/transitive-bullshit/chatgpt-api/issues/96>
- <https://github.com/wong2/chatgpt-google-extension/issues>
- <https://support.google.com/gemini/answer/17209137>
