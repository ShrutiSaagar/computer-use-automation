/**
 * THE SEAM.
 *
 * Everything above this file -- the artifact schema, the replay engine, the
 * error model, the guardrails, the handoff -- is written against these types and
 * knows nothing about browsers. Everything below is one surface implementation.
 *
 * The shape of AxNode is chosen deliberately: role, accessible name, state and
 * bounding box are exactly what macOS AXUIElement and Windows UIAutomation
 * expose, and exactly what a browser accessibility tree exposes. That is not a
 * coincidence, it is the whole bet -- if the recorded flow is expressed in terms
 * a screen reader would recognise, it is expressed in terms that survive both a
 * table-soup legacy web app and a native desktop app.
 *
 * A DOM-based recording would not port. This does.
 */

/** One control as perceived. `ref` is an opaque, surface-issued handle valid
 *  only until the next observe(). */
export type AxNode = {
  ref: string;
  role: string;
  /** Accessible name. Empty string is a real and common answer in legacy apps
   *  -- which is precisely why the locator ladder cannot stop at role+name. */
  name: string;
  /** Inline text content, where the node carries any. */
  text?: string;
  /** active / checked / disabled / expanded / url / cursor ... */
  props: Record<string, string>;
  box?: { x: number; y: number; w: number; h: number };
  /** Surface-issued frame/window identifier. On web this is the frame; on a
   *  desktop surface it would be the window or panel. Opaque and NOT stable
   *  across navigations -- see frameOrdinal. */
  frame: string;
  /** Position of that frame in tree order, 0 = main. This is the durable
   *  identifier: the raw frame id is a counter that keeps climbing for the life
   *  of the page, so a frameset that starts at f1..f3 becomes f4 after one
   *  navigation. Anything recorded in an artifact must use the ordinal. */
  frameOrdinal: number;
  depth: number;
  /** Position in document / reading order. The anchor strategy depends on this
   *  being a faithful reading order, which is also how a human scans the screen. */
  index: number;
};

export type Observation = {
  url: string;
  title: string;
  /** Pre-order flattened: reading order, which is what anchor resolution walks. */
  nodes: AxNode[];
  /** All visible text, for text_present / text_matches conditions. */
  text: string;
  /** Frame identifier -> its URL. Needed because in a frameset the top-level URL
   *  stops changing and is no longer a useful signal on its own. */
  frameUrls: Record<string, string>;
  /** Frame identifier -> its name attribute. A frameset's frame names are static
   *  even as the frame's URL changes, so this is the durable way to say "the
   *  control is in the content pane". */
  frameNames: Record<string, string>;
  /** Frame ids in tree order, so index 0 is the main frame. */
  frameOrder: string[];
  /** The viewport these bounding boxes are relative to. Carried on the
   *  observation rather than remembered by the resolver, because a locator that
   *  silently assumes the wrong viewport aims at the wrong pixel and never says so. */
  viewport: { w: number; h: number };
  at: string;
};

export type Action =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; ref: string }
  | { kind: 'type'; ref: string; value: string }
  | { kind: 'select'; ref: string; value: string }
  | { kind: 'press'; key: string; ref?: string };

/** Everything the compiler needs to build a durable locator ladder from a
 *  control that was just acted on. Populated at record time, never at replay. */
export type RecordedElement = {
  ref: string;
  role: string;
  name: string;
  tag: string;
  id: string;
  attrs: Record<string, string>;
  /** The caption a human would read as identifying this control: an associated
   *  label, else the nearest preceding text in reading order. Feeds the anchor
   *  strategy, which is what carries unlabelled legacy fields. */
  anchorText: string;
  /** How many controls of the same role sit between the anchor and this one. */
  anchorOrdinal: number;
  cssPath: string;
  frame: string;
  frameOrdinal: number;
  box?: { x: number; y: number; w: number; h: number };
  viewport: { w: number; h: number };
};

/**
 * The environment a recording was made in, and that a replay reproduces.
 *
 * Split deliberately into what we ENFORCE and what we merely RECORD:
 *
 *   enforced  viewport, scale, locale, timezone, colour scheme -- these can be
 *             set exactly, so they are, and a replay matches a recording by
 *             construction rather than by luck.
 *   recorded  browser name, version, user agent -- these cannot honestly be
 *             forced. Pretending to be a Chromium you are not is worse than
 *             noticing you are a different one, so they are compared and flagged.
 */
export type EnvironmentSpec = {
  viewport: { width: number; height: number };
  deviceScaleFactor?: number;
  locale?: string;
  timezoneId?: string;
  colorScheme?: 'light' | 'dark' | 'no-preference';
};

export type EnvironmentReport = EnvironmentSpec & {
  browser?: { name: string; version: string };
  userAgent?: string;
};

export interface Surface {
  /** Perceive current state. Invalidates every ref from the previous call. */
  observe(): Promise<Observation>;
  /** Take a handle to a control resolved by ref. */
  act(action: Action): Promise<void>;
  /** Read a value off a control: text content, form value, or an attribute. */
  read(ref: string, mode: 'text' | 'value' | 'attr', attr?: string): Promise<string | null>;
  /** Record-time introspection for the compiler. */
  describe(ref: string): Promise<RecordedElement>;
  /**
   * Escape hatch for ladder rungs that cannot be answered from the accessibility
   * tree alone (id patterns, CSS paths). A surface that has no such concept --
   * a screenshot-only or OS-level surface -- returns null and simply loses those
   * two rungs; the other six still work. That is the graceful degradation.
   */
  queryNative(kind: 'id_pattern' | 'css', value: string, frame?: string): Promise<string[]>;
  /** PNG bytes, with the given controls masked out before the image exists. */
  screenshot(maskRefs?: string[]): Promise<Buffer>;
  /** What this surface is actually running as, for recording and drift checks. */
  environment(): Promise<EnvironmentReport>;
  close(): Promise<void>;
}
