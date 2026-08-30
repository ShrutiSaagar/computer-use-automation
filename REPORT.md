# Design write-up

## 1. Architecture

Three pieces, one live session between them.

**Learning engine** (`src/learn/`) — Claude drives the application through a tool surface of
`observe / navigate / click / type / select / extract / review_recording / finalize_capability`,
supplied as an in-process MCP server to the Claude Agent SDK. **The model never writes the
artifact.** It acts, and it declares a contract; the artifact is compiled from what we observed
while it was acting. Asking a model to emit a locator ladder would mean trusting it to recall an
element's id, its frame, its bounding box and the caption beside it — we were standing there
when the click happened, so we record it instead.

**Replay engine** (`src/replay/`) — artifact plus typed inputs, no model. Every step runs the
same loop: `wait → observe → match signals → resolve → policy → act → observe → match signals →
checkpoint`.

**Session broker** (`src/hitl/`) — one live session with a single `controller` lease. Automation
takes the lease for every action, so when a human holds it the engine is not "paused by
convention", it is structurally unable to act.

Three decisions did most of the work:

**Perception is the accessibility tree, not the DOM.** `page.ariaSnapshot({ mode: 'ai' })` gives
role, accessible name, state and geometry — and descends into frames, which a frameset app needs.
That is the same four facts macOS AXUIElement and Windows UIAutomation expose, which is what makes
Section 4 more than an assertion. Trade-off: the AX tree is lossier than the DOM, so two ladder
rungs need a DOM escape hatch (`queryNative`). Those two are the ones that do not port, and the
schema already treats them as lower-value.

**I built replay before the learning engine**, against a hand-written artifact
(`test/fixtures/reference-capability.json`). Replay is the contract; the learning engine's only
job is to emit something replay accepts. It also means replay is provably model-free — you can
check by reading the import graph.

**The engine never throws.** Any unexpected exception is caught and returned as
`failed / internal`. A calling agent should not have to distinguish "the flow failed" from "the
engine failed".

The main cost of the Agent SDK is that I do not own the message loop, so step budgets live in the
tool layer rather than in a `while` loop. What I do own is everything that matters here: the tool
surface, the perception format, and the permission callback every tool call passes through.

## 2. Artifact schema

`src/schema/capability.ts`, zod as the single source of truth → TypeScript types, runtime
validation, and (via `z.toJSONSchema`) the agent-facing tool schema. Three consumers, one
definition, so a capability's published contract cannot drift from what it actually accepts.

**A locator is a ranked ladder, not a selector.**

```
0 role_name   role + accessible name        ← the only rung that also exists on desktop AX APIs
1 label       name, any role                ← survives a control being re-typed
2 attr_text   placeholder / alt / title
3 anchor      "the Nth <role> after the text 'Opening Deposit'"   ← carries legacy table soup
4 id_pattern  /txtDeposit$/                 ← tolerates ASP.NET container prefixes shifting
5 css         a short recorded path
6 text        visible text
7 coords      normalised, policy-gated      ← the bridge to non-DOM surfaces
```

Ordering is a claim: semantics outlive structure, and structure outlives generated identifiers.
Rank 3 is the one that earns its place. On the target app,
`getByRole('textbox', { name: 'Member No.' })` matches nothing — the field has no accessible
name at all, and the only durable thing about it is the caption a human reads beside it. That is
the common case in the environment the brief describes, not an edge case.

**Every locator carries a `guard`.** A stale CSS path can still resolve — to the *wrong* control.
Whatever a strategy returns must match the recorded role and name or it is rejected and the ladder
keeps walking. "Found an element" and "found the right element" are different claims, and acting
on the second-best answer is worse than failing. `recordedRank` vs. the rank that actually
resolved is a free drift signal.

**Signals are global, evaluated after every step** — not attached to the step that expects them.
"Record not found", "session expired" and "unhandled exception" do not confine themselves to the
step that anticipated them; per-step handlers are exactly how a replay blunders past one. Each
signal classifies as `business_outcome`, `recoverable`, or `hard_failure`.

**Risk lives on the step; the response lives in the policy file.** Risk is a property of the
action and travels with the capability to every tenant. What to *do* about it is a property of the
deployment. Baking "always ask a human" into the artifact would mean re-recording to change a
safety posture; baking "always proceed" in would make the artifact unsafe by construction.

**Identity is the vendor product, not the tenant** — `product: { id: "cucore", version: "8.2" }`.
That is what lets one recording serve many institutions (Section 4).

**Outputs are declarative, not steps.** "Steps act, outputs read", so what a capability *returns*
is legible from the contract without reading the step list. Output locators are built in a
different mode: for an action target the accessible name identifies the control, but for an output
the name *is* the value we came to read — keying on it would hardcode this run's answer, and
guarding on it would reject a perfectly good different one next time.

