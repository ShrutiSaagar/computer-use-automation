# Overview (3-minute read)

**Problem.** Banks and credit unions run legacy back-office applications with no API. The only
way in is the UI. An AI agent that serves members needs "hands" on those screens, but a bank
cannot have a model improvising against a production core on every call.

**Answer.** Let a model work the task out **once**, freeze what it learned into a typed,
reviewable **capability artifact**, and from then on **replay** that artifact deterministically
with no model in the loop. The agent invokes the capability by name with typed arguments, and
gets back a typed result.

```
learn (LLM, once)  ->  capability artifact (JSON)  ->  preflight  ->  replay (no LLM)  ->  result
                                                                          |
                                                                   human takeover if stuck
```

## The five ideas

1. **Discovery is real, replay is not clever.** `npm run learn` drives a live browser with Claude
   and compiles the trace into an artifact. `npm run replay` executes the artifact step by step:
   locate the control, act, assert the checkpoint. No model decides anything.
2. **The artifact is the product.** `capabilities/*/vN.json` holds the steps, a ranked locator
   ladder per control (accessible role and name first, layout anchors later), typed inputs and
   outputs, a checkpoint, the error model, and the conditions under which it was recorded.
   Schema: `src/schema/capability.ts`, exported as `capability.schema.json`.
3. **Conditions to run are declared, never stored.** An artifact says what an authenticated
   session *looks like* and which skill establishes it. It never stores a cookie or a "logged in"
   flag. A **preflight** checks policy, credentials, the skill graph, the session and the data
   preconditions before the flow starts, and files `preflight.json` in the run's evidence.
4. **Capabilities compose.** Sign-on lives in one artifact (`auth.signon`). The lookup and the
   account-opening capabilities delegate to it. When the vendor changes the sign-on screen, one
   artifact changes and nothing is re-recorded.
5. **A human can take over the same session.** When replay reaches a screen nobody recorded, it
   escalates. An operator drives the *same* browser through a co-browse console, hands back, and
   the engine re-asserts the checkpoint and continues.

## What a result can be

| Status | Meaning | Example |
|---|---|---|
| `success` | Typed outputs extracted and verified | new account number, confirmation code |
| `business_outcome` | The application gave an *answer*, not an error | `MEMBER_NOT_FOUND`, `DEPOSIT_BELOW_MINIMUM` |
| `failed` | A hard failure, with `expected` vs `observed` | `surface_error`, `checkpoint_failed`, `precondition_not_met`, `invalid_input` |
| `blocked_by_policy` | The guardrails refused | irreversible action under a policy that requires confirmation |
| `escalated` | A human was asked; the result records their decision | unrecorded screen, operator aborted |

Recoverable conditions (session expiry, maintenance interstitials, slow pages) are absorbed inside
the run and appear only in `steps[].recoveries`. The caller never sees them.

## See it work in three commands

```bash
npm install && npx playwright install chromium && cp .env.example .env
npm run target                       # the deliberately hostile legacy app on :4310
npm run replay -- --capability member.subaccount.open \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00
```

Then `npm test` (58 tests, boots the app itself, no model, no network).

## Where to read next

- [README.md](README.md): setup, every demo path in order, tests, how it works, repo layout.
- [REPORT.md](REPORT.md): the design write-up, decisions, error taxonomy, what was cut and why.
- [evidence/](evidence/): the real discovery run and one replay directory per scenario, each
  with `result.json`, `run.jsonl`, `preflight.json`, screenshots and accessibility snapshots.
