# Promo Film Production Methodology

A complete, content-agnostic method for producing a narrated promo / explainer
film (1920x1080@25fps MP4) from a product concept. Learned and proven
end-to-end while building the "Model Dock For Codex" promo film in Chinese and
English. It generalizes to any product, brand, or talking point.

## 1. When this method fits

Use it when the deliverable is a short (30-90s) narrated promotional video that
combines:

- a hero concept shot (product + message),
- one or more "capability / feature" shots,
- real product UI or screen recordings,
- an end card,
- narration with burned-in subtitles,
- one or more language variants.

The same pipeline handles abstract SaaS products, AI tools, developer tools,
hardware-adjacent products, or any content expressible as "one message, a few
proof points, a call to action".

## 2. Core principles (hard-won rules)

1. **Narration drives the timeline, not the other way around.** Write the
   script, synthesize narration, measure the real audio durations, then lay
   out shots. Shot length = narration length + breathing room.
2. **Speech must finish before the next shot starts.** If shot i+1 starts
   FADE seconds before narration i ends, the viewer hears cut-off speech. Add
   a pause PAD after every narration line with PAD > FADE (see Stage 5 math).
3. **Never let image-gen carry product identity.** Generative image models
   anchor "a product" onto a hardware box (router / modem / device) that reads
   wrong and cannot be animated cleanly. Product identity must come from
   labeled real UI (code window, dashboard, pill text), clear 3D forms
   (sphere, rings), and text labels added in-engine. Use image-gen only for
   (a) atmosphere backgrounds, (b) static concept stills, and (c) icon/hub
   layouts already validated by a human eye.
4. **A dark rounded rectangle + a glowing strip reads as hardware.** Even a
   good software scene is mistaken for a modem without textual anchors
   (product/model names). When in doubt, add text or icons in post.
5. **Composited image layers need soft edges.** A blurred full-frame backdrop
   with a radial feather alpha mask reads as atmosphere; a hard crop edge
   reads as a panel or a second window. Heavy blur (about 5% of image width
   or more) erases recognizable shapes.
6. **Validate frames one image at a time, never on contact strips.** Vision
   models conflate elements across side-by-side strip cells ("two windows")
   that do not exist in any single frame. QA on single frames; use strips only
   for human browsing.
7. **Make the QA loop cheap.** Preview 3 frames per scene before committing
   to a full clip render; extract per-second or per-shot frames from the final
   film and vision-check shots and transition midpoints.
8. **Keep the build parameterized by language.** One builder, a per-language
   narration JSON, and per-language scene/still assets, so variants are a
   config change, not a rewrite.
9. **Windows + non-ASCII text is a trap.** Never pass non-ASCII text through a
   PowerShell pipe into a script; the pipe mangles encoding and failures look
   random (e.g. TTS returns empty audio for a specific line). Read existing
   UTF-8 files from disk, or write with Node fs utf8 and unicode escapes.
10. **Local file serving must support HTTP Range** for any scene that plays or
    seeks a video element. Add a 206 byte-range response to the static server.

## 3. Stage 0 - Concept and script

1. Write the pitch as **2 concept shots + proof shots + end card** (the
   two-shot rule):
   - Shot 1: the product and the one-line promise.
   - Shot 2: the capabilities / proof (eyes, ears, voice, web, media...).
   - Middle: real interface shots (dashboard, model picker, live recording).
   - End: brand + CTA ("one switch, one restart, every model").
2. Write narration line-by-line (one line per shot) into a JSON array of
   { text, dur }. Durations are filled later from measured TTS, never guessed.
3. Keep the story to what the product actually shows. Every claim needs a
   visual or a real UI shot to back it.

## 4. Stage 1 - Narration and timing

1. Pick a voice. Microsoft Edge neural voices (via msedge-tts, no API key)
   give good results. Mature/professional voices read more authentic for
   promos than young/chipper voices; male news-style voices (zh-CN-YunyangNeural,
   en-US-ChristopherNeural) read authoritative. Always get client sign-off on
   a one-line sample before generating all segments.
2. Slower is safer. Edge TTS supports rate via the SSML prosody option
   (toStream(text, { rate: "-8%" })). Promo narration usually wants -5% to -10%.
3. Synthesize each line to webm, convert to wav (48 kHz mono) with ffmpeg,
   measure the real duration with ffprobe, and write durations back into the
   narration JSON. Never reuse durations from a different voice or rate.
4. Retry synthesis per segment; the Edge endpoint intermittently returns
   truncated/empty audio. Treat files under ~2 KB as failures.
