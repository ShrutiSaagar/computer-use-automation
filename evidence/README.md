# Evidence

Two genuine LLM discovery runs, and every replay scenario the system claims to handle.

Each directory contains `run.jsonl` (a structured event log), `snapshots/` (the accessibility
tree at each interesting moment), `screenshots/` (masked before they are written), and
`result.json`. Everything on disk passes through `Redactor` first — see
[what is redacted](#a-note-on-what-is-redacted) below.

## Discovery — the model driving a live UI

| Directory | What it shows |
|---|---|
| [`discovery-subaccount-open/`](discovery-subaccount-open/) | Claude Sonnet 5 signing on, finding a member, and opening a sub-account. 11 actions, 18 turns, $0.17. `trace.json` is what it did; `capability.json` is what we compiled from it. |
| [`discovery-balance-lookup/`](discovery-balance-lookup/) | A second, read-only capability. 6 actions, 12 turns, $0.11. |

Worth opening `discovery-subaccount-open/capability.json` and looking at `provenance`:

```json
"rejectedSignals":     [{ "code": "deposit_below_minimum", "matched": "min $" }],
"supersededSignals":   ["member_not_found"]
```

Two compile-time guards fired on that run. The model proposed an outcome detector whose regex
matched the permanent `min $25.00` hint printed beside the deposit field — it would have fired
the instant the form rendered, turning a working capability into a fake business outcome. And it
rediscovered a detector the curated product signal pack already covers, more loosely. Neither was
caught by prompting; both were caught by checking against evidence we already had.

`capability.json` also carries the `environment` the recording was made in — viewport, scale,
locale, timezone, browser build — which replay re-applies. See REPORT.md §3.

## Replay — the production path, no model in the loop

Every replay directory also contains **`preflight.json`** (and a `preflight-<slot>.json` per
delegated skill) — the conditions-to-run report: the
resolved skill graph, policy checks (status, deployment tier, composition), credential health, the
product fingerprint, and the session and data preconditions with why each held. For the composed
v2 capability it shows `signon=auth.signon@1` and `lookup=member.shareSavings.lookup@2` resolved
before the browser opened, and the session requirement **established** by the auth skill because
the sign-on screen was still up at arrival.

| Directory | Result | Point |
|---|---|---|
| [`replay-success/`](replay-success/) | `success` | Typed outputs, through the COMPOSED path: preflight signed on via the `auth.signon` skill and verified `member_exists` via the read-only lookup skill before any irreversible step ran. `result.json` pins the resolved skills; child steps appear in the trace as `signon:…` / `lookup:…`. |
| [`replay-member-not-found/`](replay-member-not-found/) | `business_outcome` | `MEMBER_NOT_FOUND` with `searchedFor` captured — and now it arrives via the **data precondition**: the lookup check's honest answer propagated as the caller's answer before the flow even started. **An answer, not a crash.** |
| [`replay-deposit-below-minimum/`](replay-deposit-below-minimum/) | `business_outcome` | `DEPOSIT_BELOW_MINIMUM`, with the minimum captured out of the app's own message. |
| [`replay-session-timeout-recovered/`](replay-session-timeout-recovered/) | `success` | Session expired mid-flow → re-authenticated from the credential *reference* via the artifact's own `establish` path (no control names in the engine) → the ready state re-established → flow restarted → completed. The caller never learns it happened; it is in `steps[].recoveries`. |
| [`replay-interstitial-recovered/`](replay-interstitial-recovered/) | `success` | An unexpected maintenance notice, dismissed without repeating the step. |
| [`replay-app-error/`](replay-app-error/) | `failed` | `surface_error` *propagated from inside the lookup skill* with the exception text in `observed` — a child's hard failure keeps its class; it is not laundered into "precondition not met". |
| [`replay-unrecorded-screen-no-operator/`](replay-unrecorded-screen-no-operator/) | `failed` | A screen the recording has never seen and no signal matches. Fails cleanly with expected-vs-observed rather than hanging, because no operator is attached. |
| [`replay-invalid-input/`](replay-invalid-input/) | `failed` | `invalid_input`, refused in ~1ms — the caller's contract is checked before a browser is opened. |
| [`replay-preflight-not-ready/`](replay-preflight-not-ready/) | `failed` / `precondition_not_met` | The credential references are unresolvable, so the static preflight refuses **before any browser opens**, and `preflight.json` says exactly which check failed. |
| [`replay-preflight-only/`](replay-preflight-only/) | verdict on paper | The `--preflight-only` path: every check that does not need the application, in milliseconds. What a calling agent should consult before committing to a run. |
| [`replay-escalation-handoff/`](replay-escalation-handoff/) | `success` | **The same unrecorded screen, with an operator attached.** See below. |
| [`replay-tenant-northstar/`](replay-tenant-northstar/) | `success` | The *same artifact* against a different institution, via a ~100-line overlay. |
| [`replay-balance-lookup/`](replay-balance-lookup/) | `success` | The read-only capability, v2: signs on by delegating to `auth.signon`. |

## The human handoff

[`replay-escalation-handoff/`](replay-escalation-handoff/) is the interesting one. Automation hit
a "Supervisor Override Required" screen nobody recorded, escalated, and a human took over the
**same live browser session** through the operator console, typed the override code, and handed
control back.

- `snapshots/*-escalation-*.json` — the state the operator was given to act on.
- `snapshots/*-human-actions-*.json` — every click and keystroke the operator made, captured from
  the input pipe rather than reconstructed, with a `redacted` flag per event.
- `snapshots/*-handoff-diff-*.json` — the *semantic* record of what the human changed, in
  accessibility terms. More useful to an auditor a year later than a stream of raw coordinates:

  ```
  appeared:    cell "Member", cell "Account Type", button "Open Account", …
  disappeared: cell "Override Code", button "Apply Override", …
  urlBefore:   http://localhost:4310/
  urlAfter:    http://localhost:4310/          ← unchanged: it is a frameset
  ```

- `run.jsonl` contains `handoff_verified`, which is the important line. On resume the engine
  re-asserts the step's own checkpoint before continuing. The operator's word is a claim; the
  application's agreement is the proof.

## An AI agent invoking a capability

[`catalog/agent-invocation.json`](catalog/agent-invocation.json) — Claude, given only the catalog
(names, JSON Schemas, declared outcomes) and no idea a browser exists:

- chose `member.subaccount.open` for the opening, and got typed outputs back;
- chose the **read-only** `member.shareSavings.lookup` to answer "does member 999999 exist",
  explicitly because using a mutating capability as an existence check would have opened an account
  for a member who never asked for one;
- received `MEMBER_NOT_FOUND` as structured data and reported it as *the answer*.

That last point is the whole argument for the result contract. Had it arrived as an exception, the
only things an agent could sensibly do are retry or give up.

## A note on what is redacted

`grep -r Tr0ubador evidence/` returns nothing. Concretely:

- credential steps log as `"value":"⟪secret⟫"` — the value never enters the artifact, the model's
  context window, or the log;
- password fields are masked **at capture time** (see
  `discovery-subaccount-open/screenshots/004-*.png`), so an unredacted image never exists on disk;
- sensitive outputs are masked in the persisted `result.json`
  (`"newAccountNumber": "0003-⟪identifier:memberNumber⟫"`) while the caller receives the real
  value. A capability exists to return data; the durable file on disk is a regulated-data
  liability. Those are different things and are treated differently.
