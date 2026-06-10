# Orchestration reconciler — correctness as a proof problem (#247)

A worksheet for reasoning about the Mode A reconciler's gating logic
rigorously, rather than patching failures one at a time. Work the proof
obligations + adversarial schedules below by hand; each is a place a bug
can hide. Known findings (from the integration test) are listed at the
end — try to *derive* them before reading.

---

## 1. The model

**State.** An orchestration is a DAG of children. Each child `c` has:
- `deps(c)` ⊆ children — its predecessors (immutable after discovery),
- `status(c) ∈ {blocked, ready, released, succeeded, failed, skipped}`,
- at most one `task(c)` (an ABCA task), created when released.

Persisted in DynamoDB: one row per child (PK `orchestration_id`, SK
`sub_issue_id`), plus a `#meta` row. A `ChildTaskIndex` GSI maps
`task_id → row`.

**Events.** The only inputs are **terminal task events** arriving on the
TaskTable stream: `complete(c, build_passed)`, `fail(c)`,
`cancel(c)`, `timeout(c)`. Each is delivered **at least once** (stream
redelivery) and events for *different* children may be processed
**concurrently** by separate Lambda invocations. Roots are released once
at seed time (separate path).

**Success predicate.** `succ(c) ≝ status(c)=succeeded`, set only by a
`complete(c, true)`. (`complete(c,false)` → `failed`; see Obligation O3.)

**Release rule (intended).** A child `c` becomes releasable iff
`status(c)=blocked ∧ ∀d∈deps(c): succ(d)`. Releasing creates `task(c)`
and sets `status(c)=released`.

**Operations available** (their atomicity matters):
- `Put(item, cond)` — conditional put, atomic.
- `Update(key, set, cond)` — conditional update, atomic per item.
- `Query(partition | GSI)` — **not** atomic with any write.
- `createTaskCore(...)` — internally does `Query(IdempotencyIndex)` then
  `Put(cond: attribute_not_exists(task_id))`. **Check-then-act across two
  calls → NOT atomic.** A new `task_id` (ulid) is minted each call, so the
  `attribute_not_exists` condition does **not** dedup two calls with the
  same idempotency key.

---

## 2. Invariants to preserve (state these as ∀-properties)

- **I1 (no premature start):** if `status(c)∈{released,succeeded}` then at
  the moment of release `∀d∈deps(c): succ(d)`.
- **I2 (exactly-once task):** at most one `task(c)` is ever created per `c`.
- **I3 (no lost release):** if at any quiescent point
  `∀d∈deps(c): succ(d)` and `status(c)=blocked`, then eventually `c` is
  released. (Liveness — no stranding.)
- **I4 (terminal monotonicity):** `succeeded/failed/skipped` are terminal;
  no event moves `c` out of them.
- **I5 (failure closure):** if `∃d∈deps*(c)` (transitive) with
  `status(d)∈{failed,skipped}` then `c` is eventually `skipped`, never
  released. (No child runs on a failed predecessor.)
- **I6 (completion soundness):** the orchestration is reported complete iff
  `∀c: status(c)∈{succeeded,failed,skipped}`.

---

## 3. Proof obligations

For the reconcile procedure `R(e)` run per event `e`, prove each holds
under **(a)** single-threaded sequential delivery, **(b)** at-least-once
redelivery, **(c)** concurrent delivery of distinct-child events.

- **O1.** `R` preserves I1. *(Does the release decision read a state in
  which all deps are truly `succeeded`, or a stale snapshot?)*
- **O2.** `R` preserves I2 under (c). *(If two events each conclude `c` is
  releasable, how many `task(c)` get created? Which step is the
  serialization point — the row flip or the task create? Does the
  serialization point come **before** or **after** the irreversible
  `createTaskCore`?)*
- **O3.** `complete(c, false)` is treated as `fail(c)` for all of
  I1/I5. *(Build-passed gate.)*
- **O4.** `R` preserves I3 under (c). *(The "diamond race": `d∈deps(D)` and
  `e∈deps(D)` complete concurrently; each invocation persists only its own
  child as succeeded. Construct a schedule where **neither** invocation
  sees both `succ(d)∧succ(e)` → D stranded. What read ordering defeats
  it?)*
- **O5.** `R` preserves I2 **and** I3 simultaneously. *(This is the crux:
  O4's fix — "re-read fresh and release if all deps succeeded" — can
  reintroduce O2 violations. Show whether your `R` can satisfy both, or
  prove they require a single atomic compare-and-release.)*
