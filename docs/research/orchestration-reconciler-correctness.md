# Orchestration reconciler — correctness as a proof problem (#247)

This is a worksheet for reasoning rigorously about the gating logic of the
sub-issue reconciler, rather than patching failures one at a time. Work the
proof obligations and the adversarial schedules below by hand. Each is a
place where a bug can hide. The known findings from the integration test are
listed at the end. Try to *derive* them before you read them.

---

## 1. The model

**State.** An orchestration is a DAG of children. Each child `c` has:
- `deps(c)` ⊆ children, its predecessors (immutable after discovery),
- `status(c) ∈ {blocked, ready, released, succeeded, failed, skipped}`,
- at most one `task(c)` (an ABCA task), created when released.

The state is persisted in DynamoDB as one row per child (PK
`orchestration_id`, SK `sub_issue_id`), plus a `#meta` row. A
`ChildTaskIndex` GSI maps `task_id → row`.

**Events.** The only inputs are **terminal task events** that arrive on the
TaskTable stream: `complete(c, build_passed)`, `fail(c)`,
`cancel(c)`, `timeout(c)`. Each event is delivered **at least once** (stream
redelivery). Separate Lambda invocations may process events for *different*
children **concurrently**. Roots are released once at seed time, on a
separate path.

**Success predicate.** `succ(c) ≝ status(c)=succeeded`, set only by a
`complete(c, true)`. (`complete(c,false)` → `failed`; see Obligation O3.)

**Release rule (intended).** A child `c` becomes releasable iff
`status(c)=blocked ∧ ∀d∈deps(c): succ(d)`. Releasing creates `task(c)`
and sets `status(c)=released`.

**Operations available** (their atomicity matters):
- `Put(item, cond)` is a conditional put, atomic.
- `Update(key, set, cond)` is a conditional update, atomic per item.
- `Query(partition | GSI)` is **not** atomic with any write.
- `createTaskCore(...)` internally does `Query(IdempotencyIndex)`, then
  `Put(cond: attribute_not_exists(task_id))`. **This is check-then-act
  across two calls, so it is NOT atomic.** Each call mints a new `task_id`
  (ulid), so the `attribute_not_exists` condition does **not** dedup two
  calls with the same idempotency key.

---

## 2. Invariants to preserve (state these as ∀-properties)

- **I1 (no premature start).** If `status(c)∈{released,succeeded}` then at
  the moment of release `∀d∈deps(c): succ(d)`.
- **I2 (exactly-once task).** At most one `task(c)` is ever created per `c`.
- **I3 (no lost release).** If at any quiescent point
  `∀d∈deps(c): succ(d)` and `status(c)=blocked`, then eventually `c` is
  released. (Liveness, no stranding.)
- **I4 (terminal monotonicity).** `succeeded/failed/skipped` are terminal.
  No event moves `c` out of them.
- **I5 (failure closure).** If `∃d∈deps*(c)` (transitive) with
  `status(d)∈{failed,skipped}` then `c` is eventually `skipped`, never
  released. (No child runs on a failed predecessor.)
- **I6 (completion soundness).** The orchestration is reported complete iff
  `∀c: status(c)∈{succeeded,failed,skipped}`.

---

## 3. Proof obligations

For the reconcile procedure `R(e)`, which runs per event `e`, prove
that each obligation holds under **(a)** single-threaded sequential
delivery, **(b)** at-least-once redelivery, and **(c)** concurrent delivery
of distinct-child events.

- **O1.** `R` preserves I1. *(Does the release decision read a state in
  which all deps are truly `succeeded`, or a stale snapshot?)*
- **O2.** `R` preserves I2 under (c). *(If two events each conclude `c` is
  releasable, how many `task(c)` get created? Which step is the
  serialization point, the row flip or the task create? Does the
  serialization point come **before** or **after** the irreversible
  `createTaskCore`?)*
- **O3.** `complete(c, false)` is treated as `fail(c)` for all of
  I1/I5. *(Build-passed gate.)*
