/**
 * Regenerates test/fixtures/reference-capability.json.
 *
 * This is the HAND-WRITTEN artifact that replay was developed against, before the
 * learning engine existed -- which is what makes "replay involves no model" a
 * property you can check rather than a claim. The semantics below (intents, risk
 * classes, signals, checkpoints, the input and output contract) are authored by
 * hand; only the locator ladders are derived mechanically, by walking the live
 * app once and calling the same buildLadder() the compiler uses.
 *
 *   npm run target &  &&  npx tsx test/fixtures/regenerate.mts
 */
import { writeFileSync } from 'node:fs';
import { WebSurface } from '../../src/surface/web.js';
import { buildLadder } from '../../src/replay/locator.js';
import { Capability } from '../../src/schema/capability.js';
import type { Locator } from '../../src/schema/capability.js';

const s = await WebSurface.launch();
const L: Record<string, Locator> = {};
const grab = async (k: string, ref: string, desc: string, mode: 'action'|'output' = 'action') => {
  L[k] = buildLadder(await s.describe(ref), desc, 'mainFrame', mode);
};
const grabTop = async (k: string, ref: string, desc: string) => {
  L[k] = buildLadder(await s.describe(ref), desc, undefined, 'action');
};

await s.act({ kind: 'navigate', url: 'http://localhost:4310/' });
let o = await s.observe();
const find = (role: string, name: string) => o.nodes.find(n => n.role === role && n.name === name)!.ref;
await grabTop('username', find('textbox','Operator ID'), 'the Operator ID field on the sign-on screen');
await grabTop('password', find('textbox','Password'),    'the Password field on the sign-on screen');
await grabTop('signon',   find('button','Sign On'),      'the Sign On button on the sign-on screen');
await s.act({kind:'type', ref: find('textbox','Operator ID'), value: process.env.CU_CORE_OPERATOR_USERNAME ?? 'svc.automation'});
await s.act({kind:'type', ref: find('textbox','Password'),    value: process.env.CU_CORE_OPERATOR_PASSWORD ?? 'Tr0ubador-Demo-2026'});
await s.act({kind:'click', ref: find('button','Sign On')});
await new Promise(r=>setTimeout(r,700));

o = await s.observe();
await grab('memberId', o.nodes.find(n=>n.role==='textbox' && !n.name && n.frame==='f3')!.ref, 'the member number field on the Member Search form');
await grab('search',   find('button','Search'), 'the Search button on the Member Search form');
await s.act({kind:'type', ref: o.nodes.find(n=>n.role==='textbox' && !n.name && n.frame==='f3')!.ref, value:'100482'});
await s.act({kind:'click', ref: find('button','Search')});
await new Promise(r=>setTimeout(r,700));

o = await s.observe();
await grab('newSub', find('button','New Sub-Account'), 'the New Sub-Account button on the member detail screen');
await s.act({kind:'click', ref: find('button','New Sub-Account')});
await new Promise(r=>setTimeout(r,700));

o = await s.observe();
await grab('accountType', find('combobox','Account Type'), 'the Account Type dropdown on the New Sub-Account form');
await grab('deposit', o.nodes.filter(n=>n.role==='textbox' && !n.name)[0]!.ref, 'the Opening Deposit field on the New Sub-Account form');
await grab('continueBtn', find('button','Continue'), 'the Continue button on the New Sub-Account form');
await s.act({kind:'select', ref: find('combobox','Account Type'), value:'Money Market'});
await s.act({kind:'type', ref: o.nodes.filter(n=>n.role==='textbox' && !n.name)[0]!.ref, value:'50'});
await s.act({kind:'click', ref: find('button','Continue')});
await new Promise(r=>setTimeout(r,700));

o = await s.observe();
await grab('openAccount', find('button','Open Account'), 'the Open Account button on the review screen');
await s.act({kind:'click', ref: find('button','Open Account')});
await new Promise(r=>setTimeout(r,700));

