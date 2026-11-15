/*
 * Frame Animator — UXP plugin for frame-by-frame animation in Photoshop.
 *
 * One source of truth, two views:
 *   PSD layers:  ANIMATION > SHOT 01, SHOT 02, … > frames (+ "BG…" layers per shot)
 *   Timeline panel (+ the canvas): the film played linearly, shot after shot.
 *   Storyboard panel: one card per shot, each looping its own animation.
 * Both panels live in this one JS context and read the same layers and the
 * same thumbnail cache, so an edit in one shows up in the other.
 */
const { app, core, action, constants, imaging } = require("photoshop");
const { storage, entrypoints } = require("uxp");
const F = require("./src/frames.js");

const THUMB_H = 96;
const NO_ONION = { enabled: false };

const state = {
  currentByDoc: new Map(), // doc.id -> global frame index
  playing: false,
  fps: 12,
  loop: true,
  shotOnly: false,
  liveThumbs: true,
  onion: { enabled: true, before: 1, after: 1, opacity: 30 },
  modalDepth: 0,
  ignoreEventsUntil: 0,
};

// Thumbnail cache shared by both views. Key: "docId:layerId" of a frame.
const thumbs = new Map();
const dirty = new Set();

const els = {};
const $ = (id) => els[id] || (els[id] = document.getElementById(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isGroup = (layer) => layer.kind === constants.LayerKind.GROUP;
const thumbKey = (doc, layer) => `${doc.id}:${layer.id}`;

// ---------------------------------------------------------------- model

function activeDoc() {
  try {
    return app.activeDocument || null;
  } catch (_) {
    return null;
  }
}

function getRoot(doc) {
  if (!doc) return null;
  return doc.layers.find((l) => isGroup(l) && l.name === F.ROOT_NAME) || null;
}

function toNode(layer, depth) {
  return {
    name: layer.name,
    isGroup: isGroup(layer),
    ref: layer,
    children: depth > 0 && isGroup(layer) ? [...layer.layers].map((l) => toNode(l, depth - 1)) : undefined,
  };
}

/** Read the scene from the document. Returns null if there's no ANIMATION group. */
function getModel(doc) {
  const root = getRoot(doc);
  if (!root) return null;
  const model = F.buildModel([...root.layers].map((l) => toNode(l, 1)), root);
  model.root = root;
  model.doc = doc;
  return model;
}

function indexOfLayer(model, id) {
  return model.flat.findIndex((_, g) => F.frameAt(model, g).ref.id === id);
}

/** Current frame: the frame containing the active layer, else the remembered one. */
function currentIndex(model) {
  const n = model.flat.length;
  if (!n) return 0;
  const stored = F.clampInt(state.currentByDoc.get(model.doc.id) ?? 0, 0, n - 1);
  let layer = model.doc.activeLayers && model.doc.activeLayers[0];
  while (layer) {
    const g = indexOfLayer(model, layer.id);
    if (g >= 0) return g;
    const si = model.shots.findIndex((s) => !s.implicit && s.ref.id === layer.id);
    const shot = model.shots[si] || model.shots.find((s) => s.statics.some((l) => l.id === layer.id));
    if (shot) {
      const inShot = stored >= shot.start && stored < shot.start + shot.frames.length;
      return inShot || !shot.frames.length ? stored : shot.start;
    }
    layer = layer.parent;
  }
  return stored;
}

function applyDisplay(model, g, onion) {
  const plan = F.computeSceneDisplay(model, g, onion);
  if (!model.root.visible) model.root.visible = true;
  model.shots.forEach((s, si) => {
    if (!s.implicit && s.ref.visible !== plan.shotVisible[si]) s.ref.visible = plan.shotVisible[si];
    const frames = plan.frames[si];
    if (!frames) return;
    s.statics.forEach((l) => {
      if (!l.visible) l.visible = true;
    });
    s.frames.forEach((f, fi) => {
      const d = frames[fi];
      if (f.ref.visible !== d.visible) f.ref.visible = d.visible;
      if (d.visible && f.ref.opacity !== d.opacity) f.ref.opacity = d.opacity;
    });
  });
}

/** Select a frame without changing visibility. For groups, select the top child so you can draw at once. */
async function selectLayer(layer) {
  const target = isGroup(layer) && layer.layers.length ? layer.layers[0] : layer;
  await action.batchPlay(
    [{ _obj: "select", _target: [{ _ref: "layer", _id: target.id }], makeVisible: false, _options: { dialogOptions: "dontDisplay" } }],
    {}
  );
}

/**
 * Run fn(doc, ctx) in a modal scope collapsed into one history state.
 * keepHistory=false discards the changes afterwards (used for thumbnail rendering).
 */
async function modal(name, fn, { keepHistory = true, interactive = false } = {}) {
  state.modalDepth++;
  try {
    return await core.executeAsModal(
      async (ctx) => {
        const doc = activeDoc();
        if (!doc) throw new Error("No open document.");
        const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name });
        try {
          return await fn(doc, ctx);
        } finally {
          await ctx.hostControl.resumeHistory(hid, keepHistory);
        }
      },
      { commandName: name, interactive }
    );
  } finally {
    state.modalDepth--;
    state.ignoreEventsUntil = Date.now() + 500; // our own changes echo back as notifications
  }
}

