/**
 * The web surface: Playwright driving a real Chromium.
 *
 * Perception is the accessibility tree (`ariaSnapshot({ mode: 'ai' })`), not the
 * DOM. That choice is the reason this design has anything to say about legacy
 * apps and desktop apps: the AX tree gives role, accessible name, state and
 * geometry for a frameset-and-table-soup page just as readily as for a modern
 * one, and the same four facts are what OS accessibility APIs expose.
 *
 * Two findings from building against a real frameset shaped this file:
 *
 *  1. `ariaSnapshot({ mode:'ai' })` descends into frames and issues frame-scoped
 *     refs (f3e15), and `page.locator('aria-ref=f3e15')` resolves them back
 *     across the frame boundary. Frameset support is therefore free.
 *
 *  2. `page.waitForLoadState()` does NOT wait for a child frame's navigation --
 *     verified: the frame URLs were unchanged after a form submit inside a
 *     frame. So this surface exposes no wait primitive at all. Waiting is done
 *     upstream by polling declarative Conditions against fresh observations,
 *     which works through framesets and ports to surfaces that have no notion
 *     of "page load" whatsoever.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Action, AxNode, EnvironmentReport, EnvironmentSpec, Observation, RecordedElement, Surface } from './types.js';

/**
 * What a recording is made in unless an artifact says otherwise.
 *
 * A fixed viewport is not cosmetic: bounding boxes, which controls are visible at
 * all under a responsive layout, and anything resolved by coordinates all move
 * with it. Locale is not cosmetic either -- browser-rendered controls carry
 * locale-dependent accessible names ("Choose File"), so a role+name locator
 * recorded in en-US can simply stop matching in another locale. And a fixed
 * timezone keeps date-shaped outputs from drifting by a day depending on where
 * the runner happens to be.
 */
export const DEFAULT_ENVIRONMENT: Required<EnvironmentSpec> = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'light',
};

/** `- textbox "Member No." [ref=f3e15] [box=1,2,3,4]: some text` */
const LINE = /^(\s*)-\s+(.*)$/;
const ATTR = /^\s*\[([a-zA-Z]+)(?:=([^\]]*))?\]/;

export function parseAriaSnapshot(yaml: string): AxNode[] {
  const nodes: AxNode[] = [];
  const stack: { indent: number; node: AxNode }[] = [];
  let index = 0;

  for (const raw of yaml.split('\n')) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const indent = m[1]!.length;
    let rest = m[2]!;

    // `- /url: /content/search` is a property of the enclosing node, not a node.
    if (rest.startsWith('/')) {
      const pm = /^\/([a-zA-Z]+):\s*(.*)$/.exec(rest);
      const owner = [...stack].reverse().find((s) => s.indent < indent)?.node;
      if (pm && owner) owner.props[pm[1]!] = pm[2]!;
      continue;
    }

    const roleM = /^([a-zA-Z][\w-]*)/.exec(rest);
    if (!roleM) continue;
    const role = roleM[1]!;
    rest = rest.slice(roleM[0].length);

    let name = '';
    const nameM = /^\s+"((?:[^"\\]|\\.)*)"/.exec(rest);
    if (nameM) {
      name = nameM[1]!.replace(/\\(.)/g, '$1');
      rest = rest.slice(nameM[0].length);
    }

    const props: Record<string, string> = {};
    let am: RegExpExecArray | null;
    while ((am = ATTR.exec(rest))) {
      props[am[1]!] = am[2] ?? 'true';
      rest = rest.slice(am[0].length);
    }

    const text = rest.startsWith(':') ? rest.slice(1).trim() : undefined;

    let box: AxNode['box'];
    if (props.box) {
      const [x, y, w, h] = props.box.split(',').map(Number);
      if ([x, y, w, h].every((n) => Number.isFinite(n))) box = { x: x!, y: y!, w: w!, h: h! };
    }

    const ref = props.ref ?? '';
    const node: AxNode = {
      ref, role, name, text, props, box,
      frame: /^(f\d+)/.exec(ref)?.[1] ?? 'f1',
      frameOrdinal: 0, // assigned below, once the encounter order is known
      depth: indent / 2,
      index: index++,
    };
    if (text) node.text = text;

    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    stack.push({ indent, node });
    nodes.push(node);
  }
  return nodes;
}

export class WebSurface implements Surface {
  private constructor(
    private browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
  ) {}

  private last: Observation | null = null;

  static async launch(opts: { headless?: boolean; environment?: EnvironmentSpec } = {}): Promise<WebSurface> {
    const env = { ...DEFAULT_ENVIRONMENT, ...(opts.environment ?? {}) };
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const context = await browser.newContext({
      viewport: env.viewport,
      deviceScaleFactor: env.deviceScaleFactor,
      locale: env.locale,
      timezoneId: env.timezoneId,
      colorScheme: env.colorScheme,
    });
    const page = await context.newPage();
    const surface = new WebSurface(browser, context, page);
    surface.env = env;
    return surface;
  }

