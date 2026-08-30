/**
 * CU-Core Back Office -- a stand-in for the legacy back-office apps this system
 * exists to automate. Server-rendered, frameset shell, no API, no test IDs.
 *
 *   npm run target                        # tenant A on :4310
 *   npm run target -- --tenant=b --port=4311
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { findMember, openSubAccount, MINIMUM_OPENING_DEPOSIT } from './data.js';
import { TENANTS, type TenantConfig } from './tenant.js';
import * as chaos from './chaos.js';
import * as pages from './pages.js';

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const TENANT: TenantConfig = {
  ...(TENANTS[arg('tenant', 'a')] ?? TENANTS.a!),
  productVersion: arg('version', '8.2'),
};
const PORT = Number(arg('port', '4310'));

const OPERATOR = {
  username: process.env.CU_CORE_OPERATOR_USERNAME ?? 'svc.automation',
  password: process.env.CU_CORE_OPERATOR_PASSWORD ?? 'Tr0ubador-Demo-2026',
};

const app = express();
app.use(express.urlencoded({ extended: false }));

// Session-scoped screens must never be cached. Without this, Express's ETag
// makes a re-navigation after a session timeout return 304 and the browser
// re-displays the *authenticated* frameset it still has in cache -- so the
// sign-on screen the server actually wants to show never appears. Real
// back-office apps send no-store on exactly these pages for exactly this reason.
app.set('etag', false);
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// ponytail: a Set of session ids in memory is the whole session store. This app
// exists to be driven, not to be deployed.
const sessions = new Set<string>();
let sessionCounter = 0;

const sid = (req: Request): string | undefined =>
  /cucore_sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];

const authed = (req: Request): boolean => {
  const s = sid(req);
  return !!s && sessions.has(s);
};

const html = (res: Response, body: string, status = 200): void => {
  res.status(status).type('html').send(body);
};

// ---------------------------------------------------------------- chaos control

app.post('/_chaos/arm', express.json(), (req, res) => {
  const { mode, times } = req.body ?? {};
  if (!chaos.CHAOS_MODES.includes(mode)) {
    res.status(400).json({ error: `unknown mode: ${mode}`, modes: chaos.CHAOS_MODES });
    return;
  }
  chaos.arm(mode, times ?? 1);
  res.json({ armed: chaos.state() });
});

app.post('/_chaos/clear', (_req, res) => {
  chaos.clear();
  sessionCounter = 0;
  res.json({ armed: chaos.state() });
});

app.get('/_chaos', (_req, res) => res.json({ armed: chaos.state(), tenant: TENANT.id }));

// ---------------------------------------------------------------- chaos middleware

/** Applies to /content/* only, so the chaos endpoints and login stay reachable. */
app.use('/content', async (req: Request, res: Response, next: NextFunction) => {
  if (chaos.consume('slow')) await new Promise((r) => setTimeout(r, 6000));

  if (chaos.consume('session_timeout')) {
    const s = sid(req);
    if (s) sessions.delete(s);
    html(res, pages.loginPage(TENANT, 'Your session has expired. Please sign on again.'), 200);
    return;
  }

  if (!authed(req)) {
    html(res, pages.loginPage(TENANT, 'Your session has expired. Please sign on again.'), 200);
    return;
  }

  if (chaos.consume('error500')) {
    html(res, pages.errorPage(TENANT,
      'System.NullReferenceException: Object reference not set to an instance of an object.\n' +
      '   at CUCore.Servicing.MemberController.Render(HttpContext ctx)'), 500);
    return;
  }

  if (chaos.consume('interstitial')) {
    html(res, pages.interstitialPage(TENANT, req.originalUrl, 'System Notice',
      'Scheduled maintenance is planned for this weekend. Acknowledge to continue.'));
    return;
  }

  next();
});

// ---------------------------------------------------------------- auth

app.get('/', (req, res) => {
  if (!authed(req)) { html(res, pages.loginPage(TENANT)); return; }
  html(res, pages.frameset(TENANT));
});

app.get('/nav', (req, res) => {
  if (!authed(req)) { html(res, pages.loginPage(TENANT)); return; }
  html(res, pages.navFrame(TENANT));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (username !== OPERATOR.username || password !== OPERATOR.password) {
    html(res, pages.loginPage(TENANT, 'Invalid operator ID or password.'));
    return;
  }
  const s = `s${++sessionCounter}`;
  sessions.add(s);
  res.setHeader('Set-Cookie', `cucore_sid=${s}; Path=/; HttpOnly`);
  // Tenant B interposes a compliance banner -- the kind of per-tenant difference
  // a TenantOverlay has to absorb without re-recording the capability.
  if (TENANT.loginInterstitial) {
    html(res, pages.interstitialPage(TENANT, '/', 'Compliance Notice',
      'Activity in this system is monitored and recorded under 12 CFR 748.'));
    return;
  }
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  const s = sid(req);
  if (s) sessions.delete(s);
  html(res, pages.loginPage(TENANT, 'You have been signed out.'));
});

