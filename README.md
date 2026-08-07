# Model Dock For Codex

Give DeepSeek eyes, ears, a voice, and a web connection - through a thin
Responses bridge for OpenCode Go and DeepSeek official.

<p align="center">
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.es.md">Español</a>
</p>

## Why ModelDock

DeepSeek V4 Flash is fast and cheap, but it cannot see, speak, or listen, and
its Responses endpoint has no hosted search. ModelDock adds all four as tools,
without rewriting the conversation history:

- **See** - paste an image into Codex and the request is routed to the vision
  model (gpt-5.6-luna by default), or let the model call `vision_inspect` on a
  screenshot or file.
- **Speak** - the `speak` tool turns text into a local audio file.
- **Hear** - the `hear` tool transcribes an audio file back to text.
- **Search** - the `web_search_exa` tool queries the web through Exa.

The bridge keeps the Codex-to-upstream Responses stream byte-for-byte
identical: no reasoning translation, no tool-history compaction, no buffered
SSE resynthesis. Multi-turn tool loops, streaming, and compaction behave the
way they do on the native channel.

## Install

Windows:

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS:

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

The installer checks Node.js >= 22, downloads ModelDock to `~/.modeldock`,
starts it in the background, and opens the dashboard. Paste your
[opencode.ai](https://opencode.ai/auth) token in the Settings dialog that opens.

## Connect Codex

1. Open **http://127.0.0.1:4097** in your browser
2. Flip the switch on the page
3. Fully quit and restart Codex
4. Pick a ModelDock model in Codex's model picker

## Daily use

**Model picker** - switch the main model in Codex's own picker (bottom-right).
ModelDock shows the active provider and model read-only on the dashboard; it
does not change your Codex model.

**Vision model** - choose the vision model from the dashboard picker. It is
used for pasted images and for `vision_inspect` calls.

**Upstreams** - OpenCode Go and DeepSeek official are both supported. The
owner suffix in the model id (for example `deepseek-v4-flash@deepseek-official`)
selects the upstream; plain ids resolve to OpenCode Go.

**Speech** - open the TTS / STT tile on the dashboard and toggle TTS or STT on.
The `speak` and `hear` tools become available to the model.

**Language** - the dashboard speaks English, 简体中文, 日本語, Français,
Español. Change it anytime under Settings -> Interface language.

**Autostart & updates** - flip the Autostart toggle on the dashboard;
ModelDock starts hidden at every login. A green Update button appears when a
new release is ready - one click downloads, restarts, and reloads.
