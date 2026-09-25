# Design phase 5 — resume here

**Written 2026-09-25 immediately before a session restart.** Read this file first; it is
self-contained. Everything below was verified against the repo at the moment of writing,
not recalled.

---

## 1. Where things stand

| | |
|---|---|
| `HEAD` | `c2c65f6` |
| Unpushed commits | **8** (`origin/main` is at `5aab099`) |
| Deployed | `5aab099` — both workflows ran green; `taskflow.supercodehive.com` returns 200 |
| Phase plan (the authority) | `docs/superpowers/plans/2026-09-25-design-phase5-resources-and-ergonomics.md` |
| Chronological ledger | `.superpowers/sdd/2026-09-25-design-phase5-resources-and-ergonomics/progress.md` (git-ignored, ~400 KB) |
| Phase workspace | `.superpowers/sdd/2026-09-25-design-phase5-resources-and-ergonomics/` (briefs, reports, review packages — **all git-ignored**) |

**Tasks 1–31 are complete and reviewed.** Task 32 and 29 are the only unfinished work.
The phase's durable record — including the measurement traps that cost the most time
today — is written into the plan doc under **"The durable record"**, because the reports
themselves are not tracked.

---

## 2. What is IN FLIGHT right now (uncommitted)

Two agents left work in the working tree when their session was killed by an API billing
error (HTTP 402). **Nothing was lost** — the transcripts are saved and both agents are
resumable by id.

### Task 32's fix round — `aace18237f338bac2`

Its work is in the tree, **uncommitted and unowned by anyone else**. These six files are
its own; nobody else may touch them:

```
v2_fe/src/lib/design-layout.ts          v2_fe/src/lib/design-layout.test.ts
v2_fe/src/pages/design/pages-order.ts   v2_fe/src/pages/design/pages-order.test.ts
v2_fe/src/pages/design/pages-panel.tsx  v2_fe/src/pages/design/pages-panel.test.ts
```

What it was doing: the **arrow semantics** change, the record correction, the Rust
round-trip test, and four Minors. Its last visible action was the panel test — escaping an
interpolated label and correcting a comment that repeats a retracted reason.

### Task 29 — `aa17cd0d07d9f03d6`

One untracked file: **`v2_fe/src/lib/zz-task29-bench.test.ts`**. It self-assessed this
correctly as **a benchmark harness, not a test** — it asserts nothing and only
`console.log`s timings — and was about to run it against a detached checkout. It must be
committed under an honest name or deleted, **never left as a stray**: an untracked file has
produced three wrong lint/test counts in this phase.

### Task 31's re-review — `a80a55a15442041d3`

Read-only; it wrote nothing. Restart it from scratch if you want a verdict — the re-review
target is commit `b69f898` (base `7de8ec8`), package
`review-7de8ec8..b69f898.diff`.

Also present: `v2_fe/yarn.lock` is modified and is **nobody's to commit** — no workflow
reads yarn, all three cache `package-lock.json`.

---

## 3. How to resume

The fastest path is to **resume the agents**, not to redo their work:

```
SendMessage(to: "aace18237f338bac2", ...)   # Task 32 fix round — its files are in the tree
SendMessage(to: "aa17cd0d07d9f03d6", ...)   # Task 29 — its bench file is in the tree
```

Tell each: *the session restarted on an API billing error, your uncommitted work is still
in the tree, re-read your files before continuing rather than trusting your memory of where
you stopped, and say which parts you completed before the interruption.*

If an agent does not resume, its work is still recoverable: Task 32's is the six modified
files above, Task 29's is the one untracked file.

---

## 4. What remains, in order

1. **Task 32's fix round**, then a scoped re-review of it. The review's one Important
   finding was the **arrow semantics**: on an interleaved flow (every project's default)
   arranging two screens inside a group costs k−1 clicks, k−2 of which change nothing in
   the panel while silently reordering *another* group. The agreed replacement: **if a page
   has a section-mate in the direction asked, move it past that mate** (one click, one
   visible move); **if it has none, keep today's ±1 flow move and keep the arrow enabled.**
2. **Task 29**, then its review. The other half of the user's "frozen UI" report.
3. **The final whole-branch review** (`superpowers:requesting-code-review`, most capable
   model), then its single fix wave.
4. **Deploy the accumulated commits** — see §5. 8 commits are ready now; more will land.

---

## 5. Deploying — the sequence is NOT optional

**`deploy-backend.yml` builds and ships the frontend too**, atomically. **`deploy_frontend.yml`
auto-triggers on a push touching `v2_fe/**`, while the backend one is manual-only.** So a
plain `git push` runs the dangerous half by itself.

Why it matters: the phase added a new realtime group (`design_layout`). A frontend that asks
for a group the deployed backend does not know gets a **403 on the entire SSE handshake**,
and the SSE has **no `onerror` handler**, so realtime stays dead until reload — for every
open tab. Measured: frontend deploys take **~1 minute**, backend deploys take **8–13**, so
the race is not close.

```
gh workflow disable 325631380          # Deploy Frontend
git push origin main
gh workflow run deploy-backend.yml --ref main
gh run watch <id> --exit-status        # await green (~9 min)
gh workflow enable 325631380
gh workflow run deploy_frontend.yml --ref main
```

**Always re-enable the frontend workflow afterwards** — leaving it disabled is the one way
this sequence can cause a silent future problem.

---

## 6. Things that cost the most time today — do not re-learn them

- **Cite symbols, not line numbers.** Briefs written at one commit and executed three later
  had *every* citation stale; three tasks reported the drift. A coordinate can be wrong in
  the direction of a *correction* too — that happened.
- **A surviving mutation is a statement about the FIXTURE as much as the mutation.** A test
  was declined as non-discriminating on a measured survivor; varying the fixture turned the
  same mutation into a unique killer.
- **`cargo test` without `--no-fail-fast` stops at the first failing target and hides the
  second killer** — so "this kills one test" was a measurement artifact.
- **`cargo test --workspace` is mandatory** in `backend/`; a bare `cargo test` silently omits
  every plugin crate.
- **Measure from a commit, not the shared tree.** Four wrong counts came from live-tree
  reads; a detached worktree with `node_modules` symlinked is the reliable way.
- **`git commit -F <msg> -- <exact paths>`** — never `git add <paths> && git commit`, which
  commits whatever other agents have staged. `git add` exact paths first if the file is new.
- **A coverage claim must be scoped.** Two findings today were claims true per file but read
  as coverage of a whole change — one omitted the very shape that motivated it.
- **A reason that applies equally to the alternative is not a reason.** One design decision
  was justified by an objection the reviewer reproduced against the shipped code itself.
