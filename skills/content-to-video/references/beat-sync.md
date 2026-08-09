# Beat Sync (cut strong-beat BGM to the grid)

Adapted from video-shotcraft's music-beat-sync.md to this skill's 25fps
pipeline. When the user has already chosen a strong-beat BGM, every cut and
key motion must land ON the beat. Measured on the source film: 70s, 18 shots,
131.97 BPM -> all cut errors <= 2.2 frames (perceptible threshold ~3f).

## When to use

- BGM already chosen -> analyze the beat grid FIRST, then anchor every cut /
  key motion to beat numbers.
- No BGM chosen -> pace by content; do not force beat-sync (see
  references/sound-design.md).

## 1. Beat-grid measurement (never trust the tempo scalar)

`librosa.beat.beat_track`'s returned tempo can be off by 2%+ (measured 129.2
vs true 131.97), but its beat times sequence is good. Fit a least-squares
grid to the whole beat sequence:

```python
import numpy as np, librosa

y, sr = librosa.load("bgm.mp3", sr=None, mono=True)
tempo, beats = librosa.beat.beat_track(y=y, sr=sr, tightness=400, units="time")

i = np.arange(len(beats))
A = np.vstack([i, np.ones_like(i)]).T
(T, t0), *_ = np.linalg.lstsq(A, beats, rcond=None)
bpm = 60.0 / T
residual = beats - (t0 + i * T)
print(f"BPM={bpm:.2f} t0={t0:.4f}s T={T:.5f}s residual +/-{np.abs(residual).max()*1000:.0f}ms")
```

Accept: residual <= +-15ms (half a frame) => machine drum, grid trustworthy.
Larger residual => tempo changes; fit per section.

## 2. Locate kicks / accents (where the big slam goes)

```python
from scipy.signal import butter, sosfilt
sos = butter(4, [40, 160], btype="band", fs=sr, output="sos")  # kick band
kick = sosfilt(sos, y)
env = librosa.onset.onset_strength(y=kick, sr=sr)
times = librosa.times_like(env, sr=sr)
# energy at each integer beat -> rank, keep top as big-slam candidates
for n in range(int((times[-1] - t0) / T)):
    t = t0 + n * T
    e = env[np.argmin(np.abs(times - t))]
    # record (beat n, energy e)
```

Produce two things for the design spec: the music structure table (from which
beat the energy is full, where breakdowns/silences are - put brand breathing
shots on breakdowns) and the top-2-3 strongest hits (opening/climax/closing
slam go there).

Gotcha (measured): a slam pinned at b52.5 (between beats) while the strongest
kick is on integer b52 -> +5.75f error after render. Strong-beat accents are
almost always on integer beats; a half-beat pin needs env data, not feel.

## 3. Write the timeline in beat numbers, not frames

```ts
export const FPS = 25;                    // this pipeline renders at 25
export const BEAT0 = 0.2244;              // t0 (s)
export const BEAT_INT = 0.45465;          // T (s)
export const beatT = (n: number) => BEAT0 + n * BEAT_INT;
export const beatF = (n: number) => Math.round(beatT(n) * FPS);

export const SHOTS = {
  s0_open: { from: 0, to: beatF(8) },
  s1_slam: { from: beatF(8), to: beatF(16) },
  // every shot boundary is beatF(integer beat); inner motion uses local beats
};
export const localBeat = (shot: {from: number}, n: number) => beatF(n) - shot.from;
```

Benefit: changing track/section = change two constants, whole film reflows;
the SFX table uses the same `beatF(n)` source of truth (see
references/sound-design.md).

Design rules:
- Shot lengths in beats (4/8 beats a shot); acceleration can step in half/quarter
  beats (e.g. CUT_BEATS = [48, 49.5, 50.5, 51, 51.25]).
- Step-by-step shots (list items, grid cells) map one action per beat directly.
- Dense BGM drums => sparse SFX: only pin screen-unique actions, give the big
  slam 2-3 hits max, let the drum be the rhythm.

## 4. Post-render verification (closed loop, required)

```bash
ffmpeg -i out/promo.mp4 -vn -acodec pcm_s16le render-audio.wav
```

Re-run step 1's grid fit on the RENDERED audio (from the video, not the source
file - verifies encoding/alignment too), then compare designed cut frames vs
nearest measured beat frames; output the error table.

| Verdict | Error |
| --- | --- |
| Pass | <= 3f (perceptible threshold) |
| Ideal | <= 1.5f |
| Must fix | any cut > 3f |

Over-limit pins: change the beat number / frame offset at step 3, re-render,
re-measure until the whole table passes.

## 5. Tooling notes

- librosa not in system python: `uv run --with librosa --with scipy --python 3.11 script.py`
- Vocal-heavy / complex arrangements drift beat_track: separate percussion
  first with `librosa.effects.hpss`.
- Tempo-changing tracks (DJ transitions, accelerando): fit per energy section,
  each with its own t0/T.

