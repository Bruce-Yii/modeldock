---
name: promo-film
description: Build narrated promo / explainer / product films as 1920x1080@25fps MP4 from a concept. Covers script and narration-first timeline with measured TTS durations, three.js/HTML animated scenes, image-gen atmosphere and concept stills, real-UI screen footage, ffmpeg Ken Burns + crossfades + burned subtitles, multi-language variants, and a single-frame vision QA loop. Use when the user asks to make or iterate on a promo, product, marketing, or explainer video, animate a slide deck or concept into a film, or wants the full video-production pipeline (story, assets, scenes, render, QA).
---

# Promo Film

Produce a narrated promo film end-to-end. The method is content-agnostic:
one message, a few proof shots, real interface footage, an end card,
subtitles, and optional language variants.

## Pipeline at a glance

1. Script and narration JSON (2 concept shots + proof + end card).
2. Synthesize narration (authentic voice, slightly slower), measure durations.
3. Scene production: three.js/HTML animated scenes + static Ken Burns stills.
4. Asset strategy: image-gen for atmosphere only; identity via labeled UI.
5. Render previews (3 frames per scene), then clips (25 fps) and stills (3840x2160).
6. Assemble with ffmpeg: Ken Burns, crossfades, delayed narration mix, ASS subs.
7. QA: single-frame vision checks per shot and at transition midpoints.
8. Repeat per language from one parameterized builder.

## Read these first

- references/methodology.md  -  the full method: decisions, failure modes,
  asset sourcing, and checklists. Read it before starting a new film.
- references/pipeline.md  -  scene contract, render/build commands, timing
  math, and the ffmpeg filtergraph. Read it when writing scenes or assembling.

## Non-negotiable rules

- Narration drives the timeline; measure real TTS durations, never guess.
- PAD > FADE (e.g. 1.5s vs 1.0s) so speech finishes before the next shot.
- Never let image-gen carry product identity: no "device" heroes. Identity =
  labeled real UI + clear 3D forms + text sprites. image-gen is for
  atmosphere backgrounds, concept stills, and validated hub layouts.
- Composite image layers with heavy blur + radial feather mask; never hard
  crop edges (they read as panels/windows).
- Vision-QA one image per call, never contact strips (cross-frame misreads).
- Real UI footage: object-fit contain so controls are never cropped.
- Keep the builder parameterized by language (--lang).
- Windows: never pass non-ASCII text through a PowerShell pipe; read UTF-8
  files from disk or write with Node fs utf8 + unicode escapes.
- A static server used for video scenes must support HTTP Range (206).
- Add a data: favicon link to every scene so console-error checks stay clean.

## Scripts

- scripts/build_film.py  -  ffmpeg assembly (Ken Burns, xfade, audio mix, ASS
  subs, --lang). Adapt the CONFIG block (paths, inputs, narration JSON).
- scripts/render-clip.mjs  -  render an animated scene to an mp4 clip at 25 fps
  (supports seek-based frameAsync for video-in-scene pages).
- scripts/preview-scenes.mjs  -  sample 0.3/0.55/0.8 frames per scene, capture
  page/console errors, write 3-up strips.
- scripts/qa-frames.mjs  -  extract per-shot and mid-fade frames for QA.
- scripts/static-server-range.mjs  -  minimal static server with Range support.

See references/pipeline.md for exact usage and adaptation notes.

## QA loop

1. Preview every scene: zero page/console errors.
2. Per shot, check single frames: identity elements, labels, no modem/box
   reading, title readable, no hard edges, no double-exposure.
3. Check transition mid-fade frames for broken crossfades.
4. Check real footage shows all key controls.
5. Only then render the clip and rebuild the film.
