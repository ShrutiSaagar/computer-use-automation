/** A Surface backed by a fixed node list, so locator and condition logic can be
 *  tested without a browser. The point of the surface seam is that this is
 *  possible at all. */
import type { Action, AxNode, EnvironmentReport, Observation, RecordedElement, Surface } from '../src/surface/types.js';

export function node(p: Partial<AxNode> & { role: string }): AxNode {
  return {
    ref: p.ref ?? `e${Math.random().toString(36).slice(2, 6)}`,
    role: p.role, name: p.name ?? '', text: p.text, props: p.props ?? {},
    box: p.box, frame: p.frame ?? 'f1', frameOrdinal: p.frameOrdinal ?? 0,
    depth: p.depth ?? 1, index: p.index ?? 0,
  };
}

export function observation(nodes: AxNode[], over: Partial<Observation> = {}): Observation {
  nodes.forEach((n, i) => { n.index = n.index || i; });
  return {
    url: 'http://localhost:4310/', title: 't', nodes,
    text: nodes.map((n) => `${n.name} ${n.text ?? ''}`).join(' '),
    frameUrls: { f1: 'http://localhost:4310/' }, frameNames: { f1: '' }, frameOrder: ['f1'],
    viewport: { w: 1280, h: 800 },
    at: new Date().toISOString(), ...over,
  };
}

export class FakeSurface implements Surface {
  constructor(private obs: Observation, private native: Record<string, string[]> = {}) {}
  acted: Action[] = [];
  async observe(): Promise<Observation> { return this.obs; }
  async act(a: Action): Promise<void> { this.acted.push(a); }
  async read(ref: string): Promise<string | null> {
    return this.obs.nodes.find((n) => n.ref === ref)?.name ?? null;
  }
  async describe(): Promise<RecordedElement> { throw new Error('not needed'); }
  async queryNative(kind: string, value: string): Promise<string[]> { return this.native[`${kind}:${value}`] ?? []; }
  async screenshot(): Promise<Buffer> { return Buffer.alloc(0); }
  async environment(): Promise<EnvironmentReport> {
    return { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light' };
  }
  async close(): Promise<void> {}
}

export function recorded(p: Partial<RecordedElement> & { role: string }): RecordedElement {
  return {
    ref: 'e1', role: p.role, name: p.name ?? '', tag: p.tag ?? 'input', id: p.id ?? '',
    attrs: p.attrs ?? {}, anchorText: p.anchorText ?? '', anchorOrdinal: p.anchorOrdinal ?? 0,
    cssPath: p.cssPath ?? 'input', frame: p.frame ?? 'f1', frameOrdinal: p.frameOrdinal ?? 0,
    box: p.box ?? { x: 10, y: 20, w: 100, h: 20 }, viewport: p.viewport ?? { w: 1280, h: 800 },
  };
}
