/*
 * Pure frame-animation logic. No Photoshop APIs here, so this file
 * runs in both the UXP panel and Node (for unit tests).
 *
 * Conventions:
 *  - Frames are the direct children of a top-level layer group named "ANIMATION".
 *  - Frame 1 is the BOTTOM child; new frames stack upward.
 *  - A frame's hold (how many timeline ticks it stays on screen) is a name
 *    suffix: "012 x3" holds frame 012 for 3 ticks. No suffix = 1 tick.
 */

const ROOT_NAME = "ANIMATION";
const HOLD_RE = /\s+x(\d+)\s*$/i;
const MAX_HOLD = 999;

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function pad(n, width = 3) {
  return String(n).padStart(width, "0");
}

/** "012 x3" -> { label: "012", hold: 3 } */
function parseFrameName(name) {
  const text = String(name ?? "");
  const m = HOLD_RE.exec(text);
  if (!m) return { label: text.trim(), hold: 1 };
  return {
    label: text.slice(0, m.index).trim(),
    hold: clampInt(m[1], 1, MAX_HOLD),
  };
}

/** Replace (or drop) the hold suffix while keeping the label. */
function withHold(name, hold) {
  const { label } = parseFrameName(name);
  const h = clampInt(hold, 1, MAX_HOLD);
  return h > 1 ? `${label} x${h}` : label;
}

/** Next numeric frame name, e.g. ["001","002 x2"] -> "003". */
function nextFrameName(names) {
  let max = 0;
  for (const n of names) {
    const { label } = parseFrameName(n);
    if (/^\d+$/.test(label)) max = Math.max(max, parseInt(label, 10));
  }
  return pad(Math.max(max, names.length) + 1);
}

/** Move by delta, wrapping when loop is true, clamping otherwise. */
function stepIndex(current, delta, count, loop) {
  if (count <= 0) return 0;
  const next = current + delta;
  if (loop) return ((next % count) + count) % count;
  return Math.min(count - 1, Math.max(0, next));
}

/**
 * Visibility/opacity for every frame given the current frame and onion settings.
 * onion: { enabled, before, after, opacity (0-100) }
 * Onion frames fade linearly with distance: with opacity 30 and before 3
 * you get 30, 20, 10.
 */
function computeDisplay(count, current, onion) {
  const out = Array.from({ length: count }, () => ({ visible: false, opacity: 100 }));
  if (count === 0) return out;
  const cur = clampInt(current, 0, count - 1);
  out[cur] = { visible: true, opacity: 100 };

  if (onion && onion.enabled) {
    const base = clampInt(onion.opacity, 0, 100);
    const ghost = (dist, n) => Math.max(1, Math.round((base * (n - dist + 1)) / n));
    const before = clampInt(onion.before, 0, count);
    const after = clampInt(onion.after, 0, count);
    for (let d = 1; d <= before && cur - d >= 0; d++) {
      out[cur - d] = { visible: base > 0, opacity: ghost(d, before) };
    }
    for (let d = 1; d <= after && cur + d < count; d++) {
      out[cur + d] = { visible: base > 0, opacity: ghost(d, after) };
    }
  }
  return out;
}

/** [1,3,1] -> [0,1,1,1,2] : frame index for each timeline tick. */
function expandTimeline(holds) {
  const ticks = [];
  holds.forEach((h, i) => {
    for (let k = 0; k < clampInt(h, 1, MAX_HOLD); k++) ticks.push(i);
  });
  return ticks;
}

/** Document title -> safe file stem ("My shot.psd" -> "My_shot"). */
function fileStem(title) {
  const base = String(title ?? "").replace(/\.[^.]+$/, "");
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "frame";
}

function exportFileName(stem, n, total) {
  return `${stem}_${pad(n, Math.max(4, String(total).length))}.png`;
}

// ---------------------------------------------------------------- shots

const SHOT_RE = /^shot\b\s*(\d+)?\s*(.*)$/i;
const STATIC_RE = /^bg\b/i;

function isShotName(name) {
  return SHOT_RE.test(String(name ?? "").trim());
}

/** Layers named "BG…" inside a shot are shown on every frame of that shot. */
function isStaticName(name) {
  return STATIC_RE.test(String(name ?? "").trim());
}

function nextShotName(names) {
  let max = 0;
  for (const n of names) {
    const m = SHOT_RE.exec(String(n ?? "").trim());
    if (m && m[1]) max = Math.max(max, parseInt(m[1], 10));
  }
  return `SHOT ${pad(Math.max(max, names.length) + 1, 2)}`;
}

/** "shot 7 Chase" + 2 -> "SHOT 02 Chase" */
function renumberShotName(name, n) {
  const m = SHOT_RE.exec(String(name ?? "").trim());
  const title = m ? m[2].trim() : "";
  return `SHOT ${pad(n, 2)}${title ? " " + title : ""}`;
}

/**
 * Build the scene model from the ANIMATION group's children.
 * nodes: [{ name, isGroup, ref, children? }] listed top-to-bottom (Photoshop order).
 * Shots are child groups named "SHOT…", first shot = bottom-most.
 * With no shot groups at all, the whole root is one implicit shot (older documents).
 */
function buildModel(nodes, rootRef) {
  const shotNodes = nodes.filter((n) => n.isGroup && isShotName(n.name));
  const implicit = shotNodes.length === 0;
  const sources = implicit
    ? [{ name: "SHOT 01", ref: rootRef, children: nodes, implicit: true }]
    : [...shotNodes].reverse();

  const shots = sources.map((s) => {
    const kids = s.children || [];
    return {
      ref: s.ref,
      name: s.name,
      implicit: !!s.implicit,
      statics: kids.filter((k) => isStaticName(k.name)).map((k) => k.ref),
      frames: kids
        .filter((k) => !isStaticName(k.name))
        .reverse()
        .map((k) => ({ ref: k.ref, name: k.name, hold: parseFrameName(k.name).hold })),
    };
  });

  const flat = [];
  shots.forEach((s, si) => {
    s.start = flat.length;
    s.frames.forEach((_, fi) => flat.push({ shot: si, frame: fi }));
  });
  return { implicit, shots, flat };
}

function frameAt(model, g) {
  const e = model.flat[g];
  return e ? model.shots[e.shot].frames[e.frame] : null;
}

/** Only the current frame's shot is visible; onion skin stays inside that shot. */
function computeSceneDisplay(model, g, onion) {
  const e = model.flat[g];
  const cur = e ? e.shot : -1;
  return {
    shotVisible: model.shots.map((_, si) => si === cur),
    frames: model.shots.map((s, si) => (si === cur ? computeDisplay(s.frames.length, e.frame, onion) : null)),
  };
}

/** Global frame index for each tick of the whole film. */
function globalTimeline(model) {
  const holds = model.flat.map((_, g) => frameAt(model, g).hold);
  return expandTimeline(holds);
}

/** Global frame index for each tick of one shot. */
function shotTimeline(model, si) {
  const s = model.shots[si];
  return expandTimeline(s.frames.map((f) => f.hold)).map((fi) => s.start + fi);
}

module.exports = {
  ROOT_NAME,
  isShotName,
  isStaticName,
  nextShotName,
  renumberShotName,
  buildModel,
  frameAt,
  computeSceneDisplay,
  globalTimeline,
  shotTimeline,
  MAX_HOLD,
  clampInt,
  pad,
  parseFrameName,
  withHold,
  nextFrameName,
  stepIndex,
  computeDisplay,
  expandTimeline,
  fileStem,
  exportFileName,
};
