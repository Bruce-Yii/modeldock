# Classification Reference

How to decide what kind of video to make from arbitrary source content.
`scripts/classify.mjs` gives a fast, deterministic first pass; this document
is the authority for judgment calls the script cannot make.

## Decision order

1. **User intent beats content signals.** If the user says "make a TikTok",
   "promo", "story", or "tutorial", follow that even when the source text
   suggests something else. Ask only when intent is genuinely ambiguous.
2. **Source type sets the ceiling.** A `.pptx` deck -> slides-to-video. An
   audio file -> podcast-video. A README -> promo or explainer (ask the
   two-shot question below). Raw numbers-heavy text -> data-story.
3. **Format follows distribution, not content.** Who will watch it and where?
   Social feeds want 9:16; YouTube/website/broadcast want 16:9; an internal
   report may want 1:1 in a dashboard.
4. **Duration follows the medium, not the source length.** An 8000-word
   article does not mean an 8-minute video. Target ranges below; trim
   ruthlessly.

## Content types

| Type | Source smells like | Typical trigger | Format | Duration target |
| --- | --- | --- | --- | --- |
| promo | README, product page, feature list, launch notes | "make a promo/launch video" | 16:9 | 30-60s |
| explainer | article, docs, "what is X", overview | "explain this", "turn this article into a video" | 16:9 | 60-120s |
| tutorial | how-to, steps, install/configure, code blocks | "show me how to do X" | 16:9 | 90-180s |
| story | novel, script, dialogue, chapters | "turn this story into a film" | 16:9 (cinematic) | 60-180s |
| slides | .pptx/.key/.pdf deck | "animate my deck" | 16:9 | deck-length |
| data | reports, metrics, charts, percentages | "visualize this report" | 16:9 or 1:1 | 30-90s |
| social | listicles, hacks, hooks, hashtags | "make a short" | 9:16 | 15-45s |
| podcast | audio, transcript, episode | "make a video from this episode" | 16:9 | clip or full |

## The two-shot question (promo vs explainer)

For product-ish text, decide between promo and explainer with one question:
is the goal to *sell* (promo: message + proof + CTA) or to *teach* (explainer:
concept -> mechanism -> example)? When in doubt, default to explainer - it is
the easier to make good, and users rarely mind.

## Presets (from classify.mjs)

Each content type maps to: pipeline, format, duration target, pacing
(slow/standard/fast), visual strategy, TTS voice profile. The script emits
these; adjust them only with a stated reason (distribution, brand, audience).

## Language

- Detect CJK vs Latin from the source (the script reports `lang_hint`).
- Pick per-language voice and subtitle style; keep the build parameterized by
  `--lang` (one builder, per-language narration JSON) - or with HyperFrames,
  per-language text via `--variables`/`--batch` (see references/hyperframes.md).
- Never pass non-ASCII text through a PowerShell pipe (encoding mangling);
  read UTF-8 files from disk or write with Node fs utf8.

## Edge cases and overrides

- **Mixed signals** (README with tutorial section): pick the dominant type,
  then steal the other's useful elements (e.g. promo with a short how-it-works
  beat).
- **Product + story**: brand story -> promo pipeline with story structure, not
  the story pipeline.
- **No signal at all**: default explainer at 60s; confirm message with the
  user before production.
- **User gives a URL**: fetch it, then classify the fetched text.
- **User gives media**: screenshots/recordings are assets, not source; ask
  what message they should carry before planning.

## Confidence rules

- confidence >= 0.8 from the script: trust it unless intent contradicts.
- 0.5-0.8: state the top-2 candidates and pick with intent, then move on.
- < 0.5: stop and ask one question (audience + desired duration) before
  planning.