o = await s.observe();
const cellAfter = (label: string) => {
  const i = o.nodes.findIndex(n => n.name === label);
  return o.nodes.slice(i+1).find(n => n.role==='cell')!.ref;
};
await grab('outAcct', cellAfter('New Account Number'), 'the New Account Number value on the confirmation screen', 'output');
await grab('outConf', cellAfter('Confirmation'),       'the Confirmation value on the confirmation screen', 'output');
await grab('outDate', cellAfter('Effective Date'),     'the Effective Date value on the confirmation screen', 'output');
await s.close();

const cap = Capability.parse({
  schemaVersion: '1.0',
  id: 'member.subaccount.open',
  version: 1,
  name: 'Open a member sub-account',
  description:
    'Signs on to CU-Core Back Office, looks up a member by number, opens a new sub-account of the requested ' +
    'product type with the given opening deposit, and returns the new account number, confirmation code and ' +
    'effective date from the confirmation screen.',
  status: 'verified',
  product: { id: 'cucore', vendor: 'CU-Core Systems', version: '8.2' },
  surface: { kind: 'legacy_web', entryUrl: 'http://localhost:4310/' },
  auth: { credentialRef: 'env:CU_CORE_OPERATOR', loginStepIds: ['s1_username','s2_password','s3_signon'] },

  inputs: [
    { name:'memberId', type:'string', description:'The six-digit member number to open the sub-account for.',
      required:true, pattern:'^\\d{6}$', sensitivity:'identifier', example:'100482' },
    { name:'accountType', type:'string', description:'Which product to open.',
      required:true, enum:['Share Savings','Money Market','Certificate','Holiday Club'],
      default:'Share Savings', sensitivity:'none', example:'Money Market' },
    { name:'openingDeposit', type:'string', description:'Opening deposit in dollars. The core rejects anything below the product minimum.',
      required:true, pattern:'^\\d+(\\.\\d{2})?$', sensitivity:'amount', example:'50' },
  ],
  outputs: [
    { name:'newAccountNumber', type:'string', description:'The account number the core assigned.',
      from:L.outAcct, extract:'text', pattern:'^\\d{4}-\\d{6}$', sensitivity:'account_number' },
    { name:'confirmationCode', type:'string', description:'Confirmation reference for the opening.',
      from:L.outConf, extract:'text', pattern:'^SA-\\d{6}-[A-Z]+$', sensitivity:'none' },
    { name:'effectiveDate', type:'string', description:'Date the account becomes effective (YYYY-MM-DD).',
      from:L.outDate, extract:'text', pattern:'^\\d{4}-\\d{2}-\\d{2}$', sensitivity:'none' },
  ],

  steps: [
    { id:'s1_username', intent:'Enter the service operator ID on the sign-on screen', action:'type',
      target:L.username, value:{ $secret:'env:CU_CORE_OPERATOR.username' }, risk:'safe',
      waitFor:{ node_visible:{ role:'button', name:'Sign On' } } },
    { id:'s2_password', intent:'Enter the service operator password', action:'type',
      target:L.password, value:{ $secret:'env:CU_CORE_OPERATOR.password' }, risk:'safe' },
    { id:'s3_signon', intent:'Sign on to the back office', action:'click', target:L.signon, risk:'safe',
      checkpoint:{ node_visible:{ role:'link', name:'Member Search' } } },

    { id:'s4_member', intent:'Type the member number into the Member Search form', action:'type',
      target:L.memberId, value:{ $param:'memberId' }, risk:'safe',
      waitFor:{ node_visible:{ role:'button', name:'Search' } } },
    { id:'s5_search', intent:'Run the member search', action:'click', target:L.search, risk:'safe',
      checkpoint:{ text_present:'Member Detail' } },

    { id:'s6_newsub', intent:'Open the New Sub-Account form for this member', action:'click',
      target:L.newSub, risk:'safe',
      checkpoint:{ node_visible:{ role:'combobox', name:'Account Type' } } },
    { id:'s7_type', intent:'Choose the product type for the new sub-account', action:'select',
      target:L.accountType, value:{ $param:'accountType' }, risk:'safe' },
    { id:'s8_deposit', intent:'Enter the opening deposit amount', action:'type',
      target:L.deposit, value:{ $param:'openingDeposit' }, risk:'safe' },

    { id:'s9_continue', intent:'Submit the form and reach the review screen', action:'click',
      target:L.continueBtn,
      // Mutating but reversible: it creates a pending request the operator can
      // simply walk away from. Distinct from the posting step below.
      risk:'risky',
      checkpoint:{ text_present:'Review Sub-Account Request' } },
    { id:'s10_open', intent:'Post the account opening to the core', action:'click',
      target:L.openAccount,
      // The point of no return. Classified here, in the artifact, because that is
      // a fact about the action. What to DO about it is the policy file's call.
      risk:'irreversible',
      checkpoint:{ text_present:'Sub-Account Opened' } },
  ],

  signals: [
    { id:'member_not_found', priority:10, classify:'business_outcome',
      description:'The member number does not exist in this institution.',
      when:{ text_matches:'No member matching "([^"]*)" was found' },
      outcome:{ code:'MEMBER_NOT_FOUND', message:'No member with that number exists at this institution.',
                capture:{ searchedFor:1 } } },
    { id:'deposit_below_minimum', priority:11, classify:'business_outcome',
      description:'The core rejected the opening deposit as below the product minimum.',
      when:{ text_matches:'Opening deposit must be at least \\$([0-9.]+)' },
      outcome:{ code:'DEPOSIT_BELOW_MINIMUM', message:'The opening deposit is below this product’s minimum.',
                capture:{ minimum:1 } } },
    { id:'permission_denied', priority:12, classify:'business_outcome',
      description:'The service operator lacks the sub-account entitlement.',
      when:{ text_present:'not authorized to open sub-accounts' },
      outcome:{ code:'PERMISSION_DENIED', message:'The automation operator is not entitled to open sub-accounts.' } },

    { id:'session_expired', priority:20, classify:'recoverable',
      description:'The back-office session timed out; sign on again and rebuild navigation.',
      when:{ text_present:'Your session has expired' },
      recover:{ do:'reauth', then:'restart', maxTimes:2, waitMs:0 } },
    { id:'system_notice', priority:21, classify:'recoverable',
      description:'An unscheduled maintenance notice interposed itself; acknowledge and carry on.',
      when:{ text_present:'Scheduled maintenance is planned' },
      recover:{ do:'click', target:{
        description:'the Continue button on the System Notice interstitial',
        strategies:[{ kind:'role_name', role:'button', name:'Continue', exact:true }],
        recordedRank:0, guard:{ role:'button', name:'Continue' } },
        then:'continue', maxTimes:3, waitMs:0 } },

    { id:'app_error', priority:5, classify:'hard_failure', errorClass:'surface_error',
      description:'The application returned an unhandled server exception.',
      when:{ text_present:'Unhandled Exception' } },
  ],

  checkpoint: { all: [
    { text_present:'Sub-Account Opened' },
    { value_matches:{ target:L.outAcct, pattern:'^\\d{4}-\\d{6}$' } },
  ] },

  provenance: {
    discoveryRunId:'hand-authored-reference',
    model:'none (hand-authored fixture; ladders derived mechanically from a live walk)',
    recordedAt:new Date().toISOString(),
    evidenceDir:'test/fixtures',
  },
  stats:{ replays:0, successes:0 },
});

writeFileSync('test/fixtures/reference-capability.json', JSON.stringify(cap, null, 2));
console.log('wrote test/fixtures/reference-capability.json  steps=%d signals=%d', cap.steps.length, cap.signals.length);
