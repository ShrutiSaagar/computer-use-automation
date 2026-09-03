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

Design write-up: **[REPORT.md](REPORT.md)** · Runs and logs: **[evidence/](evidence/)**

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env          # fake operator credentials for the target app
```

**Model access.** The learning engine uses the [Claude Agent SDK], which authenticates with
whatever the host already has: a Claude Code subscription works with no key, and
`ANTHROPIC_API_KEY` works if set. Same code path — a reviewer needs nothing issued to them.
`replay`, `catalog` and `npm test` never call a model at all.

[Claude Agent SDK]: https://code.claude.com/docs/en/agent-sdk

## Demo path

```bash
# 1. the target application: a deliberately hostile legacy back office
npm run target                                    # tenant A on :4310
npm run target -- --tenant=b --port=4311          # the same product, rebranded

# 2. DISCOVERY -- a real LLM run against the live UI, compiled into an artifact,
#    then immediately self-replayed to decide whether it can be trusted
npm run learn -- \
  --goal "Sign on to the back office, look up member 100482, and open a new Money Market \
sub-account for them with a 50 dollar opening deposit, reaching the confirmation screen. \
Return the new account number, the confirmation code and the effective date." \
  --target http://localhost:4310/

# 3. REPLAY -- the production path. No model involved.
#
#    The default artifact (v2) is COMPOSED: before the flow runs, the engine
#    verifies the session requirement and signs on via the `auth.signon` SKILL,
#    then verifies "the member exists" by delegating to the read-only lookup
#    skill -- so a MEMBER_NOT_FOUND arrives as the caller's ANSWER before any
#    irreversible step may run. A preflight.json lands in the evidence dir
#    recording every check and why it held.
npm run replay -- --capability member.subaccount.open \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00

# 3b. THE CONDITIONS TO RUN, without a browser: resolve the skill graph, check
#     policy (status, deployment tier, composition), verify every credential
#     reference across the graph. What a calling agent consults BEFORE committing.
npm run replay -- --capability member.subaccount.open --preflight-only \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00

# 3c. ...and the gate refusing to run when a condition cannot be met. With the
#     credential references unresolvable, this fails in milliseconds as
#     precondition_not_met -- no browser ever opens, and preflight.json in the
#     evidence dir says exactly which check failed.
env -u CU_CORE_OPERATOR_USERNAME -u CU_CORE_OPERATOR_PASSWORD \
  npm run replay -- --capability member.subaccount.open \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00

# 4. ...and the paths that are not the happy path
npm run replay -- --capability member.subaccount.open --input memberNumber=999999 \
  --input accountType="Money Market" --input openingDeposit=50.00     # MEMBER_NOT_FOUND
npm run replay -- --capability member.subaccount.open --input memberNumber=100482 \
  --input accountType="Money Market" --input openingDeposit=5.00      # DEPOSIT_BELOW_MINIMUM
```

To see a runtime condition handled, arm one in the target app first:

```bash
curl -sX POST -H 'content-type: application/json' \
  -d '{"mode":"session_timeout"}' localhost:4310/_chaos/arm
npm run replay -- --capability member.subaccount.open \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00
#  -> still SUCCESS: re-authenticated mid-flow via the artifact's own establish
#     path (the auth.signon skill -- no control names hardcoded in the engine)
#     and restarted. See steps[].recoveries.
```

Modes: `not_found`, `validation`, `session_timeout`, `interstitial`, `slow`, `error500`,
`permission_denied`, `supervisor_override`.

### Human takeover

```bash
npm run console            # http://localhost:7788
```

Pick `supervisor_override` and press **Start run**. The automation reaches a screen nobody
recorded, cannot pass its checkpoint, and escalates. The lease flips to `human`, the console
streams the live page over CDP, and your clicks and keystrokes are forwarded into the *same*
browser session. Type `OVR-7781`, click **Apply Override**, then **resume** — the engine
re-asserts the step's checkpoint and finishes the flow.

### An agent invoking a capability

```bash
npm run catalog            # http://localhost:7789 -- tool descriptors + invoke endpoint
npx tsx src/cli.ts agent-demo --ask "Open a Money Market sub-account for member 100482 \
with a 50 dollar deposit, and check whether member 999999 exists without changing anything."
```

### Cross-tenant reuse

```bash
npm run replay -- --capability member.subaccount.open@1 \
  --overlay capabilities/member.subaccount.open/northstar-fcu.overlay.json \
  --input memberNumber=100483 --input accountType="Holiday Club" --input openingDeposit=75.00
