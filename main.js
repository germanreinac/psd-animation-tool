/*
 * Frame Animator — UXP panel for frame-by-frame animation in Photoshop.
 * Frames are the children of a top-level "ANIMATION" group (bottom = frame 1).
 * Layers outside that group (backgrounds, BG paint, etc.) stay visible on every frame.
 */
const { app, core, action, constants } = require("photoshop");
const { storage } = require("uxp");
const F = require("./src/frames.js");

const state = {
  currentByDoc: new Map(), // doc.id -> frame index
  playing: false,
  fps: 12,
  loop: true,
  onion: { enabled: true, before: 1, after: 1, opacity: 30 },
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Photoshop helpers

function activeDoc() {
  try {
    return app.activeDocument || null;
  } catch (_) {
    return null;
  }
}

function getRoot(doc) {
  if (!doc) return null;
  return doc.layers.find((l) => l.kind === constants.LayerKind.GROUP && l.name === F.ROOT_NAME) || null;
}

/** Frames ordered frame 1 .. N (Photoshop lists layers top-to-bottom). */
function getFrames(root) {
  return root ? [...root.layers].reverse() : [];
}

/** Current frame: the one containing the active layer, else the remembered index. */
function currentIndex(doc, root, frames) {
  if (!frames.length) return 0;
  const active = doc.activeLayers && doc.activeLayers[0];
  let layer = active;
  while (layer && layer.parent && layer.parent.id !== root.id) layer = layer.parent;
  if (layer && layer.parent && layer.parent.id === root.id) {
    const idx = frames.findIndex((f) => f.id === layer.id);
    if (idx >= 0) return idx;
  }
  return F.clampInt(state.currentByDoc.get(doc.id) ?? 0, 0, frames.length - 1);
}

function applyDisplay(root, frames, idx, onion) {
  if (!root.visible) root.visible = true;
  const display = F.computeDisplay(frames.length, idx, onion);
  frames.forEach((frame, i) => {
    const d = display[i];
    if (frame.visible !== d.visible) frame.visible = d.visible;
    if (d.visible && frame.opacity !== d.opacity) frame.opacity = d.opacity;
  });
}

/** Select a layer without changing visibility. For groups, select the top child so you can draw immediately. */
async function selectFrame(frame) {
  let target = frame;
  if (frame.kind === constants.LayerKind.GROUP && frame.layers.length) target = frame.layers[0];
  await action.batchPlay(
    [{ _obj: "select", _target: [{ _ref: "layer", _id: target.id }], makeVisible: false, _options: { dialogOptions: "dontDisplay" } }],
    {}
  );
}

/** Run fn inside a modal scope collapsed into a single history state. */
function modal(name, fn) {
  return core.executeAsModal(
    async (ctx) => {
      const doc = activeDoc();
      if (!doc) throw new Error("No open document.");
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name });
      try {
        return await fn(doc, ctx);
      } finally {
        await ctx.hostControl.resumeHistory(hid);
      }
    },
    { commandName: name }
  );
}

/** Show frame idx (clamped), apply onion skin, select it. */
async function showFrame(doc, idx) {
  const root = getRoot(doc);
  const frames = getFrames(root);
  if (!frames.length) return;
  const i = F.clampInt(idx, 0, frames.length - 1);
  state.currentByDoc.set(doc.id, i);
  applyDisplay(root, frames, i, state.onion);
  await selectFrame(frames[i]);
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
      const layer = await doc.createLayer({ name: F.nextFrameName([]) });
      layer.move(root, constants.ElementPlacement.PLACEINSIDE);
    }
    await showFrame(doc, 0);
  });
}

async function goRelative(delta) {
  await modal("Change frame", async (doc) => {
    const root = getRoot(doc);
    const frames = getFrames(root);
    if (!frames.length) return;
    const idx = F.stepIndex(currentIndex(doc, root, frames), delta, frames.length, state.loop);
    await showFrame(doc, idx);
  });
}

async function goTo(idx) {
  await modal("Change frame", (doc) => showFrame(doc, idx));
}

async function goEnd(last) {
  await modal("Change frame", async (doc) => {
    const frames = getFrames(getRoot(doc));
    await showFrame(doc, last ? frames.length - 1 : 0);
  });
}

