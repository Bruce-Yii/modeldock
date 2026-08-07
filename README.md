# ModelDock

Give DeepSeek eyes, ears, and a voice — and keep long sessions on track.

<p align="center">
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.es.md">Español</a>
</p>

<p align="center">
  <img src="assets/dashboard.png" alt="ModelDock dashboard" width="100%" />
</p>

## Why ModelDock

**Multimedia**

DeepSeek V4 Flash is fast and cheap, but it cannot see, speak, or listen. ModelDock adds all three:

- **See** — drop an image into Codex; DeepSeek gets a description back (routed to MiMo V2.5 Free, fallback MiniMax M3)
- **Speak** — the `speak` tool turns any text into an audio file
- **Hear** — the `hear` tool transcribes an audio file back to text

Enable speech in the **TTS · STT** tile on the dashboard; it stays on across sessions.

**Long sessions**

ModelDock declares a 250 k context window to Codex, which triggers Codex's built-in auto-compaction at 80 %. A session checker nudges the model when it goes quiet, so a long coding job keeps running instead of stopping mid-way.

## Install

Windows:

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS:

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

The installer checks Node.js >= 22, downloads ModelDock to `~/.modeldock`, starts it in the background, and opens the dashboard. Paste your [opencode.ai](https://opencode.ai/auth) token in the Settings dialog that opens.

## Connect Codex

1. Open **http://127.0.0.1:4097** in your browser
2. Flip the switch on the page
3. Fully quit and restart Codex
4. Pick any ModelDock model in Codex's model picker

## Daily use

**Model picker** — every reachable model appears in Codex's own picker (bottom-right), labelled by source. Switch without restarting.

**Free-first** — pick `Auto - DeepSeek Free first`. ModelDock uses the free quota, silently falls back to the paid model on exhaustion, and retries free after an hour.

**Speech** — open the TTS · STT tile on the dashboard. Toggle TTS on once; the `speak` tool becomes available to the model. Toggle STT for `hear`.

**Language** — the dashboard speaks English, 简体中文, 日本語, Français, Español. Change anytime under Settings → Interface language.

**Autostart & updates** — flip the Autostart toggle on the dashboard; ModelDock starts hidden at every login. A green Update button appears when a new release is ready — one click downloads, restarts, and reloads.
