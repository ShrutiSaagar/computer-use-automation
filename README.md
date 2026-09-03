# Computer-Use Automation System

An LLM works out how to do a task in a legacy bank back-office UI once. That run is frozen into
a typed, versioned **capability artifact**. From then on the artifact replays deterministically,
with no model in the decision loop, and an AI agent invokes it by name with typed arguments.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how
> the AI agent invokes it in production.

```
  goal ──▶ LEARNING ENGINE ──▶ capability artifact ──▶ PREFLIGHT ──▶ REPLAY ENGINE ──▶ result
           (Claude drives a        (typed, versioned,     (conditions      (no LLM)         success
            live surface)           reviewable JSON)       to run met?)                      business outcome
                                                              │             │             failed
                                             SESSION BROKER ◀────────────────┘             escalated
                                           (one live session,
                                            one control lease)
                                                   │
                                             OPERATOR CONSOLE
                                        (CDP co-browse: a human drives
                                         the same session, then resumes)
```

**Reading order.** [OVERVIEW.md](OVERVIEW.md) (3 minutes) → this file (setup, demos, tests, how it
works) → [REPORT.md](REPORT.md) (design decisions and cuts) → [evidence/](evidence/) (the runs).

## Contents

1. [Setup](#1-setup)
2. [Run it, in order](#2-run-it-in-order)
3. [Tests and evidence](#3-tests-and-evidence)
4. [How it works](#4-how-it-works)
5. [Repository layout](#5-repository-layout)

## 1. Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env          # fake operator credentials for the target app
```

**Model access is only needed for discovery.** `replay`, `catalog`, `console` and `npm test`
never call a model. The learning engine uses the [Claude Agent SDK], which authenticates with
whatever the host already has: a Claude Code subscription works with no key, and
`ANTHROPIC_API_KEY` works if set.

[Claude Agent SDK]: https://code.claude.com/docs/en/agent-sdk

## 2. Run it, in order

Each step builds on the previous one. Every replay writes a directory under `evidence/` with
`result.json`, `run.jsonl`, `preflight.json`, screenshots and accessibility snapshots.

### 2.1 Start the target application

```bash
npm run target                                    # tenant A on :4310
```

`target-app/` is a deliberately hostile stand-in for a real legacy back office (see
[§4.5](#45-the-target-application)). Leave it running in its own terminal.

### 2.2 Replay the happy path (no model)

```bash
npm run replay -- --capability member.subaccount.open \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00
```

The artifact is **composed**: before the flow runs, the engine checks the session requirement and
signs on via the `auth.signon` skill, then verifies "the member exists" by delegating to the
read-only lookup skill. Only then do the irreversible steps run. Look at the printed step table
(each step names the locator strategy that won), then open the evidence directory.

### 2.3 Preflight: the conditions to run

```bash
# every check that needs no browser: skill graph, policy, deployment tier, credentials
npm run replay -- --capability member.subaccount.open --preflight-only \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00

# the gate refusing: credentials withheld -> precondition_not_met in milliseconds, no browser opens
env -u CU_CORE_OPERATOR_USERNAME -u CU_CORE_OPERATOR_PASSWORD \
  npm run replay -- --capability member.subaccount.open \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00
```

### 2.4 Business outcomes are answers, not failures

```bash
npm run replay -- --capability member.subaccount.open --input memberNumber=999999 \
  --input accountType="Money Market" --input openingDeposit=50.00     # MEMBER_NOT_FOUND
npm run replay -- --capability member.subaccount.open --input memberNumber=100482 \
  --input accountType="Money Market" --input openingDeposit=5.00      # DEPOSIT_BELOW_MINIMUM
```

`MEMBER_NOT_FOUND` arrives from the lookup skill during preflight, before any irreversible step.
`DEPOSIT_BELOW_MINIMUM` carries the minimum, read out of the application's own message.

### 2.5 Runtime conditions, recovered silently

Arm a fault in the target app, then replay:

```bash
curl -sX POST -H 'content-type: application/json' \
  -d '{"mode":"session_timeout"}' localhost:4310/_chaos/arm
npm run replay -- --capability member.subaccount.open \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00
#  -> still SUCCESS. The session expired mid-flow; the engine re-authenticated through the
#     artifact's own establish path and restarted. See steps[].recoveries in result.json.
```

Modes: `not_found`, `validation`, `session_timeout`, `interstitial`, `slow`, `error500`,
`permission_denied`, `supervisor_override`.

### 2.6 Human takeover of the same session

```bash
npm run console            # http://localhost:7788
```

Pick `supervisor_override` and press **Start run**. The automation reaches a screen nobody
recorded, cannot pass its checkpoint, and escalates. The lease flips to `human`, the console
streams the live page over CDP, and your clicks and keystrokes are forwarded into the *same*
browser session. Type `OVR-7781`, click **Apply Override**, then **resume**. The engine
re-asserts the step's checkpoint and finishes the flow.

### 2.7 An agent invoking a capability

```bash
npm run catalog            # http://localhost:7789 -- tool descriptors + invoke endpoint
npx tsx src/cli.ts agent-demo --ask "Open a Money Market sub-account for member 100482 \
with a 50 dollar deposit, and check whether member 999999 exists without changing anything."
```

A refused preflight comes back as HTTP 409, and the result names the check that failed.

### 2.8 The same artifact against a second institution

```bash
npm run target -- --tenant=b --port=4311          # the same product, rebranded
npm run replay -- --capability member.subaccount.open@1 \
  --overlay capabilities/member.subaccount.open/northstar-fcu.overlay.json \
  --input memberNumber=100483 --input accountType="Holiday Club" --input openingDeposit=75.00
```

The overlay is the entire difference between the two institutions: seven renamed controls and
one extra interstitial. It can override the session check too, because renaming controls is
exactly how one tenant's configuration differs from another's. The Northstar overlay is bound to
v1; per-skill overlays are future work, so preflight *refuses* an overlay pointed at a composed
artifact or at a version its `appliesTo` does not name.

### 2.9 Discovery: record a new capability (needs a model)

```bash
npm run learn -- \
  --goal "Sign on to the back office, look up member 100482, and open a new Money Market \
sub-account for them with a 50 dollar opening deposit, reaching the confirmation screen. \
Return the new account number, the confirmation code and the effective date." \
  --target http://localhost:4310/
```

Claude drives the live UI, the trace is compiled into an artifact, and the artifact is
immediately self-replayed to decide whether it can be trusted. The recorded discovery runs that
produced the shipped artifacts are in `evidence/discovery-*/`.

## 3. Tests and evidence

```bash
npm test                          # 58 tests. Boots the target app itself; no model, no network.
npm run typecheck
bash scripts/make-evidence.sh     # regenerates every replay directory under evidence/
npm run schema -- --out capability.schema.json   # regenerates the exported JSON Schema
```

The e2e tests drive the real target app through the composed path, the business outcomes, each
recoverable condition, a hard failure, the input contract, and the cross-tenant overlay. A unit
test asserts that `capability.schema.json` matches the zod schema it is generated from.

## 4. How it works

### 4.1 The artifact

`capabilities/<id>/vN.json` is the unit of everything. It holds typed inputs and outputs, the
steps, a ranked **locator ladder** per control (accessible role and name first, layout anchors
and id patterns later, coordinates never by default), a `waitFor` and `checkpoint` per step, the
capability checkpoint, the error model (signals classified as business outcome, recoverable, or
hard failure), the recording environment, and the identity of the vendor product it was recorded
against. The schema is `src/schema/capability.ts`; `capability.schema.json` is its export.

### 4.2 Conditions to run: requirements, not state

Schema 1.1 adds the block that answers "may this run start at all?", stated as **requirements**,
never as stored state:

```jsonc
"uses": [
  { "name": "signon", "capabilityId": "auth.signon", "version": "*",
    "purpose": "establish the operator session" },
  { "name": "lookup", "capabilityId": "member.shareSavings.lookup", "version": "*",
    "purpose": "verify the member exists and land on their profile before any irreversible step may run" }
],
"requires": {
  "session": {
    "describe": "an authenticated operator session (the sign-on screen is gone)",
    "check":     { "node_absent": { "role": "button", "name": "Sign On" } },  // how to TELL
    "establish": { "uses": "signon" },                                        // how to GET THERE
    "onNotMet":  "establish"                                                  // establish | fail | escalate
  },
  "data": [
    { "name": "member_exists", "via": "lookup",
      "args": { "memberNumber": { "$param": "memberNumber" } },
      "notMetOutcomes": ["MEMBER_NOT_FOUND"],
      "onNotMet": "propagate" }   // a child's honest answer IS the caller's answer, not an error
  ]
}
```

**Store the requirement, never the state.** A session cookie *is* the credential (persisting it
violates the same rule as persisting a password), it is dead in minutes, bound to one
tenant/user/environment, hostile to audit attribution, and quietly fatal to determinism. So the
artifact carries a checkable predicate, in the same `Condition` vocabulary the steps use, plus how
to establish it and who decides when it cannot be. Artifacts from schema 1.0 get their check
synthesized from their own recorded login steps, so old recordings gain the gate unchanged.

Sign-on knowledge lives in exactly one artifact (`auth.signon`, a skill with no business logic).
When the vendor renames a control or adds an MFA prompt, that one artifact changes and every
capability that composes it is upgraded, with nothing re-recorded. The engine hardcodes no
control names: mid-run session-expiry recovery routes through the artifact's own `establish`
path, and a restart re-runs the ready state (session and data preconditions), because "restart"
means "reach the ready state again", not merely "rewind the cursor".

### 4.3 The preflight report

Everything is collected into one report, `preflight.json` in the evidence directory, with a
`preflight-<slot>.json` per delegated skill beside it: inputs, capability status vs. policy,
deployment tier vs. `allowedDeployments` (a sandbox-tagged artifact is refused by production
policy before a browser opens), composition permitted, overlay binding, the resolved skill graph,
credential health across the whole graph (values unread), the product fingerprint, the session
requirement, and each data precondition. A gated failure arrives as
`failed/precondition_not_met`. "You cannot run this here, yet" is a different answer from "the
flow failed at step 7", and callers retry it differently.

### 4.4 Reproducibility

An artifact stores the conditions it was recorded under and replay re-applies them:

```json
"environment": {
  "viewport": { "width": 1280, "height": 800 },
  "deviceScaleFactor": 1, "locale": "en-US", "timezoneId": "UTC", "colorScheme": "light",
  "browser": { "name": "chromium", "version": "151.0.7922.34" },
  "userAgent": "Mozilla/5.0 ..."
}
```

The first five are **enforced** on the browser context, so a replay matches its recording by
construction. The last two are **recorded and compared**: you cannot honestly force a browser
version, so a difference raises an `environment_drift` flag instead.

`signals/cucore.json` also carries a product `fingerprint` asserted on arrival: "is this still
CU-Core 8.2?". Try it:

```bash
npm run target -- --version=8.3      # this institution upgraded ahead of the others
npm run replay -- --capability member.subaccount.open --input memberNumber=100482 \
  --input accountType="Money Market" --input openingDeposit=50.00
#  -> still SUCCESS, plus a product_version_drift flag. Notice, don't refuse.
```

### 4.5 The target application

`target-app/` is a server-rendered "CU-Core Back Office" with a `<frameset>` shell, nested-table
layout, `<font>` tags, ASP.NET-style `ctl00_*` ids, one control whose id is regenerated on every
render, and no test IDs anywhere.

Label association is **mixed on purpose**, because real legacy apps are mixed and because it
forces different rungs of the locator ladder to win on different steps:

| Control | Markup | Winning strategy |
|---|---|---|
| Operator ID | `<label for>` | `role_name` (rank 0) |
| Member No. | no label, adjacent table cell | `anchor`: accessible name is **empty** |
| Account Type | `<label for>` | `role_name` |
| Opening Deposit | no label, **rotating id** | `anchor` |
| Notes | `placeholder` only | `role_name` (the placeholder becomes the name) |

`getByRole('textbox', { name: 'Member No.' })` matches **zero** elements on that page. If every
field had a clean label this project would prove nothing.

Data is obviously synthetic. Credentials come from `.env` and are referenced, never inlined.

## 5. Repository layout

```
src/schema/       capability.ts   the artifact schema (zod) -- the focal point
                  result.ts       what a caller gets back
src/capabilities/ store.ts        artifact loading + the product signal pack merge
src/surface/      types.ts        THE SEAM: observe / act / read / describe
                  web.ts          Playwright + accessibility tree
                  desktop.stub.ts a documented stub, to show the seam is real
src/replay/       engine.ts       deterministic execution
                  contract.ts     the caller's input contract, checked before anything acts
                  skills.ts       uses-graph resolution: version ranges, cycles, session-check
                                  synthesis for 1.0 artifacts
                  preflight.ts    the conditions-to-run gate and its persisted report
                  locator.ts      the ranked ladder, built and resolved
                  detect.ts       conditions and signals
                  repair.ts       bounded single-step LLM repair (off by default)
src/learn/        loop.ts         the agent loop and its tool surface
                  compile.ts      trace -> artifact, with the model's output verified
src/policy/       guardrails.ts   one decision function, used by both engines
                  redact.ts       one chokepoint, applied to everything on its way to disk
src/hitl/         broker.ts       the control lease
                  console/        CDP co-browse operator console
src/catalog/      server.ts       agent-facing tool descriptors + invoke
target-app/       the hostile legacy back office, with a chaos endpoint
signals/          cucore.json     product-level signal pack, merged at load time
capabilities/     the artifacts (auth.signon, member.shareSavings.lookup, member.subaccount.open)
                  and the Northstar tenant overlay
evidence/         one directory per discovery run and per replay scenario
policy.dev.yaml   / policy.prod.yaml   the guardrails, per environment
```