async function showFrame(model, g) {
  if (!model.flat.length) return;
  const i = F.clampInt(g, 0, model.flat.length - 1);
  state.currentByDoc.set(model.doc.id, i);
  applyDisplay(model, i, state.onion);
  await selectLayer(F.frameAt(model, i).ref);
}

function currentShot(model) {
  const e = model.flat[currentIndex(model)];
  return e ? model.shots[e.shot] : model.shots[model.shots.length - 1];
}

// ---------------------------------------------------------------- commands

async function setup() {
  await modal("Set up animation", async (doc) => {
    let root = getRoot(doc);
    if (!root) {
      root = await doc.createLayerGroup({ name: F.ROOT_NAME });
      if (root.parent || doc.layers[0].id !== root.id) {
        root.move(doc.layers[0], constants.ElementPlacement.PLACEBEFORE);
      }
    }
    if (!root.layers.length) {
      const shot = await doc.createLayerGroup({ name: F.nextShotName([]) });
      shot.move(root, constants.ElementPlacement.PLACEINSIDE);
      const frame = await doc.createLayer({ name: F.nextFrameName([]) });
      frame.move(shot, constants.ElementPlacement.PLACEINSIDE);
    }
    await showFrame(getModel(doc), 0);
  });
}

async function goRelative(delta) {
  await modal("Change frame", async (doc) => {
    const model = getModel(doc);
    const n = model.flat.length;
    await showFrame(model, F.stepIndex(currentIndex(model), delta, n, state.loop));
  });
}

async function goTo(g) {
  await modal("Change frame", (doc) => showFrame(getModel(doc), g));
}

async function goEnd(last) {
  await modal("Change frame", async (doc) => {
    const model = getModel(doc);
    await showFrame(model, last ? model.flat.length - 1 : 0);
  });
}

async function newFrame() {
  await modal("New frame", async (doc) => {
    const model = getModel(doc);
    const g = currentIndex(model);
    const e = model.flat[g];
    const shot = currentShot(model);
    const layer = await doc.createLayer({ name: F.nextFrameName(shot.frames.map((f) => f.name)) });
    if (e) layer.move(F.frameAt(model, g).ref, constants.ElementPlacement.PLACEBEFORE);
    else layer.move(shot.ref, constants.ElementPlacement.PLACEINSIDE);
    const after = getModel(doc);
    await showFrame(after, indexOfLayer(after, layer.id));
  });
}