- **O6.** Redelivery of an already-processed `e` is a no-op (idempotent).
- **O7.** Termination: `R` halts and the DAG reaches all-terminal in
  finite events (no infinite re-release loop).

---

## 4. Adversarial schedules to run by hand

Use `▸` for "invocation reads", `✎` for "invocation writes". Two
invocations P, Q. Find the interleaving that breaks an invariant.

**S1 — diamond, simultaneous (O4):** D deps {B,C}, both `released`.
Events `complete(B,true)`, `complete(C,true)` processed by P, Q.
```
P▸snapshot{B:released,C:released,D:blocked}
Q▸snapshot{B:released,C:released,D:blocked}
P✎ B:=succeeded
Q✎ C:=succeeded
P: in P's snapshot, C≠succeeded → P does NOT release D
Q: in Q's snapshot, B≠succeeded → Q does NOT release D
⇒ D stranded blocked, both deps succeeded.  I3 violated.
```
Fix attempt: each invocation, after writing its own child, RE-READS.
Re-derive — does re-read alone guarantee someone sees both? (Hint: depends
whether the re-read happens-after both writes; construct the schedule where
both re-reads still precede the other's write.)

**S2 — double release (O2/O5):** continue S1 with the re-read fix, where
both re-reads DO see {B:succeeded, C:succeeded}.
```
P▸fresh{B:succ,C:succ,D:blocked} → P decides release D
Q▸fresh{B:succ,C:succ,D:blocked} → Q decides release D
P✎ createTaskCore(D) → task_P    (idempotency Query saw nothing yet)
Q✎ createTaskCore(D) → task_Q    (idempotency Query saw nothing yet)
P✎ flip D:blocked→released (cond) ✓
Q✎ flip D:blocked→released (cond) ✗ ConditionalCheckFailed
⇒ TWO tasks created, one orphaned.  I2 violated.
```
Question: reorder so the **conditional flip precedes the task create**.
Does flip-then-create satisfy I2? What new failure does it admit (crash
between flip and create → I3 / stranded `released`-with-no-task)? Is that
recoverable by the #303 stranded sweep? State the trade.

**S3 — redelivery during release (O6):** `complete(B,true)` delivered
twice, processed by P then Q after P fully finished. Show I2/I3 hold.

**S4 — failed leg + concurrent success (O5×O3):** D deps {B,C};
`complete(B,true)` and `fail(C)` concurrent. Show D ends `skipped`, never
released, regardless of interleaving, AND B ends `succeeded`.

**S5 — skip vs release ordering:** A fails; B deps {A}; C deps {B}.
`fail(A)` and a stale `complete`-driven attempt to release B race. Show C
never starts.

---

## 5. The central design question (decide, then prove)

The irreversible action is `createTaskCore`. I2 (exactly-once) requires a
**single serialization point that gates the irreversible action**. Options:

1. **create-then-flip** (current): create always happens; flip dedups the
   row. → I2 broken under concurrency (S2). I3 safe.
2. **flip-then-create**: only the invocation that wins the conditional
   `blocked→released` flip calls createTaskCore. → I2 safe (one winner).
   New risk: crash/throw after flip, before create → `released` row, no
   task → I3 needs the #303 stranded sweep to recover (re-create for a
   `released` row with no live task).
3. **atomic claim**: flip `blocked→releasing` (cond) as the claim; winner
   creates + sets `released`+`task_id`; sweep recovers stuck `releasing`.
   A 3-state version of (2).

Prove which of {2,3} gives I2 ∧ I3 (with the sweep as the I3 backstop),
and whether (1) is salvageable at all under at-least-once + concurrent
delivery. The integration test `concurrent predecessors (wired)` is the
executable witness for S2.

---

## 6. Known findings (try to derive before reading)

- **F1 (= S1):** stale-snapshot release decision strands D under
  simultaneous predecessor completion. *Lost update.* (Fixed attempt:
  re-read fresh.)
- **F2 (= S2):** the re-read fix then admits double task creation, because
  `createTaskCore` idempotency is check-then-act (non-atomic) and
  `releaseChild` is create-then-flip, so the flip (the only serialization
  point) happens *after* the irreversible create. *Double create.*
- **Open:** adopt flip-then-create (Option 2/3) so the conditional flip is
  the gate, with #303's stranded sweep as the I3 backstop for a
  crash-after-flip. Prove I2 ∧ I3 for the chosen option, then encode S1–S5
  as tests.
