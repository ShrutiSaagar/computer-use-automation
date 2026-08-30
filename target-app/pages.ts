/**
 * Deliberately hostile server-rendered markup: a frameset shell, nested tables
 * for layout, <font> tags, ASP.NET-style generated ids, and zero test IDs.
 *
 * Label association is MIXED on purpose, because real legacy apps are mixed, and
 * because it forces different rungs of the locator ladder to win on different
 * steps:
 *
 *   login fields        <label for=...>        -> accessible name exists -> role_name (rank 0)
 *   member search       no label, table cell   -> accessible name EMPTY  -> anchor    (rank 3)
 *   account type        <label for=...>        -> role_name
 *   opening deposit     no label + ROTATING id -> anchor only; id_pattern is a trap
 *   notes               placeholder only       -> placeholder             (rank 2)
 *   submit buttons      <input value=...>      -> role_name
 *
 * If every field had a clean label this project would prove nothing.
 */
import type { Member } from './data.js';
import { MINIMUM_OPENING_DEPOSIT, SUB_ACCOUNT_TYPES } from './data.js';
import type { TenantConfig } from './tenant.js';

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const money = (n: number): string => `$${n.toFixed(2)}`;

/** ASP.NET WebForms-style id. The kind of thing a CSS selector pins to and regrets. */
const ctl = (name: string): string => `ctl00_ContentPlaceHolder1_${name}`;

/**
 * A control whose id is regenerated on every render -- some legacy grids really
 * do this. Any artifact that pinned to the id would break on the second replay;
 * the ladder has to fall through to a structural strategy.
 */
const rotatingId = (name: string): string =>
  `ctl00_dyn${Math.random().toString(36).slice(2, 8)}_${name}`;

