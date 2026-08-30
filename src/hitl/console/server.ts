/**
 * The operator console: real remote control of the live session.
 *
 * The mechanism is deliberately not "a button that says resume". The console
 * attaches a CDP session to the SAME page the automation is driving, streams it
 * with Page.startScreencast, and forwards the operator's mouse and keyboard back
 * through Input.dispatchMouseEvent / dispatchKeyEvent. Same BrowserContext, same
 * cookies, same server-side session, same scroll position. Nothing is
 * reconstructed, because reconstruction is where handoffs lose state.
 *
 * Two properties follow from owning the input pipe:
 *
 *   - Enforcement is structural. Input is forwarded only while the broker's lease
 *     says `human`. The operator cannot fight the automation for the mouse,
 *     because before the lease flips there is nowhere for their clicks to go.
 *   - The audit record is a capture, not an inference. Every event the operator
 *     sends passes through this file, so "what did the human do" is answered
 *     exactly -- with keystrokes into password fields redacted at the moment they
 *     arrive rather than scrubbed afterwards.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CDPSession } from 'playwright';
import { WebSurface } from '../../surface/web.js';
import { SessionBroker } from '../broker.js';
import { loadCapability, listCapabilities, runReplay } from '../../run.js';
import type { ReplayResult } from '../../schema/result.js';
import type { Intervention } from '../../schema/intervention.js';

const HERE = dirname(fileURLToPath(import.meta.url));

type ConsoleState = {
  running: boolean;
  controller: 'automation' | 'human';
  intervention: Intervention | null;
  lastResult: ReplayResult | null;
  log: { ts: string; text: string }[];
};

export async function startConsole(opts: { port: number }): Promise<void> {
  const app = express();
  app.use(express.json());
  const http = createServer(app);
  const wss = new WebSocketServer({ server: http, path: '/ws' });

  const broker = new SessionBroker();
  // Headed so the run is also visible on the host machine, but every operator
  // action in this console goes through CDP -- the console works identically
  // against a headless browser on a server, which is the deployment that matters.
  const surface = await WebSurface.launch({ headless: false });
  let cdp: CDPSession | null = null;

  const state: ConsoleState = {
    running: false, controller: 'automation', intervention: null, lastResult: null, log: [],
  };

  const clients = new Set<WebSocket>();
  const broadcast = (msg: unknown): void => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1) c.send(s);
  };
  const log = (text: string): void => {
    const e = { ts: new Date().toISOString(), text };
    state.log.push(e);
    if (state.log.length > 300) state.log.shift();
    broadcast({ type: 'log', ...e });
  };
  const pushState = (): void => {
    state.controller = broker.controller;
    broadcast({ type: 'state', state: { ...state, log: undefined } });
  };

  // ---- live screen

  const startScreencast = async (): Promise<void> => {
    if (cdp) return;
    cdp = await surface.context.newCDPSession(surface.page);
    cdp.on('Page.screencastFrame', async (f) => {
      broadcast({ type: 'frame', data: f.data, metadata: f.metadata });
      await cdp?.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1,
    });
    log('screencast attached to the live session');
  };

  // ---- broker events

  broker.on('intervention', (i: Intervention) => {
    state.intervention = i;
    log(`INTERVENTION ${i.id} (${i.reason}) at step ${i.stepId ?? '-'}: ${i.context.summary}`);
    log('control handed to the operator -- your input is now being forwarded to the live session');
    pushState();
  });
  broker.on('resumed', ({ resumption }: { resumption: { resolution: string; note?: string } }) => {
    log(`control returned to automation: ${resumption.resolution}${resumption.note ? ` (${resumption.note})` : ''}`);
    state.intervention = null;
    pushState();
  });
  broker.on('human_action', (a: { kind: string; detail: string; redacted?: boolean }) => {
    log(`operator ${a.kind}: ${a.redacted ? '(redacted)' : a.detail}`);
  });

  // ---- api

  app.get('/', (_req, res) => res.type('html').send(readFileSync(join(HERE, 'index.html'), 'utf8')));

  app.get('/api/state', (_req, res) => res.json({ ...state, controller: broker.controller }));

  app.get('/api/capabilities', (_req, res) =>
    res.json(listCapabilities().map((c) => ({
      id: c.id, version: c.version, status: c.status, name: c.name,
      inputs: c.inputs.map((i) => ({ name: i.name, example: i.example, enum: i.enum })),
    }))));

  app.post('/api/runs', async (req, res) => {
    if (state.running) { res.status(409).json({ error: 'a run is already in progress' }); return; }
    const { capability, inputs, policy, chaos, target } = req.body ?? {};
    let cap;
    try { cap = loadCapability(String(capability)); }
    catch (e) { res.status(400).json({ error: String((e as Error).message) }); return; }

    if (chaos) {
      await fetch(`${target ?? 'http://localhost:4310'}/_chaos/arm`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: chaos, times: 1 }),
      }).catch(() => {});
      log(`armed target condition: ${chaos}`);
    }

    state.running = true; state.lastResult = null; state.log = [];
    log(`starting ${cap.id}@${cap.version} with ${JSON.stringify(inputs)}`);
    pushState();
    res.json({ started: true });

    await startScreencast();
    // Fire and forget: the HTTP response has already gone, and the operator
    // follows the run over the websocket.
    void runReplay(cap, inputs ?? {}, { policyPath: policy, broker, surface, label: 'operator' })
      .then(({ result }) => {
        state.lastResult = result;
        log(`run finished: ${result.status}` +
          (result.status === 'success' ? ` outputs=${JSON.stringify(result.outputs)}` : '') +
          (result.status === 'failed' ? ` ${result.error.class} at ${result.error.stepId}` : ''));
        log(`evidence: ${result.evidenceDir}`);
      })
      .catch((e) => log(`run crashed: ${String(e?.message)}`))
      .finally(() => { state.running = false; pushState(); });
  });

  app.post('/api/interventions/:id/resolve', (req, res) => {
    const { resolution, note, operator } = req.body ?? {};
    const ok = broker.resume(req.params.id, { resolution, note, operator: operator || 'operator@console' });
    if (!ok) { res.status(404).json({ error: 'no such open intervention' }); return; }
    res.json({ ok: true });
  });

  // ---- input forwarding

  const forwardable = () => broker.controller === 'human' && cdp;

  wss.on('connection', async (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'state', state: { ...state, controller: broker.controller, log: undefined } }));
    for (const e of state.log.slice(-80)) ws.send(JSON.stringify({ type: 'log', ...e }));

    // Chromium's screencast only emits on repaint, so an operator who opens the
    // console while the page is sitting still -- which is exactly the situation
    // during an intervention -- would stare at a blank canvas. Push one frame on
    // connect so the first thing they see is the screen they have to act on.
    if (cdp) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }).catch(() => null);
      if (shot) ws.send(JSON.stringify({ type: 'frame', data: shot.data }));
    }

    ws.on('message', async (raw) => {
      let m: { type: string; [k: string]: unknown };
      try { m = JSON.parse(String(raw)); } catch { return; }

      // The lease is enforced here, structurally: while automation holds it,
      // operator input has nowhere to go.
      if (!forwardable()) {
        if (m.type === 'mouse' || m.type === 'key') {
          ws.send(JSON.stringify({ type: 'log', ts: new Date().toISOString(),
            text: 'ignored: automation currently holds control of this session' }));
        }
        return;
      }

      try {
        if (m.type === 'mouse') {
          const { x, y, action } = m as unknown as { x: number; y: number; action: string };
          if (action === 'click') {
            await cdp!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
            const label = await surface.page.evaluate(([px, py]) => {
              const el = document.elementFromPoint(px as number, py as number) as HTMLElement | null;
              if (!el) return 'nothing';
              const v = (el as HTMLInputElement).value;
              return `${el.tagName.toLowerCase()}${v ? ` "${v}"` : ''}`;
            }, [x, y]).catch(() => 'unknown');
            broker.recordHumanAction({ kind: 'mouse', detail: `click at (${Math.round(x)},${Math.round(y)}) on ${label}` });
          } else if (action === 'move') {
            await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          }
        } else if (m.type === 'key') {
          const { key, text } = m as unknown as { key: string; text?: string };
          // Ask what has focus before recording, so a password is redacted as it
          // is typed rather than scrubbed out of a log afterwards.
          const onSecret = await surface.page
            .evaluate(() => (document.activeElement as HTMLInputElement | null)?.type === 'password')
            .catch(() => false);
          // keyDown carrying `text` ALREADY inserts the character; sending a
          // `char` event as well types everything twice. keyDown without text,
          // then char, then keyUp is the sequence that behaves like a keyboard.
          await cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
          if (text) await cdp!.send('Input.dispatchKeyEvent', { type: 'char', text, key });
          else if (key === 'Backspace' || key === 'Enter' || key === 'Tab') {
            // no char event for these; the keyDown above is the whole story
          }
          await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
          broker.recordHumanAction({
            kind: 'key', detail: onSecret ? '(into a password field)' : (text ?? key), redacted: onSecret,
          });
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'log', ts: new Date().toISOString(), text: `forward failed: ${String((e as Error).message)}` }));
      }
    });

    ws.on('close', () => clients.delete(ws));
  });

  await new Promise<void>((r) => http.listen(opts.port, r));
  console.log(`operator console  http://localhost:${opts.port}`);
  console.log(`  a live browser session is attached and waiting for a run`);
  console.log(`  start one from the console, or POST /api/runs`);
}
