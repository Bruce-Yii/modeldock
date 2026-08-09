# Quality Gates

The difference between a "video" and a "good video" is enforced here. Three
gates; do not proceed past a failing gate. QA on single frames only (never
contact strips - vision models conflate cells across a strip).

## Q1 - Plan gate (before narration or scene work)

- One-line message is written and it is a sentence, not a topic ("ModelDock
  runs every model on one machine" beats "ModelDock").
- Audience and distribution are stated (who watches, where).
- CTA / takeaway is defined (promo: action; explainer/story: idea).
- Proof points exist for every claim in the script - each claim maps to a
  visible shot (real UI, diagram, chart, scene).
- Storyboard panels (image-gen, planning only) reviewed with vision: does the
  sequence tell the one-line message? Fix the flow now, not after renders.
- Every storyboard panel names its tech stack - primary technique + layers
  (three.js / HTML+GSAP / image-gen sprite / real UI / data-viz / HyperFrames,
  see references/tech-stack.md). A panel with no stack is a plan failure.
- Pacing and duration chosen with a reason; voice sample signed off.

## Q2 - Production gate (per shot, single frames)

- **Identity**: labeled real UI + 3D forms + text; exactly one hero element;
  no modem/router/box reading anywhere (see methodology.md failure mode).
- **Text**: titles and labels readable at full resolution; no overflow; safe
  margins respected (title-safe ~5%, social-vertical: top 15% / bottom 25%).
  **Effective glyph height**, measured on the rendered frame (not the code
  fontSize): captions >= ~56px (>= 5.2% of frame height), supporting text /
  URLs >= 32px (>= 3%); account for all ancestor scales and 3D perspective
  compression (approx by cos(rotY)). Text has only two states: decorative
  "texture" (visibly blurred/dimmed so nobody reads it) or "meant to be
  read" (above thresholds + contrast, scrim behind light backgrounds) -
  no middle state where text is reflowed but still unreadable.
- **Compositing**: no hard panel edges, no double exposure, no visible crop
  seams; atmosphere layers are blurred + feathered, opacity <= 0.45.
- **Transitions**: crossfade midpoints are clean (no broken fade, no
  double-flash).
- **Footage**: real UI shows all key controls; nothing cropped; no scrolling
  blur in tutorials.
- **Determinism**: every scene renders without page/console errors; frames are
  reproducible (drift derived only from t).

## Q3 - Final gate (watch the assembled film with audio)

- **Speech**: no narration cut by a transition (PAD > FADE everywhere); no
  truncated or empty TTS segments; voice consistent across the film.
- **Audio**: narration clearly above any bed/music; no clipping; no long
  dead silence; subtitles appear exactly when the line is spoken.
- **Subtitles**: fit within safe area, correct language, no mojibake
  (Windows: non-ASCII must not round-trip through a shell pipe).
- **Picture**: correct aspect ratio and fps (25); no dropped black frames;
  Ken Burns stays within still headroom (3840x2160 source).
- **Deliverable**: libx264 yuv420p +faststart; duration within +-0.5s of the
  timing plan; file size sane for its length; opens in a normal player.
- **Beat sync** (only when user-selected strong-beat BGM): every cut/key
  motion lands on the beat grid - re-measure the rendered audio, all cut
  errors <= 3f (ideal <= 1.5f); see references/beat-sync.md.

## Independent final review (before delivery)

Never let the maker self-review their own cut (confirmation bias). Dispatch a
clean-context subagent with only: the finished video (BGM + no-BGM versions),
extracted keyframes, the product brief / storyboard, shot tech-stack list,
design tokens, and the checklists in this file + references/beat-sync.md.
The reviewer reports per-shot verdicts with frame-number evidence (e.g.
"S3 X frame 615: text blurry"; "S5 X frame 340: missing confirmed feature").
The maker fixes, re-previews only the affected shots, re-runs the gate, and
only then renders the final BGM + no-BGM pair.

## If a gate fails

1. Identify the cheapest fix (frame, scene, or script) - never re-render
   blindly.
2. Fix, re-preview that shot only, then re-run the gate.
3. Track repeat failures: two identical failures signal a structural problem
   (change the approach, not the parameter).

## Cost control (keeps quality affordable)

- Preview 3 frames per scene before committing to a full clip render.
- Extract QA frames per shot and at transition midpoints only.
- One vision check per frame, one frame per call.
