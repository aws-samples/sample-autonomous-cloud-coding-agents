# ABCA Demo Runbook — "Plan it. Watch it run. Trust it ships."

**Audience:** enterprise prospects. **Goal:** show that ABCA turns the planning teams *already do* in Linear into safe, autonomous execution — easy to drive, governed by default.

**Environment:** `backgroundagent-dev` (the `linear-vercel` stack). Demo repo: `isadeks/vercel-abca-linear`. Linear workspace: ABCA-demo.

**The arc (two acts):**
- **Act 1 — "Look how easy."** A real feature (a pricing page) planned as sub-issues, executed from one label, refined in plain English, merged into one preview.
- **Act 2 — "It protects you."** A broken change is caught, its dependents are skipped, nothing ships broken. The governance beat.

**Pre-staged for you (✅ PRISTINE re-stage, 2026-06-18 ~12:47 — no rehearsal comments):**
- **Act 1: `ABCA-385` — "DEMO · Launch the new pricing page"** — *already run; panel shows ✅ complete.* You narrate the finished result, then do ONE live comment to show iteration.
  - Sub-issues: `ABCA-386` pricing table (PR #259), `ABCA-387` trust strip (PR #258), `ABCA-388` trial CTA — stacked on 386 (PR #260), Integration (PR #261).
  - **Combined preview (renders the full feature — pricing tiers + $29 Pro + Start-free-trial + Trusted-by):**
    `https://vercel-abca-linear-k3k2dtkn6-brian-maguires-projects.vercel.app`
    (also embedded as the clickable image in the ABCA-385 panel)
- **Act 2: `ABCA-389` — "DEMO · Release safety net"** — *staged, not triggered.* You fire it live (the failure cascade is fast + dramatic).
  - Sub-issues: `ABCA-390` footer-year (safe), `ABCA-391` broken refactor, `ABCA-392` stacked-on-broken.

> **Why pre-run Act 1?** Each sub-issue is a real coding agent (~2-4 min). Pre-running means no dead air; you present a finished epic and only wait on the single live comment-iteration (~90s). Act 2 you trigger live because the *whole point* is watching it react.

---

## SETUP (5 min before, off-screen)

1. Open Linear to the ABCA-demo project. Have these two issues pinned in tabs:
   - **ABCA-385** (pricing — should show ✅ complete by demo time)
   - **ABCA-389** (safety — Backlog, untriggered)
2. Open the demo repo's PR list in a tab: `https://github.com/isadeks/vercel-abca-linear/pulls`
3. Confirm ABCA-385's panel shows **✅ ABCA orchestration complete** with a **Combined preview** link. (If not, wait — or see Fallbacks.)
4. Have the combined-preview URL open in a tab, ready to show.

---

## ACT 1 — "Plan it. Watch it run." (~5 min)

### Beat 1 — "This is just how your team already works" (30s)
- Show **ABCA-385** and its **3 sub-issues** in Linear's sub-issue list.
- Point at the dependency: **"Start free trial" (ABCA-388) is blocked by the pricing table (ABCA-386)** — the trial button can't exist until the Pro card does.
- **Say:** *"There's no new tool here. This is a normal Linear epic — the way your PMs and leads already break work down. The only thing we added is one label."*

### Beat 2 — "One label, and it executes the graph" (60s)
- Scroll to the epic's **status panel comment** (the single maturing comment from bgagent).
- **Say:** *"When the `abca` label went on, ABCA read the sub-issue graph, figured out what could run in parallel versus what had to wait, and spun up an isolated coding agent for each one."*
- Walk the panel line by line:
  - ✅ **Pricing table** — succeeded — PR link
  - ✅ **Trusted-by strip** — ran in parallel — PR link
  - ✅ **Start-free-trial CTA** — *waited for the pricing table, then stacked on its branch* — PR link
  - ✅ **Integration** — merged all three — PR link
- **Key point:** *"One status comment that matures in place — not 40 bot notifications. And it respected the dependency: the CTA only started after the table was done, and built on that branch — not on a stale copy of main."*

### Beat 3 — "See the whole thing, deployed" (45s)
- Click the **Combined preview** link in the panel.
- Show the live page: the **pricing table + trial button + trust strip all together** on one deployed URL.
- **Say:** *"Every sub-issue is its own reviewable PR, but you also get one combined preview of the whole feature — deployed, clickable, exactly what your reviewers and stakeholders see."*

### Beat 4 — "Talk to it in plain English" (90s, LIVE)
- On the **parent epic (ABCA-385)**, post this comment **live** (✅ verified to route cleanly to the trust strip, ABCA-387):
  > `@bgagent the "Trusted by" heading should say "Loved by teams everywhere" instead`
- **Narrate as it happens:**
  - It reacts 👀 within a second — *"it's acknowledged, working."*
  - It figures out **which** sub-issue you meant (the trust strip) from plain English — no ticket number needed.
  - ~60-90s later it threads back **✅ Updated — PR #258** right under your comment.
- **Say:** *"No syntax, no dashboard. A reviewer comments the way they'd comment to a teammate, and it iterates the right PR and reports back — pointing you at exactly what changed."*

> **⚠️ COMMENT WORDING MATTERS — read this before improvising.** Routing is deterministic keyword-matching against sub-issue *titles* (see "How routing works" below), so a comment must clearly point at ONE sub-issue. The verified line above works because "Trusted by" only matches ABCA-387. **Do NOT** improvise something like *"the pricing table heading…"* — the word "pricing" appears in BOTH the pricing-table (ABCA-386) and the Pro-pricing-card CTA (ABCA-388) titles, so it will (correctly) ask *"which sub-issue?"* instead of acting. If that happens live, it's a **feature, not a bug** — see the talking point below — just re-comment naming the issue: `@bgagent ABCA-386: change the heading to "Pricing that scales with you"`.

> **Optional flourish (technical audience):** show precise targeting — `@bgagent ABCA-386: rename the section heading to "Pricing that scales with you"` — proves you can name the issue by ID for exactness.

> **💬 Likely question — "How does it know which sub-issue? Is that an LLM?"**
> *"No — routing is deterministic. It matches your comment against the sub-issue titles (or an explicit `ABCA-NNN`). If it's ambiguous it asks rather than guesses — it will never silently edit the wrong work item. The AI is reserved for writing the code once the target is decided, not for guessing your intent."* This is a **governance strength** — predictable, auditable, no surprise edits.

**Transition line into Act 2:**
> *"So that's how easy it is to drive. But the question every enterprise asks next is: what stops it from shipping something broken? Watch this."*

---

## ACT 2 — "It protects you." (~4 min, LIVE)

### Beat 5 — Trigger the safety epic (30s)
- Open **ABCA-389 — "DEMO · Release safety net"**. Show its 3 sub-issues:
  - Update footer year (safe)
  - **Refactor a shared helper** (this one will break the build)
  - A feature **stacked on** the refactor
- **Say:** *"Same setup — three sub-issues, one depends on another. But one of these is going to introduce a real build error. In most automation, that just merges. Let's see what ABCA does."*
- **Add the `abca` label** to ABCA-389 live (or tell me to trigger it). *[Presenter: in Linear, add the label; or the operator runs the trigger.]*

### Beat 6 — Let it run, narrate the catch (~3 min)
- The safe footer change → ✅ succeeds, opens its PR.
- The broken refactor → the agent makes the change, **but ABCA runs the repo's build/test command and it fails** → ❌.
- The stacked feature → **⏭️ skipped** — *"it was never even attempted, because building it on top of broken code would just compound the problem."*
- The panel settles to **⚠️ ABCA orchestration finished with failures.**

- **Say (the money line):** *"It caught the broken build, marked that sub-issue failed, and — critically — it skipped everything that depended on it. It did not silently ship, and it did not build new work on a broken base. The healthy change still shipped. You get a clear, honest status, not a green checkmark hiding a problem."*

### Beat 6b — Fix it in a comment, watch the WHOLE epic recover (~7 min — see timing note)
- On the **failed** sub-issue (the broken refactor), comment **live**:
  > `@bgagent please remove the unused variable that's breaking the lint and get the build passing`
- **Narrate the recovery as it cascades:**
  - 👀 ack → the failed sub-issue re-runs → its build passes → it flips **❌ → ✅**.
  - The dependent that was skipped **un-skips and runs** (it was waiting on the fix).
  - The integration node **re-runs** and merges everything.
  - The panel reverts from **⚠️ finished with failures** back to **🔄 in progress**, then settles to **✅ ABCA orchestration complete** with the combined preview.
- **Say (the recovery money line):** *"And here's the part teams really care about: when something breaks, you're not stuck. You fix it the same way you talk to a teammate — in a comment — and the whole epic recovers itself. The fix re-runs, everything that was waiting on it picks back up, and the epic finishes green. No re-triggering, no manual cleanup."*

> **⏱️ TIMING — IMPORTANT.** Full recovery is a serial chain (fix re-runs → dependent re-runs → integration re-runs) and takes **~7 minutes** live. Two ways to present:
> - **(Recommended) Narrate + cut away:** kick off the fix-comment live, point out the 👀 ack and the panel reverting to 🔄, then move to Q&A / the recap while it churns and return to show the final ✅ complete. OR
> - **Pre-stage the failure:** have an already-failed epic ready (operator can leave one in the ❌ state), do ONLY the fix-comment live, and let the ~7-min recovery run during Q&A. Verified end-to-end on ABCA-381 → ✅ complete + combined PR #257.

### Beat 7 — Close (30s)
- **Say:** *"That's the whole model: your team plans in Linear like they already do, ABCA executes the graph in parallel with full PRs and previews, you steer it in plain English — and it's governed by default. A broken change is caught, not shipped — and when you fix it in a comment, the whole epic recovers on its own. Easy for the people using it, safe enough for the people accountable for it."*

---

## TALKING POINTS (drop in as questions come up)

- **"Where does the code run?"** *Your own AWS account — isolated per task. Linear is just the interface; the compute, repos, and tokens never leave your infrastructure.*
- **"Is it just for demos / toy repos?"** *No — point it at any onboarded repo with its real build command. It runs that command to gate.*
- **"What about review?"** *Every sub-issue is a normal PR. Nothing merges itself — humans review and merge. ABCA opens, previews, and reports.*
- **"Parallelism / scale?"** *It runs independent sub-issues concurrently up to a configurable cap, queues the rest, and stacks dependent work on the right branch.*
- **"Governance?"** *Build-gating (just shown), per-repo configuration, and a full audit trail of every task. (Plus the contribution-governance model behind the platform itself.)*
- **"How does it pick which sub-issue a comment is about? Is there an LLM?"** *Deterministic, no LLM. It matches your comment against the sub-issue titles (or an explicit `ABCA-NNN` you name). Exactly one match → it acts; ambiguous or none → it asks rather than guesses. The AI is used to write the code once the target is chosen — never to guess which item you meant. Predictable and auditable by design.*

---

## HOW ROUTING WORKS (reference — so you can field questions confidently)

A `@bgagent` comment on the parent epic is routed to a sub-issue by **pure deterministic logic** (`parseParentNodeReference`), in priority order:
1. **Explicit Linear ID** in the comment (`ABCA-386`) → routes there exactly. Always wins.
2. **Significant-title-keyword overlap** → lowercases the comment, drops noise words (`add`, `the`, `change`, `page`…), and finds which sub-issue *titles* share a meaningful word. **Exactly one → acts; two or more → asks ("which sub-issue?"); zero → asks.**

There is **no model** in this path — it's instant, free, and predictable, and it never silently picks the wrong item. The coding **agent (LLM)** runs only *after* a target is chosen, to make the actual change. Practical demo consequence: phrase comments so one sub-issue's title word is unambiguous, or name the ID. (A future optional LLM-assisted disambiguation tier could soften ambiguous cases — noted as an enhancement, not in scope today.)

---

## FALLBACKS (if something's slow or off)

- **Act 1 panel not complete at demo time:** present it mid-flight — *"watch it happening live"* — and use the already-✅ sub-issues. The story still works; you just narrate in present tense.
- **The live comment (Beat 4) is slow (>2 min):** keep talking — show the PRs in GitHub, the combined preview — and circle back to the ✅ Updated reply. It will land.
- **Beat 4 gets a "which sub-issue?" reply instead of acting:** that's the disambiguation safety net — say *"it asks rather than guesses"* and re-comment with the exact wording above (which names the pricing table clearly), or target by ID: `@bgagent ABCA-386: <change>`.
- **Act 2 broken-build agent "fixes" the error instead of leaving it:** rare, but if the broken sub-issue comes back ✅, just narrate the gating concept from the panel and note it's verified behavior; or re-run. (Pre-rehearse this one if you can.)
- **Anything stuck:** the operator can `inspect` any epic and read live state.

---

## OPERATOR CHEAT-SHEET (the person at the keyboard, not on screen)

```
# inspect any epic's live state
python3 scripts/linear_epic.py inspect --issue ABCA-385

# trigger Act 2 live (if not adding the label by hand in Linear)
python3 scripts/linear_epic.py trigger --issue ABCA-389

# post the Beat-4 comment programmatically (if preferred over typing in Linear)
# (VERIFIED to route → trust strip ABCA-387 → ✅ Updated — PR #258)
python3 /tmp/comment.py ABCA-385 '@bgagent the "Trusted by" heading should say "Loved by teams everywhere" instead'

# teardown after the demo
python3 scripts/linear_epic.py teardown --issue ABCA-385
python3 scripts/linear_epic.py teardown --issue ABCA-389

# RE-STAGE a clean pricing epic before a real demo (ABCA-385 already has rehearsal
# comments on it; capture the NEW combined-preview URL into this runbook after it completes):
python3 scripts/linear_epic.py create-epic --spec /tmp/demo_pricing.json
python3 scripts/linear_epic.py trigger --issue <new-parent-id>
```

**Demo issue IDs:**
- Act 1 pricing epic: **ABCA-385** (children 366 tiers, 367 trust, 368 cta) — *has 2 rehearsal comments; re-stage for a pristine run*
- Act 2 safety epic: **ABCA-389** (children 370 good, 371 broken, 372 stacked)

**Note:** ABCA-385 currently carries the Beat-4 rehearsal comments (one ambiguous→asked, one that routed → ✅ Updated PR #258). They demonstrate the behavior but for a clean stage run, re-stage via the command above.
