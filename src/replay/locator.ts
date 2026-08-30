/**
 * Building and resolving the locator ladder.
 *
 * Two pure-ish concerns live here:
 *
 *   buildLadder()  record time: one observed element -> an ordered set of ways
 *                  to find it again, best-first.
 *   resolveLocator() replay time: walk that set until one rung resolves to
 *                  exactly one control that passes the guard.
 *
 * Six of the eight rungs are answered entirely from the AxNode list, so they are
 * surface-agnostic: the same code would resolve them against a desktop
 * accessibility tree. Only id_pattern and css need the surface's native query,
 * and a surface that has no such concept simply loses those two rungs.
 */
import type { Locator, Strategy } from '../schema/capability.js';
import type { AxNode, Observation, RecordedElement, Surface } from '../surface/types.js';

// ---------------------------------------------------------------- record time

/** Ids like ctl00_ContentPlaceHolder1_txtMbrNo: the container prefix is
 *  generated and shifts between pages and versions; the trailing segment is what
 *  a developer actually named. Anchoring the regex to the suffix is what makes
 *  this rung survive an ASP.NET control-tree change -- and it is also why the
 *  rung sits below anchor rather than above it. */
function idSuffixPattern(id: string): string | null {
  if (!id) return null;
  const parts = id.split(/[_:]/).filter(Boolean);
  const tail = parts[parts.length - 1];
  if (!tail || tail.length < 3) return null;
  return `${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/**
 * `mode` matters more than it looks.
 *
 * For an ACTION target, the accessible name identifies the control and is the
 * best thing to key on. For an OUTPUT target, the accessible name IS the value we
 * came to read -- so keying on it would hardcode this run's answer into the
 * artifact, and guarding on it would make the next replay reject a perfectly good
 * different value. Output locators therefore lead with the caption anchor and
 * guard on role alone.
 */
export function buildLadder(
  el: RecordedElement,
  description: string,
  frameName?: string,
  mode: 'action' | 'output' = 'action',
): Locator {
  const s: Strategy[] = [];
  const nameIdentifies = mode === 'action' && !!el.name;

  // 0: role + accessible name. The only rung that also exists on desktop AX APIs.
  if (nameIdentifies) s.push({ kind: 'role_name', role: el.role, name: el.name, exact: true });

  // 1: accessible name irrespective of role, so a control that is re-typed
  //    (textbox -> combobox) between versions is still found.
  if (nameIdentifies) s.push({ kind: 'label', text: el.name, exact: true });

  // 2: author-supplied attribute text.
  for (const attr of ['placeholder', 'alt', 'title'] as const) {
    const v = el.attrs[attr];
    if (v) s.push({ kind: 'attr_text', attr, text: v });
  }

  // 3: the workhorse for legacy layout tables. When a field has no label and no
  //    accessible name -- the common case -- the durable fact about it is that it
  //    sits after a caption a human reads.
  if (el.anchorText) {
    s.push({ kind: 'anchor', anchorText: el.anchorText, role: el.role, ordinal: el.anchorOrdinal });
  }

  // 4: tolerant id regex.
  const idPat = idSuffixPattern(el.id);
  if (idPat) s.push({ kind: 'id_pattern', regex: idPat });

  // 5: recorded CSS path. Brittle by construction -- it is below anchor for a
  //    reason -- but a real last structural resort.
  if (el.cssPath) s.push({ kind: 'css', value: el.cssPath });

  // 6: visible text, only where it identifies rather than merely describes.
  if (!el.name && el.attrs.value && /button|submit/i.test(el.attrs.type ?? '')) {
    s.push({ kind: 'text', value: el.attrs.value, exact: true });
  }

  // 7: normalised coordinates. Policy-gated at replay, and kept because it is
  //    the rung a screenshot-only or OS-level surface would lead with.
  if (el.box && el.viewport.w && el.viewport.h) {
    s.push({
      kind: 'coords',
      nx: +((el.box.x + el.box.w / 2) / el.viewport.w).toFixed(4),
      ny: +((el.box.y + el.box.h / 2) / el.viewport.h).toFixed(4),
    });
  }

  return {
    description,
    // Ordinal, never the raw frame id -- the id is a per-page counter that
    // changes after any navigation, so recording it would produce an artifact
    // that works once.
    frame: frameName ? { name: frameName, index: el.frameOrdinal } : { index: el.frameOrdinal },
    strategies: s.length ? s : [{ kind: 'css', value: el.cssPath }],
    recordedRank: 0,
    guard: { role: el.role, name: nameIdentifies ? el.name : undefined, tag: el.tag },
  };
}

// ---------------------------------------------------------------- replay time

export type Resolution =
  | { ok: true; ref: string; rank: number; kind: string }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'guard_mismatch'; tried: string[]; detail: string };

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

const matches = (candidate: string, want: string, exact: boolean): boolean =>
  exact ? norm(candidate) === norm(want) : norm(candidate).includes(norm(want));

/** Which surface frame id the locator refers to: by frame name first (stable
 *  across navigation inside a frameset), then recorded ordinal, then anywhere. */
function frameIdFor(loc: Locator, obs: Observation): string | undefined {
  const f = loc.frame;
  if (!f) return undefined;
  if (f.name) {
    const hit = Object.entries(obs.frameNames).find(([, n]) => n === f.name);
    if (hit) return hit[0];
  }
  if (f.urlPattern) {
    const re = new RegExp(f.urlPattern);
    const hit = Object.entries(obs.frameUrls).find(([, u]) => re.test(u));
    if (hit) return hit[0];
  }
  if (f.index !== undefined && obs.frameOrder[f.index]) return obs.frameOrder[f.index];
  return undefined;
}

function candidatesFromTree(st: Strategy, pool: AxNode[], viewport: { w: number; h: number }): AxNode[] {
  switch (st.kind) {
    case 'role_name':
      return pool.filter((n) => n.role === st.role && matches(n.name, st.name, st.exact));
    case 'label':
      return pool.filter((n) => n.name && matches(n.name, st.text, st.exact));
    case 'anchor': {
      // Find the caption, then take the Nth control of the wanted role after it
      // in reading order. Scoped to the caption's own frame.
      const anchor = pool.find((n) => norm(n.name || n.text || '') === norm(st.anchorText));
      if (!anchor) return [];
      const after = pool.filter(
        (n) => n.frame === anchor.frame && n.index > anchor.index && n.role === st.role,
      );
      const hit = after[st.ordinal];
      return hit ? [hit] : [];
    }
    case 'text':
      return pool.filter((n) => matches(n.name || n.text || '', st.value, st.exact));
    case 'coords':
      // Boxes are viewport-relative, so this must denormalise against the
      // viewport we ACTUALLY observed. It previously used two hardcoded numbers,
      // which happened to be right only because the viewport was also hardcoded
      // somewhere else -- exactly the kind of coupling that works until someone
      // changes a window size and gets clicks landing on the wrong control with
      // no error.
      return pool.filter(
        (n) =>
          n.box &&
          Math.abs(n.box.x + n.box.w / 2 - st.nx * viewport.w) < Math.max(24, n.box.w / 2) &&
          Math.abs(n.box.y + n.box.h / 2 - st.ny * viewport.h) < Math.max(16, n.box.h / 2),
      );
    default:
      return [];
  }
}

export async function resolveLocator(
  loc: Locator,
  obs: Observation,
  surface: Surface,
  opts: { allowCoordinateFallback?: boolean } = {},
): Promise<Resolution> {
  const frameId = frameIdFor(loc, obs);
  const pool = frameId ? obs.nodes.filter((n) => n.frame === frameId) : obs.nodes;
  const tried: string[] = [];
  let sawAmbiguous = '';
  let sawGuardMiss = '';

  for (let rank = 0; rank < loc.strategies.length; rank++) {
    const st = loc.strategies[rank]!;
    if (st.kind === 'coords' && !opts.allowCoordinateFallback) {
      tried.push(`${st.kind}(skipped by policy)`);
      continue;
    }
    tried.push(st.kind);

    let cands: AxNode[];
    if (st.kind === 'id_pattern' || st.kind === 'css') {
      const value = st.kind === 'css' ? st.value : st.regex;
      const refs = await surface.queryNative(st.kind, value, frameId).catch(() => [] as string[]);
      cands = pool.filter((n) => refs.includes(n.ref));
    } else if (st.kind === 'attr_text') {
      const refs = await surface
        .queryNative('css', `[${st.attr}="${st.text.replace(/"/g, '\\"')}"]`, frameId)
        .catch(() => [] as string[]);
      cands = pool.filter((n) => refs.includes(n.ref));
    } else {
      cands = candidatesFromTree(st, pool, obs.viewport);
    }

    // The guard is what separates "found an element" from "found the RIGHT
    // element". A stale CSS path can still resolve -- to the wrong control -- and
    // acting on it is worse than failing to find anything.
    const guarded = cands.filter((n) => {
      if (loc.guard.role && n.role !== loc.guard.role) return false;
      if (loc.guard.name && !matches(n.name, loc.guard.name, true)) return false;
      return true;
    });

    if (cands.length && !guarded.length) {
      sawGuardMiss = `${st.kind} matched ${cands.length} node(s) but none had role="${loc.guard.role}"${
        loc.guard.name ? ` name="${loc.guard.name}"` : ''
      } (saw: ${cands.slice(0, 3).map((c) => `${c.role}"${c.name}"`).join(', ')})`;
      continue;
    }
    if (guarded.length === 1) return { ok: true, ref: guarded[0]!.ref, rank, kind: st.kind };
    if (guarded.length > 1) {
      const nth = 'nth' in st ? st.nth : undefined;
      if (nth !== undefined && guarded[nth]) {
        return { ok: true, ref: guarded[nth]!.ref, rank, kind: st.kind };
      }
      sawAmbiguous = `${st.kind} matched ${guarded.length} controls; no disambiguator recorded`;
    }
  }

  if (sawAmbiguous) return { ok: false, reason: 'ambiguous', tried, detail: sawAmbiguous };
  if (sawGuardMiss) return { ok: false, reason: 'guard_mismatch', tried, detail: sawGuardMiss };
  return {
    ok: false,
    reason: 'not_found',
    tried,
    detail: `no strategy resolved "${loc.description}" (tried: ${tried.join(' -> ')})`,
  };
}