async function duplicateFrame() {
  await modal("Duplicate frame", async (doc) => {
    const model = getModel(doc);
    const g = currentIndex(model);
    const src = F.frameAt(model, g);
    if (!src) return;
    const shot = model.shots[model.flat[g].shot];
    const dup = await src.ref.duplicate(src.ref, constants.ElementPlacement.PLACEBEFORE);
    dup.name = F.withHold(F.nextFrameName(shot.frames.map((f) => f.name)), src.hold);
    const cached = thumbs.get(thumbKey(doc, src.ref));
    if (cached) thumbs.set(thumbKey(doc, dup), cached); // identical pixels: reuse thumbnail
    const after = getModel(doc);
    await showFrame(after, indexOfLayer(after, dup.id));
  });
}

async function deleteFrame() {
  await modal("Delete frame", async (doc) => {
    const model = getModel(doc);
    const g = currentIndex(model);
    const e = model.flat[g];
    if (!e) return;
    if (model.shots[e.shot].frames.length <= 1) {
      throw new Error("That's the shot's only frame. Delete the shot group in the Layers panel instead.");
    }
    F.frameAt(model, g).ref.delete();
    const after = getModel(doc);
    await showFrame(after, Math.min(g, after.flat.length - 1));
  });
}

async function newShot() {
  await modal("New shot", async (doc) => {
    let model = getModel(doc);
    if (model.implicit && model.root.layers.length) {
      // Older document without shots: wrap the existing frames into SHOT 01 first.
      const wrapped = await doc.createLayerGroup({ name: F.nextShotName([]), fromLayers: [...model.root.layers] });
      if (!wrapped.parent || wrapped.parent.id !== model.root.id) {
        wrapped.move(model.root, constants.ElementPlacement.PLACEINSIDE);
      }
      model = getModel(doc);
    }
    const cur = currentShot(model);
    const shot = await doc.createLayerGroup({ name: F.nextShotName(model.shots.filter((s) => !s.implicit).map((s) => s.name)) });
    if (cur && !cur.implicit) shot.move(cur.ref, constants.ElementPlacement.PLACEBEFORE);
    else shot.move(model.root, constants.ElementPlacement.PLACEINSIDE);
    const frame = await doc.createLayer({ name: F.nextFrameName([]) });
    frame.move(shot, constants.ElementPlacement.PLACEINSIDE);
    const after = getModel(doc);
    await showFrame(after, indexOfLayer(after, frame.id));
  });
}

async function changeHold(delta) {
  await modal("Change hold", async (doc) => {
    const model = getModel(doc);
    const f = F.frameAt(model, currentIndex(model));
    if (f) f.ref.name = F.withHold(f.name, f.hold + delta);
  });
}

async function renumber() {
  await modal("Renumber", async (doc) => {
    const model = getModel(doc);
    model.shots.forEach((s, si) => {
      if (!s.implicit) s.ref.name = F.renumberShotName(s.name, si + 1);
      s.frames.forEach((f, fi) => (f.ref.name = F.withHold(F.pad(fi + 1), f.hold)));
    });
  });
}

async function refreshDisplay() {
  await modal("Onion skin", async (doc) => {
    const model = getModel(doc);
    if (model.flat.length) applyDisplay(model, currentIndex(model), state.onion);
  });
}

async function togglePlay() {
  if (state.playing) {
    state.playing = false; // the loop below sees this and stops
    return;
  }
  state.playing = true;
  renderPlayButton();
  try {
    await modal(
      "Play animation",
      async (doc, ctx) => {
        const model = getModel(doc);
        if (!model.flat.length) return;
        let shown = currentIndex(model);
        const e = model.flat[shown];
        const timeline = state.shotOnly ? F.shotTimeline(model, e.shot) : F.globalTimeline(model);
        try {
          let pos = Math.max(0, timeline.indexOf(shown));
          let last = -1;
          while (state.playing && !ctx.isCancelled) {
            const started = Date.now();
            const g = timeline[pos];
            if (g !== last) {
              applyDisplay(model, g, NO_ONION);
              last = shown = g;
              highlightCurrent(model, g);
            }
            await sleep(Math.max(0, 1000 / state.fps - (Date.now() - started)));
            pos++;
            if (pos >= timeline.length) {
              if (!state.loop) break;
              pos = 0;
            }
          }
        } finally {
          state.currentByDoc.set(doc.id, shown);
          applyDisplay(model, shown, state.onion);
        }
      },
      { interactive: true }
    );
  } finally {
    state.playing = false;
    renderPlayButton();
  }
}

