# HyperFrames Backend

Optional second rendering backend: heygen-com/hyperframes, npm package
`hyperframes` (CLI v0.7.x), Apache-2.0, Node >= 22, FFmpeg required.
Deterministic HTML -> MP4: you write a composition in plain HTML + data
attributes, register a paused GSAP timeline, and the CLI captures every frame
in headless Chrome and encodes it. Verified working on this machine
(4s 1920x1080 clip rendered in ~17s, ~188 KB, h264/yuv420p).

## When to use HyperFrames vs the bundled machinery

Prefer **HyperFrames** when:

- Motion-graphics-heavy short pieces: kinetic type, stat/chart hits, logo
  stings, captions/overlays on top of footage (talking-head recut).
- Vertical social (9:16) with fast turnaround - GSAP timelines are quicker to
  write than imperative three.js for flat 2D motion.
- The user brings an existing HyperFrames composition, or wants a
  `compositions/` project to keep and iterate on.
- Data-story: the catalog has chart blocks (`npx hyperframes add data-chart`).

Prefer the **bundled machinery** (three.js/HTML scenes + build_film.py) when:

- Cinematic 3D scenes, particles, volumetric glows, real-UI heroes with 3D
  forms (the identity rules in methodology.md are built around this).
- Deep custom three.js/shader work, or reusing existing scenes.

Both backends produce the same contract upstream (narration JSON with measured
durations; Q1-Q3 gates) - only the scene authoring and render command change.

## Verified local workflow

```bash
npx --yes hyperframes@latest telemetry disable          # one-time
npx --yes hyperframes@latest init <dir> --example blank # non-interactive init REQUIRES --example
cd <dir>
# edit index.html (composition below), then:
npx --yes hyperframes@latest check                      # lint
npx --yes hyperframes@latest render --fps 25 --strict   # MP4 at 25fps, fail on lint errors
```

Output defaults to `renders/<name>.mp4`. Useful flags (v0.7.99):

- `-o, --output <path>` - output path.
- `-f, --fps 25` - default is 30; use 25 to match the bundled pipeline.
- `-q, --quality draft|standard|high`.
- `--format mp4|webm|mov|gif|png-sequence` (webm/mov keep alpha).
- `--crf <n>` - encoder quality override.
- `--variables '{"title":"..."}'` or `--variables-file` - per-composition
  values (read via `window.__hyperframes.getVariables()`); perfect for
  per-language text without duplicating compositions.
- `--batch <rows.json>` - render one output per variable row; use for
  language variants in one command.
- `--strict` / `--strict-all` - fail the render on lint errors/warnings.
- `--no-best-effort` - fail instead of warning when media is not ready.
- `-w, --workers N` - parallel Chrome workers (~256 MB RAM each).

## Installed official HyperFrames skills

`hyperframes init` auto-installs the official HyperFrames skills alongside
this one (D:\CodexHome\.codex\skills\). Load them for deep authoring details;
do not re-derive what they already specify:

- `hyperframes` (router) - entry point; intent routing, project state, briefs.
- `hyperframes-core` - the composition contract: `data-*` timing, `class="clip"`,
  tracks, sub-compositions, variables, framework-owned media playback,
  determinism rules. **Read before writing composition HTML.**
- `hyperframes-animation` - seekable animation: GSAP timelines, scene
  blueprints, transitions, the seven runtime adapters (GSAP/Lottie/Three.js/
  Anime.js/CSS/WAAPI/TypeGPU), 24 named text-animation effects.
- `hyperframes-cli` - the CLI dev loop: init, lint, check, snapshot, preview,
  render, publish, cloud/lambda render.
- `hyperframes-creative` - non-animation creative direction: frame.md/design.md,
  palettes, typography, narration, beat planning, audio-reactive visuals.
- `hyperframes-keyframes` - seek-safe 2D/3D keyframes and diagnostics.
- `hyperframes-registry` - install/wire catalog blocks and components
  (`hyperframes add data-chart` etc.).
- `media-use` - resolve any media (BGM, SFX, image, icon, voice, LUT) to a
  frozen local file; generate via TTS/music/image models; transcription,
  captions, background removal.

Integration note: the `hyperframes` router defaults to HyperFrames for any
video request. In this skill, backend choice is a classification decision
(bundled vs hyperframes), not a default - follow the pipeline and the
`render_backend` hint from classify.mjs, then delegate composition authoring to
the HyperFrames skills above.

## Composition contract (what works)

```html
<div id="root" data-composition-id="main" data-start="0" data-duration="10"
     data-width="1920" data-height="1080" data-fps="25">
  <div id="title" class="clip" data-start="0" data-duration="5"
       data-track-index="1">Hello</div>
  <audio data-start="0" data-duration="4" data-track-index="2"
         data-volume="1.0" src="assets/audio/narration.wav"></audio>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
</div>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.from("#title", { opacity: 0, y: -60, duration: 0.8 }, 0);
  window.__timelines["main"] = tl;
</script>
```

Rules:

- Root carries `data-composition-id`, `data-start`, `data-duration`,
  `data-width`, `data-height`; set `data-fps="25"` or pass `--fps 25`.
- Every visible element is `class="clip"` with `data-start` + `data-duration`
  (+ `data-track-index` to order/overlay tracks).
- Animations are seekable: one **paused** GSAP timeline per composition id
  registered on `window.__timelines`. No wall-clock animations.
- Video clips: `<video class="clip" data-start data-duration data-track-index
  src="..." muted playsinline></video>`.
- Audio: `<audio data-start data-duration data-track-index data-volume
  src="...">`. Same narration-discipline as the bundled pipeline: use the
  measured WAV durations; never let a track run past the composition.
- Vertical: `data-width="1080" data-height="1920"`.

## Narration and captions with HyperFrames

- Generate narration WAVs exactly as in the bundled pipeline (msedge-tts,
  rate -8%, measure with ffprobe, retry < 2 KB outputs).
- Place each narration segment as an `<audio>` clip at its shot start.
  Keep PAD > FADE discipline: end each clip at least 0.5s before the next
  shot's fade-in.
- Captions: either a HyperFrames captions block (`npx hyperframes add <block>`,
  kinetic - good for social), or burn ASS subtitles in a final ffmpeg pass
  (consistent with the bundled narration JSON timing). Do not do both.

## QA with the HyperFrames backend

- Run `check` and render with `--strict` before watching frames.
- Extract QA frames with ffmpeg from the rendered MP4 (same as bundled:
  per shot + transition midpoints) and vision-check one frame per call.
- Same Q2/Q3 checklists apply: identity rules, safe margins, no hard edges,
  no cut speech, correct aspect/fps, h264 yuv420p +faststart.
