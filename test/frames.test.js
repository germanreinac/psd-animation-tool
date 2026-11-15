const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../src/frames.js");

test("parseFrameName reads hold suffix", () => {
  assert.deepEqual(F.parseFrameName("012 x3"), { label: "012", hold: 3 });
  assert.deepEqual(F.parseFrameName("012"), { label: "012", hold: 1 });
  assert.deepEqual(F.parseFrameName("walk  X2 "), { label: "walk", hold: 2 });
  assert.deepEqual(F.parseFrameName("box"), { label: "box", hold: 1 });
  assert.deepEqual(F.parseFrameName("a x0"), { label: "a", hold: 1 });
});

test("withHold adds, replaces and removes suffix", () => {
  assert.equal(F.withHold("001", 2), "001 x2");
  assert.equal(F.withHold("001 x2", 4), "001 x4");
  assert.equal(F.withHold("001 x4", 1), "001");
  assert.equal(F.withHold("001", -5), "001");
});

test("nextFrameName continues numbering", () => {
  assert.equal(F.nextFrameName([]), "001");
  assert.equal(F.nextFrameName(["001", "002 x2"]), "003");
  assert.equal(F.nextFrameName(["001", "sketch", "inks"]), "004");
  assert.equal(F.nextFrameName(["010"]), "011");
});

test("stepIndex wraps or clamps", () => {
  assert.equal(F.stepIndex(4, 1, 5, true), 0);
  assert.equal(F.stepIndex(0, -1, 5, true), 4);
  assert.equal(F.stepIndex(4, 1, 5, false), 4);
  assert.equal(F.stepIndex(0, -1, 5, false), 0);
  assert.equal(F.stepIndex(0, 1, 0, true), 0);
});

test("computeDisplay shows current frame only without onion", () => {
  const d = F.computeDisplay(4, 2, { enabled: false });
  assert.deepEqual(d.map((x) => x.visible), [false, false, true, false]);
  assert.equal(d[2].opacity, 100);
});

test("computeDisplay fades onion frames and respects edges", () => {
  const d = F.computeDisplay(5, 1, { enabled: true, before: 2, after: 3, opacity: 30 });
  assert.deepEqual(d.map((x) => x.visible), [true, true, true, true, true]);
  assert.equal(d[0].opacity, 30); // 1 before (only one exists)
  assert.equal(d[1].opacity, 100);
  assert.deepEqual([d[2].opacity, d[3].opacity, d[4].opacity], [30, 20, 10]);
});

test("computeDisplay with zero opacity hides onion frames", () => {
  const d = F.computeDisplay(3, 1, { enabled: true, before: 1, after: 1, opacity: 0 });
  assert.deepEqual(d.map((x) => x.visible), [false, true, false]);
});

test("expandTimeline repeats held frames", () => {
  assert.deepEqual(F.expandTimeline([1, 3, 1]), [0, 1, 1, 1, 2]);
  assert.deepEqual(F.expandTimeline([]), []);
});

test("file naming", () => {
  assert.equal(F.fileStem("My shot (v2).psd"), "My_shot_v2");
  assert.equal(F.fileStem(""), "frame");
  assert.equal(F.exportFileName("shot", 7, 24), "shot_0007.png");
  assert.equal(F.exportFileName("shot", 7, 12000), "shot_00007.png");
});
