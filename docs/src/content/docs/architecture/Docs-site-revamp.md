---
title: Docs site revamp
---

# Docs site revamp

**Status:** draft  
**Date:** 2026-07-07  
**Branch:** `docs/doc-revamp`

## Summary

ABCA’s documentation site (Astro + Starlight under `docs/`) has grown faster than its information architecture, navigation, and authoring workflow. Guides are split across monolithic source files, mirrored pages, and a hand-maintained sidebar — which already drift (orphaned pages, missing nav entries). The introduction page mixes visionary narrative with onboarding, and integration setup guides compete for attention with day-to-day usage content.

This document defines goals, requirements, and a phased plan to revamp the site for **operators**, **daily users**, **knowledge workers**, and **contributors** — while keeping the existing source-first + sync pipeline and [ADR-004 tabula rasa](/sample-autonomous-cloud-coding-agents/architecture/adr-004-tabula-rasa-documentation) standard.

A major theme: ABCA (name TBD) is a **general autonomous agent platform**, not a coding-only tool. The docs must make that obvious in navigation and marketing narrative — similar to [Ona's beyond-coding positioning](https://ona.com/cases/beyond-coding) — while routing readers to **concrete, tutorial-style use cases** inspired by [Hermes Agent's user-stories hub](https://hermes-agent.nousresearch.com/docs/user-stories).

**Information architecture** follows [Diátaxis](https://diataxis.fr/) (tutorials, how-to guides, explanation, reference). **Authoring** follows docs-as-code: source in git, automated sync, CI gates against drift. **Presentation** shifts to a **light-first** visual design (readable, approachable — not the current default-dark chrome).

## Problem statement

### Who reads these docs

| Persona | Primary goal | Typical entry |
|---------|--------------|---------------|
| **New operator** | Deploy ABCA, onboard first repo, submit first task | Quick Start, Deployment Guide |
| **Teammate** | Submit tasks, authenticate, use CLI/Slack/Linear | User guide, channel setup guides |
| **Repo / blueprint author** | Customize prompts, Cedar policies, per-repo overrides | Customizing section |
| **Platform contributor** | Build features, run tests, open PRs | Developer guide, Contributing |
| **Architect / security reviewer** | Understand control plane, threat model, cost | Architecture, ADRs |
| **Evaluator / buyer** | Understand what the platform is and how pieces fit, without deploying | Concepts, Beyond coding |
| **Knowledge worker** | Run research, analysis, or ops workflows without touching a repo | Use case tutorials, Concepts → Level 100, `knowledge/web-research-v1` |
| **Autonomous agent** | Execute a task with zero implicit context | Any procedural page (ADR-004) |

Each persona needs a clear path. Today they often land on a long introduction or a flat sidebar and must infer the next step. There is no **“what do you want to achieve?”** router, and the platform's repo-optional workflows (`default/agent-v1`, `knowledge/web-research-v1`) are buried in architecture docs instead of surfaced as first-class journeys.

### Current strengths

- **Source-first authoring** — guides live in `docs/guides/`, design in `docs/design/`, ADRs in `docs/decisions/`; Starlight mirrors are generated.
- **Tabula rasa standard** — ADR-004 gives a concrete quality bar for procedural content.
- **Rich architecture corpus** — 19 design docs with diagrams, mermaid, and cross-links.
- **CI guardrails** — sync mutation check, link check, Astro build in CI.
- **GitHub Pages compatibility** — custom Search/Sidebar components handle the `base` path correctly.

### Pain points (observed)

1. **Navigation drift** — `astro.config.mjs` sidebar is manual. Sync produces pages that are not linked (e.g. `developer-guide/where-to-make-changes`, `getting-started/cost-attribution`).
2. **Dual maintenance for structure** — `sync-starlight.mjs` maps slugs, splits guides by `##`, moves files between `using/` and `customizing/`, and maintains anchor rewrite tables. Adding a page requires edits in three places (source, sync script, sidebar).
3. **Monolithic source guides** — `USER_GUIDE.md` (~1,100 lines) and `DEVELOPER_GUIDE.md` (~380 lines) are split at sync time. Authors think in one file; readers get many pages; sidebar order is unrelated to source order.
4. **Weak package README** — `docs/README.md` is a placeholder (`# replace this`), so contributors opening the `docs/` tree get no orientation.
5. **Introduction overload** — `index.md` leads with “software dark factory” narrative (~50 lines) before “get started.” Valuable for vision, heavy for someone who needs deploy steps in the next five minutes. The page is a **long-form doc**, not a landing experience — unlike [Starlight’s own docs homepage](https://starlight.astro.build/) (splash hero + CTAs) or product sites like [Ona](https://ona.com/) (value tiles above the fold).
6. **Flat “Using the Platform” section** — 14 sibling pages including three PM integrations, a migration runbook, and conceptual pages (`task-lifecycle`, `what-the-agent-does`) at the same level.
7. **Architecture discoverability** — 18+ pages, collapsed by default, no overview map beyond `ARCHITECTURE.md`. Hard to know what to read first.
8. **No first-class troubleshooting** — the Claude Code plugin has `/troubleshoot`, but the site has no dedicated runbook index for common failures.
9. **Inconsistent page metadata** — frontmatter `title` and `description` are auto-generated from filenames; SEO and search snippets are uneven.
10. **Role-based journeys are implicit** — user guide describes four lifecycle roles in prose, but the site nav does not reflect operator vs teammate vs onboarder paths.
11. **No use-case discovery** — workflows exist for coding *and* knowledge work, but the site reads as “coding agents on AWS.” Operators evaluating the platform for research, review, or ops automation have no curated entry point.
12. **No tutorial layer** — procedural guides (Quick Start, channel setup) exist, but there are no outcome-oriented **“do X in 15 minutes”** tutorials (e.g. “automate PR review on every open PR,” “run a competitive research brief”).
13. **Marketing narrative trapped in architecture** — the “software dark factory” and workflow-driven-task story live on the index and in design docs; there is no scannable **beyond coding** page for evaluators and non-engineer stakeholders.
14. **Jargon without a on-ramp** — terms like **harness**, **blueprint**, **workflow**, **hydration**, and **orchestrator** appear in architecture docs with no beginner-friendly definitions. ADR-004 calls for a glossary; today there is none in the site nav. Customers must read `COMPUTE.md` or `WORKFLOWS.md` to learn vocabulary.
15. **Conceptual content mixed with how-to** — `task-lifecycle` and `what-the-agent-does` live under “Using the Platform” beside Slack setup guides, so readers cannot tell **understand** vs **do**.
16. **No Diátaxis discipline** — tutorials, how-tos, explanations, and reference material are interleaved in monolithic guides; readers cannot tell whether they are learning, doing, understanding, or looking up a fact ([Diátaxis](https://diataxis.fr/)).
17. **Default-dark chrome** — `astro.config.mjs` forces dark mode on first visit; evaluators and enterprise readers expect a **light, readable** docs surface (common on [Starlight](https://starlight.astro.build/) and product docs).
18. **Snippet quality uneven** — some examples use implicit placeholders, single-language-only blocks, or commands that fail copy-paste; no documented standard for `YOUR_*` placeholders or multi-stack parity ([GitHub: documentation done right](https://github.blog/developer-skills/documentation-done-right-a-developers-guide/)).
19. **No guided docs contribution path** — the ABCA plugin has `/setup`, `/deploy`, etc., but no `/write-docs` skill for contributors adding or updating documentation.

## Goals

1. **Findability** — any persona reaches the right doc in ≤2 clicks from the home page or search.
2. **No nav drift** — every synced page appears in navigation, or is explicitly excluded with a documented reason.
3. **Lower authoring friction** — adding or renaming a page should not require editing scattered slug maps unless unavoidable.
4. **Tabula rasa compliance** — procedural pages pass ADR-004; audit and fix top failure paths (Quick Start, deploy, auth, first submit).
5. **Progressive disclosure** — vision and deep architecture remain available without blocking onboarding.
6. **Contributor clarity** — `docs/README.md` and developer-guide pages explain source → sync → build → PR workflow.
7. **Use-case-first discovery** — readers who know their goal (“review every PR,” “research a market,” “fix CVEs”) reach a tutorial in ≤2 clicks from Getting Started or the home page.
8. **Beyond-coding positioning** — a dedicated page explains non-coding and hybrid workflows with the same governed execution model (isolated runtime, audit trail, policy gates) that coding tasks use.
9. **Conceptual literacy** — any reader can learn platform vocabulary and mental model via a **Concepts** section with Level 100 (fundamentals) and Level 200 (how it fits together) before touching Architecture deep dives.
10. **Diátaxis-aligned IA** — every page has one primary type (tutorial, how-to, explanation, reference); navigation and templates make the type obvious.
11. **Light-first UX** — default to a clean light theme; dark mode remains available via Starlight toggle.
12. **Docs-as-code with minimal drift** — automate sync, nav validation, link check, and build in CI; contributors run one skill (`/write-docs`) for the happy path.

## Non-goals

- Replacing Starlight or migrating off Astro.
- Moving design docs out of `docs/design/` (repo conventions and AGENTS.md references stay).
- Rewriting all architecture content (structure and navigation first; content refresh is follow-on work).
- Building a separate marketing site outside the repo (the **Beyond coding** page lives in docs, not a standalone landing domain).
- Scraping community stories from social feeds (Hermes-style aggregation is a **Phase 4** optional; Phase 1–2 ship curated first-party tutorials only).
- Auto-generating docs from code (OpenAPI UI, etc.) — may be a future phase.
- Renaming ABCA in this revamp (copy should tolerate a future rename; avoid hard-coding the acronym in URLs/slugs where possible).

## Requirements

### Functional

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Home page is a **splash landing** (hero, primary CTAs, value tiles) — not a long-form introduction doc | P0 |
| F1b | Hero includes **Get started** (Quick Start) and **View on GitHub** (repo) buttons, per [Starlight splash pattern](https://starlight.astro.build/guides/customization/#splash-page) | P0 |
| F1c | Below the hero, **value proposition cards** (4–6 tiles) highlight platform differentiators — inspired by [Ona](https://ona.com/) capability sections | P0 |
| F2 | Sidebar reflects **all** published pages OR a generated manifest; no orphan mirror pages | P0 |
| F3 | **Role-based landing pages** (or hub pages) for Operator, Teammate, Repo author, Contributor | P1 |
| F4 | **Integrations** grouped (Slack, Linear, Jira, webhooks) under a sub-section, not flat siblings | P1 |
| F5 | **Troubleshooting** section with symptom → cause → fix entries; links from Quick Start error blocks | P1 |
| F6 | **Architecture hub** — curated reading order (5–7 docs) before the full catalog | P1 |
| F7 | Cost attribution guide linked from Getting Started (operator FinOps path) | P2 |
| F8 | **“Edit this page”** links to GitHub source file (guide vs design vs ADR) | P2 |
| F9 | **Concepts** top-level nav section — hub + Level 100 + Level 200 pages; glossary as A–Z index inside Concepts | P0 |
| F10 | **Learning path** page — last item under Getting Started; routes readers by goal (“deploy,” “submit first task,” “integrate Slack,” “customize a repo,” “contribute,” “run research,” **“understand how it works”**) | P0 |
| F11 | **Use case tutorials** — outcome-oriented guides (prerequisites → steps → success criteria) grouped by category | P0 |
| F12 | **Beyond coding** page — marketing narrative + capability tiles for non-engineer and hybrid workflows (inspired by [Ona beyond coding](https://ona.com/cases/beyond-coding)) | P1 |
| F13 | Use case index supports **category filters** (coding, review, research, ops, integrations) — static at first; optional data-driven tiles later | P1 |
| F14 | Each tutorial links to the **workflow** it uses (`coding/pr-review-v1`, `knowledge/web-research-v1`, etc.) and the channel docs (CLI, webhook, Linear) | P1 |
| F15 | Every Level 100 concept page: **one-sentence definition**, plain-language analogy, “see also” link to Level 200 and Architecture | P0 |
| F16 | Concepts hub includes an **end-to-end diagram** (submit → orchestrator → compute → outcome) linking to child pages | P1 |
| F17 | Procedural docs **bold + define** platform terms on first use; link to the matching Concepts page (ADR-004 terminology) | P1 |
| F18 | Splash page uses `template: splash` — **no sidebar**, full-width layout | P0 |
| F19 | Landing secondary row: **journey cards** (Concepts · Use cases · Beyond coding · Contribute) below value tiles | P1 |
| F20 | Optional hero visual — architecture diagram or subtle branded illustration; must not block LCP on GitHub Pages | P2 |
| F21 | **Light-first theme** — remove forced dark default; `prefers-color-scheme` or explicit light default | P0 |
| F22 | Optional `docs/src/styles/custom.css` — refined light palette (spacing, accent, card contrast) without breaking Starlight accessibility | P1 |
| F23 | Each doc page declares **`diataxis:`** type in frontmatter (`tutorial` \| `how-to` \| `explanation` \| `reference`) for authoring lint | P1 |
| F24 | New ABCA plugin skill **`/write-docs`** — guided workflow to add/update docs per Diátaxis + ADR-004 | P0 |

### Non-functional

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Preserve `mise //docs:sync` + CI mutation check workflow | P0 |
| NF2 | Keep GitHub Pages `base` path working (no regressions to Search/Sidebar) | P0 |
| NF3 | Pagefind search continues to index all public content | P0 |
| NF4 | Link check CI passes on all internal links after IA changes | P0 |
| NF5 | Mobile nav usable for top journeys (get started, submit task) | P1 |
| NF6 | Meaningful `description` frontmatter on hub and getting-started pages | P1 |
| NF7 | Landing page **Lighthouse performance** — no render-blocking assets; prefer Starlight built-in components over heavy custom JS | P1 |
| NF8 | Landing readable on mobile (hero stack, card grid wraps, tap targets ≥44px) | P0 |
| NF9 | **WCAG contrast** on light theme — body text and code blocks meet AA | P0 |
| NF10 | Theme toggle preserves user choice (`localStorage`); no override script forcing dark | P0 |

### Content quality (ADR-004)

| ID | Requirement | Priority |
|----|-------------|----------|
| C1 | Quick Start and Deployment Guide audited for tabula rasa (prerequisites, expected output, error fixes) | P0 |
| C2 | Authentication and repository onboarding pages include success criteria | P1 |
| C3 | Every command block copy-pasteable; no hidden env vars without prior mention | P1 |
| C4 | Level 100 concept pages pass tabula rasa (no undefined terms without a link) | P0 |
| C5 | Blueprint vs workflow explained in both Level 100 and Level 200 (top confusion per ADR-014) | P0 |
| C6 | **Code snippets** — valid syntax, copy-pasteable, `YOUR_*` placeholders with obtain instructions ([WtD principles](https://www.writethedocs.org/guide/)) | P0 |
| C7 | **Language parity** — REST examples show `curl` + one of TypeScript/Python where APIs are shown; CLI examples use `bgagent` | P1 |
| C8 | **Runnable examples** — link to repo Quick Start or documented sandbox when live try-it is not hosted | P2 |
| C9 | One **Diátaxis type per page** — no tutorial+reference mashups; split or cross-link instead | P1 |

## Proposed changes

### 1. Information architecture (sidebar)

**Target top-level structure:**

```
Introduction                    → splash landing only (omit from sidebar or "Home")
Beyond Coding                 (new — evaluator / stakeholder narrative)
Getting Started
  ├─ Quick Start
  ├─ Deployment Guide
  ├─ Cost Attribution          (currently orphaned)
  ├─ Troubleshooting           (new hub)
  └─ Learning path               (new — goal router; LAST in section)
Concepts                        (new top-level — understand before deep dives)
  ├─ How the platform works      (hub — end-to-end story + diagram)
  ├─ Level 100 — Fundamentals
  │    ├─ Task and workflow
  │    ├─ Blueprint vs workflow
  │    ├─ Orchestrator and agent
  │    ├─ Agent harness
  │    ├─ Compute and isolation
  │    ├─ Channels and submission
  │    ├─ Memory (overview)
  │    └─ Policy and guardrails (overview)
  ├─ Level 200 — How it fits together
  │    ├─ Task lifecycle
  │    ├─ Context hydration
  │    ├─ Pre-flight and admission
  │    ├─ Blueprint steps (deterministic vs agentic)
  │    ├─ Tool policy and Cedar
  │    ├─ Memory tiers and provenance
  │    ├─ Observability and audit trail
  │    └─ Cost and limits
  └─ Glossary                    (A–Z index → links to 100/200 pages)
Use Cases & Tutorials           (new top-level section)
  ├─ All use cases               (index with category filters)
  ├─ Coding
  │    ├─ Implement from a GitHub issue
  │    ├─ Iterate on PR review feedback
  │    └─ Dependency / CVE remediation
  ├─ Review & quality
  │    ├─ Automated PR review on open PRs
  │    └─ Pre-merge risk scan (webhook)
  ├─ Research & knowledge
  │    ├─ Competitive / market research brief
  │    └─ Summarize attachments + web sources
  ├─ Operations & platform
  │    ├─ Onboard a repo and tune a blueprint
  │    └─ Cost attribution for FinOps
  └─ Integrations (cross-links to setup guides)
Using ABCA
  ├─ Overview & roles          (shortened from current overview)
  ├─ Submit & monitor tasks
  │    ├─ CLI
  │    ├─ REST API
  │    └─ Good citizen tips
  ├─ Integrations
  │    ├─ Webhooks
  │    ├─ Slack setup
  │    ├─ Linear setup
  │    ├─ Linear PAK migration
  │    └─ Jira setup
  ├─ Workflows                   (short “which workflow when”; links to Concepts)
  ├─ Authentication
  └─ (task-lifecycle, what-the-agent-does → moved to Concepts Level 200)
Customizing
  (unchanged scope, verify order: onboard → overrides → prompts → Cedar)
Developer Guide
  ├─ Introduction
  ├─ Installation
  ├─ Where to make changes     (currently orphaned)
  ├─ Repository preparation
  ├─ Project structure
  └─ Contributing
Decisions
  (autogenerate — keep)
Architecture
  ├─ Start here (new hub — reading order; assumes Concepts Level 100)
  └─ (existing design docs, possibly grouped: Control plane | Agent | Security | Operations)
Reference
  └─ API contract (link into architecture or duplicate nav entry)
```

**Grouping principles:**

- **Concepts before procedures** — evaluators and new teammates read Level 100 before Slack setup or Architecture.
- **Level 100 before 200** — each Level 200 page states its Level 100 prerequisites at the top.
- **Understand vs do** — conceptual pages live under Concepts; channel setup and CLI commands stay under Using ABCA.

- **Task path before tool path** — “what happens when I submit” before “how Slack is wired.”
- **Setup vs operation** — integration *setup* guides under Integrations; day-to-day usage stays in parent pages.
- **Collapse deep catalogs** — Architecture and Decisions stay collapsible; add a visible “Start here” that is not collapsed.

- **Understand vs do** — conceptual pages live under Concepts; channel setup and CLI commands stay under Using ABCA.

### 1b. Diátaxis content model

Organize and label all documentation per [Diátaxis](https://diataxis.fr/) — four types by **user need**, not by team or file format ([GitHub: documentation done right](https://github.blog/developer-skills/documentation-done-right-a-developers-guide/)):

| Diátaxis type | User need | ABCA nav homes | Example pages |
|---------------|-----------|----------------|---------------|
| **Tutorial** | Learning by doing — safe path to first success | Getting Started · Use Cases | Quick Start, implement-from-issue tutorial |
| **How-to** | Solve a specific problem — assumes basics | Using ABCA · Customizing · Troubleshooting | Slack setup, webhook HMAC, Cedar policy how-to |
| **Explanation** | Understand — context and mental model | Concepts · Beyond coding · Architecture | Level 100/200, WORKFLOWS.md, VISION |
| **Reference** | Look up facts — complete and accurate | Reference · Decisions · Glossary | API contract, ADRs, CLI flag tables |

**Compass rule** ([Diátaxis compass](https://diataxis.fr/compass/)): if the reader is *studying*, use a tutorial; if *working*, use a how-to; if *understanding*, use explanation; if *information*, use reference. Never mix types on one page.

**Mapping current mess → Diátaxis:**

| Today | Problem | After revamp |
|-------|---------|--------------|
| `USER_GUIDE.md` monolith | tutorial + how-to + reference | Split: how-tos under Using; tutorials under Use cases |
| `index.md` essay | explanation on landing | Splash landing + explanation in Concepts / VISION |
| Architecture `design/` | explanation (deep) | Stays; Concepts 100/200 are the on-ramp |
| `API_CONTRACT.md` | reference | Reference section + link from how-tos |

**Authoring metadata** — add to source frontmatter (sync preserves):

```yaml
---
title: ...
description: ...
diataxis: how-to   # tutorial | how-to | explanation | reference
---
```

Phase 2: CI or `mise //docs:lint` warns when `diataxis` is missing on new pages under `docs/guides/`.

**Writing tenets** (from [Write the Docs](https://www.writethedocs.org/guide/) + GitHub blog):

- **Clear** — plain language; define terms on first use (link Concepts).
- **Concise** — one page, one job; link out for depth.
- **Structured** — prerequisites first, scannable headings, expected output after commands.

### 1c. Visual design — light-first theme

**Current state:** `astro.config.mjs` injects a script that sets `starlight-theme` to `dark` when unset — visitors always land on dark chrome.

**Target:** Light-first, world-class readability — aligned with [Starlight](https://starlight.astro.build/) defaults and enterprise docs norms — while keeping dark mode as an opt-in toggle.

| Change | Location | Action |
|--------|----------|--------|
| Remove forced dark default | `astro.config.mjs` `head` script | Delete or replace with `auto` (respect `prefers-color-scheme`) |
| Default theme | Starlight | `light` default, or no script (Starlight default is often light until user picks) |
| Custom polish | `docs/src/styles/custom.css` | Subtle light gray page bg, AWS-adjacent accent, card shadows on splash |
| Code blocks | Starlight + custom CSS | Light-theme syntax colors; verify contrast |
| Mermaid | existing CDN init | Use `theme: 'default'` in light, `'dark'` when `data-theme=dark` |
| Splash / cards | `index.mdx` | Designed for light bg; test dark toggle still works |

**Design tokens (draft):**

- Page background: Starlight light default or `#f8f9fb`
- Primary accent: AWS orange `#ff9900` sparingly on CTAs only, or neutral blue for calmer enterprise tone
- Body: high-contrast gray `#16191f` on white (AWS console-adjacent)
- Avoid heavy dark hero on landing — light hero with optional diagram

**Accessibility:** Verify WCAG AA contrast on light theme (NF9). Do not rely on color alone for Diátaxis badges or links.

### 1d. Docs-as-code and automation

Treat documentation like application code ([docs-as-code](https://www.writethedocs.org/guide/docs-as-code/)): versioned in git, reviewed in PRs, validated in CI.

**Already shipped:**

| Automation | Prevents |
|------------|----------|
| `mise //docs:sync` | Stale Starlight mirrors |
| CI mutation check | Committed `src/content/docs/` ≠ sync output |
| `docs/scripts/link-check.sh` | Broken internal links |
| `mise //docs:build` | Astro/MDX breakage |
| prek `docs-sync` hook | Forgotten sync on commit |

**Add in revamp:**

| Automation | Phase | Prevents |
|------------|-------|----------|
| `docs/sidebar.yaml` + validator | 1 | Orphan pages, nav drift |
| `diataxis` frontmatter lint | 2 | Wrong content type / mixed-purpose pages |
| Snippet smoke test (optional) | 3 | Extract `bash`/`curl` blocks from Quick Start; run in CI with dry-run flags |
| Generated sidebar fragment in sync | 2 | Hand-edited `astro.config.mjs` drift |
| `editLink` to source path | 2 | Editors opening wrong file |
| API reference excerpt from `types.ts` (future) | 4 | API_CONTRACT drift from handlers |

**Single contributor command chain** (documented in `/write-docs` and `docs/README.md`):

```bash
# edit source under docs/guides/ | docs/design/ | docs/decisions/
mise //docs:sync
mise //docs:build    # or mise //docs:check
mise run hooks:run   # if prek installed
```

**Principle:** If a check can run in CI, it should — human memory is not a linter ([avoid outdated docs](https://www.writethedocs.org/guide/writing/docs-principles/)).

### 1e. Code snippets and examples standard

Developer docs live or die on examples ([GitHub blog](https://github.blog/developer-skills/documentation-done-right-a-developers-guide/)). Adopt a repo-wide snippet contract:

**Formatting**

- Fenced blocks with language tags (`bash`, `json`, `typescript`, `python`).
- One command per block when showing expected output — output in a separate `text` or `json` block below.
- Line length ≤100 chars where practical (horizontal scroll frustrates mobile readers).

**Placeholders**

- Use **SCREAMING_SNAKE** placeholders: `YOUR_API_BASE_URL`, `YOUR_GITHUB_PAT`, `YOUR_REPO`, `YOUR_TASK_ID`.
- Immediately above or below the block: one sentence on **how to obtain** the value (link to auth or deployment guide).
- Never use `foo`, `bar`, `xxx`, or real-looking fake secrets.

**Language parity** (platform stacks)

| Surface | Primary | Also show when API is documented |
|---------|---------|----------------------------------|
| CLI / operators | `bash` + `bgagent` | — |
| REST API | `curl` | `typescript` (fetch) or copy-paste JSON body only |
| Agent / workflows | `python` (snippets from `agent/`) | — |
| CDK / operators | `typescript` | — |
| Webhooks | `bash` (openssl hmac) + `json` payload | — |

Do not duplicate every example in three languages — show **curl + one SDK** for HTTP; link to CLI for the same operation.

**Runnable / try-it**

| Approach | When |
|----------|------|
| Link to **Quick Start** (deployed stack) | Default — real environment |
| Link to **GitHub repo** sample payloads | Webhook signature examples |
| External sandbox (RunKit, CodePen) | **Phase 4 optional** — only for stateless JS demos; not required for AWS-deployed platform |
| GitHub Codespaces / devcontainer | Mention in Developer guide if devcontainer ships later |

**Validation (Phase 3+)**

- Lint: no placeholder left as literal `YOUR_` in copy-paste paths without definition section on page.
- Optional: `scripts/verify-doc-snippets.sh` runs annotated blocks (`<!-- verify -->`) in CI.

**Example (REST create task):**

```bash
curl -sS -X POST "${YOUR_API_BASE_URL}/v1/tasks" \
  -H "Authorization: Bearer ${YOUR_JWT}" \
  -H "Content-Type: application/json" \
  -d '{"repo":"YOUR_ORG/YOUR_REPO","task_description":"YOUR_TASK_DESCRIPTION"}'
```

`YOUR_API_BASE_URL` — stack output `ApiUrl` from deploy (see Deployment Guide).  
`YOUR_JWT` — `bgagent login` then `bgagent token` (see Authentication).

### 1f. ABCA plugin: `/write-docs` skill

Add a new skill so contributors (human or agent) follow one workflow when adding documentation — parallel to `/onboard-repo` and `/submit-task`.

**Location:** `docs/abca-plugin/skills/write-docs/SKILL.md`  
**Trigger:** `/write-docs`, or phrases like “add documentation”, “write a doc page”, “update the docs”, “new tutorial”, “document this feature”.

**Skill outline:**

1. **Classify with Diátaxis** — ask or infer: tutorial, how-to, explanation, or reference? Refuse to combine types on one page; suggest split.
2. **Pick source path** per [docs/AGENTS.md](/sample-autonomous-cloud-coding-agents/architecture/agents):
   - User-facing guide → `docs/guides/` (or `guides/concepts/`, `guides/use-cases/`)
   - Design / architecture → `docs/design/`
   - Decision → `docs/decisions/ADR-NNN-*.md`
   - Never edit `docs/src/content/docs/` except hand-maintained `index.mdx`
3. **Select template** — tutorial, how-to, concept-100, concept-200, or reference table (templates live in `docs/guides/_templates/` — add in Phase 1).
4. **ADR-004 checklist** — prerequisites, expected output, error states, tabula rasa test, glossary links for new terms.
5. **Snippet rules** — `YOUR_*` placeholders, language parity per §1e.
6. **Nav** — update `docs/sidebar.yaml` (or manifest) with slug + label.
7. **Sync and verify:**
   ```bash
   mise //docs:sync
   mise //docs:build
   ```
8. **PR hygiene** — if platform code changed, confirm docs PR includes source + generated mirror; mention `diataxis:` frontmatter.
9. **Governance** — doc-only changes may not need ADR-003 issue; doc changes **shipping with a feature** should reference the feature issue.

**Plugin updates:**

| File | Change |
|------|--------|
| `docs/abca-plugin/skills/write-docs/SKILL.md` | New skill |
| `docs/abca-plugin/README.md` | Add `/write-docs` to skills table |
| `docs/abca-plugin/hooks/hooks.json` | Advertise skill on SessionStart |
| Root `README.md` / `CLAUDE.md` | Mention `/write-docs` alongside other plugin commands |

**Templates directory (Phase 1):**

```
docs/guides/_templates/
  tutorial.md
  how-to.md
  explanation-100.md
  explanation-200.md
  reference.md
```

(`_templates/` excluded from sync mirror via sync script ignore.)

### 2. Landing page (splash homepage)

Replace the current long-form `index.md` with a **world-class splash landing** — the first impression for evaluators, operators, and contributors. Model after [Starlight’s marketing homepage](https://starlight.astro.build/) (hero + dual CTAs + feature grid) and [Ona’s value sections](https://ona.com/) (capability tiles that sell outcomes, not jargon).

**Implementation:** Starlight [`template: splash`](https://starlight.astro.build/guides/customization/#splash-page) on `docs/src/content/docs/index.md` (or `index.mdx` if we need imports). This file is **hand-maintained** in `src/content/docs/` — an intentional exception to the source→sync pipeline (splash frontmatter + `CardGrid` do not map cleanly to a plain guide mirror).

**Move existing intro prose** (dark factory, maturity table, blueprint steps) to:
- `docs/design/VISION.md` / Concepts hub (vision)
- `docs/guides/concepts/README.md` (how it works)
- Remove duplicate narrative from the landing; link out instead.

#### Layout (top → bottom)

```
┌─────────────────────────────────────────────────────────────┐
│  [Logo]  ABCA Docs                    [Search] [GitHub]     │  ← Starlight header (splash)
├─────────────────────────────────────────────────────────────┤
│                                                             │
│     Headline (1–2 lines, outcome-focused)                 │
│     Subhead (one sentence — self-hosted autonomous agents)  │
│                                                             │
│     [ Get started ]    [ View on GitHub ↗ ]               │
│                                                             │
│     (optional hero image / architecture diagram)            │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Value 1  │ │ Value 2  │ │ Value 3  │ │ Value 4  │       │  ← CardGrid
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
├─────────────────────────────────────────────────────────────┤
│  “What will you do?” — journey cards or link chips          │
│  Quick Start · Concepts · Use cases · Beyond coding       │
├─────────────────────────────────────────────────────────────┤
│  (optional) Social proof / AWS Samples badge                │
└─────────────────────────────────────────────────────────────┘
```

#### Hero copy (draft — refine in implementation)

| Element | Draft content |
|---------|---------------|
| **Headline** | Run autonomous agents in the cloud. |
| **Subhead** | Self-hosted background agents on AWS — submit a task, get a pull request, report, or review. Governed, isolated, and observable. |
| **Primary CTA** | Get started → `/getting-started/quick-start` |
| **Secondary CTA** | View on GitHub → `https://github.com/aws-samples/sample-autonomous-cloud-coding-agents` (`variant: minimal`, `icon: external`) |

Tone: confident and plain — like Starlight (“Make your docs shine”) and Ona (“Task in, pull request out”), not internal architecture vocabulary.

#### Value proposition cards (Ona-inspired)

Six tiles in a `CardGrid` (3×2 desktop, 1-col mobile). Each card: **icon** (Starlight built-in), **title**, **one-line benefit**, **link** to Concepts or use case.

| Card | Title | Benefit | Links to |
|------|-------|---------|----------|
| 1 | **Background agents** | Task in, PR or outcome out — fire and forget | Concepts → task lifecycle |
| 2 | **Isolated environments** | Every task runs in its own MicroVM with scoped credentials | Concepts → compute |
| 3 | **Workflow-driven** | Versioned workflows — coding, review, and research — not one-off prompts | Concepts → workflow |
| 4 | **Governance built in** | Cedar policy, guardrails, audit trail on every run | Concepts → policy |
| 5 | **Beyond coding** | Research briefs and ops workflows — same platform | Beyond coding page |
| 6 | **Your AWS account** | CDK-deployed sample you control — not a SaaS black box | Deployment guide |

Optional second `CardGrid` — **“Put agents to work”** (Ona-style outcome chips, not full tutorials):

Fix from issue · Review every PR · Patch dependencies · Iterate on feedback · Research a topic · Triage from Linear

Each chip links to a use-case tutorial (stub OK in Phase 1).

#### Journey row (below value cards)

Four `Card` components for readers who already know their path:

| Card | Audience | Link |
|------|----------|------|
| **Get started** | Deploy in ~30 min | Quick Start |
| **Understand concepts** | New to the platform | Concepts hub |
| **Explore use cases** | I know my goal | Use cases index |
| **Contribute** | Platform developer | Developer guide |

#### Frontmatter sketch (`index.mdx`)

```yaml
---
title: ABCA Docs
description: Autonomous background coding agents on AWS — deploy, submit tasks, review outcomes.
template: splash
editUrl: false
hero:
  tagline: Self-hosted autonomous agents on AWS. Submit a task; get a PR, review, or research brief — in an isolated, governed runtime.
  image:
    alt: ABCA architecture overview
    file: ../../assets/hero-arch.png   # optional; docs/public or src/assets
  actions:
    - text: Get started
      link: /sample-autonomous-cloud-coding-agents/getting-started/quick-start/
      icon: right-arrow
    - text: View on GitHub
      link: https://github.com/aws-samples/sample-autonomous-cloud-coding-agents
      icon: external
      variant: minimal
---
```

Body uses Starlight components (same pattern as [Starlight’s splash docs](https://starlight.astro.build/)):

```mdx
import { Card, CardGrid } from '@astrojs/starlight/components';

## Why teams use ABCA

<CardGrid>
  <Card title="Background agents" icon="rocket">...</Card>
  ...
</CardGrid>
```

**Base path:** Hero `link` values must include `base` (`/sample-autonomous-cloud-coding-agents/...`) or use root-relative paths Starlight resolves — verify with existing `Search.astro` / `SidebarSublist` base-path handling.

#### Visual polish (Phase 1 vs 4)

| Item | Phase 1 | Phase 4 |
|------|---------|---------|
| Typography | Starlight defaults + optional `customCss` tweak (`--sl-font`, accent) | Branded font if design provides |
| Logo | Add `logo` to `astro.config.mjs` (`src/assets/`) | Light/dark variants |
| Hero image | Reuse `abca-arch.png` from `docs/imgs/` | Custom illustration or animated diagram |
| Dark mode | Keep toggle; **default light** (remove forced-dark script) | — |
| 404 page | Match splash style (`template: splash` hero) | — |

#### Sidebar treatment

- Splash `index` has **no doc sidebar** (Starlight default for `template: splash`).
- Rename sidebar label from **Introduction** → omit index from sidebar, or label **Home** linking to `/`.
- Doc pages keep full sidebar; landing is a separate visual mode.

#### Success criteria (landing)

- First screen answers “what is this?” and offers Get started + GitHub without scrolling on desktop.
- Value cards visible without scroll on common laptop viewports (1280×800).
- No dark-factory essay above the fold.
- `mise //docs:build` passes; mobile layout does not clip CTAs.

### 2b. Introduction content (relocated)

Long-form content currently on `index.md` moves to dedicated pages (not deleted):

| Former index section | New home |
|---------------------|----------|
| Software dark factory / maturity table | `docs/design/VISION.md` (link from Beyond coding + Concepts) |
| What is ABCA / use case paragraph | Concepts hub + Beyond coding hero |
| Blueprint steps (admission → finalization) | Concepts Level 200 → blueprint steps |
| Get started link | Landing hero CTA only |

### 3. Concepts section

A dedicated top-level nav section for **mental models and vocabulary** — not deploy steps, not API reference. Targets evaluators, new operators, and teammates who hit unfamiliar terms in Slack threads or architecture reviews.

**Problem:** Today, “harness” is defined only in [COMPUTE.md](/sample-autonomous-cloud-coding-agents/architecture/compute); “blueprint vs workflow” only in [WORKFLOWS.md](/sample-autonomous-cloud-coding-agents/architecture/workflows). Customers should not need architecture deep dives to learn basic vocabulary.

**Depth model (Level 100 / 200):**

| Level | Audience | Style | Length target |
|-------|----------|-------|---------------|
| **100 — Fundamentals** | First week on the platform; non-engineers welcome | One concept per page; analogy; no code required | 300–600 words |
| **200 — How it fits together** | Operators customizing repos; leads reviewing design | How components interact; simple diagrams; links to Architecture | 600–1,200 words |
| **Architecture** (existing) | Contributors; security review | Full design docs with implementation detail | unchanged |

**Source layout:**

```
docs/guides/concepts/
  README.md                    → hub: “How the platform works”
  level-100/
    task-and-workflow.md
    blueprint-vs-workflow.md
    orchestrator-and-agent.md
    agent-harness.md
    compute-and-isolation.md
    channels-and-submission.md
    memory-overview.md
    policy-overview.md
  level-200/
    task-lifecycle.md            ← migrate from USER_GUIDE split
    context-hydration.md
    preflight-and-admission.md
    blueprint-steps.md
    tool-policy-and-cedar.md
    memory-tiers.md
    observability-and-audit.md
    cost-and-limits.md
  GLOSSARY.md                    → A–Z; each entry links to 100 or 200 page
```

**Concept page template (Level 100):**

```markdown
# <Term>

**Level:** 100 — Fundamentals
**One line:** <definition in plain language>

## What it is
Short explanation. Bold term on first use.

## Analogy
One concrete comparison (e.g. harness = “flight software around the pilot”).

## Why it matters to you
Operator | Teammate | Repo author — one sentence each.

## Related concepts
- [Blueprint vs workflow](/sample-autonomous-cloud-coding-agents/architecture/blueprint-vs-workflow) (Level 100)
- [Task lifecycle](/sample-autonomous-cloud-coding-agents/architecture/task-lifecycle) (Level 200)

## Deep dive
Link to Architecture doc when ready.
```

**Hub page (`concepts/README.md`):**

1. **60-second story** — you submit a task → orchestrator admits and hydrates → agent runs in isolated compute under a harness → outcome (PR, report, comments) → memory and audit trail.
2. **Mermaid flowchart** — same story, every box links to a Level 100 or 200 page.
3. **“Start here if…”** — table routing confused readers to the right first page.
4. **Level 100 / 200** — two visible lists (not collapsed); glossary link at bottom.

**Seed glossary entries (minimum):**

| Term | Level 100 page | Notes |
|------|----------------|-------|
| Task | task-and-workflow | Unit of work from submit to terminal state |
| Workflow | task-and-workflow | Versioned recipe for *kind* of task |
| Blueprint | blueprint-vs-workflow | Per-**repo** platform config (model, credentials, limits) |
| Orchestrator | orchestrator-and-agent | Durable control plane; cheap deterministic steps |
| Agent | orchestrator-and-agent | LLM execution inside compute session |
| Harness | agent-harness | SDK loop around the model (tools, policy, turns) |
| Compute / session / MicroVM | compute-and-isolation | Where the agent runs |
| Hydration | context-hydration (200) | Assembling prompt context before agent runs |
| Pre-flight | preflight-and-admission (200) | Fail-fast checks before spend |
| Memory | memory-overview / memory-tiers | Cross-task learning |
| Cedar / guardrails | policy-overview | Tool and content policy |
| Channel | channels-and-submission | CLI, API, webhook, Slack, Linear, Jira |
| Turn / budget | cost-and-limits (200) | Spend and safety caps |
| Workflow ref | task-and-workflow | API field selecting a workflow |

**Relationship to other sections:**

| Section | Role |
|---------|------|
| **Concepts** | Teach vocabulary and mental model |
| **Using ABCA** | Apply concepts via channels and daily operations |
| **Use cases** | Outcome tutorials that link back to Concepts terms |
| **Architecture** | Implementation truth; Concepts pages link here, not vice versa |
| **Beyond coding** | Links to Concepts hub for “how execution works” |

**Sync:** Mirror `docs/guides/concepts/` → `src/content/docs/concepts/`; register in sidebar manifest. Retain redirects from old `using/task-lifecycle` and `using/what-the-agent-does` slugs if URLs are already shared.

**ADR-004 alignment:** Glossary satisfies ADR-004 “maintain a project glossary”; Level 100 pages satisfy “bold on first use with parenthetical definition” for the rest of the site.

### 4. Learning path (Getting Started finale)

The **Learning path** is the last page in Getting Started — the hand-off after deploy docs, not another deploy guide. It answers: *“I'm set up (or joining an existing stack). What do I want to do next?”*

**Interaction model (Phase 1 — static markdown):**

Use a decision matrix of goal cards. Each card has: one-line outcome, persona tag, estimated time, primary doc link, and optional workflow badge.

| If you want to… | Go to | Workflow / channel |
|-----------------|-------|-------------------|
| Submit your first coding task from the terminal | [Using the CLI](/sample-autonomous-cloud-coding-agents/using/using-the-cli) tutorial | `coding/new-task-v1` · CLI |
| Auto-review every new PR | [PR review webhook tutorial](/sample-autonomous-cloud-coding-agents/use-cases/automated-pr-review) | `coding/pr-review-v1` · webhook |
| Address review comments on an open PR | [Workflows](/sample-autonomous-cloud-coding-agents/using/workflows) (`coding/pr-iteration-v1`) | `coding/pr-iteration-v1` · CLI `--pr` |
| Trigger tasks from Linear / Jira / Slack | Integration setup under Using → Integrations | channel-specific |
| Customize prompts or Cedar policy for a repo | Customizing section | blueprint |
| Run research without a GitHub repo | [Web research tutorial](/sample-autonomous-cloud-coding-agents/use-cases/web-research-brief) | `knowledge/web-research-v1` |
| Understand how the platform works (no deploy yet) | [Concepts hub](/sample-autonomous-cloud-coding-agents/concepts/how-the-platform-works) → Level 100 | — |
| Learn what “harness” and “blueprint” mean | [Agent harness](/sample-autonomous-cloud-coding-agents/concepts/level-100/agent-harness) · [Blueprint vs workflow](/sample-autonomous-cloud-coding-agents/concepts/level-100/blueprint-vs-workflow) | Concepts |
| Contribute to the platform | Developer guide → Contributing | — |

**Phase 2 enhancement:** Starlight `CardGrid` or tabs on the learning-path page; optional “I am a…” persona toggle (operator / teammate / repo author / contributor / knowledge worker) that reorders cards.

**Placement rationale:** Putting the learning path **last** in Getting Started follows progressive disclosure (ADR-004 Layer 3): deploy docs stay sequential; the router appears once prerequisites are documented.

### 5. Beyond coding page

A dedicated page for evaluators, engineering leaders, and non-engineer stakeholders. Tone: outcomes and governance, not implementation detail — analogous to [Ona's beyond-coding case page](https://ona.com/cases/beyond-coding).

**Source:** `docs/guides/BEYOND_CODING.md`  
**Site slug:** `beyond-coding/beyond-coding` or top-level `beyond-coding` (prefer short URL).

**Page structure:**

1. **Hero** — “Autonomous agents with real execution environments — not only for pull requests.”
2. **Thesis** — Coding agents proved isolated, tool-using runtimes work. ABCA generalizes that pattern: durable orchestration, policy gates, memory, and audit trails for any workflow domain.
3. **Capability tiles** (mirror Ona's pattern: computer, workflows, tools, guardrails, audit):
   - **Isolated execution** — MicroVM per task, scoped credentials
   - **Workflow-driven tasks** — versioned YAML, not hardcoded branches ([WORKFLOWS.md](/sample-autonomous-cloud-coding-agents/architecture/workflows))
   - **Repo-optional knowledge work** — `requires_repo: false` workflows
   - **Governance built in** — Cedar, guardrails, human PR review as default gate
   - **Observable outcomes** — TaskEvents, progress stream, attribution
4. **Use case gallery** — 6–8 tiles linking into the tutorial index (research brief, PR review automation, issue triage, doc updates, ops runbooks). Label each as **Shipped today**, **Sample tutorial**, or **Planned** — never imply unshipped platform features without a label.
5. **Who it's for** — engineering teams *and* platform/ops/data leads delegating governed background work.
6. **CTA** — Concepts hub · Learning path · Quick Start · Use cases index

**Relationship to index:** Index stays technical and concise; Beyond coding carries the evaluator narrative so onboarding docs do not compete with vision content.

### 6. Use cases & tutorials section

Inspired by [Hermes user stories](https://hermes-agent.nousresearch.com/docs/user-stories): categorized, scannable tiles — but **authored tutorials** first, not scraped community posts.

**Source layout:**

```
docs/guides/use-cases/
  README.md              → index (categories + table of all tutorials)
  implement-from-issue.md
  pr-iteration.md
  automated-pr-review.md
  web-research-brief.md
  dependency-updates.md
  ...
```

**Tutorial template** (each file follows ADR-004):

```markdown
# <Outcome title>

**Category:** Coding | Review | Research | Ops | Integration
**Persona:** Teammate | Operator | Repo author
**Time:** ~15 min
**Workflow:** `coding/pr-review-v1`
**Channel:** CLI | webhook | Linear | …

## What you'll achieve
One paragraph + success criteria.

## Prerequisites
Linked prerequisites (auth, onboarded repo, deployed stack).

## Steps
Numbered, self-contained.

## What happens under the hood
Link to **Concepts** Level 200 page + Architecture (not raw design doc dumps).

## Troubleshooting
Symptom → fix; link to troubleshooting hub.

## Next steps
Related tutorials.
```

**Index page (`use-cases/README.md`):**

- Category chips (static markdown sections in Phase 1; filter UI in Phase 2 if warranted).
- Table: outcome · workflow · channel · persona · time.
- “Contributing a use case” link for community tutorials (future).

**Seed tutorials (Phase 1–2):**

| Tutorial | Workflow | Notes |
|----------|----------|-------|
| Implement a feature from a GitHub issue | `coding/new-task-v1` | Canonical coding path |
| Address PR review feedback | `coding/pr-iteration-v1` | Links to CLI `--pr` |
| Automate PR review on new PRs | `coding/pr-review-v1` | GitHub Actions / webhook |
| Run a web research brief (no repo) | `knowledge/web-research-v1` | Highlights beyond-coding |
| General agent task with attachments | `default/agent-v1` | Repo-optional |
| Triage tasks from Linear | — | Links to Linear setup + submit |
| Set up Slack submit + progress | — | Links to Slack guide |
| Tune cost attribution tags | — | Links to cost attribution guide |

**Hermes patterns to adopt (not copy):**

- Category + source filters on the index (Hermes uses 15 categories and external sources; we use **workflow domain** + **persona**).
- Every tile links to a **real doc**, not an external post (our corpus is first-party).
- Optional Phase 4: `use-cases/community.md` or JSON-driven tiles for contributed stories (Discord/GitHub issue template).

**Sync implications:**

- Mirror `docs/guides/use-cases/` → `src/content/docs/use-cases/`.
- Add explicit route in `sync-starlight.mjs` (like `PROMPT_GUIDE`).
- Register all pages in sidebar manifest.

### 7. Source layout and sync pipeline

**Problem:** `splitGuide()` couples authoring to sync-time page boundaries.

**Options (pick one in implementation phase):**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A. Multi-file guides** | Break `USER_GUIDE.md` / `DEVELOPER_GUIDE.md` into one file per page under `docs/guides/using/`, `docs/guides/developer/` | WYSIWYG authoring; simpler sync | Large migration; more files |
| **B. Frontmatter nav** | Each source file declares `sidebar:` order/label; sync builds `astro` sidebar config | Single source of truth | Requires sync script + config generation changes |
| **C. Keep split + manifest** | Retain splitGuide; generate sidebar from directory listing + `docs/sidebar.yaml` | Smaller initial change | Still two mental models |

**Recommendation:** Phase 1 uses **C** (manifest + fix orphans). Phase 2 moves to **A** for user/developer guides if contributors find split authoring painful.

**Deliverables for sync:**

- `docs/sidebar.yaml` (or generated JSON) — nav tree consumed by sync to emit Starlight sidebar fragment or validate `astro.config.mjs`.
- CI check: every file under `src/content/docs/` (except excluded patterns) appears in manifest.
- Reduce `rewriteDocsLinkTarget` special cases as pages become real files with stable slugs.

### 8. New and updated pages

| Page | Type | Source location |
|------|------|-----------------|
| **Concepts hub** | New guide | `docs/guides/concepts/README.md` |
| **Level 100 pages** (8) | New guides | `docs/guides/concepts/level-100/*.md` |
| **Level 200 pages** (8) | New guides | `docs/guides/concepts/level-200/*.md` |
| **Glossary** | New | `docs/guides/concepts/GLOSSARY.md` |
| **Learning path** | New guide | `docs/guides/LEARNING_PATH.md` → `getting-started/learning-path` |
| **Beyond coding** | New guide | `docs/guides/BEYOND_CODING.md` → `beyond-coding/` (top-level) |
| **Use cases index** | New guide | `docs/guides/use-cases/README.md` |
| **Use case tutorials** (8 seed) | New guides | `docs/guides/use-cases/*.md` |
| Troubleshooting hub | New guide | `docs/guides/TROUBLESHOOTING.md` |
| Architecture “Start here” | New short guide | `docs/guides/ARCHITECTURE_READING_GUIDE.md` or section in `ARCHITECTURE.md` |
| Package README | Replace placeholder | `docs/README.md` |

Troubleshooting seed topics (from support patterns / plugin skills):

- Cognito login / token errors
- `REPO_NOT_FOUND_OR_NO_ACCESS` / GitHub PAT scope
- Task stuck in `QUEUED` / concurrency
- Webhook signature failures
- Agent failed / pre-flight errors

### 9. UX and Starlight configuration

**Landing (splash):**

- `template: splash` on `docs/src/content/docs/index.mdx` — hand-maintained, not sync-generated.
- `hero.actions` — Get started + View on GitHub (Starlight [`hero` frontmatter](https://starlight.astro.build/guides/customization/#splash-page)).
- `Card` / `CardGrid` from `@astrojs/starlight/components` for value tiles and journey row.
- `logo` in `astro.config.mjs` when brand asset is ready.
- `editUrl: false` on landing (no “edit this page” on marketing surface).
- Match splash styling on `404.md` for cohesive first impression.

**Site-wide:**

- **Light-first theme** — remove `localStorage.setItem(k,'dark')` bootstrap script; add `customCss: ['./src/styles/custom.css']` for light polish.
- **Mermaid theme** — switch on `document.documentElement.dataset.theme` (already partially done); default mermaid to light.
- **Edit link** — Starlight `editLink.baseUrl` pointing at `https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/edit/main/docs/guides/` with path mapping logic in sync.
- **Descriptions** — extend `ensureFrontmatter()` to read optional `description:` from source first paragraph or explicit YAML in guides.
- **Architecture sidebar** — optional sub-groups via Starlight nested `items` (no content move required).
- **Concepts sidebar** — Level 100 and Level 200 as nested groups; hub page not collapsed.
- **In-doc term links** — optional sync pass to auto-link glossary terms in guides (Phase 4); Phase 1 manual links from USER_GUIDE to Concepts.

### 10. Docs package README

Replace `docs/README.md` with:

- What lives where (`guides/`, `design/`, `decisions/`, generated `src/content/docs/`)
- Commands: `mise //docs:sync`, `build`, `check`
- How to add a page (source file → sync → sidebar manifest → PR)
- Link to this revamp design doc and ADR-004

### 11. Plugin and site alignment

The Claude Code plugin (`docs/abca-plugin/`) skills reference guides by path. When IA changes:

- Update skill `SKILL.md` links to new slugs.
- Prefer stable anchor text over hard-coded GitHub Pages URLs in skills.
- Ship **`/write-docs`** skill (§1f) as the canonical contributor entry for documentation changes.

## Implementation phases

### Phase 0 — Design alignment (this doc)

- [ ] Review and approve IA proposal
- [ ] Choose sync/sidebar strategy (A/B/C)
- [ ] Open tracking issue(s) for phased work (repo governance)

- [ ] Adopt Diátaxis labels in sidebar manifest
- [ ] Approve light-first theme direction

### Phase 1 — Quick wins (nav + routers + theme)

- **Light-first theme** — default light via `localStorage` script (no custom.css)
- Add **`/write-docs`** skill + `docs/guides/_templates/` stubs
- Add missing sidebar entries (`where-to-make-changes`, `cost-attribution`, orphans)
- Introduce sidebar manifest + validation script (`sidebar.yaml`, `validate-sidebar.mjs`)
- Replace `docs/README.md`
- **Splash landing page** — `index.mdx` with hero, CTAs, value cards, journey row; dark-factory prose in VISION
- Add Troubleshooting hub (skeleton + top 5 entries)
- **Learning path** page — last item in Getting Started
- **Concepts hub** + **4 Level 100 pages**
- **Introduction** page (overview + beyond-coding narrative) + links to seed tutorials
- **Use cases index** + **3 seed tutorials**

**Exit criteria:** No orphan pages; link check green; `mise //docs:build` passes; **landing splash live** with dual CTAs and ≥4 value cards; Concepts reachable from journey row.

### Phase 2 — IA restructure + tutorial catalog

- Regroup Using section (Integrations subgroup)
- Remaining **Level 100** (4) + **Level 200** pages (8); migrate `task-lifecycle` / `what-the-agent-does` content
- **Glossary** with full seed term table
- Remaining **5 seed tutorials** from the table above
- Architecture “Start here” page
- Edit-on-GitHub links
- Cross-link Concepts ↔ use cases ↔ workflows doc ↔ Beyond coding
- F17 pass: bold + link terms in Quick Start and USER_GUIDE splits
- **Snippet audit** on Quick Start + REST API pages (`YOUR_*` placeholders, curl parity)
- Add `diataxis:` frontmatter to all new/seed pages; lint script in CI
- Category sections on use cases index

**Exit criteria:** Five personas (operator, teammate, repo author, knowledge worker, contributor) each complete one tutorial path using only docs.

### Phase 3 — Authoring model (optional)

- Migrate `USER_GUIDE.md` / `DEVELOPER_GUIDE.md` to multi-file layout if warranted
- Simplify `sync-starlight.mjs` (remove anchor rewrite tables)
- Tabula rasa audit on P0 procedural pages
- Optional snippet verification script for annotated blocks

### Phase 4 — Polish

- Frontmatter descriptions sitewide
- Architecture sidebar sub-groups
- Redirect map for renamed slugs (if any) via Starlight or hosting config
- Analytics feedback (if available on GitHub Pages)
- Optional: community use-case tiles (Hermes-style); filter UI if tutorial count > ~15
- Revisit naming/slug when ABCA is renamed

## Success metrics

| Metric | Baseline | Target |
|--------|----------|--------|
| Orphan mirror pages | ≥2 known | 0 |
| Clicks from index to Quick Start | (measure if analytics added) | 1 |
| Tabula rasa audit pass rate (P0 pages) | TBD | 100% |
| Contributor steps to add a doc page | 3+ files | 2 (source + manifest) |
| Internal link check | passing | passing |
| Time for new operator to first task (doc-only, lab) | TBD | ≤30 min stated in Quick Start |
| Seed use case tutorials published | 0 | ≥8 |
| Learning path goals covered | 0 | ≥8 routing targets |
| Beyond-coding page linked from index | no | yes (value card + journey row) |
| Landing splash with hero + GitHub CTA | no | yes |
| Value proposition cards on landing | 0 | ≥4 |
| Level 100 concept pages published | 0 | ≥8 |
| Glossary entries with Concept links | 0 | ≥20 |
| Docs pages with `diataxis:` frontmatter | 0 | 100% of new guides |
| `/write-docs` skill shipped | no | yes |
| Default theme on first visit | dark | light or auto |

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Breaking external links to GitHub Pages URLs | Maintain slug aliases or redirect table; run link check on PR |
| Sidebar manifest drifts from `astro.config.mjs` | Generate one from the other in sync |
| Large USER_GUIDE split migration causes merge conflicts | Phase 3 only; do Phase 1–2 first |
| Vision content feels “hidden” after index trim | Prominent link from index + architecture hub |
| Beyond-coding page overpromises repo-optional workflows | Label every tile Shipped / Tutorial / Planned; link to WORKFLOWS.md |
| Tutorial sprawl duplicates USER_GUIDE | Tutorials are outcome-focused and link to reference docs; do not fork full channel docs |
| ABCA rename breaks URLs | Avoid `abca` in new slugs; use neutral paths (`beyond-coding`, `use-cases`, `concepts`) |
| Concepts duplicates Architecture | 100/200 summarize; Architecture remains source of truth; one-way links up |
| Split USER_GUIDE loses task-lifecycle URLs | Redirect old `using/task-lifecycle` slugs to `concepts/level-200/task-lifecycle` |
| Light theme breaks custom Search/Sidebar | Test GitHub Pages `base` paths in both themes before merge |
| Diátaxis rigidity blocks pragmatic pages | Allow `diataxis` + “see also” links; lint warns, does not block mixed *sections* if type is declared |

## Open questions

1. **Approved issue** — Which GitHub issue tracks this revamp for ADR-003 governance?
2. **Sidebar generation** — Should `astro.config.mjs` import generated sidebar from sync output (full automation) or validated hand-edited config?
3. **Vision placement** — Keep dark-factory narrative on index (below fold) vs dedicated `VISION` guide page?
4. **Troubleshooting scope** — Site-only FAQ vs parity with `/troubleshoot` plugin skill content?
5. **Reference section** — Separate top-level “Reference” or keep API contract under Architecture only?
6. **Analytics** — Is GitHub Pages traffic data available to validate findability changes?
7. **Beyond coding placement** — Top-level sidebar entry vs subsection under Introduction?
8. **Tutorial ownership** — Who reviews new `docs/guides/use-cases/` contributions (same as guides, or separate checklist)?
9. **Community stories** — Do we want a Hermes-style external story feed in Phase 4, or only first-party tutorials?
10. **Rename timing** — Should new pages use generic “platform” language now, or keep ABCA until rename lands?
11. **Concepts naming** — Keep “Level 100 / 200” labels (Microsoft-style) or plainer “Basics / Deep dive”?
12. **Glossary location** — Subpage under Concepts only, or also surface in Pagefind “did you mean harness?” shortcuts?
13. **Landing MDX exception** — Document in `docs/AGENTS.md` that `index.mdx` is hand-edited (splash) while other `src/content/docs/` paths remain sync-generated?
14. **Hero visual** — Static architecture PNG vs minimal text-only hero for faster first paint?
15. **Accent color** — AWS orange on CTAs vs neutral blue for calmer enterprise look?
16. **Snippet CI** — Full extract-and-run vs manual review for Phase 3?
17. **Runnable sandboxes** — Invest in external RunKit/CodePen or rely on deploy-to-try Quick Start only?

## References

- [COMPUTE.md](/sample-autonomous-cloud-coding-agents/architecture/compute) — agent harness definition (source for Level 100 harness page)
- [ADR-004: Tabula rasa documentation](/sample-autonomous-cloud-coding-agents/architecture/adr-004-tabula-rasa-documentation) — glossary + terminology consistency
- [docs/AGENTS.md](/sample-autonomous-cloud-coding-agents/architecture/agents) — package commands and boundaries
- [ARCHITECTURE.md](/sample-autonomous-cloud-coding-agents/architecture/architecture) — platform architecture corpus
- [DEVELOPER_GUIDE.md](/sample-autonomous-cloud-coding-agents/developer-guide/introduction) — contributor orientation
- [sync-starlight.mjs](../scripts/sync-starlight.mjs) — mirror and split logic
- [astro.config.mjs](../astro.config.mjs) — Starlight sidebar and site config
- [WORKFLOWS.md](/sample-autonomous-cloud-coding-agents/architecture/workflows) — workflow domains, `requires_repo`, repo-optional tasks
- [Hermes Agent user stories](https://hermes-agent.nousresearch.com/docs/user-stories) — categorized use-case discovery pattern
- [Ona: Beyond coding](https://ona.com/cases/beyond-coding) — non-coding positioning reference
- [Starlight docs homepage](https://starlight.astro.build/) — splash landing reference
- [Starlight: splash template](https://starlight.astro.build/guides/customization/#splash-page) — `template: splash`, hero actions, CardGrid
- [Ona homepage](https://ona.com/) — value proposition tiles and outcome chips
- [Diátaxis](https://diataxis.fr/) — tutorials, how-to, explanation, reference framework
- [GitHub: Documentation done right](https://github.blog/developer-skills/documentation-done-right-a-developers-guide/) — clear, concise, structured; Diátaxis overview
- [Write the Docs guide](https://www.writethedocs.org/guide/) — docs-as-code, principles, snippet quality
- [WtD: Docs as Code](https://www.writethedocs.org/guide/docs-as-code/) — version control and automation
- [Starlight customization](https://starlight.astro.build/guides/customization/) — splash, themes, custom CSS