function chrome(t: TenantConfig, title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><title>${esc(t.institution)} - ${esc(title)}</title>
<style>
 body { font-family: Verdana, Geneva, sans-serif; font-size: 11px; background: #f4f4ef; margin: 0; }
 table { border-collapse: collapse; }
 .hdr { background: ${t.accent}; color: #fff; padding: 6px 10px; font-weight: bold; font-size: 12px; }
 .panel { border: 1px solid #b9b9ad; background: #fff; margin: 8px; }
 .paneltitle { background: #e2e2d8; border-bottom: 1px solid #b9b9ad; padding: 4px 8px; font-weight: bold; }
 .fld { padding: 3px 6px; }
 .err { color: #a10000; font-weight: bold; padding: 6px; border: 1px solid #a10000; background: #ffecec; margin: 8px; }
 input[type=text], input[type=password], select { font-family: Verdana; font-size: 11px; border: 1px solid #7f9db9; }
 input[type=submit] { font-family: Verdana; font-size: 11px; }
</style></head>
<body>
<div class="hdr">${esc(t.institution)} &nbsp;&#8212;&nbsp; CU-Core Back Office ${esc(t.productVersion ?? '8.2')}</div>
${body}
</body></html>`;
}

export function frameset(t: TenantConfig): string {
  // No <body>: a real frameset document. The address bar stops changing after
  // this point, which is exactly why url-based checkpoints are not enough.
  return `<!DOCTYPE html>
<html><head><title>${esc(t.institution)} - CU-Core Back Office</title></head>
<frameset cols="170,*" border="1">
  <frame name="navFrame" src="/nav" />
  <frame name="mainFrame" src="/content/search" />
</frameset></html>`;
}

export function navFrame(t: TenantConfig): string {
  return chrome(t, 'Menu', `
<table width="100%" cellpadding="3" cellspacing="0">
 <tr><td class="paneltitle">Servicing</td></tr>
 <tr><td><font size="1"><a href="/content/search" target="mainFrame">Member Search</a></font></td></tr>
 <tr><td><font size="1"><a href="/content/reports" target="mainFrame">Reports</a></font></td></tr>
 <tr><td><font size="1"><a href="/logout" target="_top">Sign Out</a></font></td></tr>
</table>`);
}

export function loginPage(t: TenantConfig, error?: string): string {
  return chrome(t, 'Sign On', `
${error ? `<div class="err">${esc(error)}</div>` : ''}
<div class="panel" style="width:380px">
  <div class="paneltitle">Operator Sign On</div>
  <form method="post" action="/login">
  <table cellpadding="4" cellspacing="0">
    <tr>
      <td class="fld"><label for="${ctl('txtUser')}"><font size="1">Operator ID</font></label></td>
      <td class="fld"><input type="text" name="username" id="${ctl('txtUser')}" size="24" /></td>
    </tr>
    <tr>
      <td class="fld"><label for="${ctl('txtPwd')}"><font size="1">Password</font></label></td>
      <td class="fld"><input type="password" name="password" id="${ctl('txtPwd')}" size="24" /></td>
    </tr>
    <tr><td colspan="2" class="fld"><input type="submit" value="Sign On" id="${ctl('btnSignOn')}" /></td></tr>
  </table>
  </form>
</div>`);
}

export function interstitialPage(t: TenantConfig, returnTo: string, heading: string, body: string): string {
  return chrome(t, heading, `
<div class="panel" style="width:520px">
  <div class="paneltitle">${esc(heading)}</div>
  <table cellpadding="8"><tr><td><font size="1">${esc(body)}</font></td></tr>
  <tr><td>
    <form method="get" action="${esc(returnTo)}"><input type="submit" value="Continue" /></form>
  </td></tr></table>
</div>`);
}

export function searchPage(t: TenantConfig, notFoundFor?: string): string {
  // NOTE: no <label for>. The field's accessible name is empty; the only thing
  // that identifies it is the text in the table cell to its left.
  return chrome(t, 'Member Search', `
${notFoundFor ? `<div class="err">No member matching "${esc(notFoundFor)}" was found.</div>` : ''}
<div class="panel" style="width:460px">
  <div class="paneltitle">Member Search</div>
  <form method="post" action="/content/search">
  <table cellpadding="4" cellspacing="0"><tr><td>
    <table cellpadding="2" cellspacing="0">
      <tr>
        <td class="fld" align="right"><font size="1">${esc(t.labels.memberIdField)}</font></td>
        <td class="fld"><input type="text" name="memberId" id="${ctl('txtMbrNo')}" size="14" /></td>
        <td class="fld"><input type="submit" value="${esc(t.labels.searchButton)}" id="${ctl('btnSearch')}" /></td>
      </tr>
    </table>
  </td></tr></table>
  </form>
</div>`);
}

export function memberPage(t: TenantConfig, m: Member): string {
  const rows = m.accounts.map((a) => `
      <tr>
        <td class="fld"><font size="1">${esc(a.number)}</font></td>
        <td class="fld"><font size="1">${esc(a.type)}</font></td>
        <td class="fld" align="right"><font size="1">${esc(money(a.balance))}</font></td>
        <td class="fld"><font size="1">${esc(a.opened)}</font></td>
      </tr>`).join('');
  return chrome(t, 'Member Detail', `
<div class="panel">
  <div class="paneltitle">Member Detail</div>
  <table cellpadding="4" cellspacing="0"><tr><td>
    <table cellpadding="2" cellspacing="0">
      <tr><td align="right"><font size="1">${esc(t.labels.memberIdField)}</font></td>
          <td><font size="1"><b>${esc(m.id)}</b></font></td>
          <td align="right"><font size="1">Status</font></td>
          <td><font size="1"><b>${esc(m.status)}</b></font></td></tr>
      <tr><td align="right"><font size="1">Name</font></td>
          <td><font size="1"><b>${esc(m.name)}</b></font></td>
          <td align="right"><font size="1">Branch</font></td>
          <td><font size="1">${esc(m.branch)}</font></td></tr>
      <tr><td align="right"><font size="1">Member Since</font></td>
          <td><font size="1">${esc(m.since)}</font></td></tr>
    </table>
  </td></tr></table>
</div>
<div class="panel">
  <div class="paneltitle">Accounts</div>
  <table cellpadding="4" cellspacing="0" width="100%">
    <tr bgcolor="#e2e2d8">
      <td><font size="1"><b>Account</b></font></td><td><font size="1"><b>Type</b></font></td>
      <td align="right"><font size="1"><b>Balance</b></font></td><td><font size="1"><b>Opened</b></font></td>
    </tr>${rows}
  </table>
  <table cellpadding="6"><tr><td>
    <form method="get" action="/content/member/${esc(m.id)}/subaccount/new">
      <input type="submit" value="${esc(t.labels.newSubAccount)}" id="${ctl('btnNewSub')}" />
    </form>
  </td></tr></table>
</div>`);
}

export function subAccountFormPage(
  t: TenantConfig, m: Member, error?: string,
  prior?: { accountType?: string; openingDeposit?: string; notes?: string },
): string {
  const opts = SUB_ACCOUNT_TYPES.map(
    (o) => `<option value="${esc(o)}"${prior?.accountType === o ? ' selected' : ''}>${esc(o)}</option>`,
  ).join('');
  const fundingOpts = m.accounts.map(
    (a) => `<option value="${esc(a.number)}">${esc(a.number)} (${esc(a.type)})</option>`,
  ).join('');
  return chrome(t, 'New Sub-Account', `
${error ? `<div class="err">${esc(error)}</div>` : ''}
<div class="panel" style="width:560px">
  <div class="paneltitle">${esc(t.labels.newSubAccount)} &#8212; Member ${esc(m.id)}</div>
  <form method="post" action="/content/member/${esc(m.id)}/subaccount/new">
  <table cellpadding="4" cellspacing="0"><tr><td>
    <table cellpadding="3" cellspacing="0">
      <tr>
        <td class="fld" align="right">
          <label for="${ctl('ddlType')}"><font size="1">${esc(t.labels.accountType)}</font></label>
        </td>
        <td class="fld">
          <select name="accountType" id="${ctl('ddlType')}">${opts}</select>
        </td>
      </tr>
      <tr>
        <!-- no <label for>, and the id is regenerated on every render -->
        <td class="fld" align="right"><font size="1">${esc(t.labels.openingDeposit)}</font></td>
        <td class="fld">
          <input type="text" name="openingDeposit" id="${rotatingId('txtDeposit')}" size="12"
                 value="${esc(prior?.openingDeposit ?? '')}" />
          <font size="1" color="#666">&nbsp;min ${esc(money(MINIMUM_OPENING_DEPOSIT))}</font>
        </td>
      </tr>
      <tr>
        <td class="fld" align="right"><font size="1">Funding Account</font></td>
        <td class="fld"><select name="fundingAccount" id="${ctl('ddlFunding')}">${fundingOpts}</select></td>
      </tr>
      <tr>
        <td class="fld" align="right"><font size="1">Notes</font></td>
        <td class="fld">
          <input type="text" name="notes" size="34" placeholder="Optional notes"
                 value="${esc(prior?.notes ?? '')}" />
        </td>
      </tr>
      <tr><td colspan="2" class="fld">
        <input type="submit" value="${esc(t.labels.submitReview)}" id="${ctl('btnContinue')}" />
      </td></tr>
    </table>
  </td></tr></table>
  </form>
</div>`);
}

export function reviewPage(
  t: TenantConfig, m: Member,
  d: { accountType: string; openingDeposit: string; fundingAccount: string; notes: string },
): string {
  return chrome(t, 'Review', `
<div class="panel" style="width:560px">
  <div class="paneltitle">Review Sub-Account Request</div>
  <table cellpadding="4" cellspacing="0"><tr><td>
    <table cellpadding="3" cellspacing="0">
      <tr><td align="right"><font size="1">Member</font></td><td><font size="1"><b>${esc(m.id)} ${esc(m.name)}</b></font></td></tr>
      <tr><td align="right"><font size="1">${esc(t.labels.accountType)}</font></td><td><font size="1"><b>${esc(d.accountType)}</b></font></td></tr>
      <tr><td align="right"><font size="1">${esc(t.labels.openingDeposit)}</font></td><td><font size="1"><b>${esc(money(Number(d.openingDeposit)))}</b></font></td></tr>
      <tr><td align="right"><font size="1">Funding Account</font></td><td><font size="1">${esc(d.fundingAccount)}</font></td></tr>
      <tr><td align="right"><font size="1">Notes</font></td><td><font size="1">${esc(d.notes || '(none)')}</font></td></tr>
    </table>
  </td></tr></table>
  <table cellpadding="6"><tr><td>
    <form method="post" action="/content/member/${esc(m.id)}/subaccount/confirm">
      <input type="hidden" name="accountType" value="${esc(d.accountType)}" />
      <input type="hidden" name="openingDeposit" value="${esc(d.openingDeposit)}" />
      <input type="hidden" name="fundingAccount" value="${esc(d.fundingAccount)}" />
      <input type="hidden" name="notes" value="${esc(d.notes)}" />
      <input type="submit" value="${esc(t.labels.confirmOpen)}" id="${ctl('btnConfirm')}" />
    </form>
  </td></tr></table>
  <table cellpadding="6"><tr><td><font size="1" color="#666">
    This posts the account opening to the core. It cannot be undone from this screen.
  </font></td></tr></table>
</div>`);
}

export function confirmationPage(
  t: TenantConfig, m: Member,
  r: { number: string; confirmation: string; effective: string }, accountType: string,
): string {
  return chrome(t, 'Sub-Account Opened', `
<div class="panel" style="width:560px">
  <div class="paneltitle">Sub-Account Opened</div>
  <table cellpadding="4" cellspacing="0"><tr><td>
    <table cellpadding="3" cellspacing="0">
      <tr><td align="right"><font size="1">New Account Number</font></td>
          <td><font size="1"><b>${esc(r.number)}</b></font></td></tr>
      <tr><td align="right"><font size="1">Confirmation</font></td>
          <td><font size="1"><b>${esc(r.confirmation)}</b></font></td></tr>
      <tr><td align="right"><font size="1">Effective Date</font></td>
          <td><font size="1"><b>${esc(r.effective)}</b></font></td></tr>
      <tr><td align="right"><font size="1">${esc(t.labels.accountType)}</font></td>
          <td><font size="1">${esc(accountType)}</font></td></tr>
      <tr><td align="right"><font size="1">Member</font></td>
          <td><font size="1">${esc(m.id)} ${esc(m.name)}</font></td></tr>
    </table>
  </td></tr></table>
</div>`);
}

export function supervisorOverridePage(
  t: TenantConfig, m: Member,
  d: { accountType: string; openingDeposit: string; fundingAccount: string; notes: string },
): string {
  return chrome(t, 'Supervisor Override', `
<div class="panel" style="width:560px">
  <div class="paneltitle">Supervisor Override Required</div>
  <form method="post" action="/content/member/${esc(m.id)}/subaccount/override">
  <table cellpadding="6"><tr><td><font size="1">
    This product requires a supervisor override code before the request can be reviewed.<br/>
    Contact your branch supervisor for today's code.
  </font></td></tr>
  <tr><td>
    <table cellpadding="3"><tr>
      <td align="right"><font size="1">Override Code</font></td>
      <td><input type="text" name="override" size="16" /></td>
      <td><input type="submit" value="Apply Override" /></td>
    </tr></table>
  </td></tr></table>
  <input type="hidden" name="accountType" value="${esc(d.accountType)}" />
  <input type="hidden" name="openingDeposit" value="${esc(d.openingDeposit)}" />
  <input type="hidden" name="fundingAccount" value="${esc(d.fundingAccount)}" />
  <input type="hidden" name="notes" value="${esc(d.notes)}" />
  </form>
</div>`);
}

export function errorPage(t: TenantConfig, detail: string): string {
  return chrome(t, 'Error', `
<div class="err">Server Error in '/CUCore' Application.</div>
<div class="panel"><div class="paneltitle">Unhandled Exception</div>
<table cellpadding="8"><tr><td><pre style="font-size:11px">${esc(detail)}</pre></td></tr></table></div>`);
}

export function deniedPage(t: TenantConfig): string {
  return chrome(t, 'Not Authorized', `
<div class="err">You are not authorized to open sub-accounts. Contact your security administrator.</div>`);
}

export function reportsPage(t: TenantConfig): string {
  return chrome(t, 'Reports', `
<div class="panel"><div class="paneltitle">Reports</div>
<table cellpadding="8"><tr><td><font size="1">No reports are available in this environment.</font></td></tr></table></div>`);
}