// ---------------------------------------------------------------- content

app.get('/content/search', (_req, res) => html(res, pages.searchPage(TENANT)));
app.get('/content/reports', (_req, res) => html(res, pages.reportsPage(TENANT)));

app.post('/content/search', (req, res) => {
  const memberId = String(req.body?.memberId ?? '');
  const member = chaos.consume('not_found') ? undefined : findMember(memberId);
  if (!member) { html(res, pages.searchPage(TENANT, memberId)); return; }
  res.redirect(`/content/member/${member.id}`);
});

app.get('/content/member/:id', (req, res) => {
  const m = findMember(req.params.id);
  if (!m) { html(res, pages.searchPage(TENANT, req.params.id)); return; }
  html(res, pages.memberPage(TENANT, m));
});

app.get('/content/member/:id/subaccount/new', (req, res) => {
  const m = findMember(req.params.id);
  if (!m) { html(res, pages.searchPage(TENANT, req.params.id)); return; }
  if (chaos.peek('permission_denied')) { html(res, pages.deniedPage(TENANT), 403); return; }
  html(res, pages.subAccountFormPage(TENANT, m));
});

app.post('/content/member/:id/subaccount/new', (req, res) => {
  const m = findMember(req.params.id);
  if (!m) { html(res, pages.searchPage(TENANT, req.params.id)); return; }

  const accountType = String(req.body?.accountType ?? '');
  const openingDeposit = String(req.body?.openingDeposit ?? '');
  const fundingAccount = String(req.body?.fundingAccount ?? '');
  const notes = String(req.body?.notes ?? '');

  const amount = Number(openingDeposit.replace(/[$,\s]/g, ''));
  const forced = chaos.consume('validation');
  if (forced || !Number.isFinite(amount) || amount < MINIMUM_OPENING_DEPOSIT) {
    html(res, pages.subAccountFormPage(TENANT, m,
      `Opening deposit must be at least $${MINIMUM_OPENING_DEPOSIT}.00 for this product.`,
      { accountType, openingDeposit, notes }));
    return;
  }
  if (chaos.consume('supervisor_override')) {
    html(res, pages.supervisorOverridePage(TENANT, m, { accountType, openingDeposit, fundingAccount, notes }));
    return;
  }
  html(res, pages.reviewPage(TENANT, m, { accountType, openingDeposit, fundingAccount, notes }));
});

/** Today's code is on the branch supervisor's whiteboard, obviously. */
const OVERRIDE_CODE = 'OVR-7781';

app.post('/content/member/:id/subaccount/override', (req, res) => {
  const m = findMember(req.params.id);
  if (!m) { html(res, pages.searchPage(TENANT, req.params.id)); return; }
  const d = {
    accountType: String(req.body?.accountType ?? ''),
    openingDeposit: String(req.body?.openingDeposit ?? ''),
    fundingAccount: String(req.body?.fundingAccount ?? ''),
    notes: String(req.body?.notes ?? ''),
  };
  if (String(req.body?.override ?? '').trim() !== OVERRIDE_CODE) {
    html(res, pages.supervisorOverridePage(TENANT, m, d));
    return;
  }
  html(res, pages.reviewPage(TENANT, m, d));
});

app.post('/content/member/:id/subaccount/confirm', (req, res) => {
  const m = findMember(req.params.id);
  if (!m) { html(res, pages.searchPage(TENANT, req.params.id)); return; }
  if (chaos.peek('permission_denied')) { html(res, pages.deniedPage(TENANT), 403); return; }
  const accountType = String(req.body?.accountType ?? '');
  const record = openSubAccount(m.id, accountType);
  html(res, pages.confirmationPage(TENANT, m, record, accountType));
});

app.use((_req, res) => html(res, pages.errorPage(TENANT, 'HTTP 404: The resource cannot be found.'), 404));

app.listen(PORT, () => {
  console.log(`CU-Core Back Office ${TENANT.productVersion} (${TENANT.institution}, tenant=${TENANT.id}) on http://localhost:${PORT}`);
  console.log(`  operator: ${OPERATOR.username} / ${'*'.repeat(OPERATOR.password.length)}`);
  console.log(`  chaos:    POST /_chaos/arm {"mode":"not_found"}  |  modes: ${chaos.CHAOS_MODES.join(', ')}`);
});