async function newFrame() {
  await modal("New frame", async (doc) => {
    const root = getRoot(doc);
    const frames = getFrames(root);
    const idx = currentIndex(doc, root, frames);
    const layer = await doc.createLayer({ name: F.nextFrameName(frames.map((f) => f.name)) });
    if (frames.length) layer.move(frames[idx], constants.ElementPlacement.PLACEBEFORE);
    else layer.move(root, constants.ElementPlacement.PLACEINSIDE);
    await showFrame(doc, frames.length ? idx + 1 : 0);
  });
}

async function duplicateFrame() {
  await modal("Duplicate frame", async (doc) => {
    const root = getRoot(doc);
    const frames = getFrames(root);
    if (!frames.length) return;
    const idx = currentIndex(doc, root, frames);
    const src = frames[idx];
    const dup = await src.duplicate(src, constants.ElementPlacement.PLACEBEFORE);
    dup.name = F.withHold(F.nextFrameName(frames.map((f) => f.name)), F.parseFrameName(src.name).hold);
    await showFrame(doc, idx + 1);
  });
}

async function deleteFrame() {
  await modal("Delete frame", async (doc) => {
    const root = getRoot(doc);
    const frames = getFrames(root);
    if (frames.length <= 1) throw new Error("Can't delete the last remaining frame.");
    const idx = currentIndex(doc, root, frames);
    frames[idx].delete();
    await showFrame(doc, Math.min(idx, frames.length - 2));
  });
}

async function changeHold(delta) {
  await modal("Change hold", async (doc) => {
    const root = getRoot(doc);
    const frames = getFrames(root);
    if (!frames.length) return;
    const frame = frames[currentIndex(doc, root, frames)];
    frame.name = F.withHold(frame.name, F.parseFrameName(frame.name).hold + delta);
  });
}

async function renumber() {
  await modal("Renumber frames", async (doc) => {
    getFrames(getRoot(doc)).forEach((f, i) => {
      f.name = F.withHold(F.pad(i + 1), F.parseFrameName(f.name).hold);
    });
  });
}

