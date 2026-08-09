# Pipeline Reference

Concrete contracts, commands, and math for the bundled video pipeline.

## Scene contract

Every animated scene is a standalone HTML page at 1920x1080 exposing:

    window.__modeldock = { frame(t), duration, frameAsync?(t) }
    window.__ready = true   // set after textures load / video canplay

- frame(t): deterministic render of time t (used for previews and clips).
- frameAsync(t): for pages containing a <video>; seek the video to t, wait for
  'seeked' with a ~500ms timeout fallback, redraw overlays and reflection
  canvases, then continue. Used for clip rendering.
- duration: scene length in seconds.

Shared scene helpers (three.js r160): makeWorld, glowSprite, textSprite,
makeDust, beveledBox, edgeLines, radialTexture, hexA, and easing helpers
(clamp01, lerp, smoothstep, easeInOut). Keep them in one module and import
from every scene.

## Render environment

Headless MS Edge via Playwright:

    --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
    --ignore-gpu-blocklist

Scene/asset server: local static server on 127.0.0.1:8090 serving the project
root. It must implement HTTP Range (206) and map .mp4 to video/mp4 so browser
video seeking works (see scripts/static-server-range.mjs).

## Commands

Preview 3 frames per scene and write 3-up strips:

    node preview-scenes.mjs [scene1 scene2 ...]

Render an animated scene to a clip at 25 fps:

    node render-clip.mjs <scene> <out.mp4> [duration]

Render static stills (3840x2160) for Ken Burns headroom:

    # playwright page at 3840x2160, wait networkidle, screenshot

Assemble the film:

    python build_film.py [--lang zh|en]

Extract QA frames:

    ffmpeg -y -v error -ss <t> -i video.mp4 -frames:v 1 frame.png

## Timing math (in build_film.py)

    FADE = 1.0   # crossfade length
    PAD  = 1.5   # silence after narration before the next shot fades in
    TAIL = 3.0   # end-card tail after the last narration

    L[i]  = durs[i] + PAD          for i < n-1
    L[-1] = durs[-1] + TAIL
    T[0]  = 0
    T[i]  = T[i-1] + L[i-1] - FADE
    total = T[-1] + L[-1] - FADE

The next narration starts PAD - FADE (0.5s) after the previous one ends, so
speech is never cut by a transition.

## ffmpeg filtergraph pattern

Inputs: stills (3840x2160), clips (1920x1080), real footage (any), narration wavs.

Ken Burns on a still (odd shots zoom-in, even shots zoom-out):

    [i:v]zoompan=z='min(1.0+0.0005*on,1.14)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=<frames>:s=1920x1080:fps=25,trim=duration=<d>,setpts=PTS-STARTPTS,format=yuv420p[v<i>]

Video clip input:

    [i:v]scale=1920:1080:flags=lanczos,fps=25,trim=duration=<d>,setpts=PTS-STARTPTS,format=yuv420p[v<i>]

Crossfades:

    [v0][v1]xfade=transition=fade:duration=1.0:offset=<T1-1.0>[x1]
    [x1][v2]xfade=transition=fade:duration=1.0:offset=<T2-1.0>[x2]

Audio (delay each narration to its shot start, then mix):

    [i:a]adelay=<T_i*1000>:all=1[a<i>]
    [a0]...[aN]amix=inputs=N:normalize=0,aresample=48000[aout]

Subtitles (burned in):

    [vout]ass=subs.ass,format=yuv420p[vout]

ASS style: PlayRes 1920x1080, Fontsize in true pixels, Microsoft YaHei,
Outline 1px + Shadow 3px, bottom margin ~64px. One Dialogue line per narration
line from start to start+duration.

## i18n

One builder, per-language config:

- narration-<lang>.json: text + measured durations.
- Audio dir per language (assets/audio/<lang>/).
- Language-neutral scenes are reused (atmosphere, real UI, text-free 3D scenes).
- Text-bearing stills and end cards are translated per language.
- Subs per language (subs-<lang>.ass).
- Voice per language: mature/professional (e.g. zh-CN-YunyangNeural,
  en-US-ChristopherNeural), rate -8%.

## TTS (msedge-tts)

    const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
    const { audioStream } = await tts.toStream(text, { rate: '-8%' });

Convert to wav (48 kHz mono):

    ffmpeg -y -v error -i in.webm -ar 48000 -ac 1 out.wav

Measure real duration:

    ffprobe -v error -show_entries format=duration -of csv=p=0 out.wav

Rules: retry each segment (the Edge endpoint intermittently returns audio
under 2 KB; treat those as failures); back up the previous voice's audio so a
revert is instant; get client sign-off on a one-line sample before generating
all segments; never reuse durations from a different voice or rate.

## QA checklist (single-frame vision prompts)

- Count labeled identity elements: exactly one code window, one core.
- Any modem/router/box/hardware reading? (must be No)
- Title and labels readable?
- Any hard panel edge, double-exposure, or broken crossfade?
- Real footage: are the key controls fully visible?