**Compilation verifies the model rather than trusting it.** Three checks, all of which fired on
real runs (see `provenance` in the evidence):

- *Chain integrity* — kept steps must join up through the states we recorded, or compilation fails
  naming the gap.
- *Full accounting* — every successful action must appear in `steps[]` or `droppedSeqs`. The chain
  check catches a dropped navigation; it cannot see a dropped `type`, which changes no URL and
  would leave an artifact that submits a form with an empty field.
- *Detector validation* — every proposed outcome detector is tested against the screens the
  successful run visited. One run proposed a "deposit below minimum" regex matching the permanent
  `min $25.00` hint beside the field; it fired the instant the form rendered and turned a working
  capability into a fake business outcome. That is decidable from evidence we already have, so it
  is checked, not prompted for.

Two more invariants are enforced in code because they are invariants, not preferences: credentials
proposed as caller inputs are stripped (credentials come from a reference), and a parameter's own
value is stripped out of the capability id (`member.subaccount.moneyMarket.open` →
`member.subaccount.open`).

**Verify-on-record.** A fresh artifact is immediately replayed with the same inputs. Pass →
`verified`; fail → `draft`, saved with the failure attached rather than discarded. A recording
that has never been played back is a guess: the model reached the goal once using refs valid at
that instant, and nothing yet says the durable locators we derived will find the same controls
cold. This gate caught two bad artifacts during development.

## 3. Determinism & error handling

Determinism comes from removing the two usual sources of drift: no model decides anything, and
there are no sleeps. Every wait is a declarative `Condition` polled against a fresh observation.

That was not purism. `page.waitForLoadState()` does **not** fire for a navigation inside a
frameset child frame — verified: the frame URLs were unchanged after a form submit. A load-state
wait sails straight past the screens this system exists to drive. Polling conditions works there,
and is also the only wait model that means anything on a desktop surface. Relatedly, the `fN` frame
ids in a snapshot are a counter over every frame the page has ever had, not an index into
`page.frames()` — after navigating away from a frameset that used `f1..f3`, the fresh document is
`f4`. Artifacts record a frame *ordinal*; recording the raw id produces a capability that works
exactly once.

**The recording's environment is stored and re-applied.** "It worked on my machine" is not a
replay guarantee, so the artifact carries an `environment` block — viewport, device scale, locale,
timezone, colour scheme — captured at discovery and re-applied on every replay. Each of those
changes behaviour, not just appearance: the viewport decides bounding boxes and what is visible at
all under a responsive layout; locale changes browser-rendered control names, so a `role_name`
locator recorded in en-US can stop matching elsewhere; timezone shifts date-shaped outputs by a
day depending on where the runner sits.

The split is deliberate. Those five are *enforced*, so a replay matches its recording by
construction. Browser build and user agent are *recorded but not imposed* — you cannot honestly
force a browser version, and pretending to be one you are not is worse than noticing you are a
different one, so a mismatch becomes an `environment_drift` flag.

This was not theoretical. The viewport was previously a constant in the launcher, and the
coordinate strategy denormalised against two *separately hardcoded* numbers — with a comment
claiming it used the observed viewport, which it did not. The two agreed only by coincidence;
changing a window size would have put clicks on the wrong control with no error at all. The
observation now carries its own viewport and there is a test that fails on the old behaviour.

Alongside it, `product.fingerprint` is asserted once on arrival: "is this still the software this
flow was recorded against?". It is supplied by the product pack rather than the recording, because
it is a fact about the product, and a mismatch is flagged rather than fatal — one institution
upgrading ahead of the others is something to hear about on the day, not a reason to refuse work.
`npm run target -- --version=8.3` demonstrates it.

Two things I deliberately did *not* pin. **The clock**: Playwright can freeze time, but a bank's
effective date should be the real one, so date outputs are asserted by shape rather than equality.
And **cookies/storage**: every run starts clean and signs in, because a replay that depends on
inherited session state is a replay that works until it doesn't.

**The result contract** distinguishes what the brief asks it to:

| Status | Meaning |
|---|---|
| `success` | with declared outputs |
| `business_outcome` | a legitimate answer — `MEMBER_NOT_FOUND` is data, not a crash |
| `escalated` | a human was involved; carries what they decided |
| `blocked_by_policy` | a guardrail refused; not the app's fault and not a bug |
| `failed` | with `class`, `stepId`, `expected`, `observed` |

Note what is *not* a status: **recovered**. Dismissing an interstitial or re-authenticating does
not change the caller's answer, so it is telemetry on the step, not a result to branch on.

