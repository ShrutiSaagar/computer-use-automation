/**
 * A desktop surface, stubbed at the seam.
 *
 * NOT IMPLEMENTED, and deliberately so -- but written out rather than described,
 * because the claim "our design extends to desktop apps" is only worth anything
 * if you can see exactly how much would have to change. The answer is: this file,
 * and nothing above it.
 *
 * The reason it is this small is the choice made in `web.ts`: perception is the
 * accessibility tree, not the DOM. A macOS AXUIElement and a Windows UIAutomation
 * element expose the same four facts an AX node in a browser does -- role,
 * accessible name, state, and screen geometry. So `AxNode` needs no new fields,
 * and consequently:
 *
 *   - the artifact schema does not change;
 *   - the locator ladder does not change. Six of its eight rungs (role_name,
 *     label, attr_text, anchor, text, coords) are resolved purely from AxNode[]
 *     by surface-agnostic code in replay/locator.ts, and all six work here;
 *   - conditions do not change, because they are polled against observations
 *     rather than delegated to any browser notion of "page load";
 *   - the replay engine, the signal model, the guardrails, the redactor and the
 *     control-lease handoff do not change at all.
 *
 * Two rungs degrade, and the schema already expects that: `id_pattern` and `css`
 * are DOM concepts, so `queryNative` returns nothing and the ladder falls through
 * them. On a surface with no DOM, `coords` -- last resort on the web -- becomes
 * the pragmatic bottom of the ladder, which is why it was kept in the schema and
 * gated by policy rather than deleted.
 *
 * What genuinely needs building:
 *
 *   observe()   AXUIElementCopyAttributeValues (macOS) / IUIAutomationTreeWalker
 *               (Windows) walked into a flat, pre-order AxNode[]. Reading order
 *               matters: the anchor strategy depends on it, and it is also how a
 *               human scans a screen. `ref` becomes a stable element handle.
 *   act()       AXUIElementPerformAction(kAXPressAction) / SetValue, or
 *               UIA InvokePattern / ValuePattern. Coordinate clicks via CGEvent
 *               or SendInput where a control exposes no action.
 *   read()      AXValue / ValuePattern.CurrentValue.
 *   describe()  the same anchor computation as web.ts -- nearest preceding
 *               caption in reading order, skipping the node's own ancestors --
 *               which is written against AxNode, not against the DOM, and so
 *               ports unchanged.
 *   screenshot() CGWindowListCreateImage / PrintWindow, with masking applied by
 *               drawing over the bounding boxes we already have.
 *
 * The handoff would need a different transport (VNC or RDP rather than CDP
 * screencast), but the control-transfer MODEL is unchanged: one session, one
 * lease, escalate/resume, and the same checkpoint re-assertion on the way back.
 */
import type { Action, EnvironmentReport, Observation, RecordedElement, Surface } from './types.js';

const NOT_BUILT = (what: string): never => {
  throw new Error(
    `DesktopSurface.${what}() is a documented stub. See the comment at the top of ` +
    `src/surface/desktop.stub.ts for exactly what would need building and what would not.`,
  );
};

export class DesktopSurface implements Surface {
  constructor(private readonly app: { bundleId?: string; windowTitle?: string }) {}

  async observe(): Promise<Observation> { return NOT_BUILT('observe'); }
  async act(_action: Action): Promise<void> { return NOT_BUILT('act'); }
  async read(): Promise<string | null> { return NOT_BUILT('read'); }
  async describe(): Promise<RecordedElement> { return NOT_BUILT('describe'); }

  /** No DOM here. The ladder loses two rungs and keeps six -- which is the
   *  graceful degradation the Surface contract is designed around, not a gap. */
  async queryNative(): Promise<string[]> { return []; }

  async screenshot(): Promise<Buffer> { return NOT_BUILT('screenshot'); }

  /** A desktop app inherits the OS display, so viewport is a report rather than
   *  a setting: you record the screen resolution and scale you saw and flag a
   *  mismatch, instead of pretending you can impose one. */
  async environment(): Promise<EnvironmentReport> { return NOT_BUILT('environment'); }
  async close(): Promise<void> {}
}
