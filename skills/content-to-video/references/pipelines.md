# Pipeline Catalog

All pipelines share one machinery (see SKILL.md "Bundled machinery"): narration-
first timeline, HTML/three.js scenes with a deterministic `frame(t)` contract,
TTS with measured durations, ffmpeg assembly with Ken Burns + crossfades + ASS
subtitles, and single-frame vision QA. What differs per pipeline is structure,
visual strategy, pacing, and format. An optional HyperFrames backend
(references/hyperframes.md) can replace scene authoring and the render command
for motion-graphics-heavy or vertical pieces - the upstream narration and QA
gates stay identical.

## P0 - promo (default pipeline)

- Structure: 2 concept shots + proof shots + end card + CTA.
- Identity: labeled real UI + 3D core + text sprites. image-gen is for
  atmosphere and storyboards only (see methodology.md principle 3).
- Pacing: standard, ~45s.

## P1 - explainer

- Structure: hook -> concept -> how it works (mechanism) -> example/proof ->
  takeaway.
- Visual strategy: numbered concept cards, diagrams built in canvas/HTML,
  real-UI proof clips, Ken Burns stills for metaphors. Denser text density
  than promo but same identity rules.
- Pacing: standard, 60-120s. One idea per shot, never two.

## P2 - tutorial

- Structure: goal -> what you need -> steps (numbered supers) -> verify/result
  -> next steps.
- Visual strategy: screen capture is first-class. Show real UI at full
  fidelity, keep key controls in frame (object-fit contain), add step supers,
  chapter markers, and cursor highlights. Voice-over walks each step.
- Pacing: standard; each step gets its own shot; cut exactly on the action.
- QA extra: every step's screen must be legible at 1080p; no scrolling blur.

## P3 - story

- Structure: cold open -> rising action -> climax -> moral/end card.
- Visual strategy: three.js cinematic scenes, style anchors from image-gen
  (planning), voice acting (multiple voices if possible), wider shot grammar
  (establishing -> close). Slower, moodier pacing with longer fades.
- Pacing: slow; FADE/PAD from the bundled machinery still apply, extend for mood
  (PAD >= 1.8s).
- QA extra: character/place consistency across shots; check single frames
  per scene plus transition midpoints.

## P4 - slides-to-video

- Structure: one scene per slide; title slide -> sections -> closing.
- Visual strategy: render each slide as a full-bleed scene, add Ken Burns
  motion, highlight bullets progressively, and build section transitions.
  Speak the speaker notes.
- Pacing: standard; ~6-10s per slide minimum.
- QA extra: no text overflow after Ken Burns zoom; progressive bullet timing
  matches narration.

## P5 - data-story

- Structure: question -> context -> the numbers (animated charts) -> insight ->
  takeaway.
- Visual strategy: canvas/SVG charts with animated axes, counters, and
  callouts; one chart per point; big numbers on screen while spoken.
- Pacing: standard; 30-90s. Never show more than one chart per shot.
- QA extra: axis labels and callouts legible; no chart cropped by safe margins.

## P6 - social-vertical

- Structure: hook (first 2s) -> content -> CTA. 9:16, 15-45s.
- Visual strategy: big burned captions (readable on a phone), fast cuts every
  2-4s, countdown/loop-friendly ending, vertical-safe margins (top 15% /
  bottom 25% free of critical content for UI overlays).
- Pacing: fast; PAD can shrink to 0.8s but speech must still never be cut.
- QA extra: check the phone-frame crop and caption size on a single frame
  per shot.

## P7 - podcast-video

- Structure: intro card -> conversation (waveform + transcript cards) ->
  b-roll/clips -> outro.
- Visual strategy: audio waveform with the current phrase highlighted,
  transcript cards, topic cards, and b-roll. Face/avatar optional.
- Pacing: slow; 1-3min clips or a full episode. Speaker changes drive cuts.
- QA extra: waveform sync with audio; transcript cards never block the
  waveform; text wraps correctly.

## Cross-pipeline notes

- **Format presets**: 16:9 at 1920x1080@25fps for most; 9:16 at 1080x1920 for
  social; 1:1 at 1080x1080 for dashboards/embedded.
- **Backend per pipeline**: classify.mjs emits a `render_backend` hint
  (bundled vs hyperframes). Data-story and social-vertical default to
  HyperFrames; the rest default to the bundled machinery.
- **Per-shot tech stack**: decided at storyboard time, panel by panel, and
  recorded in the panel (references/tech-stack.md). A shot reaches production
  only with its primary technique + layers named.
- **Scenes are HTML pages** in every pipeline - the render path is identical,
  only the composition changes.
- **Real footage rules** (contain, no cropped controls) apply to tutorial,
  explainer, and promo alike.
- **Voice selection**: per-pipeline profile in classify.mjs output; always
  sample one line and get sign-off before generating all segments.
- **Sound (all pipelines)**: picture locks first, then sound
  (references/sound-design.md). Promo/explainer/data/social: BGM bed ~0.34 +
  genre SFX vocabulary (whoosh/impact/riser/sparkle/transition), declarative
  relative-frame SFX table, deliver BGM + no-BGM versions. Story: longer
  fades, sparse SFX, slower BGM. Podcast-video: waveform sync is the QA gate;
  BGM under speech only. User-selected strong-beat BGM => beat-sync the whole
  timeline (references/beat-sync.md).