async function exportPngSequence() {
  const folder = await storage.localFileSystem.getFolder();
  if (!folder) return;
  const count = await modal("Export PNG sequence", async (doc) => {
    const model = getModel(doc);
    if (!model.flat.length) throw new Error("No frames to export.");
    const original = currentIndex(model);
    const timeline = F.globalTimeline(model);
    const stem = F.fileStem(doc.title);
    const saved = new Map(); // global frame -> file already written, reused for held ticks
    const binary = { format: storage.formats.binary };
    try {
      for (let n = 0; n < timeline.length; n++) {
        const g = timeline[n];
        const file = await folder.createFile(F.exportFileName(stem, n + 1, timeline.length), { overwrite: true });
        if (saved.has(g)) {
          await file.write(await saved.get(g).read(binary), binary);
        } else {
          applyDisplay(model, g, NO_ONION);
          await doc.saveAs.png(file, { compression: 6 }, true);
          saved.set(g, file);
        }
        setMessage(`Exporting ${n + 1} / ${timeline.length}…`);
      }
    } finally {
      applyDisplay(model, original, state.onion);
    }
    return timeline.length;
  });
  setMessage(`Exported ${count} PNGs to ${folder.nativePath}`);
}

// ---------------------------------------------------------------- thumbnails (shared by both views)

/**
 * Render thumbnails by showing each frame (no onion) and grabbing the
 * document composite, so cards look exactly like the canvas, including
 * BG layers and anything outside ANIMATION. History is discarded afterwards.
 */
async function renderThumbs(mode) {
  if (!imaging) throw new Error("Thumbnails need Photoshop 24.2 or later.");
  const doc = activeDoc();
  const model = doc && getModel(doc);
  if (!model || !model.flat.length || state.playing) return;

  const todo = [];
  model.flat.forEach((_, g) => {
    const key = thumbKey(doc, F.frameAt(model, g).ref);
    if (mode === "all" || dirty.has(key) || !thumbs.has(key)) todo.push(g);
  });
  if (!todo.length) return;

  await modal(
    "Update thumbnails",
    async () => {
      const original = currentIndex(model);
      try {
        for (let i = 0; i < todo.length; i++) {
          const g = todo[i];
          const key = thumbKey(doc, F.frameAt(model, g).ref);
          applyDisplay(model, g, NO_ONION);
          const { imageData } = await imaging.getPixels({
            documentID: doc.id,
            targetSize: { height: THUMB_H },
            componentSize: 8,
            applyAlpha: true,
            colorSpace: "RGB",
          });
          try {
            const jpeg = await imaging.encodeImageData({ imageData, base64: true });
            thumbs.set(key, "data:image/jpeg;base64," + jpeg);
            dirty.delete(key);
          } finally {
            imageData.dispose();
          }
          if (todo.length > 3) setMessage(`Thumbnails ${i + 1} / ${todo.length}…`);
        }
      } finally {
        applyDisplay(model, original, state.onion);
      }
    },
    { keepHistory: false }
  );
  if (todo.length > 3) setMessage("");
}

