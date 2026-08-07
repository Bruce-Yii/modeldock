# ModelDock

**Give DeepSeek eyes. Connect Codex to Other API providers.**

<p align="center">
  <a href="#en">English</a> ·
  <a href="#zh">中文</a> ·
  <a href="#ja">日本語</a>
</p>

<p align="center">
  <img src="assets/dashboard.png" alt="ModelDock dashboard" width="100%" />
</p>

<details open id="en">
<summary>English</summary>

**Give DeepSeek eyes. Connect Codex to Other API providers.**

ModelDock is a small local helper with two superpowers:

- **Vision for DeepSeek V4 Flash** — Visual turns are routed to a vision model (MiMo V2.5 Free by default, with MiniMax M3 fallback), then the next independent turn returns to DeepSeek. DeepSeek can also request a vision observation through a local vision tool, including local screenshot files.
- **API bridge for Codex** — ModelDock forwards and normalizes Codex Responses requests. Local shell, file, and MCP tools keep working; incompatible hosted web/tool-search schemas are replaced with locally orchestrated Exa search.

## What you get

| Capability | What it means |
| --- | --- |
| 🖼️ DeepSeek sees images | Screenshots, charts, UI — analyzed by a vision model, summarized back in text |
| 🔗 Connect Codex | The dashboard backs up and switches the user config; restart Codex to apply |
| 🧰 Tool loops preserved | Keeps local Codex tools and adapts hosted schemas that Go rejects |
| 📊 One-glance dashboard | Usage, latency, recent requests in your browser |
| 🎚️ Every model in Codex's picker | Switch model — and provider — from Codex itself, no restart |
| 💸 Free-first mode | Runs on the free model and slips over to the paid one when it runs out |
| 🗣️ Speech tools | `speak` turns text into an audio file; `hear` transcribes audio back to text |
| 🌍 Five languages | English, 简体中文, 日本語, Français, Español — follows your browser |
| 🔄 Self-updating | Checks GitHub on startup; a small Update button updates and restarts in one click |

## Quick start

**Option A: One-line install (recommended)**

Windows (PowerShell):

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS (Terminal):

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

The installer checks Node.js (>= 22, guides you to it if missing), downloads the latest
single-file release into `~/.modeldock`, starts ModelDock in the background, and opens
the dashboard. Paste your API token into the Settings dialog that pops up — get one by
signing in at <https://opencode.ai/auth> — and you are done.

**Option B: Let your AI do it**

Send this repo URL to your AI coding assistant (Codex / Claude Code / Cursor, etc.):

```
https://github.com/architectds/modeldock
```

Tell it: "Help me install ModelDock and configure the API token." It will handle the
install, setup, and launch for you.

**Connect Codex**

1. Open <http://127.0.0.1:4097> in your browser
2. Flip the switch on the page
3. **Fully quit and restart Codex**
4. Pick the ModelDock model in Codex — done

## Choosing a model

Every model ModelDock can reach shows up in **Codex's own model picker** (bottom right),
labelled by where it comes from — `OpenCode Go - GLM 5.2`, `DeepSeek Official - DeepSeek
V4 Flash`. Pick one and it takes effect on the next message: no config editing, no
restart. The dashboard follows along and always shows the model actually in use.

There is also an **`Auto - DeepSeek Free first`** entry. Pick it and ModelDock sends your
work to the free model, and the moment that upstream refuses — quota gone, or anything
else — it retries on the paid one before a single character has reached Codex. You see a
slightly slower first word instead of an error. It stays on the paid model for an hour,
then tries free again on its own.

## Speech

The dashboard has a **TTS · STT** tile. Turn TTS on once and it installs a small speech
package; from then on the model can call `speak` to turn text into an audio file. `hear`
does the reverse — it transcribes an audio file back to text using Windows' built-in
recognizer (Windows only, and non-WAV input needs ffmpeg). Both stay off until you switch
them on.

## Interface language

The dashboard speaks **English, 简体中文, 日本語, Français and Español**. It follows your
browser on first run and you can change it any time under **Settings → Interface
language**; the choice is remembered on this machine.

## Start at login & automatic updates

- **Start at login** (Windows / macOS): flip the **Autostart** toggle on the dashboard.
  ModelDock then launches hidden in the background every time you log in — no terminal
  window, nothing to remember. Flip it off any time from the same toggle.
