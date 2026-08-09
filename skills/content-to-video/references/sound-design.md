# Sound Design (BGM + SFX + voice mix)

Distilled from the video-shotcraft skill
(github.com/Vincentwei1021/video-shotcraft, references/sound-design.md and
its 149-SFX / 5-BGM library) and adapted to this skill's 25fps pipeline
(bundled three.js/HTML or HyperFrames backend, ffmpeg final mix).

## Order of operations (non-negotiable)

**Picture locks first, then sound.** BGM sets the energy skeleton, then SFX
are pinned beat by beat. Any later change to shot duration/order requires a
full SFX table re-pin - plan for it (sound is a timeline asset, not a shot
asset). Keep all audio in ONE file as a declarative table; scenes contain no
audio code.

1. Lock the shot structure (Q1 plan gate passed, storyboard has tech stacks).
2. Pick BGM (below) - energy curve must match the storyboard's energy arc.
3. Pin SFX per shot with relative frame expressions.
4. Mix (voice + BGM + SFX) at the end; deliver BGM and no-BGM versions.

## BGM selection

- Pick by **film genre, not "nice music"**: for product promos use a strong
  beat, driving electronic bed (tech-house class). Test by ear: "like a
  product launch trailer, not a mobile game" (S1 rule).
- **Candidate tracks must be auditioned inside the finished cut** - listening
  to the track alone cannot judge fit (three swaps in 34 minutes taught this:
  ambient piano -> folk-pop -> tech-house).
- Default bed volume ~0.34 (headroom for SFX and voice), fade in/out with an
  interpolate envelope on the first ~1s and last ~1.7s.
- Free commercial sources: Mixkit (free commercial, no attribution; record
  track name/URL at download because metadata is often stripped), incompetech
  (CC-BY, attribution required). Game packs (Kenney etc.) are banned for
  product promos.
- **No BGM until the user picks one?** Then the timeline is paced by content,
  not beats (do not force beat-sync). See references/beat-sync.md when the
  user HAS chosen a track - analyze first, then cut to beats.
- Deliver two versions from the same timeline: with BGM and without BGM
  (SFX kept) - the user may re-music it later. In HyperFrames gate the BGM
  `<audio>` with a boolean variable (e.g. `bgm`, default true) and render the
  no-BGM pass with `--variables '{"bgm":false}'`.

## SFX vocabulary (pick by genre, not by event)

Product-promo SFX vocabulary: **whoosh** (camera move) / **impact** (landing)
/ **riser** (build) / **sparkle** (light reveal) / **transition** (scene
change). Game-pack timbres (synth plucks, bloop, cartoon bounces) are banned.

Ban is about **timbre, not action**: a real click/switch/break on screen gets
its real-world foley (the template uses a camera shutter click at its loudest
SFX volume 0.6). Ask: does this sound like the real object (shutter, switch,
glass, paper) or like a game UI feedback tone? The former yes, the latter no.

## Declarative SFX table (one file, relative frames)

```ts
const SFX = [
  // hero card: whoosh up on the pop
  { from: SHOTS.hero.from + 24, src: "whoosh-fast.mp3", volume: 0.5 },
  // impact reseat at hero card landing
  { from: SHOTS.hero.from + 90, src: "transition-snap.mp3", volume: 0.4 },
  // finale: riser -> impact -> sparkle
  { from: beatF(945), src: "riser-cine.mp3", volume: 0.45 },
  { from: beatF(980), src: "impact-deep-whoosh.mp3", volume: 0.55 },
  { from: beatF(1005), src: "sparkle.mp3", volume: 0.4 },
];
```

Rules:
- `from` is always a **relative expression** (`SHOTS.x.from + offset` or
  `beatF(n)`), never a bare absolute frame number - so timeline shifts
  reflow automatically.
- Every entry carries a comment naming the visual action it scores.
- One line per audible cue; no "feel-based" sprinkling.

## Volume math (the two traps)

- **`volume` is a multiplier, not a target level.** A file recorded at
  -24.6dB peak stays -24.6dB at volume 1.0 and gets buried under a BGM bed
  (~-9.4dB at 0.34). Fix in priority order: swap in a louder file from the
  same category -> pre-normalize with
  `ffmpeg -i in.mp3 -af loudnorm=I=-16:TP=-1.5 out.mp3` -> apply gain >1
  (allowed; verify peak on the rendered artifact, never trust preview).
- **Files longer than ~5s must be truncated explicitly** (a `durationInFrames`
  on the clip / `trim` in ffmpeg). Otherwise the sound bleeds into the next
  shot. Long-tail impacts (reverb) are the exception: let them decay.

## Machine-gun prevention (rapid repeats)

1. Alternate two similar samples (not the same file - dedupe by md5 first).
2. Volume staircase along the sequence (e.g. 0.40 -> 0.25 over 6 hits).
3. Interval accelerating with the animation curve (8f -> 3f); when hits blur
   into mush, let the sound fade into a single swoosh instead of per-item
   voices.

Goal: a rapid sequence sounds countable, not like a metronome copy.

## Fixed closing sentence

Riser (start of assembly/build) -> impact (wordmark lands, loudest SFX hit)
-> sparkle (afterglow). This three-beat was the only sound section the source
template never re-pinned.

## Mix (final pass, ffmpeg)

- Voice is the top layer; BGM bed at ~0.34; SFX 0.2-0.6 relative to their
  recorded peak (see volume math).
- Normalize the final mix with EBU R128 loudness: `loudnorm=I=-14:TP=-1.5`
  (single pass acceptable; two-pass for stricter control), aresample 48000.
- Verify peak on the deliverable: `ffmpeg ... -af volumedetect` -> max_volume
  must stay below ~0dB (no clipping).
- Subtitles/captions must match spoken timing (see pipeline.md ASS section
  and the narration JSON with measured durations).

## Asset library (external - download on demand)

Audio assets are NOT bundled with this skill (kept small). The library lives
in the video-shotcraft repo:

https://github.com/Vincentwei1021/video-shotcraft

Download just the audio tree (sparse checkout, ~35 MB):

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/Vincentwei1021/video-shotcraft
cd video-shotcraft
git sparse-checkout set assets/audio
```

The layout under `assets/audio/`:

- `bgm/` - 5 strong-beat candidates (tech-house / house / hip-hop beds).
- `sfx/<category>/` - 149 SFX in 16 scene categories: transition(23),
  impact(14), ui(18), data(13), text(13), camera(10), paper(10), light(10),
  mech(8), film(8), scifi(5), fluid(5), glass(4), counter(4), crowd(3),
  riser(1).
- `AUDITION-2026-07-27.md` - per-file duration / peak / suggested pin points.
- `ATTRIBUTION.md` - sources and license URLs. Keep it when copying assets
  into a project.

When a project needs sound, download the library once (e.g. to
`assets/audio/` in the project) and reference files from there.

Category is a **search index, not a sound-choice verdict**: `ui/` needs
per-file audition (about half are synthetic feedback tones banned by S1 -
the real foley ones are switch/click family); sparkle files live in `light/`
(there is no `sparkle/` dir). `glass/` is real breakage material, allowed.
Long samples (>5s) and quiet files (peak < -12dB) have named lists in
`AUDITION-2026-07-27.md`; see "Volume math" above.