5. Back up the previous voice's audio so a revert is instant.

## 5. Stage 2 - Visual asset strategy

### Asset classes and their safe sources

| Asset class | Safe source | Notes |
| --- | --- | --- |
| Atmosphere / stage background | image-gen (blurred + feathered in-scene) | No product identity; center empty |
| Hero concept still | image-gen | Static Ken Burns shot; identity added via labels in post |
| Product identity (windows, pills, UI) | Real UI render or canvas-drawn UI with text | Cannot be mistaken for hardware |
| Model / data core (sphere, rings) | three.js primitives + glow sprites | Reads as software/AI |
| Capability icons | Canvas-drawn glyphs (eye, ear, mic, search, image, film) | Orbit or float in 3D |
| Real product footage | User screen recording, trimmed | Keep key UI visible; never crop controls |
| Fonts | Local CJK fonts (Microsoft YaHei, SimHei) | Burned subtitles use PlayRes-sized ASS |

### image-gen prompts that work

- Atmosphere: "deep navy #0B1220 stage, subtle reflective floor with faint
  perspective grid, soft cyan/emerald volumetric glow from the edges, gentle
  bokeh particles, large clean empty center, cinematic keynote style. No
  devices, no text, no logos, no boxes."
- Capability hub: radial layout, center hub + N orbiting nodes, consistent
  neon palette, dark navy background.
