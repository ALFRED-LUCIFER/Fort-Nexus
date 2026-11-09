# Self-healing runs and stronger coding agents

Status: built and reviewed on `feat/self-healing-runs` (2026-11-09), approved by the owner ("consider this also and start building"). Not yet merged or run on a real job. Feedback is sent from the run drawer's box, typed or by its mic; the Talk integration is not built. PRD: FR-RUN-06, FR-DEV-02/05/06, FR-AGT-02/03/06/09.

## Why

- A job makes one attempt. When its tests fail, it still reaches the push approval, and the owner has no way to make the agent try again.
- The first real run (medvya #213) showed a second problem. Its tests never ran: `sh: pnpm: not found`, because the sandbox offers only `corepack pnpm` while the repository's own script calls `pnpm`. NEXUS reported that as failed tests.
- The owner's rule: **a change cannot be pushed unless its tests succeeded.** The agent should work in a loop until they do, within limits.
- The agents are thinner than their descriptions: QA is on the roster but no job ever runs it, the Developer's profile doesn't apply to jobs started directly, and its prompt doesn't tell it to follow the repository's conventions.

## Goals

1. Repositories whose scripts call `pnpm` or `yarn` can be tested in the sandbox.
2. After the first attempt, the agent gets **up to 3 repair rounds**, each ending in NEXUS's own test run.
3. No push approval exists unless NEXUS saw the tests pass on exactly the tree being pushed. The server enforces this.
4. The owner can tell a stuck job to **Keep fixing**, with an optional note.
5. The Developer works better: it follows repository conventions, plans before editing, adds tests, and its profile applies.
6. QA becomes real: an independent review of the change against the issue before approval.
7. The Developer carries the whole development cycle: understand, spec, grill, red, green with the smallest complete change, review.
8. The owner can give the agent feedback while it works, and after 3 repair rounds it reports plainly what is stuck.

## Non-goals (this wave)

- Automatic merging, or any push without the owner's approval.
- Fixing failed GitHub CI on an open draft PR. It is the next wave, after this one has worked on real jobs (see "Next waves").
- Issues that need a new dependency: the agent has no registry access, so these stop with a clear reason.
- Reworking Product, AI researcher, Financial analyst or Chief of Staff. They get their own audit and spec (see "Next waves").

## Anti-goals: a failure even if it technically works

- The agent makes tests pass by deleting, skipping or rewriting away what they check.
- The loop spends money on a problem code can't fix, such as a missing tool or a blocked network.
- NEXUS reports success on the agent's word instead of its own test run.
- A QA opinion is presented as fact, or allows a push by itself.

## Behaviour

### 1. Sandbox

The sandbox image puts working `pnpm` and `yarn` on `PATH` for nested calls from repository scripts. The image tag changes (`SANDBOX_IMAGE`), and the runbook and build step are updated. The owner's machine needs the new image built.

### 2. The loop

Within one job and one lease, on the same worktree:

```
agent attempt -> changeset -> integrity check -> NEXUS test run
  passed                 -> QA review -> (no blocking defects) -> upload, approval
  failed (code problem)  -> repair round, up to 3
  anything else          -> stop and say why
```

A repair round runs the Developer again with the fixed rules, the issue, and the failure evidence (redacted test output tail, QA defects or integrity problems). Test output and QA defects come from repository content and the model, so they are fenced as untrusted data the same way the issue is.

**How a test result is classified:**

| Result | Action |
|---|---|
| `passed` | Continue to QA |
| `failed`, code problem | Repair round |
| `failed`, environment problem (command not found, DNS or network refusal in the output) | Stop: `ENVIRONMENT`. No repair round |
| Test run timed out | Repair round: the change may have introduced a hang |
| Install failed, and the change touched a package manifest or lockfile | Stop: the change needs a new dependency, which this wave can't install. Says so plainly |
| Install failed otherwise, or the test run could not start | Stop: `ENVIRONMENT` |
| `not_configured` | Stop: says how to add a test script or `.nexus.json` |

`Verification` records which of these happened, so the owner and the loop don't have to infer it from `error`.

**Tests that were already failing (owner's decision).** The first time tests fail in a job, NEXUS runs them once on the base commit, in the same sandbox and against the same wall clock. If the base fails too, the job stops with outcome `ALREADY_FAILING` and no repair rounds. The owner can use Keep fixing and say in the note to fix those failures too; only then may the agent make those changes. When tests pass the first time, this extra run never happens.

**The agent can run the tests (owner's decision).** Before the first round, NEXUS installs the repository's packages in a separate container with the same limited registry access the test run has, using install commands from the base commit. The agent's container then has those packages available and runs the tests as it works. Its network stays limited to the model provider. The owner accepted the trade-off: repository packages and test code run in the container that holds the AI key. NEXUS's own test run stays the only result that counts. If this install fails, the job proceeds without it and the agent is told it can't run tests.

**A passing tree is never lost (builder's review; Claude's call).** NEXUS snapshots each tree whose tests passed. If a later round makes things worse, runs out of budget or stops early, NEXUS restores the last passing tree and offers that for approval with its original test result, plus any open QA defects. A model's opinion alone can't turn a pushable result into a failure.

**The loop stops early when it isn't progressing:** the same failure twice in a row (compared after removing timings, paths and other noise), a repair round that changes nothing, or too little budget left to run another round.

**Budget:** all rounds and QA share the job's one budget (cost, turns, wall clock). The test runs count toward wall clock. The job's total can't exceed what the owner approved at the start.

**Stopping:** cancel and Emergency stop end the loop at any point, as they end a run today.

### 3. Test integrity

The test command is read from the base commit, but the repository's own `package.json` script runs from the agent's tree, so the agent could still change what "test" means. Before a test result counts, NEXUS checks the changeset deterministically. The result can't count as passed if the change:

- deletes or renames a test file;
- changes the `test` script, `.nexus.json`, or a test runner config;
- adds a skip or focus marker (`.skip`, `.only`, `xit`, `fdescribe`, `@Ignore`, `pytest.mark.skip` and similar) to a test file.

An integrity problem goes back to the agent as a repair round, and if it remains the job ends without an approval. Editing existing tests is allowed, because features legitimately change them. The approval lists the test files changed so the owner can look.

### 4. The push gate

- `uploadChangeset` stores the last tree that reached a NEXUS test run, and creates an approval only when `verification.status` is `passed` and integrity is clean. A half-edited tree from a round that died mid-edit is not stored. If no tree reached a test run, nothing is stored. After a detected secret leak, nothing is ever stored. (Claude's call.)
- Otherwise the job ends `FAILED` with outcome `FAILED_TESTS`, or a new `ENVIRONMENT_BLOCKED` or `ALREADY_FAILING` outcome.
- The test result is saved with the stored changeset, because failed jobs have no approval to hold it.
- `decideApproval` refuses to approve anything whose recorded verification isn't `passed`. This also covers approvals pending from before this change, such as medvya #213.
- A repository with no runnable tests is blocked too, before any agent spend: the test plan comes from the base commit, so no round could change it. The message says exactly what to add.

### 5. Keep fixing

`POST /v1/jobs/:id/keep-fixing`, with an Idempotency-Key and an optional `note` (up to 2,000 characters).

- Available on a job that has a stored changeset that was not pushed, whatever its status, unless its tests passed and an approval can still be decided: that one is reviewed at the approval. A job whose tests passed but which integrity problems kept from an approval qualifies, as does one whose approval was denied or expired. A pending approval from before this change, such as medvya #213, qualifies: Keep fixing withdraws that approval. (Claude's call.)
- Refused for `not_configured`, because the test plan comes from the base commit and Keep fixing keeps that base. The message points to Run again after the owner adds tests.
- Creates a new job linked by `retryOfJobId`, on the **same base commit and issue snapshot**, starting from the stored changeset, with a fresh budget and 3 repair rounds.
- **It starts with NEXUS's own test run, before any model spend.** If the blocker was outside the code, the tests now pass and the job goes straight to QA and approval. The drawer counts "Round N of 4" for a new job and "Round N of 3" for Keep fixing. (Claude's call.)
- The note reaches the agent labelled as the owner's guidance. It can't override the fixed rules.
- Every check a new job gets still applies (Emergency stop, budget, project state).
- The run drawer and Jobs page show **Keep fixing** next to **Run again**. Run again starts from scratch.

### 6. Developer: the whole development lifecycle (owner's direction)

The owner wants the agent to carry the full cycle itself: spec, grill, understand, change only what's required, red and green tests, iterate. The discipline is in the fixed prompt, and NEXUS checks what it can with its own evidence.

The agent works through these phases in order:

1. **Understand.** Read the issue, `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md` at the repository root if they exist (the fixed rules always win), and the code the change touches. List every place the change must reach: callers, tests, fixtures, config.
2. **Spec.** Write a short spec: what will change, what won't, and acceptance checks.
3. **Grill.** Attack that spec: wrong assumptions, edge cases, what the change could break for users, and whether each part is needed. If a question only the owner can answer blocks the work, stop and ask (see "When the agent needs the owner").
4. **Red.** Write or update a test that fails for the right reason, and run it.
5. **Green: the smallest complete change.** Follow this order: does it need to exist, is it already in this codebase, is it in the standard library, is it in an installed dependency, otherwise the minimum code that works. Fix root causes in the shared code. Finish every part the change needs. No unrelated refactors, options or "for later" code. Never cut validation, error handling, security or accessibility.
6. **Review.** Read its own diff against the spec, remove anything not required, and run the tests.

Each phase's output is reported as a structured event, so the drawer shows what the agent understood and planned before the code.

**Red and green evidence from NEXUS.** When a change includes test files, NEXUS also runs those tests against the base code with the source change left out. If they pass there, they don't prove anything, and that is sent back as a repair round. A code change with no test change is sent back as well. Docs and config-only changes are exempt. This run happens once per job, on the first tree whose tests pass.

Repair rounds tell the agent to find the root cause and forbid weakening tests. The Developer's effective profile applies to jobs started directly: the budget is capped by the profile's limits and the job uses the profile's model when one is set.

**When the agent needs the owner.** If the grill phase finds a blocking question, the job ends with outcome `NEEDS_INFO`, no changeset and the questions shown. The owner's answer in the feedback box starts a new linked job carrying the questions and that answer. A question asked after a tree has already passed is shown in the drawer next to the approval for that tree.

**The stuck report.** When the loop ends without a pass, whatever the reason, the owner gets a short report: what each round tried, what still fails, the agent's best guess at the root cause (labelled as a guess), and the recommended next step. It appears in the run drawer and in the notification.

### 6a. Feedback: talk to the agent

The run drawer has a prompt box under the live terminal, on any issue job.

- **While the job runs:** `POST /v1/jobs/:id/feedback` (Idempotency-Key, up to 2,000 characters). The message is stored and delivered at the next round boundary, including between the agent and the test run. The drawer shows it as "Waiting for the next round", then "Delivered to round N", from the runner's own event. A running round isn't interrupted, and the UI doesn't suggest it was.
- **If feedback is waiting when the tests have passed:** it triggers another round if rounds remain. If none remain, the drawer says it wasn't used.
- **After the job has ended:** the same box is the note for Keep fixing, or the answer to the agent's questions.
- Talk and the voice button can send the same feedback when the conversation is bound to that job.
- Feedback is labelled as the owner's guidance in the prompt and can't override the fixed rules. It is audited with the correlation ID. Only the job's owner can send it.

### 7. QA

- Runs once the tests pass, in the sandbox, on the same worktree, attributed to QA and paid from the job's budget.
- Reviews the diff against the issue and its acceptance criteria. Returns structured output: verdict, and defects with file, evidence and severity.
- Must not change code: NEXUS compares the tree before and after, and discards the review and ends QA if it differs.
- Blocking defects start a repair round, from the same limit of 3.
- If rounds run out with QA defects open but tests passing, the approval is still offered, with the defects shown first.
- If QA can't run, the approval says so plainly. A QA failure to run does not block a push whose tests passed.
- The verdict is labelled as a model's review, never as a verified fact.

### 8. What the owner sees

- Live in the run drawer: "Round 2 of 4", each round's test result, and why the loop stopped.
- The approval: test evidence, test files changed, QA verdict and defects.
- Jobs that can't be pushed say why in one sentence, and offer Keep fixing or point to the setup fix.

## Constraints

- PRD Part B and the Global DoD apply: typed jobs only, no shell text, server-side authorization, idempotency, audit plus correlation ID, redaction, real UI states.
- `canTransition` is the only path for state changes; the VERIFYING to RUNNING transition is new.
- Heartbeats and lease renewal keep running through every round.
- The runner keeps one job at a time.

## Left to the builder

The event type names and payloads, the exact skip-marker patterns per language, the failure-comparison normalisation, the minimum budget needed to start another round, and how the lease carries a stored changeset.

## Next waves

1. **CI on an open draft PR:** when GitHub's checks fail, DevOps reads the failure and offers Keep fixing with that evidence. Any new push still needs approval.
2. **Audit of the remaining agents:** Chief of Staff, Product, AI researcher and Financial analyst, against FR-AGT-01..10, with evidence requirements for their handoffs (FR-AGT-09).