- **Update check on startup**: every time ModelDock starts, it compares itself against
  the newest GitHub release. If a newer version exists, a small green **Update** button
  appears in the dashboard header.
- **One-click update**: click that button — ModelDock downloads the new version,
  restarts itself, and the page reloads when it is back. Your token and settings are
  kept (they live in your local config file, outside the app).
- Running from a **git checkout** (developers)? The Update button runs `git pull` for
  you, or just pull manually and restart.
- **Update safety**: updates come only from this repository's GitHub Releases, over
  HTTPS. Before installing, ModelDock verifies the download against the release's
  SHA256 checksum — a corrupted or tampered file is refused — and it never replaces
  itself with an older version. If verification fails, the running version just keeps
  running.

## How it works (plain English)

```text
Codex ──> ModelDock ──> your API / DeepSeek
                │
                └──> images go to a vision model ──> results feed back to DeepSeek
```

The ModelDock gate and dashboard listen only on your machine (127.0.0.1). Model, vision, and Exa search requests still go to their cloud services. The dashboard shows sanitized usage and status, not prompt text, image content, or keys.

---

</details>

<details open id="zh">
<summary>中文</summary>

**给 DeepSeek 装上眼睛，让 Codex 用上其他 API。**

ModelDock 是一个本地小工具，两件本事：

- **给 DeepSeek V4 Flash 增加 Vision 能力** —— 当前视觉轮次自动交给视觉模型（默认 MiMo V2.5 Free，兜底 MiniMax M3），下一轮再回到 DeepSeek；DeepSeek 也可以通过本地视觉工具请求观察图片，包括本地截图文件。
- **把其他 API 桥接给 Codex（API Bridge）** —— ModelDock 在本地转发并规范化 Codex Responses 请求；Codex 的 Shell、文件和 MCP 等本地工具照常工作，不兼容的 hosted web/tool search 会替换成本地编排的 Exa 搜索。

## 你得到什么

| 能力 | 说明 |
| --- | --- |
| 🖼️ DeepSeek 也能看图 | 截图、图表、UI 图，视觉模型分析后回传文字结果 |
| 🔗 接入 Codex | 仪表盘备份并切换用户配置，重启 Codex 后生效 |
| 🧰 工具循环保留 | 保留 Codex 本地工具，并适配上游 API 不接受的 hosted tool schema |
| 📊 一目了然的仪表盘 | 用量、延迟、最近请求，打开浏览器就能看 |
| 🎚️ 模型都在 Codex 选单里 | 在 Codex 里直接换模型、换来源，不用重启 |
| 💸 免费优先模式 | 先用免费模型，额度用尽自动切到付费，你不会看到报错 |
| 🗣️ 语音工具 | `speak` 把文字合成语音文件，`hear` 把音频转写回文字 |
| 🌍 五种界面语言 | English、简体中文、日本語、Français、Español，跟随浏览器 |
| 🔄 自动更新 | 启动时自检新版本，仪表盘一键更新并自动重启 |

## 快速开始

**方法一：一行命令安装（推荐）**

Windows（PowerShell）：

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS（终端）：

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

安装器会检查 Node.js（需 22+，没有会引导你安装），把最新的单文件版本下载到 `~/.modeldock`，后台启动 ModelDock 并打开仪表盘。在自动弹出的设置窗口里粘贴 API token（到 <https://opencode.ai/auth> 登录获取）即可 —— 完成。

**方法二：让 AI 帮你装**

把本仓库地址发给你的 AI 编程助手（Codex / Claude Code / Cursor 等）：

```
https://github.com/architectds/modeldock
```

告诉它："帮我安装这个 ModelDock，并配置好 API token。" 它会把安装、配置、启动全部搞定。

**接入 Codex**

1. 浏览器打开 <http://127.0.0.1:4097>
2. 打开页面上的开关
3. **完全退出并重启 Codex**
4. Codex 里选择 ModelDock 模型 —— 完成

## 选择模型

ModelDock 能连到的每个模型，都会出现在 **Codex 自己的模型选单**（右下角）里，并标明来源——`OpenCode Go - GLM 5.2`、`DeepSeek Official - DeepSeek V4 Flash`。选中后下一条消息就生效：不用改配置，不用重启。仪表盘会跟着走，永远显示当前真正在用的模型。

