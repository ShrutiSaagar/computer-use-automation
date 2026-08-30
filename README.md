# Computer-Use Automation System

An LLM works out how to do a task in a legacy bank back-office UI once. That run is frozen into
a typed, versioned **capability artifact**. From then on the artifact replays deterministically,
with no model in the decision loop, and an AI agent invokes it by name with typed arguments.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how
> the AI agent invokes it in production.

Design write-up: **[REPORT.md](REPORT.md)** · Runs and logs: **[evidence/](evidence/)**

```
  goal ──▶ LEARNING ENGINE ──▶ capability artifact ──▶ REPLAY ENGINE ──▶ result
           (Claude drives a        (typed, versioned,     (no LLM)         success
            live surface)           reviewable JSON)         │             business outcome
                                                             │             failed
                                            SESSION BROKER ◀──┘             escalated
                                          (one live session,
                                           one control lease)
                                                  │
                                            OPERATOR CONSOLE
                                       (CDP co-browse: a human drives
                                        the same session, then resumes)
```

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
#  -> still SUCCESS: re-authenticated mid-flow and restarted. See steps[].recoveries.
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
npm run replay -- --capability member.subaccount.open \
  --overlay capabilities/member.subaccount.open/northstar-fcu.overlay.json \
  --input memberNumber=100483 --input accountType="Holiday Club" --input openingDeposit=75.00
```

Same artifact, different institution. The overlay is the entire difference between them.

### Tests

```bash
npm test          # 39 tests. Boots the target app itself; no model, no network.
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
src/surface/      types.ts        THE SEAM: observe / act / read / describe
                  web.ts          Playwright + accessibility tree
                  desktop.stub.ts a documented stub, to show the seam is real
src/replay/       engine.ts       deterministic execution
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