**The escalation ladder** on a step failure: declared recovery → bounded retry → bounded LLM repair
→ human → fail.

Two details in there matter. Checkpoint waiting and signal matching are *raced* in one poll loop,
because waiting for a checkpoint and only then asking "was there an error?" made a legitimate
business outcome cost the full 10s step timeout to discover; racing them cut it to ~450ms and also
fixed a real race where a signal check fired immediately after a click inspected the page the click
was still navigating away from. And `recover.then` has three values, not two: `retry_step` redoes
the action, `continue` goes back to waiting without re-acting (dismissing a banner should not
re-click Sign On), and `restart` rewinds past the login steps — because re-authenticating restores
the *session* but not the *navigation*, and retrying the failed step would act on a screen that is
no longer there. That distinction is the difference between a session-recovery demo that works and
one that only appears to.

**LLM repair** is off by default, loaded by dynamic import so the SDK is not even resident when
disabled. It may return *only* a replacement locator — never the action, the value, the order or
the risk class — is capped at 1/step and 2/run, never runs on a risky step, must re-pass the
checkpoint, and files a proposed patch for human review rather than editing the artifact.
Determinism survives because the set of things that can happen is fixed by the artifact; repair
only re-answers "which control".

On drift specifically: it is secondary in this environment, and the ladder handles it implicitly.
When replay resolves at a lower rank than recorded, that is logged and flagged, which is the signal
you would aggregate per tenant to notice a version rollout before it becomes an outage.

## 4. Heterogeneity & multi-tenant

**The seam** is `Surface` (`src/surface/types.ts`): four methods, plus `queryNative` as an
explicitly optional escape hatch. `src/surface/desktop.stub.ts` is written out rather than
described, because "extends to desktop" is only worth something if you can see how much changes.
The answer is: that file. Six of the eight ladder rungs are resolved purely from `AxNode[]` by
surface-agnostic code, so they work unchanged on a UIAutomation tree. `id_pattern` and `css`
return nothing and the ladder falls through them — which is why `coords` was kept in the schema
and policy-gated rather than deleted: on the web it is a last resort, on a screenshot-only surface
it is the pragmatic bottom of the ladder. A legacy web app needs no new surface at all; the target
app *is* one.

**Multi-tenant** is keyed on the product. An artifact belongs to `cucore@8.2`, and a
`TenantOverlay` carries the per-institution difference: base URL, per-step locator and condition
overrides, and extra signals.
`capabilities/member.subaccount.open/northstar-fcu.overlay.json` is a working example — the same
artifact recorded against Riverbend, replaying against Northstar, which renames seven controls and
interposes a compliance banner after sign-on. That file *is* the entire difference between the two
institutions. Nothing was re-recorded: the flow, risk classifications, parameters, outputs and
error model all come from the Riverbend recording.

One subtlety worth naming: overriding `entryUrl` alone is not enough. A recording carries its
origin in navigate steps and in derived `url_matches` conditions, so the overlay rebases *every*
recorded origin. Getting that half-right looks like it works and drives the wrong institution's
system — at a bank, the worst available failure.

**Signals resolve at load time, not compile time.** Session expiry, maintenance interstitials and
app crashes are properties of the vendor product, not of any one flow, and a discovery run only
sees the exceptional states that happen to occur while it is running. `signals/cucore.json` is
curated once; adding an entry upgrades every capability recorded against that product, across
every tenant, without re-recording anything. Baking them in would have meant the opposite.

**Drift management** falls out of `recordedRank` vs. actual rank. Per-tenant aggregation of that
one number tells you which institution's configuration is diverging, and from what — the input to
either an overlay or a re-record.

## 5. Escalation & handoff

**Detecting stuck** is not a heuristic: it is the step ladder running out. Recoveries exhausted,
retries exhausted, repair declined or failed. The interesting case in the evidence is a
"Supervisor Override Required" screen that no signal matches and no checkpoint passes — the honest
shape of "cannot safely proceed" is not a known error with a known handler, it is a state nobody
recorded.

**Taking control is real.** The console attaches a CDP session to the *same page* the automation
is driving, streams it with `Page.startScreencast`, and forwards mouse and keyboard back through
`Input.dispatchMouseEvent` / `dispatchKeyEvent`. Same `BrowserContext`, same cookies, same
server-side session, same scroll position. Nothing is reconstructed, because reconstruction is
where handoffs lose state and audit trails.

Two properties follow from owning the input pipe. Enforcement is *structural* — input is forwarded
only while the lease says `human`, so the operator cannot race the automation for the mouse,
because before the lease flips there is nowhere for their clicks to go. And the audit record is a
*capture*, not an inference: every event passes through one file, with keystrokes into password
fields redacted at the moment they arrive rather than scrubbed out afterwards.