async function refreshDisplay() {
  await modal("Onion skin", async (doc) => {
    const root = getRoot(doc);
    const frames = getFrames(root);
    if (frames.length) applyDisplay(root, frames, currentIndex(doc, root, frames), state.onion);
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
    await core.executeAsModal(
      async (ctx) => {
        const doc = activeDoc();
        const root = getRoot(doc);
        const frames = getFrames(root);
        if (!frames.length) return;
        const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Play animation" });
        let shown = currentIndex(doc, root, frames);
        try {
          const timeline = F.expandTimeline(frames.map((f) => F.parseFrameName(f.name).hold));
          const noOnion = { ...state.onion, enabled: false };
          let pos = Math.max(0, timeline.indexOf(shown));
          let last = -1;
          while (state.playing && !ctx.isCancelled) {
            const started = Date.now();
            const fi = timeline[pos];
            if (fi !== last) {
              applyDisplay(root, frames, fi, noOnion);
              last = shown = fi;
              highlightChip(fi);
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
          applyDisplay(root, frames, shown, state.onion);
          await ctx.hostControl.resumeHistory(hid);
        }
      },
      { commandName: "Play animation", interactive: true }
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
    const root = getRoot(doc);
    const frames = getFrames(root);
    if (!frames.length) throw new Error("No frames to export.");
    const original = currentIndex(doc, root, frames);
    const timeline = F.expandTimeline(frames.map((f) => F.parseFrameName(f.name).hold));
    const stem = F.fileStem(doc.title);
    const noOnion = { ...state.onion, enabled: false };
    const saved = new Map(); // frame index -> file already written, reused for held ticks
    const binary = { format: storage.formats.binary };
    try {
      for (let n = 0; n < timeline.length; n++) {
        const fi = timeline[n];
        const file = await folder.createFile(F.exportFileName(stem, n + 1, timeline.length), { overwrite: true });
        if (saved.has(fi)) {
          await file.write(await saved.get(fi).read(binary), binary);
        } else {
          applyDisplay(root, frames, fi, noOnion);
          await doc.saveAs.png(file, { compression: 6 }, true);
          saved.set(fi, file);
        }
        setMessage(`Exporting ${n + 1} / ${timeline.length}…`);
      }
    } finally {
      applyDisplay(root, frames, original, state.onion);
    }
    return timeline.length;
  });
  setMessage(`Exported ${count} PNGs to ${folder.nativePath}`);
}

// ---------------------------------------------------------------- UI

function setMessage(text, isError = false) {
  const el = $("message");
  el.textContent = text || "";
  el.className = isError ? "message error" : "message";
}

function renderPlayButton() {
  $("btn-play").textContent = state.playing ? "■ Stop" : "▶ Play";
}

function highlightChip(idx) {
  document.querySelectorAll(".frame-chip").forEach((chip) => {
    chip.classList.toggle("current", Number(chip.dataset.index) === idx);
  });
}

function show(id, visible) {
  $(id).classList.toggle("hidden", !visible);
}

function renderPanel() {
  if (state.playing) return; // the play loop updates the highlight itself
  const doc = activeDoc();
  const root = getRoot(doc);
  show("no-doc", !doc);
  show("setup", !!doc && !root);
  show("main", !!root);
  if (!root) return;

  const frames = getFrames(root);
  const idx = currentIndex(doc, root, frames);
  const totalTicks = F.expandTimeline(frames.map((f) => F.parseFrameName(f.name).hold)).length;
  const hold = frames.length ? F.parseFrameName(frames[idx].name).hold : 1;
  $("frame-counter").textContent = frames.length ? `Frame ${idx + 1} / ${frames.length}` : "No frames";
  $("hold-label").textContent = frames.length
    ? `hold ${hold} · ${(totalTicks / state.fps).toFixed(2)}s`
    : "";

  const list = $("frame-list");
  list.innerHTML = "";
  frames.forEach((f, i) => {
    const chip = document.createElement("div");
    chip.className = "frame-chip" + (i === idx ? " current" : "");
    chip.dataset.index = String(i);
    chip.textContent = f.name;
    chip.title = `Go to ${f.name}`;
    chip.addEventListener("click", () => run(() => goTo(i)));
    list.appendChild(chip);
  });
}

/** Run a command, report errors, refresh the panel. */
async function run(fn) {
  try {
    setMessage("");
    await fn();
  } catch (e) {
    setMessage(e && e.message ? e.message : String(e), true);
  } finally {
    renderPanel();
  }
}

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function bindNumber(id, min, max, apply) {
  $(id).addEventListener("change", (e) => {
    const v = F.clampInt(e.target.value, min, max);
    e.target.value = v;
    apply(v);
  });
}

function init() {
  $("btn-setup").addEventListener("click", () => run(setup));
  $("btn-first").addEventListener("click", () => run(() => goEnd(false)));
  $("btn-prev").addEventListener("click", () => run(() => goRelative(-1)));
  $("btn-next").addEventListener("click", () => run(() => goRelative(1)));
  $("btn-last").addEventListener("click", () => run(() => goEnd(true)));
  $("btn-play").addEventListener("click", () => run(togglePlay));
  $("btn-new").addEventListener("click", () => run(newFrame));
  $("btn-dup").addEventListener("click", () => run(duplicateFrame));
  $("btn-del").addEventListener("click", () => run(deleteFrame));
  $("btn-hold-minus").addEventListener("click", () => run(() => changeHold(-1)));
  $("btn-hold-plus").addEventListener("click", () => run(() => changeHold(1)));
  $("btn-renumber").addEventListener("click", () => run(renumber));
  $("btn-export").addEventListener("click", () => run(exportPngSequence));

  bindNumber("fps", 1, 60, (v) => {
    state.fps = v;
    renderPanel();
  });
  $("loop").addEventListener("change", (e) => (state.loop = e.target.checked));

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

  // Keep the panel in sync with edits made in Photoshop itself.
  const refresh = debounce(renderPanel, 100);
  action.addNotificationListener(
    ["select", "make", "delete", "set", "open", "close", "move", "duplicate", "historyStateChanged"],
    refresh
  );

  renderPanel();
}

init();
