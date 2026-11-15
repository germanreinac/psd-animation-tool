# Frame Animator for Photoshop

A UXP panel for frame-by-frame (cel) animation in Photoshop 2022 (v23.3) or later.

## How it works

- Your frames go in a top-level layer group named **`ANIMATION`**. Each direct child of that group is one frame. A frame can be a single layer, or a group if you want separate sketch, ink and color layers.
- **Frame 1 is the bottom child.** New frames are stacked above it.
- Layers outside `ANIMATION` (backgrounds, paper texture, reference) show on every frame.
- **Holds** go in the frame name: `012 x3` keeps frame 012 on screen for 3 ticks at the current FPS. The panel's Hold −/+ buttons edit this suffix for you.

## Features

| Area | What it does |
|---|---|
| Setup | Creates the `ANIMATION` group and frame `001` |
| Navigate | First/prev/next/last buttons, plus a clickable list of frames. Selecting any layer inside a frame also makes it the current frame |
| Edit | New empty frame (inserted after the current one), Duplicate, Delete, Renumber |
| Timing | Per-frame hold, FPS (1–60), loop, and the total running time |
| Onion skin | 0–5 frames before and after the current one, faded by distance, adjustable opacity |
| Playback | Plays in the canvas by toggling frame visibility. All of it goes into a single history state |
| Export | Writes a PNG sequence (`name_0001.png`, …) that follows the holds. Layers outside `ANIMATION` are included |

Each action is recorded as one undoable history step.

## Install for development

1. Install the **UXP Developer Tool** from the Creative Cloud app.
2. Open Photoshop.
3. In the UXP Developer Tool, click **Add Plugin…** and choose this repo's `manifest.json`.
4. Click **••• → Load**. Open the panel from **Plugins → Frame Animator**.

To pick up code changes, use **Reload** in the UXP Developer Tool, or turn on **Watch**.

## Notes and limitations

- The panel controls each frame's **opacity and visibility**. A custom opacity you set on a frame will be overwritten, so set opacity on the layers inside a frame group instead.
- Playback speed depends on document size. Large documents may play below the FPS you set. Use Export for accurate timing.
- Onion skin frames are shown faded but not tinted.

## Project layout

```
manifest.json      UXP plugin manifest
index.html         panel markup
styles.css         panel styles (follow the Photoshop theme)
main.js            Photoshop integration and UI wiring
src/frames.js      pure logic: holds, naming, onion skin, timeline (no Photoshop APIs)
test/              unit tests for src/frames.js
```

## Tests

```bash
npm test
```

## Ideas for next steps

- Tinted onion skin (red for past frames, green for future) using color-overlay layer effects
- Export to GIF/MP4 through Photoshop's video timeline
- Light table: pin a reference frame so it always shows
- Sprite sheet export