选单里还有一项 **`Auto - DeepSeek Free first`**。选它之后，ModelDock 会先把活派给免费模型；一旦免费上游拒绝——额度用尽，或是别的任何原因——它会在**一个字都还没送到 Codex 之前**改用付费模型重试。你只会觉得第一个字慢了一点，而不会看到报错。之后一小时内保持付费，然后自动再试免费。

## 语音

仪表盘上有一栏 **TTS · STT**。把 TTS 打开一次会自动装一个小的语音包，之后模型就能用 `speak` 把文字合成音频文件。`hear` 是反过来的——用 Windows 自带的识别引擎把音频转写回文字（仅 Windows，非 WAV 输入需要 ffmpeg）。不主动打开就一直是关闭状态。

## 界面语言

仪表盘支持 **English、简体中文、日本語、Français、Español**。首次打开会跟随你的浏览器语言，之后可以随时在**设置 → 界面语言**里更改，选择会记在本机。

## 开机自启与自动更新

- **开机自启**（Windows / macOS）：打开仪表盘上的 **Autostart** 开关，之后每次登录系统，ModelDock 都会自动在后台隐藏运行——没有终端窗口，也不用记着去启动。想关掉，同一个开关拨回去就行。
- **启动时自检新版本**：ModelDock 每次启动都会和 GitHub 上的最新发布版本比对，发现有新版时，仪表盘顶部会出现一个小小的绿色**更新**按钮。
- **一键更新**：点一下按钮——自动下载新版本、自动重启，页面恢复后自动刷新。你的 token 和设置都会保留（它们存在本地配置文件里，不在程序本体内）。
- 用 **git 检出**跑的（开发者）？更新按钮会帮你执行 `git pull`，或者自己 pull 之后重启也一样。
- **更新安全**：更新只从本仓库的 GitHub Releases 走 HTTPS 获取。安装前 ModelDock 会用发布版附带的 SHA256 校验和验证下载内容——损坏或被篡改的文件会被直接拒绝——并且永远不会把自己替换成更旧的版本。校验不通过时，当前版本继续照常运行。

## 它怎么工作（大白话版）

```text
Codex ──> ModelDock ──> 你的 API / DeepSeek
                │
                └──> 图片交给视觉模型 ──> 结果回灌 DeepSeek
```

ModelDock 的网关和仪表盘只监听本机（127.0.0.1）；模型、视觉和 Exa 搜索请求仍会发往对应云服务。仪表盘只显示脱敏后的用量和状态，不显示提示词、图片内容或密钥。

---

</details>

<details open id="ja">
<summary>日本語</summary>

**DeepSeek に視覚を。Codex を他の API プロバイダーへ。**

ModelDock はローカルで動く小さなヘルパーです。できることはふたつ：

- **DeepSeek V4 Flash にビジョン機能を追加** — 画像を含むターンはビジョンモデル（既定は MiMo V2.5 Free、フォールバックは MiniMax M3）へ送り、次の独立したターンで DeepSeek に戻ります。DeepSeek からローカルの視覚ツール経由で観察を依頼することもでき、ローカルのスクリーンショットにも対応します。
- **Codex への API ブリッジ** — ModelDock は Codex Responses をローカルで転送・正規化します。Shell、ファイル、MCP などのローカルツールを保ち、上流 API が受け付けない hosted web/tool search は Exa 検索に置き換えます。

## できること

| 機能 | 説明 |
| --- | --- |
| 🖼️ DeepSeek で画像認識 | スクリーンショット、グラフ、UI をビジョンモデルが解析し、テキストで返却 |
| 🔗 Codex に接続 | ダッシュボードがユーザー設定をバックアップして切り替え、Codex 再起動後に反映 |
| 🧰 ツールループを維持 | ローカルツールを保ち、上流 API 非対応の hosted schema を変換 |
| 📊 一目でわかるダッシュボード | 使用量・遅延・直近のリクエストをブラウザで確認 |
| 🎚️ Codex のモデル選択に全モデル | Codex 側でモデルも接続先も切り替え可能、再起動不要 |
| 💸 無料優先モード | 無料モデルで動き、上限に達したら自動で有料へ切り替え |
| 🗣️ 音声ツール | `speak` はテキストを音声ファイルに、`hear` は音声をテキストに変換 |
| 🌍 5 言語対応 | English・簡体中文・日本語・Français・Español、ブラウザ設定に追従 |
| 🔄 自動アップデート | 起動時に新バージョンを確認、ワンクリックで更新・再起動 |

