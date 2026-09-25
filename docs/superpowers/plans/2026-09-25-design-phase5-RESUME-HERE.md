# Design phase 5 — resume here

**Written 2026-09-25 immediately before a session restart, and corrected in the final fix
wave of the phase.** The last two sections are what outlived the phase — the deploy sequence and the
lessons that cost the most to learn. §1–§3 exist because this file is cited by name, and their
old content is the reason they are not simply deleted: two of the three claims below were
made by an earlier version of this file and were false. Do not act on a handoff — this one
included — without checking it against the repo.

---

## 1. Where things stand

| | |
|---|---|
| Phase plan (the authority) | `docs/superpowers/plans/2026-09-25-design-phase5-resources-and-ergonomics.md` |
| **The durable record** | the same plan, section **"The durable record"** — the facts that existed only in git-ignored scratch, including **facts 9–13** on crashed sessions, agent ids, strays and lost verdicts |
| Chronological ledger | `.superpowers/sdd/2026-09-25-design-phase5-resources-and-ergonomics/progress.md` (git-ignored, large) |
| Phase workspace | `.superpowers/sdd/2026-09-25-design-phase5-resources-and-ergonomics/` (briefs, reports, review packages — **all git-ignored**) |

**Status.** Every task in the plan is complete and reviewed except:

- **Task 9** (the phase's verification and held publish) and **Task 19** (typography tokens in
  their own family) — **deliberately deferred**, not unfinished work nobody got to. The plan
  says why under each task; 19 waits on the user's own browser testing;
- the final whole-branch review's own findings, fixed in one wave immediately before the push
  (its verdict: *0 Critical, 5 Important, 6 Minor — ready to merge, with fixes*) and covered by
  a scoped re-review of that wave.

Two things an earlier version of this file claimed, both corrected here because a crash is
what produced them:

- **"Tasks 1–31 are complete and reviewed"** was false in two ways. Tasks 9 and 19 were
  already deferred, not complete — and **Task 28's scoped re-review verdict had been lost
  entirely** (durable record, fact 10), so one committed task was carrying no verdict at all
  until a replacement re-review re-ran its three mutations.
- The **HEAD / unpushed counts** it quoted (`c2c65f6`, 8 commits) were a snapshot of a moving
  branch. The phase's count is `git log --oneline origin/main..HEAD` — read it, never a
  number written here.

## 2. If a session dies again — what survives

**Agent ids are not a recovery mechanism.** `SendMessage(to: "<agentId>")` returns *"No
transcript found for agent ID"*: subagent transcripts do not survive the session. The earlier
version of this file offered exactly that as **"the fastest path"** to resume, which makes it
the single most misleading thing in the file, and it is the third restart this phase paid for
(durable record, fact 9).

What survives is **the work in the tree** and **the ledger**, and nothing else:

- enumerate the dirty files **and the review loops**. An implementer that dies leaves modified
  files; a reviewer that dies leaves nothing, and `git status` cannot show you a missing
  verdict (fact 10).
- a stray untracked file is not neutral — it moves every count measured beside it, so nothing
  should be measured while one is present (fact 13).
- re-read the files before continuing, and say which parts were finished before the
  interruption; do not trust a memory of where the work stopped.

## 3. What remains

Nothing in the plan's scope beyond the two deliberately deferred tasks above. The phase's last
act is the push and the deploy — go to §4.

---

## 4. Deploying — the sequence is NOT optional

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

## 5. Things that cost the most time today — do not re-learn them

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
