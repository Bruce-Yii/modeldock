---
name: content-to-video
description: >-
  Turn arbitrary source content (README, article, story, slides, deck,
  data/report, product description, tutorial text, audio/transcript, or a bare
  topic) into a finished, high-quality MP4 video. Classifies the content type
  and user intent, picks the right pipeline, format preset (16:9 / 9:16 / 1:1),
  pacing, visual strategy, and TTS voice, then runs production end-to-end
  (message + storyboard with a per-shot tech-stack decision, narration with
  measured durations, HTML/three.js or HyperFrames scenes, image-gen
  atmosphere and transparent sprites, asset strategy, ffmpeg assembly with
  subtitles, and single-frame vision QA with quality gates). Use when the user
  asks to "make a video", "turn this into a video", or "produce a promo/
  explainer/tutorial/story/social short/data video" from any content, or wants
  automatically-produced higher-quality video without specifying the full
  production plan.
  Supersedes the former promo-film skill; HyperFrames (HTML-to-MP4) is an
  optional second rendering backend.
---

# Content to Video

Produce a finished, high-quality MP4 video from arbitrary source content.
This skill is the router and orchestrator: classify -> plan -> produce -> QA.
It bundles the full promo-film machinery (three.js/HTML scene contract, render
commands, ffmpeg assembly, TTS, i18n) and adds per-content-type presets,
adaptations (screen capture, data-viz, vertical format), an optional
HyperFrames rendering backend, and stricter quality gates.

## Pipeline

0. **CLASSIFY** - Read references/classification.md. Run
   `node scripts/classify.mjs <source>` for a fast first pass. Confirm
   content_type, format, duration, pacing, and visual strategy (intent beats
   signals; follow confidence rules in classification.md).
