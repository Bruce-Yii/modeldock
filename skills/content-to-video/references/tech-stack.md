# Per-Shot Tech Stack (storyboard tech stack)

Every storyboard panel must name its **primary technique** (and optional
layers) before production. A shot that reaches production without a chosen
tech stack is a Q1 failure - it will get the wrong asset and the wrong render
path. Decide the stack **at storyboard time**, panel by panel, and write it
into the panel ("shot 3: three.js core + GSAP title + sprite embers").

## Technique catalog

| Technique | Best for | Built with | Notes |
| --- | --- | --- | --- |
| three.js scene | 3D hero cores, camera motion, particles, shaders | three adapter in HyperFrames (hf-seek) or bundled `frame(t)` scenes | deterministic; never wall-clock |
| HTML + CSS + GSAP | kinetic type, layout, flat motion graphics | composition DOM + one paused timeline | default for ~95% of motion |
| HyperFrames composition | whole-shot assembly, media sync, clip crossfades | `data-*` clips + GSAP timeline | hosts all other layers in one file |
| image-gen still | atmosphere background, concept still | generate, then blur + feather in-scene | never product identity |
| image-gen sprite (transparent) | decorative moving elements: smoke, embers, glow orbs, sparkles, dust, leaves, generic icons | generate on chroma-key/flat bg, key to RGBA, composite + animate transforms | never product identity; very useful in animation |
| sprite frame sequence (cutout) | looped puppet motion: walking silhouette, flame flicker, flag flutter, bird flap | N-frame grid sheet -> per-frame slices -> swap on paused timeline (8-15fps) | verify loop before production; see references/sprites.md |
| real-UI screenshot | product proof | screenshot into a window frame | identity lives here |
| real footage / screen recording | tutorials, picker demos, UI walkthrough | trimmed video clip, object-fit contain | never crop key controls |
| data-viz | charts, counters, bars, rings | canvas/SVG + GSAP | one chart per point |
| Lottie | pre-baked AE animations | dotLottie via `__hfLottie` | only when the asset exists |
| TypeGPU / WebGPU | GPU particles, liquid glass, custom shaders | WGSL canvas | heavy; use sparingly |

## Decision rule per panel

1. What is this shot proving? (the message beat)
2. Which element carries **identity**? -> real UI / labeled 3D forms / text.
   Never image-gen.
3. Which element carries **atmosphere or motion**? -> three.js, sprites,
   HTML+GSAP, data-viz.
4. Primary technique = the element that must be perfect. The rest are layers.
5. Record it in the panel before writing final copy or building assets.

## Sprite guidance (image-gen, transparent background)

- Generate isolated on **chroma-key #00ff00** (most reliable) or a flat dark
  background; key out + feather in post. Never rely on the model's
  "transparent PNG" - it usually fails or leaves halos.
- Grid + numbered order list in the prompt (row-major); detect grid lines and
  center tiles by **alpha-weighted centroid** when slicing; premultiplied
  resize to avoid dark halos; write a manifest (id -> col/row or frame).
- Great sprite subjects: smoke / fog, embers / sparks, glow orbs, dust,
  leaves / petals, confetti, lens flares, abstract shapes, generic
  (non-brand) icons, and simple frame-sequence puppets.
- **Never** use sprites for product identity: no logos, no devices, no
  product UI. Identity stays real-UI / 3D / text (methodology principle 3).
- Composite like the bundled image layers: blur + radial feather, opacity
  at or below ~0.45 for atmosphere, never a hard crop edge.
- Deterministic: bake the sprite into the composition at build time; animate
  transforms (x / y / scale / rotation) only, never the image itself.
- Full playbook (prompt patterns, chroma-keying, cleanup, packing, manifests,
  8-dir remap, walk-cycle slicing): references/sprites.md.

## Typical mixes by pipeline

| Pipeline | Shot | Stack |
| --- | --- | --- |
| promo | hook | GSAP kinetic title + three.js core + image-gen atmosphere + sprite embers |
| promo | proof | real-UI screenshot + GSAP label + sprite glow orb |
| explainer | concept | SVG diagram (path-draw) + GSAP captions + sprite highlight |
| tutorial | step | screen recording + GSAP step super + cursor sprite |
| story | establishing | three.js scene + image-gen sky + sprite fog |
| social | hook | GSAP big captions + sprite sparkle burst |
| data | chart | canvas bars + GSAP counter + sprite ticker glow |

## Render-path note

The chosen stack decides the render path too: pure HTML/GSAP/sprite/Lottie
shots -> HyperFrames render; three.js-heavy or legacy scenes -> bundled
`frame(t)` machinery or the HyperFrames three adapter. Do not mix both render
paths inside one composition; pick the primary backend at classification time
(see references/hyperframes.md and references/pipeline.md).