/** After an edit, mark the thumbnails it can have changed. */
function markDirtyFromActiveLayer() {
  const doc = activeDoc();
  const model = doc && getModel(doc);
  if (!model) return;
  const markShot = (s) => s.frames.forEach((f) => dirty.add(thumbKey(doc, f.ref)));
  let layer = doc.activeLayers && doc.activeLayers[0];
  while (layer) {
    const g = indexOfLayer(model, layer.id);
    if (g >= 0) return dirty.add(thumbKey(doc, F.frameAt(model, g).ref));
    const shot = model.shots.find((s) => (!s.implicit && s.ref.id === layer.id) || s.statics.some((l) => l.id === layer.id));
    if (shot) return markShot(shot);
    layer = layer.parent;
  }
  model.shots.forEach(markShot); // edited something outside ANIMATION (e.g. a global background)
}

let thumbTimer = null;
function scheduleThumbs(delay = 800) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(async () => {
    if (!state.liveThumbs || !imaging) return;
    if (state.modalDepth > 0 || state.playing) return scheduleThumbs(1000);
    try {
      await renderThumbs("changed");
    } catch (e) {
      return scheduleThumbs(1500); // Photoshop busy (e.g. mid-stroke); try again shortly
    }
    renderAll();
  }, delay);
}

// ---------------------------------------------------------------- UI: shared

function setMessage(text, isError = false) {
  const el = $("message");
  el.textContent = text || "";
  el.className = isError ? "message error" : "message";
}

function show(id, visible) {
  $(id).classList.toggle("hidden", !visible);
}

function thumbEl(doc, frameRef, width) {
  const src = frameRef && thumbs.get(thumbKey(doc, frameRef));
  if (src) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = src;
    img.style.width = `${width}px`;
    return img;
  }
  const ph = document.createElement("div");
  ph.className = "thumb placeholder";
  ph.style.width = `${width}px`;
  ph.textContent = "…";
  return ph;
}

function docAspect(doc) {
  const w = Number(doc.width) || 16;
  const h = Number(doc.height) || 9;
  return w / h;
}

function seconds(ticks) {
  return `${(ticks / state.fps).toFixed(2)}s`;
}

function renderAll() {
  if (state.playing) return; // the play loop moves the highlight itself
  const doc = activeDoc();
  const model = doc && getModel(doc);
  renderTimelinePanel(doc, model);
  renderStoryboard(doc, model);
}

/** Run a command, report errors, refresh both views. */
async function run(fn) {
  try {
    setMessage("");
    await fn();
  } catch (e) {
    setMessage(e && e.message ? e.message : String(e), true);
  } finally {
    renderAll();
    scheduleThumbs(300);
  }
}

function highlightCurrent(model, g) {
  document.querySelectorAll(".tl-frame").forEach((el) => el.classList.toggle("current", Number(el.dataset.g) === g));
  const e = model.flat[g];
  document.querySelectorAll(".sb-card").forEach((el) => el.classList.toggle("current", e && Number(el.dataset.shot) === e.shot));
}

// ---------------------------------------------------------------- UI: timeline view (linear)

function renderPlayButton() {
  $("btn-play").textContent = state.playing ? "■ Stop" : "▶ Play";
}

function renderTimelinePanel(doc, model) {
  show("no-doc", !doc);
  show("setup", !!doc && !model);
  show("main", !!model);
  if (!model) return;

  const n = model.flat.length;
  const g = currentIndex(model);
  const e = model.flat[g];
  const total = F.globalTimeline(model).length;
  if (e) {
    const shot = model.shots[e.shot];
    $("frame-counter").textContent =
      `${shot.name} · ${e.frame + 1}/${shot.frames.length}  (${g + 1}/${n})`;
    $("hold-label").textContent = `hold ${F.frameAt(model, g).hold} · ${seconds(total)}`;
  } else {
    $("frame-counter").textContent = "No frames";
    $("hold-label").textContent = "";
  }

  const width = Math.round(40 * docAspect(doc));
  const list = $("timeline");
  list.innerHTML = "";
  model.shots.forEach((shot, si) => {
    const block = document.createElement("div");
    block.className = "tl-shot";
    const header = document.createElement("div");
    header.className = "tl-shot-header";
    header.textContent = `${shot.name} · ${shot.frames.length} fr · ${seconds(F.shotTimeline(model, si).length)}`;
    header.addEventListener("click", () => run(() => goTo(shot.start)));
    block.appendChild(header);

    const strip = document.createElement("div");
    strip.className = "tl-frames";
    shot.frames.forEach((f, fi) => {
      const gi = shot.start + fi;
      const cell = document.createElement("div");
      cell.className = "tl-frame" + (gi === g ? " current" : "");
      cell.dataset.g = String(gi);
      cell.title = `${shot.name} / ${f.name}`;
      cell.appendChild(thumbEl(doc, f.ref, width));
      const cap = document.createElement("div");
      cap.className = "cap";
      cap.textContent = f.name;
      cell.appendChild(cap);
      cell.addEventListener("click", () => run(() => goTo(gi)));
      strip.appendChild(cell);
    });
    block.appendChild(strip);
    list.appendChild(block);
  });
}