1. **PLAN** - Write the one-line message, audience, distribution, CTA.
   Design the storyboard with image-gen (planning reference only - panels are
   never final frames). Structure the film per the chosen pipeline in
   references/pipelines.md. For EVERY storyboard panel, decide and record the
   shot's tech stack - primary technique + layers - using
   references/tech-stack.md ("shot 3: three.js core + GSAP title + sprite
   embers"). A panel with no tech stack is a Q1 failure. Pass gate Q1.
2. **SCRIPT + NARRATION** - Narration-first, one line per shot, into a
   narration JSON. Synthesize with TTS, measure real durations, write them
   back. PAD > FADE so speech is never cut (see references/pipeline.md).
3. **SCENES + ASSETS** - Build scenes per the pipeline's visual strategy and
   the chosen rendering backend (below). Follow the identity rules in
   references/methodology.md: labeled real UI + 3D forms + text; image-gen
   only for atmosphere and planning panels.
4. **SOUND** - After picture locks: pick BGM per sound-design.md (audition
   inside the cut, bed ~0.34), pin SFX with a declarative relative-frame table
   (genre vocabulary: whoosh/impact/riser/sparkle/transition; no game-pack
   timbres). If the user chose a strong-beat BGM, cut the timeline in
   beatF(n) per beat-sync.md and verify <= 3f error after render.
5. **RENDER + ASSEMBLE + QA** - Preview 3 frames per scene, render clips,
   assemble with ffmpeg (Ken Burns, crossfades, audio mix with loudnorm,
   ASS subs) or render a HyperFrames composition, deliver BGM + no-BGM
   versions, then run Q2 per-shot vision checks and Q3 watch-through.
   Repeat per language from one parameterized builder.

## Classification quick matrix

| Source looks like | Content type | Pipeline | Format |
| --- | --- | --- | --- |
| README / product / launch | promo | promo | 16:9 |
| article / "what is X" | explainer | explainer | 16:9 |
| how-to / steps / code | tutorial | tutorial | 16:9 |
| novel / script / dialogue | story | story | 16:9 |
| .pptx / .key / .pdf deck | slides | slides-to-video | 16:9 |
| report / metrics / charts | data | data-story | 16:9 or 1:1 |
| listicle / hacks / hashtags | social | social-vertical | 9:16 |
| audio / transcript | podcast | podcast-video | 16:9 |

Full decision tree, presets, and overrides: references/classification.md.
Per-pipeline structures and visual strategies: references/pipelines.md.

## Choose a rendering backend

Two scene-authoring backends; pick per pipeline and content:

- **Bundled machinery** (default): three.js/HTML scenes with a deterministic
  `frame(t)` contract + build_film.py assembly. Best for cinematic 3D, real-UI
  heroes, particles. Promo/explainer/story/tutorial/slides default here.
- **HyperFrames**: HTML + GSAP timelines rendered by the `hyperframes` CLI.
  Best for kinetic motion graphics, vertical social, data charts, and
  caption/overlay-heavy pieces. See references/hyperframes.md (verified
  commands, composition contract, --variables/--batch for language variants).
  The official HyperFrames skills are installed locally (hyperframes,
  hyperframes-core, hyperframes-animation, hyperframes-cli, ...) - delegate
  composition authoring to them via references/hyperframes.md.

Both share the same upstream (classification, narration JSON with measured
durations, Q1-Q3 gates) - only scene authoring and the render command change.

## Bundled machinery (read these first)

- references/methodology.md - the full method: decisions, failure modes,
  asset sourcing, checklists. Read it before starting any film.
- references/pipeline.md - scene contract, render/build commands, timing math
  (FADE/PAD/TAIL), ffmpeg filtergraph, TTS, i18n.
- references/tech-stack.md - per-shot tech-stack catalog and decision rule;
  read it at storyboard time, panel by panel.
- references/sprites.md - image-gen sprite playbook (chroma-key, slicing,
  atlases, manifests, frame-sequence puppets); read before any sprite layer.
- references/sound-design.md - BGM + SFX + mix: genre-based vocabulary,
  declarative relative-frame SFX table, volume math, two-version delivery.
  Read at sound stage; picture locks before sound.
- references/beat-sync.md - when the user picks a strong-beat BGM: analyze
  the grid first (librosa), write the timeline in beatF(n), verify cut
  errors <= 3f on the rendered cut.

Scene contract: every scene is a standalone HTML page at 1920x1080 exposing
`window.__modeldock = { frame(t), duration, frameAsync?(t) }` and `__ready`.
Render environment: headless MS Edge via Playwright (SwiftShader flags), local
static server with HTTP Range (206). Scripts (adapt config, do not edit the
engine):

- scripts/classify.mjs - classify source content -> production recommendation.
- scripts/build_film.py - ffmpeg assembly (Ken Burns, xfade, audio mix, ASS
  subs, --lang).
- scripts/render-clip.mjs - render an animated scene to an mp4 clip at 25 fps.
- scripts/preview-scenes.mjs - sample 0.3/0.55/0.8 frames per scene, capture
  page/console errors, write 3-up strips.
- scripts/qa-frames.mjs - extract per-shot and mid-fade frames for QA.
- scripts/static-server-range.mjs - minimal static server with Range support.

## Non-negotiable rules

- Narration drives the timeline; measure real TTS durations, never guess.
- PAD > FADE (e.g. 1.5s vs 1.0s) so speech finishes before the next shot.
- Never let image-gen carry product identity: no "device" heroes. Identity =
  labeled real UI + clear 3D forms + text sprites. image-gen is for
  atmosphere backgrounds, concept stills, validated hub layouts, and
  transparent-background decorative sprites (smoke, embers, glow orbs,
  sparkles, dust, generic non-brand icons). Sprites are powerful in
  animation, but they never carry identity.
- Plan-stage image-gen designs the OUTLINE and STORYBOARD (one panel per
  planned shot, plus 2-3 style anchors when shots share a look). Panels are
  planning references, never final frames.
- Composite image layers with heavy blur + radial feather mask; never hard
  crop edges (they read as panels/windows).
- Vision-QA one image per call, never contact strips (cross-frame misreads).
- Real UI footage: object-fit contain so controls are never cropped.
- Keep the builder parameterized by language (--lang).
- Windows: never pass non-ASCII text through a PowerShell pipe; read UTF-8
  files from disk or write with Node fs utf8 + unicode escapes.
- A static server used for video scenes must support HTTP Range (206).
- Add a data: favicon link to every scene so console-error checks stay clean.

## Quality gates (the "better" in better video)

Three gates; do not proceed past a failing gate. QA on single frames only.

- **Q1 - Plan**: one-line message is a sentence, audience + distribution
  stated, CTA defined, every claim has a visible proof point, storyboard
  reviewed, voice sample signed off.
- **Q2 - Production** (per shot, single frames): labeled identity, no
  modem/router reading, text readable and in safe margins, no hard edges /
  double exposure, clean transition midpoints, footage shows all key controls.
- **Q3 - Final** (watch with audio): no cut speech, audio clean, subtitles
  fit and match, correct aspect/fps/duration, h264 yuv420p +faststart.

Full checklists and failure handling: references/quality.md.

## Language variants

One builder, per-language narration JSON and audio, shared language-neutral
scenes, translated text stills and subs. With HyperFrames, per-language text
can live in `--variables`/`--batch` instead of duplicated compositions. Never
pass non-ASCII text through a PowerShell pipe.

## QA loop

1. Q1 before production; fix the flow while a panel costs one generation.
2. Preview every scene: zero page/console errors (HyperFrames: `check` +
  `--strict` render).
3. Q2 per shot on single frames; check transition midpoints.
4. Q3 watch-through with audio; only then deliver.