- **O4.** `R` preserves I3 under (c). *(The "diamond race": `d∈deps(D)` and
  `e∈deps(D)` complete concurrently, and each invocation persists only its
  own child as succeeded. Construct a schedule where **neither** invocation
  sees both `succ(d)∧succ(e)`, so that D is stranded. What read ordering
  defeats it?)*
- **O5.** `R` preserves I2 **and** I3 simultaneously. *(This is the crux.
  O4's fix, "re-read fresh and release if all deps succeeded", can
  reintroduce O2 violations. Show whether your `R` can satisfy both, or
  prove they require a single atomic compare-and-release.)*
- **O6.** Redelivery of an already-processed `e` is a no-op (idempotent).
- **O7.** Termination: `R` halts and the DAG reaches all-terminal in
  finite events (no infinite re-release loop).

---

## 4. Adversarial schedules to run by hand

Use `▸` for "invocation reads", `✎` for "invocation writes". There are two
invocations, P and Q. Find the interleaving that breaks an invariant.

**S1. Diamond, simultaneous (O4).** D depends on {B,C}, both `released`.
P and Q process the events `complete(B,true)` and `complete(C,true)`.
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
Re-derive. Does the re-read alone guarantee that some invocation sees both?
(Hint: it depends on whether the re-read happens-after both writes.
Construct the schedule where both re-reads still precede the other's write.)

**S2. Double release (O2/O5).** Continue S1 with the re-read fix, where
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
Question: reorder so that the **conditional flip precedes the task create**.
Does flip-then-create satisfy I2? What new failure does it admit? (A crash
between flip and create puts I3 at risk and leaves a stranded
`released`-with-no-task row.) Can the #303 stranded sweep recover it? State
the trade-off.

**S3. Redelivery during release (O6).** `complete(B,true)` is delivered
twice, processed by P and then by Q after P fully finished. Show that I2
and I3 hold.

**S4. Failed leg + concurrent success (O5×O3).** D depends on {B,C}.
`complete(B,true)` and `fail(C)` are concurrent. Show that D ends
`skipped`, never released, regardless of interleaving, AND that B ends
`succeeded`.

**S5. Skip versus release ordering.** A fails. B depends on {A}. C depends on
{B}. `fail(A)` races a stale, `complete`-driven attempt to release B. Show
that C never starts.

---

## 5. The central design question (decide, then prove)

The irreversible action is `createTaskCore`. I2 (exactly-once) requires a
**single serialization point that gates the irreversible action**. Options:

1. **create-then-flip** (current). Create always happens, and flip dedups
   the row. I2 is broken under concurrency (S2). I3 is safe.
2. **flip-then-create.** Only the invocation that wins the conditional
   `blocked→released` flip calls createTaskCore. I2 is safe (one winner).
   New risk: a crash or throw after the flip and before the create leaves a
   `released` row with no task. I3 then needs the #303 stranded sweep to
   recover (re-create for a `released` row with no live task).
3. **atomic claim.** Flip `blocked→releasing` (cond) as the claim. The
   winner creates the task and sets `released` and `task_id`. The sweep
   recovers a stuck `releasing`. This is a 3-state version of (2).

Prove which of {2,3} gives I2 ∧ I3 (with the sweep as the I3 backstop),
and whether (1) is salvageable at all under at-least-once and concurrent
delivery. The integration test `concurrent predecessors (wired)` is the
executable witness for S2.

---

## 6. Known findings (try to derive before reading)

- **F1 (= S1).** A release decision on a stale snapshot strands D when
  predecessors complete simultaneously. *Lost update.* (Fixed attempt:
  re-read fresh.)
- **F2 (= S2).** The re-read fix then admits double task creation, because
  `createTaskCore` idempotency is check-then-act (non-atomic) and
  `releaseChild` is create-then-flip, so the flip, which is the only
  serialization point, happens *after* the irreversible create. *Double
  create.*
- **Open.** Adopt flip-then-create (Option 2/3) so that the conditional flip
  is the gate, with #303's stranded sweep as the I3 backstop for a
  crash after the flip. Prove I2 ∧ I3 for the chosen option, then encode S1
  to S5 as tests.