// ---------------------------------------------------------------- UI: storyboard view

const sb = { visible: false, timer: null, tick: 0, cards: [], signature: "" };

function renderStoryboard(doc, model) {
  show("sb-empty", !model);
  if (!model) {
    $("sb-grid").innerHTML = "";
    $("sb-summary").textContent = "–";
    sb.cards = [];
    sb.signature = "";
    return;
  }
  const total = F.globalTimeline(model).length;
  $("sb-summary").textContent = `${model.shots.length} shots · ${model.flat.length} frames · ${seconds(total)}`;

  const e = model.flat[currentIndex(model)];
  const width = Math.round(THUMB_H * docAspect(doc));
  const grid = $("sb-grid");
  grid.innerHTML = "";
  sb.cards = model.shots.map((shot, si) => {
    const card = document.createElement("div");
    card.className = "sb-card" + (e && e.shot === si ? " current" : "");
    card.dataset.shot = String(si);
    card.title = `Go to ${shot.name}`;

    const holder = document.createElement("div");
    holder.appendChild(thumbEl(doc, shot.frames[0] && shot.frames[0].ref, width));
    card.appendChild(holder);

    const title = document.createElement("div");
    title.className = "sb-title";
    title.textContent = shot.name;
    card.appendChild(title);

    const timeline = F.shotTimeline(model, si);
    const meta = document.createElement("div");
    meta.className = "sb-meta";
    meta.textContent = `${shot.frames.length} frames · ${seconds(timeline.length)}`;
    card.appendChild(meta);

    card.addEventListener("click", () => run(() => goTo(shot.start)));
    grid.appendChild(card);
    return {
      holder,
      width,
      keys: timeline.map((g) => thumbKey(doc, F.frameAt(model, g).ref)),
      shown: null,
    };
  });
}

/** Advance every storyboard card by one tick, each looping its own shot. */
function storyboardTick() {
  sb.tick++;
  for (const card of sb.cards) {
    if (!card.keys.length) continue;
    const src = thumbs.get(card.keys[sb.tick % card.keys.length]);
    if (!src || src === card.shown) continue;
    let img = card.holder.firstChild;
    if (!img || img.tagName !== "IMG") {
      card.holder.innerHTML = "";
      img = document.createElement("img");
      img.className = "thumb";
      img.style.width = `${card.width}px`;
      card.holder.appendChild(img);
    }
    img.src = src;
    card.shown = src;
  }
}

function startTicker() {
  clearInterval(sb.timer);
  if (sb.visible) sb.timer = setInterval(storyboardTick, 1000 / state.fps);
}

function stopTicker() {
  clearInterval(sb.timer);
  sb.timer = null;
}

// ---------------------------------------------------------------- wiring