## クイックスタート

**方法 A: ワンライナーでインストール（推奨）**

Windows（PowerShell）:

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS（ターミナル）:

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

インストーラーが Node.js（22 以上、無ければ案内あり）を確認し、最新の単一ファイル版を `~/.modeldock` にダウンロードして ModelDock をバックグラウンドで起動し、ダッシュボードを開きます。自動で表示される設定ダイアログに API トークン（<https://opencode.ai/auth> にログインして取得）を貼り付ければ完了です。

**方法 B: AI にやってもらう**

このリポジトリ URL を AI コーディングアシスタント（Codex / Claude Code / Cursor など）に渡します:

```
https://github.com/architectds/modeldock
```

「ModelDock をインストールして、API トークンを設定して」と伝えるだけで、インストール・設定・起動まで全部やってくれます。

**Codex と接続**

1. ブラウザで <http://127.0.0.1:4097> を開く
2. ページ上のスイッチをオンにする
3. **Codex を完全に終了して再起動**
4. Codex で ModelDock モデルを選択 — 完了

## モデルの選び方

ModelDock が到達できるモデルはすべて、**Codex 自身のモデル選択メニュー**（右下）に接続元付きで表示されます — `OpenCode Go - GLM 5.2`、`DeepSeek Official - DeepSeek V4 Flash` のように。選べば次のメッセージから有効になり、設定の編集も再起動も不要です。ダッシュボードもそれに追従し、実際に使われているモデルを常に表示します。

メニューには **`Auto - DeepSeek Free first`** という項目もあります。これを選ぶと ModelDock はまず無料モデルに送り、その上流が拒否した瞬間 — 上限到達でも、それ以外の理由でも — **Codex に 1 文字も届く前に**有料モデルで再試行します。エラーではなく、最初の一語がわずかに遅れるだけです。その後 1 時間は有料のままで、自動的にまた無料を試します。

## 音声

ダッシュボードに **TTS · STT** のタイルがあります。TTS を一度オンにすると小さな音声パッケージが導入され、以降モデルは `speak` でテキストを音声ファイルに変換できます。`hear` はその逆で、Windows 内蔵の音声認識で音声をテキストに戻します（Windows のみ、WAV 以外の入力には ffmpeg が必要）。どちらも有効にするまではオフのままです。

## 表示言語

ダッシュボードは **English・簡体中文・日本語・Français・Español** に対応しています。初回はブラウザの設定に従い、**設定 → 表示言語**からいつでも変更できます。選択内容はこの端末に保存されます。

## ログイン時の自動起動と自動アップデート

- **ログイン時に自動起動**（Windows / macOS）: ダッシュボードの **Autostart** トグルをオンにすると、ログインのたびに ModelDock がバックグラウンドで自動起動します。ターミナルは不要です。オフにしたいときは同じトグルを戻すだけ。
- **起動時のアップデート確認**: ModelDock は起動のたびに GitHub の最新リリースと自分を比較します。新しいバージョンがあると、ダッシュボード上部に小さな緑の**更新**ボタンが表示されます。
- **ワンクリック更新**: ボタンを押すと、新バージョンのダウンロードと再起動が自動で行われ、復帰後にページも自動リロードされます。トークンや設定はローカルの設定ファイルに保存されているため、そのまま引き継がれます。
- **git チェックアウト**で動かしている場合（開発者向け）は、更新ボタンが `git pull` を実行します。手動で pull して再起動しても同じです。
- **アップデートの安全性**: 更新は本リポジトリの GitHub Releases からのみ、HTTPS 経由で取得します。インストール前にリリース付属の SHA256 チェックサムで検証し、破損・改ざんされたファイルは拒否します。また、古いバージョンへ置き換わることはありません。検証に失敗した場合は、現行バージョンがそのまま動き続けます。

## 仕組み（やさしい説明）

```text
Codex ──> ModelDock ──> ご利用の API / DeepSeek
                │
                └──> 画像はビジョンモデルへ ──> 結果を DeepSeek へフィードバック
```

ModelDock のゲートとダッシュボードはローカル（127.0.0.1）のみで待ち受けます。モデル、視覚、Exa 検索のリクエストは各クラウドサービスへ送信されます。ダッシュボードにはサニタイズ済みの使用量と状態だけが表示され、プロンプト本文、画像内容、キーは表示されません。

</details>