  private env: Required<EnvironmentSpec> = DEFAULT_ENVIRONMENT;

  async environment(): Promise<EnvironmentReport> {
    return {
      ...this.env,
      browser: { name: this.browser.browserType().name(), version: this.browser.version() },
      userAgent: await this.page.evaluate(() => navigator.userAgent).catch(() => undefined),
    };
  }

  async observe(): Promise<Observation> {
    const yaml = await this.page.ariaSnapshot({ mode: 'ai', boxes: true });
    const nodes = parseAriaSnapshot(yaml);

    // The fN in a ref is a counter over every frame the page has ever had, not
    // an index into page.frames(): after navigating away from a frameset that
    // used f1..f3, the fresh single-frame document is f4. So map by ENCOUNTER
    // ORDER instead -- the snapshot walks the frame tree in the same order
    // page.frames() reports it, main frame first.
    const frames = this.page.frames();
    const frameOrder: string[] = [];
    for (const n of nodes) if (!frameOrder.includes(n.frame)) frameOrder.push(n.frame);

    const frameUrls: Record<string, string> = {};
    const frameNames: Record<string, string> = {};
    frameOrder.forEach((id, i) => {
      frameUrls[id] = frames[i]?.url() ?? '';
      frameNames[id] = frames[i]?.name() ?? '';
    });
    for (const n of nodes) n.frameOrdinal = Math.max(0, frameOrder.indexOf(n.frame));

    // Text comes from the frames rather than from the snapshot, because
    // text_present has to see error banners and inline validation copy that the
    // AX tree may fold into a generic node.
    //
    // evaluate() rather than locator('body').innerText(): a <frameset> document
    // has no <body> at all, so the locator form waits out its full timeout on
    // every single observation. That one line cost ~2s per observe and ~6s per
    // step before it was found.
    const texts = await Promise.all(
      frames.map((f) =>
        f.evaluate(() => (document.body ? (document.body as HTMLElement).innerText : '')).catch(() => ''),
      ),
    );

    const obs: Observation = {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      nodes,
      text: texts.join('\n'),
      frameUrls,
      frameNames,
      frameOrder,
      viewport: { w: this.env.viewport.width, h: this.env.viewport.height },
      at: new Date().toISOString(),
    };
    this.last = obs;
    return obs;
  }

  private loc(ref: string) {
    return this.page.locator(`aria-ref=${ref}`);
  }

  async act(action: Action): Promise<void> {
    switch (action.kind) {
      case 'navigate':
        await this.page.goto(action.url, { waitUntil: 'domcontentloaded' });
        return;
      case 'click':
        try {
          await this.loc(action.ref).click({ timeout: 5000 });
        } catch (e) {
          // A submit button that navigates tears its own element out of the DOM
          // mid-click. Playwright reports that as "element was detached", but the
          // click DID land -- the navigation is the proof. Only swallow this
          // specific case, and only when the page really did move on.
          const msg = String((e as Error).message);
          if (!/detached|Execution context was destroyed|Target closed/i.test(msg)) throw e;
        }
        return;
      case 'type':
        await this.loc(action.ref).fill(action.value, { timeout: 5000 });
        return;
      case 'select':
        await this.loc(action.ref).selectOption(action.value, { timeout: 5000 });
        return;
      case 'press':
        if (action.ref) await this.loc(action.ref).press(action.key, { timeout: 5000 });
        else await this.page.keyboard.press(action.key);
        return;
    }
  }

  async read(ref: string, mode: 'text' | 'value' | 'attr', attr?: string): Promise<string | null> {
    const l = this.loc(ref);
    if (mode === 'attr') return attr ? l.getAttribute(attr, { timeout: 5000 }) : null;
    if (mode === 'value') return l.inputValue({ timeout: 5000 }).catch(() => null);
    return (await l.innerText({ timeout: 5000 }).catch(() => null))?.trim() ?? null;
  }