```

Same artifact, different institution. The overlay is the entire difference between them — and it
can override the session check too, because renaming controls is exactly how one tenant's
configuration differs from another's. (The Northstar overlay is bound to v1: it rewrites the
member-search steps that v2 delegates to the lookup skill. Per-skill overlays are future work, so
preflight *refuses* an overlay pointed at a composed artifact, or at a version its `appliesTo`
does not name — a half-applied overlay would drive the wrong institution's system.)

### Tests

```bash
npm test          # boots the target app itself; no model, no network.
npm run typecheck
bash scripts/make-evidence.sh     # regenerates evidence/ end to end
```

## The target application

`target-app/` is a stand-in for the real thing: a server-rendered "CU-Core Back Office" with a
`<frameset>` shell, nested-table layout, `<font>` tags, ASP.NET-style `ctl00_*` ids, one control
whose id is regenerated on every render, and no test IDs anywhere.

Label association is **mixed on purpose**, because real legacy apps are mixed and because it
forces different rungs of the locator ladder to win on different steps:

| Control | Markup | Winning strategy |
|---|---|---|
| Operator ID | `<label for>` | `role_name` (rank 0) |
| Member No. | no label, adjacent table cell | `anchor` — accessible name is **empty** |
| Account Type | `<label for>` | `role_name` |
| Opening Deposit | no label, **rotating id** | `anchor` |
| Notes | `placeholder` only | `role_name` (the placeholder becomes the name) |

`getByRole('textbox', { name: 'Member No.' })` matches **zero** elements on that page. If every
field had a clean label this project would prove nothing.

Data is obviously synthetic. Credentials come from `.env` and are referenced, never inlined.

## Conditions to run: preflight, skills, and state

Schema 1.1 adds the block that answers "may this run start at all?" — stated as **requirements**,
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

The design stance, in one line: **store the requirement, never the state.** A session cookie *is*
the credential (persisting it violates the same rule as persisting a password), it is dead in
minutes, bound to one tenant/user/environment, hostile to audit attribution (replaying it means
acting as whoever it belonged to), and quietly fatal to determinism. So the artifact carries a
checkable predicate — in the same `Condition` vocabulary the steps use — plus how to establish it
and who decides when it cannot be. Defense in depth is explicit: the check is the cheap FIRST
line; the first step's `waitFor` is the second; the global session-expiry signal (re-auth +
restart) is the third. Artifacts from schema 1.0 get their check synthesized from their own
recorded login steps, so old recordings gain the gate unchanged.

At replay, everything is collected into one **preflight report** (`preflight.json` in the evidence
dir; a delegated skill files its own `preflight-<slot>.json` beside it): skill graph resolution, capability status vs. policy, deployment tier vs. policy
(`allowedDeployments` — a sandbox-tagged artifact is refused by production policy before a browser
opens), credential health across the whole graph, the product fingerprint, the session
requirement, and each data precondition. A gated failure arrives as
`failed/precondition_not_met` (HTTP 409 from the catalog) — "you cannot run this here, yet" is a
different answer from "the flow failed at step 7", and callers retry it differently.

Sign-on knowledge lives in exactly one artifact (`auth.signon`, a skill with no business logic).
When the vendor renames a control or adds an MFA prompt, that one artifact changes and every
capability that composes it is upgraded — with nothing re-recorded. The engine hardcodes no
control names: the mid-run session-expiry recovery routes through the artifact's own `establish`
path, and a mid-flow **restart re-runs the ready state** (session + data preconditions), because
"restart" means "reach the ready state again", not merely "rewind the cursor".

## Reproducibility

An artifact stores the conditions it was recorded under and replay re-applies them:

```json
"environment": {
  "viewport": { "width": 1280, "height": 800 },
  "deviceScaleFactor": 1, "locale": "en-US", "timezoneId": "UTC", "colorScheme": "light",
  "browser": { "name": "chromium", "version": "151.0.7922.34" },
  "userAgent": "Mozilla/5.0 ..."
}
```

The first five are **enforced** — set on the browser context, so a replay matches its recording by
construction rather than because two constants happened to agree. The last two are **recorded and
compared**: you cannot honestly force a browser version, so a difference raises an
`environment_drift` flag instead.

`signals/cucore.json` also carries a `fingerprint` asserted on arrival — "is this still CU-Core
8.2?". Try it:

```bash
npm run target -- --version=8.3      # this institution upgraded ahead of the others
npm run replay -- --capability member.subaccount.open --input memberNumber=100482 \
  --input accountType="Money Market" --input openingDeposit=50.00
#  -> still SUCCESS, plus a product_version_drift flag. Notice, don't refuse.
```

## Layout

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
signals/          cucore.json     product-level signal pack, merged at load time
capabilities/     the artifacts, and a tenant overlay
```

`capability.schema.json` is generated from the zod definition (`npm run schema`).