- Extract parts: generate the whole first as the style anchor, then edit with
  the anchor as the reference image ("same lighting, same palette, element
  isolated on solid #0B1220, no text, generous margins").

### The "modem" failure mode

Symptoms: the hero reads as a router/modem (dark rounded box, light strip,
indicator dots) even when the prompt says "software, no hardware".

Root cause: (a) a "device" in the prompt is a box to the model; (b) a dark
rounded rectangle with a glow strip is visually indistinguishable from a modem
without textual anchors.

Fix, in order:

1. Put labeled UI and clear sphere/core forms in the foreground.
2. Add big text labels (product and model names) as 3D sprites over the actors.
3. Use image-gen only for atmosphere and concept stills.
4. If a generated element is still read as hardware, remove it rather than
   regenerating - the fix is structural, not a prompt tweak.

## 6. Stage 3 - 3D / HTML scenes

Build each animated scene as a self-contained HTML page so any headless
browser can render it. Contract:

    window.__modeldock = { frame(t), duration, frameAsync?(t) }
    window.__ready = true

- frame(t) renders the exact frame at time t (deterministic; used for previews
  and clip rendering).
- frameAsync(t) is for scenes containing a video: seek the video to t, wait
  for 'seeked' (with a timeout fallback), redraw overlays, then continue.
- Shared helpers keep scenes consistent and tiny (see references/pipeline.md).

Composition playbook:

- Camera: slow push-in plus tiny drift; lookAt target eases across the shot.
- Actors assemble staggered (roughly 0.25-1.7s window), each with its own ease
  and phase; assemble from off-screen, never scale-snap.
- Depth: three z-planes (far glow, mid actors, near particles) plus camera dolly.
- Parallax: the same texture at 2-3 depths with independent drift.
- Particles: dust (AdditiveBlending sprites) + directional risers + a light
  sweep across the frame.
- Labels: textSprite with glow, faded in after the actors land.
- Backdrop compositing: full-frame, heavy blur, opacity at or below 0.45, and
  a radial feather alpha mask; never a hard crop edge.
- Scenes must be 1920x1080 and deterministic (drift derived only from t) so
  frame(t) is reproducible.

## 7. Stage 4 - Rendering (stills, previews, clips)

Use Playwright with headless MS Edge and SwiftShader flags (see
references/pipeline.md for the exact flags).

1. Preview: for each scene, sample frames at 0.3 / 0.55 / 0.8 of duration,
   screenshot, stitch a 3-up strip with ffmpeg hstack, and collect
   page/console errors. Fix errors before full renders.
2. Stills (for Ken Burns headroom): render static scenes at 3840x2160.
3. Clips (animated scenes): call frame(t) at 25 fps, screenshot each frame,
   encode with libx264 crf 18 yuv420p +faststart. For video-in-scene pages use
   frameAsync (seek-based) so output is deterministic.
4. A static server that serves scene HTML/PNG/MP4 must implement HTTP Range
   (206) for video seeking, and .mp4 must map to video/mp4.
5. Add a data: favicon link to every scene so a missing favicon does not
   pollute console-error checks.

## 8. Stage 5 - Film assembly (ffmpeg)

One filtergraph does everything (see scripts/build_film.py and
references/pipeline.md):

1. Inputs: stills (3840x2160), animated clips (1920x1080), real UI video,
   narration wavs.
2. Ken Burns on stills via zoompan (odd shots zoom-in, even shots zoom-out).
3. Video clips: scale to 1920x1080, fps=25, trim, setpts. Use object-fit
   contain (not cover) when mounting real UI footage so no controls get
   cropped.
4. Crossfades: xfade transition=fade, duration=FADE, offset = next shot start
   minus FADE.
5. Audio: delay each narration to its shot start (adelay in ms), then amix
   with normalize=0 and aresample=48000.
6. Subtitles: generate ASS (PlayRes 1920x1080, Fontsize in pixels, Microsoft
   YaHei, outline + shadow) from the narration JSON, burn with the ass filter.
7. Timing math:

       L[i]  = durs[i] + PAD            (all but last)
       L[-1] = durs[-1] + TAIL          (end-card tail)
       T[0]  = 0
       T[i]  = T[i-1] + L[i-1] - FADE
       total = T[-1] + L[-1] - FADE

   With PAD=1.5 and FADE=1.0 the next shot fades in 0.5s after the previous
   narration ends, so speech is never cut.
8. Output: libx264 crf 20, aac 192k, +faststart.

## 9. Stage 6 - QA and iteration

1. Per-shot QA: extract one frame per shot (start + 40%) and one mid-fade
   frame per transition.
2. Vision checks (one image per call, never strips):
   - Count identity elements: exactly one code window, one labeled core,
     no modem/box reading.
   - Title readable; labels present.
   - No hard panel edges, no double-exposure of the background, no broken
     transitions.
   - For real UI footage: key controls visible (not cropped).
3. Audio QA: verify pacing by math (PAD > FADE) and by inspecting shot
   boundary frames; ideally listen to a segment.
4. Iterate: scene fix -> preview 3 frames -> clip -> rebuild -> re-QA. Each
   loop should take minutes, not hours.

## 10. Stage 7 - Internationalization

- Parameterize the builder with --lang (default zh).
- Per language: narration JSON (with its own measured durations), translated
  static scenes / end cards, translated subtitle file, translated voice.
- Reuse language-neutral assets (atmosphere, dashboard, real footage, 3D
  scenes without text) across variants.
- Keep PAD/FADE identical so pacing matches across languages.

## 11. Stage 8 - Windows / encoding safety

- Never write files via PowerShell Set-Content or redirection; prefer Node
  fs writeFileSync utf8 or a dedicated file tool.
- Never pass non-ASCII text through a PowerShell pipe into a script. Read it
  from a UTF-8 file on disk, or write the script with unicode escapes so the
  source stays pure ASCII.
- Verify UTF-8 validity after writing:

      new TextDecoder('utf-8', {fatal:true}).decode(buffer)

- Background launchers must log to files (never /dev/null).

## 12. Example asset / source inventory (Model Dock film)

| Asset | Source | Use |
| --- | --- | --- |
| script.txt / narration.json | Written script + measured TTS durations | Script + timeline |
| assets/audio/seg01..05.wav | msedge-tts zh-CN-YunyangNeural, rate -8% | Narration |
| scene3d/*.html + base.mjs | three.js r160 (local vendor) | Animated scenes |
| scene/*.html | Static 3840x2160 scenes | Ken Burns stills |
| assets/dashboard-4k.png | Headless render of the real dashboard at DPR2 | Interface shot |
| assets/model-picker.mp4 | User screen recording, trimmed to 16:9 | Real footage |
| assets/capabilities-v2.png | image-gen (validated hub layout) | Capability hub |
| assets/stage-bg.png | image-gen atmosphere | Stage backdrop |
| assets/hero-a.png / hero-b.png | image-gen concept stills | Alternative hero style |
| fonts/msyh.ttc, simhei.ttf | Local CJK fonts | Subtitles / scenes |

## 13. Final checklist

- [ ] Narration measured, JSON durations updated, sample approved by client
- [ ] Preview 3 frames per scene with zero JS errors
- [ ] No modem/hardware reading on the hero shot; labels present
- [ ] Clips rendered at 25 fps, stills at 3840x2160
- [ ] PAD > FADE; speech finishes before the next shot
- [ ] Real UI footage shows all key controls
- [ ] Subtitles burned and timed to narration
- [ ] Per-shot and transition QA passed via single-frame vision checks
- [ ] All variants built from one parameterized builder
- [ ] Temporary QA files cleaned
