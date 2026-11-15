// Smoke test: run the plugin's main.js against a fake Photoshop + DOM.
const path = require("path");
const fs = require("fs");
const Module = require("module");
const { JSDOM } = require("jsdom");
const REPO = path.join(__dirname, "..", "..");

let nextId = 1;
const doc = { id: 7, title: "test.psd", width: 1920, height: 1080, layers: [], activeLayers: [] };
function listOf(parent) { return parent ? parent.layers : doc.layers; }
function detach(l) { const a = listOf(l.parent); a.splice(a.indexOf(l), 1); }
function makeLayer(name, kind) {
  const l = { id: nextId++, name, kind, visible: true, opacity: 100, parent: null, layers: kind === "group" ? [] : undefined,
    move(target, where) {
      detach(l);
      if (where === "placeInside") { l.parent = target; target.layers.unshift(l); }
      else { l.parent = target.parent; const a = listOf(target.parent); a.splice(a.indexOf(target) + (where === "placeAfter" ? 1 : 0), 0, l); }
    },
    delete() { detach(l); },
    async duplicate(target, where) { const d = makeLayer(l.name + " copy", l.kind); insertTop(d); d.move(target, where); return d; },
  };
  return l;
}
function insertTop(l) { const a = doc.activeLayers[0]; if (a) { l.parent = a.parent; const arr = listOf(a.parent); arr.splice(arr.indexOf(a), 0, l); } else doc.layers.unshift(l); doc.activeLayers = [l]; }
doc.createLayer = async ({ name }) => { const l = makeLayer(name, "pixel"); insertTop(l); return l; };
doc.createLayerGroup = async ({ name, fromLayers }) => {
  const g = makeLayer(name, "group");
  if (fromLayers) { const first = fromLayers[0]; g.parent = first.parent; const a = listOf(first.parent); a.splice(a.indexOf(first), 0, g); fromLayers.forEach((l) => { detach(l); l.parent = g; g.layers.push(l); }); }
  else insertTop(g);
  return g;
};
const bg = makeLayer("Background", "pixel"); doc.layers.push(bg);
const all = (arr = doc.layers) => arr.flatMap((l) => [l, ...(l.layers ? all(l.layers) : [])]);
const findById = (id) => all().find((l) => l.id === id);

const listeners = [];
let modalRuns = 0, discarded = 0;
const photoshop = {
  app: { get activeDocument() { return doc; } },
  constants: { LayerKind: { GROUP: "group" }, ElementPlacement: { PLACEBEFORE: "placeBefore", PLACEINSIDE: "placeInside", PLACEAFTER: "placeAfter" } },
  core: { async executeAsModal(fn) { modalRuns++; return fn({ isCancelled: false, hostControl: { async suspendHistory() { return 1; }, async resumeHistory(id, keep) { if (keep === false) discarded++; } } }); } },
  action: {
    async batchPlay(cmds) { const id = cmds[0]._target[0]._id; doc.activeLayers = [findById(id)]; },
    addNotificationListener(evts, cb) { listeners.push(cb); },
  },
  imaging: {
    async getPixels() {
      const vis = (arr) => arr.filter((l) => l.visible).flatMap((l) => (l.layers ? vis(l.layers) : [l.name + "@" + l.opacity]));
      return { imageData: { snapshot: vis(doc.layers).join("|"), dispose() {} } };
    },
    async encodeImageData({ imageData }) { return Buffer.from(imageData.snapshot).toString("base64"); },
  },
};
let panels;
const uxp = { storage: {}, entrypoints: { setup(cfg) { panels = cfg.panels; } } };

const dom = new JSDOM(fs.readFileSync(path.join(REPO, "index.html"), "utf8"));
global.document = dom.window.document;
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "photoshop") return photoshop;
  if (req === "uxp") return uxp;
  return origLoad.apply(this, arguments);
};
require(path.join(REPO, "main.js"));

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (id) => { document.querySelector("#" + id).dispatchEvent(new dom.window.Event("click")); await wait(50); };
const tree = (arr = doc.layers, ind = "") => arr.map((l) => `${ind}${l.name}${l.visible ? "" : " (hidden)"}${l.opacity !== 100 ? " " + l.opacity + "%" : ""}\n${l.layers ? tree(l.layers, ind + "  ") : ""}`).join("");
const errors = () => $("message").className.includes("error") ? "ERROR: " + $("message").textContent : "";
const assert = require("assert");

(async () => {
  const sbNode = document.createElement("div"), anNode = document.createElement("div"); document.body.append(anNode, sbNode);
  panels.frameAnimatorPanel.create(anNode); panels.frameAnimatorPanel.show(anNode);
  panels.storyboardPanel.create(sbNode); panels.storyboardPanel.show(sbNode);

  await click("btn-setup"); assert.equal(errors(), "");
  await click("btn-new"); await click("btn-new");
  await click("btn-hold-plus");
  await click("btn-shot"); assert.equal(errors(), "");
  await click("btn-new"); await click("btn-dup");
  // shot 2 background
  const shot2 = doc.layers[0].layers[0];
  const bgl = makeLayer("BG street", "pixel"); bgl.parent = shot2; shot2.layers.push(bgl);
  console.log(tree());

  await click("btn-first");
  await click("btn-thumbs"); await wait(100); assert.equal(errors(), "", errors());
  console.log("status:", $("frame-counter").textContent, "|", $("hold-label").textContent);
  console.log("timeline cells:", document.querySelectorAll(".tl-frame").length, "imgs:", document.querySelectorAll(".tl-frame img").length);
  console.log("storyboard cards:", document.querySelectorAll(".sb-card").length, $("sb-summary").textContent);
  const decode = (src) => Buffer.from(src.split(",")[1], "base64").toString();
  document.querySelectorAll(".tl-frame").forEach((c) => console.log("  thumb", c.title, "=>", decode(c.querySelector("img").src)));

  // Single source of truth: "draw" on frame 2 of shot 1, the storyboard frame must change too.
  await click("btn-next");
  const before = [...document.querySelectorAll(".tl-frame img")].map((i) => i.src);



  // simulate a brush stroke: the next composite of the active frame differs
  const realGet = photoshop.imaging.getPixels;
  photoshop.imaging.getPixels = async () => { const r = await realGet(); r.imageData.snapshot += "+NEWINK"; return r; };
  await wait(600); // past the ignore window
  listeners.forEach((cb) => cb("historyStateChanged", {}));
  await wait(1200);
  const after = [...document.querySelectorAll(".tl-frame img")].map((i) => i.src);
  const changed = after.map((s, i) => s !== before[i]);
  console.log("changed thumbs after edit:", changed);
  assert.deepEqual(changed.filter(Boolean).length, 1);
  // storyboard ticker cycles shot 1 frames: find it shows the updated one at some tick
  let saw = false; for (let i = 0; i < 20; i++) { await wait(90); const img = document.querySelector('.sb-card[data-shot="0"] img'); if (img && decode(img.src).includes("NEWINK")) saw = true; }
  console.log("storyboard shows the edit:", saw);
  assert.ok(saw);

  await click("btn-renumber"); console.log(tree());
  console.log("history-discarded thumbnail passes:", discarded, "| errors:", errors() || "none");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