  async describe(ref: string): Promise<RecordedElement> {
    const dom = await this.loc(ref).evaluate((el: Element) => {
      const attrs: Record<string, string> = {};
      for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;

      // Short, readable CSS path. Deliberately NOT a full nth-child chain from
      // <html>: a path that long is guaranteed to break, and it fails slowly and
      // confusingly, which is worse than not having the fallback at all.
      // (Written as one flat loop with no inner helper -- named function
      // expressions inside page.evaluate get an esbuild __name shim that does
      // not exist in the page.)
      const parts: string[] = [];
      let n: Element | null = el;
      for (let i = 0; n && i < 4; n = n.parentElement, i++) {
        const tag = n.tagName.toLowerCase();
        const nid = (n as HTMLElement).id;
        const nm = n.getAttribute('name');
        let segment: string;
        if (nid && !/\d{4,}/.test(nid)) segment = tag + '#' + CSS.escape(nid);
        else if (nm) segment = tag + '[name="' + nm + '"]';
        else {
          const sibs = n.parentElement
            ? Array.from(n.parentElement.children).filter((c) => c.tagName === n!.tagName)
            : [];
          segment = sibs.length > 1 ? tag + ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')' : tag;
        }
        parts.unshift(segment);
      }

      return {
        tag: el.tagName.toLowerCase(),
        id: (el as HTMLElement).id ?? '',
        attrs,
        cssPath: parts.join(' > '),
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    });

    const obs = this.last ?? (await this.observe());
    const node = obs.nodes.find((n) => n.ref === ref);

    // The anchor: the nearest preceding node in reading order that carries text a
    // human would read as this control's caption. This is what makes an
    // unlabelled field in a layout table addressable at all.
    let anchorText = '';
    let anchorOrdinal = 0;
    if (node) {
      // Walk backwards in reading order for the caption a human would read as
      // labelling this control -- but skip the node's own ANCESTORS. A layout
      // table wraps the field in a <td> that often carries its own text ("min
      // $25.00" sitting next to the input), and anchoring to the container
      // instead of the caption beside it produces a locator that looks right and
      // is subtly wrong. Ancestors are the nodes shallower than anything seen so
      // far on the way back.
      let minDepth = node.depth;
      for (let i = node.index - 1; i >= 0; i--) {
        const c = obs.nodes[i]!;
        if (c.frame !== node.frame) break;
        if (c.depth < minDepth) { minDepth = c.depth; continue; }
        const caption = (c.name || c.text || '').trim();
        if (caption && caption.length <= 60) {
          anchorText = caption;
          anchorOrdinal = obs.nodes.filter(
            (n) => n.frame === node.frame && n.index > c.index && n.index < node.index && n.role === node.role,
          ).length;
          break;
        }
      }
    }

    return {
      ref,
      role: node?.role ?? '',
      name: node?.name ?? '',
      tag: dom.tag,
      id: dom.id,
      attrs: dom.attrs,
      anchorText,
      anchorOrdinal,
      cssPath: dom.cssPath,
      frame: node?.frame ?? 'f1',
      frameOrdinal: node?.frameOrdinal ?? 0,
      box: node?.box,
      viewport: dom.viewport,
    };
  }

  /**
   * Resolve id-pattern / CSS candidates back into accessibility refs.
   *
   * Rather than introducing a second handle namespace, we find candidates in the
   * DOM, take their bounding boxes, and match those against the AX nodes we
   * already observed. One ref namespace means the guard check runs identically
   * for all eight ladder rungs instead of being skipped for the two DOM ones.
   */
  async queryNative(kind: 'id_pattern' | 'css', value: string, frame?: string): Promise<string[]> {
    const obs = this.last ?? (await this.observe());
    const boxes: { x: number; y: number; w: number; h: number }[] = [];

    for (const f of this.page.frames()) {
      const found = await f
        .evaluate(
          ({ kind, value }) => {
            const els =
              kind === 'css'
                ? Array.from(document.querySelectorAll(value))
                : Array.from(document.querySelectorAll('[id]')).filter((e) =>
                    new RegExp(value).test((e as HTMLElement).id),
                  );
            return els.map((e) => {
              const r = e.getBoundingClientRect();
              return { x: r.x, y: r.y, w: r.width, h: r.height };
            });
          },
          { kind, value },
        )
        .catch(() => [] as typeof boxes);
      boxes.push(...found);
    }

    const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
    return obs.nodes
      .filter((n) => n.box && (!frame || n.frame === frame))
      .filter((n) =>
        boxes.some((b) => near(b.x, n.box!.x) && near(b.y, n.box!.y) && near(b.w, n.box!.w) && near(b.h, n.box!.h)),
      )
      .map((n) => n.ref);
  }

  async screenshot(maskRefs: string[] = []): Promise<Buffer> {
    // Playwright paints the mask boxes during capture, so the sensitive pixels
    // never exist in the returned buffer -- there is no unredacted image to leak.
    // Password inputs are masked unconditionally, on top of whatever the caller
    // asked for, because forgetting to pass one is a one-line mistake with a
    // regulatory consequence.
    const masks = [
      this.page.locator('input[type=password]'),
      ...maskRefs.map((r) => this.loc(r)),
    ];
    return this.page.screenshot({ mask: masks, maskColor: '#101010', timeout: 10_000 });
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}