function bindNumber(id, min, max, apply) {
  $(id).addEventListener("change", (e) => {
    const v = F.clampInt(e.target.value, min, max);
    e.target.value = v;
    apply(v);
  });
}

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function onPhotoshopEvent(eventName) {
  refreshSoon();
  const ours = state.modalDepth > 0 || Date.now() < state.ignoreEventsUntil;
  if (ours) return;
  if (eventName === "historyStateChanged") markDirtyFromActiveLayer(); // strokes, fills, transforms, undo…
  if (eventName !== "select") scheduleThumbs();
}
const refreshSoon = debounce(renderAll, 100);

function init() {
  document.querySelectorAll("[id]").forEach((el) => (els[el.id] = el)); // cache before panels move nodes

  $("btn-setup").addEventListener("click", () => run(setup));
  $("btn-first").addEventListener("click", () => run(() => goEnd(false)));
  $("btn-prev").addEventListener("click", () => run(() => goRelative(-1)));
  $("btn-next").addEventListener("click", () => run(() => goRelative(1)));
  $("btn-last").addEventListener("click", () => run(() => goEnd(true)));
  $("btn-play").addEventListener("click", () => run(togglePlay));
  $("btn-new").addEventListener("click", () => run(newFrame));
  $("btn-dup").addEventListener("click", () => run(duplicateFrame));
  $("btn-del").addEventListener("click", () => run(deleteFrame));
  $("btn-shot").addEventListener("click", () => run(newShot));
  $("btn-hold-minus").addEventListener("click", () => run(() => changeHold(-1)));
  $("btn-hold-plus").addEventListener("click", () => run(() => changeHold(1)));
  $("btn-renumber").addEventListener("click", () => run(renumber));
  $("btn-export").addEventListener("click", () => run(exportPngSequence));
  $("btn-thumbs").addEventListener("click", () => run(() => renderThumbs("all")));
  $("sb-refresh").addEventListener("click", () => run(() => renderThumbs("all")));

  bindNumber("fps", 1, 60, (v) => {
    state.fps = v;
    startTicker();
    renderAll();
  });
  $("loop").addEventListener("change", (e) => (state.loop = e.target.checked));
  $("shot-only").addEventListener("change", (e) => (state.shotOnly = e.target.checked));
  $("live-thumbs").addEventListener("change", (e) => {
    state.liveThumbs = e.target.checked;
    if (state.liveThumbs) scheduleThumbs(100);
  });

  $("onion-enabled").addEventListener("change", (e) => {
    state.onion.enabled = e.target.checked;
    run(refreshDisplay);
  });
  bindNumber("onion-before", 0, 5, (v) => {
    state.onion.before = v;
    run(refreshDisplay);
  });
  bindNumber("onion-after", 0, 5, (v) => {
    state.onion.after = v;
    run(refreshDisplay);
  });
  const opacityChanged = debounce(() => run(refreshDisplay), 150);
  $("onion-opacity").addEventListener("input", (e) => {
    state.onion.opacity = F.clampInt(e.target.value, 0, 100);
    $("onion-opacity-value").textContent = `${state.onion.opacity}%`;
    opacityChanged();
  });

  action.addNotificationListener(
    ["select", "make", "delete", "set", "open", "close", "move", "duplicate", "historyStateChanged"],
    onPhotoshopEvent
  );

  // Two panels, one plugin context: each panel just hosts one of the views.
  const attach = (arg, id) => {
    const node = arg && arg.node ? arg.node : arg;
    if (node && $(id).parentNode !== node) node.appendChild($(id));
  };
  entrypoints.setup({
    panels: {
      frameAnimatorPanel: {
        create(node) {
          attach(node, "animator");
        },
        show(node) {
          attach(node, "animator");
          renderAll();
          scheduleThumbs(200);
        },
      },
      storyboardPanel: {
        create(node) {
          attach(node, "storyboard");
        },
        show(node) {
          attach(node, "storyboard");
          sb.visible = true;
          renderAll();
          startTicker();
          scheduleThumbs(200);
        },
        hide() {
          sb.visible = false;
          stopTicker();
        },
      },
    },
  });

  renderAll();
}

init();