**Handing back is a verification, not a promise.** `resume` does not redo the step — that was my
first implementation and it was wrong: the control the step clicks is typically the one the
operator just consumed on their way out of the problem, so the retry got stuck again on a button
that no longer existed. Resume re-asserts the step's own **checkpoint**. If the application agrees
the state is right, the run continues; if not, it goes straight back to the operator. Their word is
a claim; the app's agreement is the proof. Resolutions are `resume`, `retry_step`, `skip_step`,
`abort`, and `approve`/`reject` for risk confirmations.

Evidence spans the handoff: the intervention context, a per-event operator action log, and an
accessibility-level diff of what changed while the human held the lease — which is far more useful
to an auditor than raw coordinates.

## 6. Safety

**One decision function.** `assertAllowed()` is called by *both* engines. During discovery a
refusal returns to the model as a tool error so it re-plans instead of the run dying; during replay
the same refusal becomes `blocked_by_policy`. A guardrail the discovery agent can walk around is
not a guardrail.

Getting that right needed a real fix: the Agent SDK warns that a bare tool name in `allowedTools`
auto-approves the call *before* `canUseTool` runs. My first discovery run had guardrails that never
executed. Permission is now granted only through the callback.

**Layers.** Origin and route allowlist, checked on navigation *and* re-checked after every step in
case the app redirected somewhere we never asked to go. An action-type allowlist. A denied-control
pattern list, matched on accessible name, which catches a dangerous control mis-classified as safe
at record time. Step and runtime budgets. And the risk-response table, which is where `dev` and
`prod` differ: `policy.dev.yaml` allows irreversible actions so demos and CI run unattended,
`policy.prod.yaml` requires human confirmation and will only invoke `approved` capabilities. The
artifact is byte-identical in both cases. Either way the run reports a `risky_action_allowed`
flag — "we did the dangerous thing" is never silent.

**Data handling.** One redaction chokepoint, applied to everything on its way to disk. Sprinkling
redaction at call sites fails the first time someone adds a log line and cannot be audited by
reading. Credentials are referenced (`env:CU_CORE_OPERATOR`), never inlined — and the model types
placeholders, so the password never enters its context window, the transcript, or the artifact.
Password fields are masked *at capture time*, so an unredacted screenshot never exists. Sensitive
outputs are masked in the persisted `result.json` while the caller receives real values: a
capability exists to return data, but the durable file on disk is a regulated-data liability.

**Limits, honestly.** The allowlist is origin- and name-based, so an app that renames a dangerous
control defeats `deniedControlPatterns` — the risk classification in the artifact is the real
control, and it is assigned by a model at record time and needs human review, which is exactly what
the `approved` state is for. Redaction is pattern- and registration-based, so a novel PII shape in
free text would survive. There is no authentication on the operator console. And the risk of the
whole approach is concentrated in one place: a capability marked `verified` by self-replay has been
proven to work once, on one tenant, with one set of inputs.

## 7. Cuts

**Deliberately not built.**

- *Desktop surface* — stubbed at a real seam, with the port documented method by method.
- *Operator console authentication* — no auth, no multi-operator routing, no queue. The
  control-transfer model is real; the console around it is minimal on purpose.
- *Scaling infrastructure* — no queues, workers, or multi-tenant storage. The brief explicitly
  does not reward it, and the abstractions are shaped so it could be added.
- *Capability versioning workflow* — artifacts are immutable and versioned, but there is no diff,
  promotion, or rollback tooling.
- *`approved` state* — modelled and enforced by policy, but nothing sets it: there is no review UI.
- *Frame-level scroll and drag in the console* — click and type are forwarded; scroll is not.

**What I would build next, in order.**

1. **Multi-run stability.** Replay N times and publish a flakiness and mean-strategy-rank score
   per capability per tenant. Everything needed is already recorded; it is aggregation and a
   threshold. That is what would turn `verified` from "worked once" into a number you can gate on,
   and it is the missing half of the confidence story.
2. **A drift dashboard over `strategy.rank`.** The signal already exists on every run. Watching it
   per tenant is how you catch a vendor version rollout in the week before it breaks fifty
   institutions rather than the morning after.
3. **Read-only capability discovery for error states.** Discovery only sees the exceptional states
   that happen to occur while it runs, which is why the product signal pack exists. A bounded
   probe phase — deliberately trying a not-found lookup and a rejected value before the real flow —
   would let capabilities arrive with their error model more complete.
4. **Promotion tooling** for `draft → verified → approved`, with an artifact diff. The states are
   enforced; the workflow around them is a stub.
