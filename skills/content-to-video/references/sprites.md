# Sprite Production (image-gen -> usable animated layers)

Source: distilled from the `D:\projects\games` sprite pipelines (jadesea /
hanse-trader: trade-icons, building atlases, ui badges/glyphs/status icons,
8-direction ship sprites, walk cycles) and adapted for video production.
This is the "make image-gen sprites actually animate well" playbook.

## Role in video

Sprites are **decorative / atmospheric layers and cutout puppets** - never
product identity. Identity stays real-UI / 3D / text (methodology principle 3).
Great subjects: smoke, fog, embers, sparks, glow orbs, dust, leaves / petals,
confetti, lens flares, abstract shapes, generic non-brand icons, and simple
frame-sequence objects (a bird, a flag, a walking silhouette, a flickering
flame).

## 1. Prompting an atlas (proven patterns)

### Pattern A - exact grid + numbered item order (default)

- State the grid: "exact 6 columns x 4 rows grid", "each cell contains exactly
  one centered <subject>", "consistent scale, consistent camera angle,
  consistent lighting, generous padding".
- Give the **row-major numbered order list** - the slicing order is the order
  you asked for; do not let the model choose.
- Constraints block: "no text, no letters, no numbers, no labels, no
  watermark, no logo; no item crosses a cell boundary; every item fully inside
  its cell with clear margins; readable at small size".
- Output: "high-resolution PNG, at least 2048px wide, suitable for slicing".

### Pattern B - chroma-key green (most reliable cutout)

- "Perfectly flat solid #00ff00 chroma-key green background across the entire
  image, with no texture, no gradient, no shadows, no reflections. Do not use
  #00ff00 inside any <subject>."
- "Each <subject> isolated as a standalone object for later transparent
  cutout; items must not touch each other or cell edges."

### Pattern C - flat dark fallback

- When transparency/chroma-key is refused: "If transparency is not supported,
  use a flat dark muted teal or warm parchment neutral background that can be
  easily removed." In video, "isolated on pure solid black" also works; key
  out in post.

### Pattern D - grid-line sheet for frame sequences

- For a loop (walk, flame, flag flutter): "exactly N equal-width cells, visible
  vertical grid lines, an outer border, generous padding, no frame labels, no
  subject parts crossing any grid line." Crop 5px inside the detected lines,
  pad to a uniform canvas, write a manifest with per-frame id/pose.

### Anti-patterns learned

- **Never rely on image-gen "transparent background"** - it usually fails or
  returns checkerboard / hard halos. Always plan a key step.
- Grids are never perfectly uniform - detect grid lines / centroids rather
  than trusting equal-cell math.
- Multi-view sheets rarely come in the order you want - an 8-view render needs
  an explicit direction remap (e.g. source indexes -> E SE S SW W NW N NE).

## 2. Keying: background -> alpha

### Chroma-key -> alpha (Pillow/OpenCV)

- Relaxed key test: `g>=120 and g-r>=45 and g-b>=45`.
- Strict key test: `g>=150 and r<=110 and b<=110 and g-max(r,b)>=70`.
- **Flood-fill from all borders** (BFS), not a per-pixel test - this keeps
  green pixels *inside* the subject intact.
- Edge decontamination: pixels touching keyed background where `g>r and g>b`
  get green reduced to `max(r,b)+36` (kills green spill halos).
- Feather: GaussianBlur the mask (sigma ~0.45) for a soft alpha edge.

### HSV / luminance key (solid black or any background)

- Foreground mask: bright `v>72`, colored `s>26 & v>34`, plus special cases
  (red flag hues, water/blue); then morphology CLOSE + DILATE to close gaps.
- Connected components: keep the largest plus nearby components; drop
  caption-like specks (below ~70% height with small area).

## 3. Slice, clean, normalize (per tile)

1. Detect grid lines (x/y column runs) instead of assuming equal cells.
2. Connected-component cleanup on the alpha channel: keep main + overlapping
   neighbors; drop edge-touching strays and tiny far specks
   (`area < max(260, main*0.035)` etc.).
3. Tight crop to alpha bbox + padding (3-8px).
4. **Center by alpha-weighted centroid, not bounding-box center** - visually
   balanced, prevents "floating" sprites.
5. Scale-fit into the cell (`min(cell_w*0.93/w, cell_h*0.88/h)`, LANCZOS).
6. **Premultiplied resize trick**: multiply RGB by alpha before LANCZOS and
   divide back after - prevents dark halos when sprites are scaled in video.

## 4. Packing + manifest + QA

- Compose the atlas at a fixed cell size with padding; anchor every tile by
  centroid. Write a manifest:
  `{image, tileSize, columns, rows, tiles: {id: [col,row]}}` plus optional
  per-tile geometry (bbox, centroid) so the composition can position by visual
  center (the `align_trade_icons` pattern emits per-icon CSS geometry vars).
- 8-direction atlases: apply the direction remap and ship three files -
  `_transparent`, `_atlas_row`, `_atlas_row_preview` (compass-labeled).
- Grid-key QA: render the sheet over a flat dark/checker background with
  labels, then vision-inspect **one image** (never contact strips).

## 5. Frame-sequence animation in a video (cutout puppet)

- Generate the loop sheet (Pattern D), slice to uniform per-frame canvases,
  write `{index, id, file, pose}` into a manifest.
- Animate at 8-15fps by swapping frames on the **paused, seek-safe timeline**
  (never wall-clock): HTML `<img>` sequence or CSS `steps()` background
  position; three.js: swap canvas textures.
- Verify the loop with a chain preview before committing to production.

## 6. Multi-view / 3D-rendered sprites

- If the subject exists as a 3D model, render an orthographic N-view atlas
  with **fixed camera height / focal / scale / lighting** across the asset
  set (the sprite-tool.html pattern: drop GLB/STL -> batch render -> pack).
- Image-gen alternative for pseudo-3D: one grid of N views, then remap
  direction order and key as above.

## Video integration checklist (per sprite asset)

- [ ] Source: chroma-key green or flat dark background (never model alpha).
- [ ] Keyed to RGBA: feathered edge, edge-decontaminated.
- [ ] Tight-cropped, alpha-centroid aligned, premultiplied-scaled.
- [ ] Manifest written (id, col/row or frame, geometry).
- [ ] Single-frame vision QA on the sheet; loop previewed before production.
- [ ] In-scene: animate transforms only (x/y/scale/rotation/opacity), never
  the image itself; atmosphere sprites at opacity <= ~0.45 with blur+feather.

