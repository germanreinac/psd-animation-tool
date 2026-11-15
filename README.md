# Frame Animator for Photoshop

A UXP panel for frame-by-frame (cel) animation in Photoshop 2023 (v24.2) or later.

## How it works: one animation, two views

The PSD holds the only copy of the animation. Both panels read the same layers:

```
ANIMATION
├─ SHOT 02 Chase        ← shots: first shot = bottom group
│   ├─ 003 x2           ← frames: first frame = bottom layer, "x2" = hold 2 ticks
│   ├─ 002
│   ├─ 001
│   └─ BG street        ← "BG…" layers show on every frame of this shot
└─ SHOT 01 Intro
    ├─ 002
    └─ 001
Background              ← anything outside ANIMATION shows on every frame
```

- **Frame Animator panel and the canvas (timeline view)** play the film in order, one shot after another. The panel shows a filmstrip of every frame, grouped by shot. You draw on the canvas as usual.
- **Storyboard panel** shows one card per shot, and each card loops its own animation at the project FPS. Click a card to jump to that shot.

Thumbnails are rendered from the real layers and shared by both panels. When you draw on a frame or edit a shot's `BG` layer, the affected thumbnails re-render a moment later, so the edit appears in the timeline and the storyboard at the same time. Renaming, reordering, adding or deleting shots and frames in the Layers panel also updates both views.

A frame can be a single layer, or a group if you want separate sketch, ink and color layers.

## Features

| Area | What it does |
|---|---|
| Setup | Creates `ANIMATION > SHOT 01 > 001` |
| Shots | **+ Shot** adds a shot after the current one. Documents made with v0.1 get their frames wrapped into `SHOT 01` the first time you add a shot |
| Navigate | First/prev/next/last buttons work across shots. Click any frame in the filmstrip or any storyboard card. Selecting a layer in the Layers panel also makes its frame current |
| Edit | New empty frame (after the current one), Duplicate, Delete, Renumber (shots and frames; keeps titles and holds) |
| Timing | Per-frame hold, FPS, loop, "This shot only" playback, and durations per shot and for the whole film |
| Onion skin | 0–5 frames before and after, faded by distance. It stays within the current shot |
| Playback | Plays in the canvas. All of it goes into a single history state |
| Export | PNG sequence of the whole film, following the holds |

Each action is recorded as one undoable history step. Rendering thumbnails adds nothing to the history.

## Install for development

1. Install the **UXP Developer Tool** from the Creative Cloud app.
2. Open Photoshop.
3. In the UXP Developer Tool, click **Add Plugin…** and choose this repo's `manifest.json`.
4. Click **••• → Load**. Open both panels from **Plugins → Frame Animator** and dock them side by side.

To pick up code changes, use **Reload** in the UXP Developer Tool, or turn on **Watch**.

## Notes and limitations

- The panel controls each frame's **opacity and visibility**. A custom opacity you set on a frame will be overwritten, so set opacity on the layers inside a frame group instead.
- Playback speed depends on document size. Large documents may play below the FPS you set. Use Export for accurate timing.
- Onion skin frames are shown faded but not tinted.
- Rendering a thumbnail briefly switches the canvas to that frame with no onion skin, so you may see a quick flicker after edits. Turn off **Live thumbnails** if it gets in the way, and use ↻ to refresh by hand.
- Thumbnails are kept in memory. They are rebuilt automatically after Photoshop restarts or a document is reopened, which can take a few seconds on long films.

## Project layout

```
manifest.json      UXP plugin manifest
index.html         panel markup
styles.css         panel styles (follow the Photoshop theme)
main.js            Photoshop integration, thumbnail cache, both views
src/frames.js      pure logic: shots, holds, naming, onion skin, timelines (no Photoshop APIs)
test/              unit tests for src/frames.js
test/smoke/        runs main.js against a fake Photoshop + DOM (jsdom)
```

## Tests

```bash
npm install
```

```bash
npm test
```

## Ideas for next steps

- Tinted onion skin (red for past frames, green for future) using color-overlay layer effects
- Drag to reorder shots in the storyboard
- Shot notes/dialogue under each storyboard card (stored in the PSD)
- Export to GIF/MP4 through Photoshop's video timeline
- Light table: pin a reference frame so it always shows
- Sprite sheet export
