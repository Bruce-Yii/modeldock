# ModelDock

**给 DeepSeek 装上眼睛，让 Codex 用上 OpenCode Go。**

ModelDock 是一个本地小工具，两件本事：

- **给 DeepSeek V4 Flash 增加 Vision 能力** —— 当前视觉轮次自动交给 Go 内的 Luna（Kimi 备用），下一轮再回到 DeepSeek；DeepSeek 也可以通过本地视觉工具请求 Luna 观察图片。
- **把 OpenCode Go 桥接给 Codex（API Bridge）** —— ModelDock 在本地转发并规范化 Codex Responses 请求；Codex 的 Shell、文件和 MCP 等本地工具照常工作，不兼容的 hosted web/tool search 会替换成本地编排的 Exa 搜索。

## 你得到什么

| 能力 | 说明 |
| --- | --- |
| 🖼️ DeepSeek 也能看图 | 截图、图表、UI 图，视觉模型分析后回传文字结果 |
| 🔗 接入 Codex | 仪表盘备份并切换用户配置，重启 Codex 后生效 |
| 🧰 工具循环保留 | 保留 Codex 本地工具，并适配 Go 不接受的 hosted tool schema |
| 📊 一目了然的仪表盘 | 用量、延迟、最近请求，打开浏览器就能看 |

## 快速开始

**方法一：自己动手（约 5 分钟）**

**第 0 步：把项目拿下来**

- 方式 A（推荐）：在终端运行 `git clone https://github.com/architectds/modeldock`
- 方式 B：到 <https://github.com/architectds/modeldock> 点绿色 **Code** 按钮 → **Download ZIP**，解压到你喜欢的文件夹

完成后，你会看到一个文件夹（含 `package.json`、`src`、`public` 等）。

**第 1 步：确认/安装 Node.js**

在终端运行 `node -v`：
- 显示 `v22.x` 或更高 → 跳过
- 没有或版本低于 22 → 到 <https://nodejs.org> 下载安装 **LTS 版本**，装完重开终端

**第 2 步：填 API token（.env 文件）**

在**项目根目录**（和 `package.json` 同一个文件夹）里：

1. 找到 `.env.example` 文件
2. 复制一份，重命名为 `.env`
3. 用记事本打开 `.env`，把这一行改成：

   ```
   OPENCODE_GO_TOKEN=你的token
   ```

   Token 从 <https://opencode.ai/auth> 登录获取（OpenCode Go 订阅的 API key）。

   （`.env` 只在本地生效，不会上传或被提交到 GitHub。）

**第 3 步：安装依赖并启动**

在项目文件夹打开终端，先运行 `npm install`，再运行 `npm start`。

Windows 用户也可以运行 `powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1` 创建 `ModelDock` 桌面快捷方式，以后双击启动。

**第 4 步：接入 Codex**

1. 浏览器打开 <http://127.0.0.1:4097>
2. 打开页面上的开关
3. **完全退出并重启 Codex**
4. Codex 里选择 ModelDock 模型 —— 完成

**方法二：让 AI 帮你装**

把本仓库地址发给你的 AI 编程助手（Codex / Claude Code / Cursor 等）：

```
https://github.com/architectds/modeldock
```

告诉它："帮我安装这个 ModelDock，并按 .env.example 配置好 OpenCode Go token。" 它会把安装、配置、启动全部搞定。

## 它怎么工作（大白话版）

```text
Codex ──> ModelDock ──> OpenCode Go / DeepSeek
                │
                └──> 图片交给视觉模型 ──> 结果回灌 DeepSeek
```

ModelDock 的网关和仪表盘只监听本机（127.0.0.1）；模型、视觉和 Exa 搜索请求仍会发往对应云服务。仪表盘只显示脱敏后的用量和状态，不显示提示词、图片内容或密钥。

---

## English

**Give DeepSeek eyes. Connect Codex to OpenCode Go.**

ModelDock is a small local helper with two superpowers:

- **Vision for DeepSeek V4 Flash** — Visual turns are routed to Luna on Go (with Kimi fallback), then the next independent turn returns to DeepSeek. DeepSeek can also request a Luna observation through a local vision tool.
- **OpenCode Go bridge for Codex** — ModelDock forwards and normalizes Codex Responses requests. Local shell, file, and MCP tools keep working; incompatible hosted web/tool-search schemas are replaced with locally orchestrated Exa search.

## What you get

| Capability | What it means |
| --- | --- |
| 🖼️ DeepSeek sees images | Screenshots, charts, UI — analyzed by a vision model, summarized back in text |
| 🔗 Connect Codex | The dashboard backs up and switches the user config; restart Codex to apply |
| 🧰 Tool loops preserved | Keeps local Codex tools and adapts hosted schemas that Go rejects |
| 📊 One-glance dashboard | Usage, latency, recent requests in your browser |

## Quick start

**Option A: Do it yourself (~5 minutes)**

**Step 0: Get the project**

- Option A (recommended): run `git clone https://github.com/architectds/modeldock` in a terminal
- Option B: go to <https://github.com/architectds/modeldock>, click the green **Code** button → **Download ZIP**, unzip it anywhere you like

You'll get a folder containing `package.json`, `src`, `public`, etc.

**Step 1: Check / install Node.js**

Run `node -v` in a terminal:
- Shows `v22.x` or newer → skip
- Not installed or older → download the **LTS version** from <https://nodejs.org>, install, then reopen your terminal

**Step 2: Add your API token (the .env file)**

In the **project root folder** (the same folder as `package.json`):

1. Find the `.env.example` file
2. Copy it and rename the copy to `.env`
3. Open `.env` in a text editor and change this line to:

   ```
   OPENCODE_GO_TOKEN=your-token
   ```

   Get the token by signing in at <https://opencode.ai/auth> (the OpenCode Go subscription API key).

   (`.env` stays local — it's never uploaded or committed to GitHub.)

**Step 3: Install dependencies and launch**

Open a terminal in the project folder, run `npm install`, then run `npm start`.

On Windows, you can also run `powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1` once to create a `ModelDock` desktop shortcut for future launches.

**Step 4: Connect Codex**

1. Open <http://127.0.0.1:4097> in your browser
2. Flip the switch on the page
3. **Fully quit and restart Codex**
4. Pick the ModelDock model in Codex — done

**Option B: Let your AI do it**

Send this repo URL to your AI coding assistant (Codex / Claude Code / Cursor, etc.):

```
https://github.com/architectds/modeldock
```

Tell it: "Help me install ModelDock and configure the OpenCode Go token from .env.example." It will handle the clone, install, setup, and launch for you.

## How it works (plain English)

```text
Codex ──> ModelDock ──> OpenCode Go / DeepSeek
                │
                └──> images go to a vision model ──> results feed back to DeepSeek
```

The ModelDock gate and dashboard listen only on your machine (127.0.0.1). Model, vision, and Exa search requests still go to their cloud services. The dashboard shows sanitized usage and status, not prompt text, image content, or keys.

---

## 日本語

**DeepSeek に視覚を。Codex を OpenCode Go へ。**

ModelDock はローカルで動く小さなヘルパーです。できることはふたつ：

- **DeepSeek V4 Flash にビジョン機能を追加** — 画像を含むターンは Go 上の Luna（Kimi フォールバック）へ送り、次の独立したターンで DeepSeek に戻ります。DeepSeek からローカルの視覚ツール経由で Luna に観察を依頼することもできます。
- **Codex と OpenCode Go の API ブリッジ** — ModelDock は Codex Responses をローカルで転送・正規化します。Shell、ファイル、MCP などのローカルツールを保ち、Go が受け付けない hosted web/tool search は Exa 検索に置き換えます。

## できること

| 機能 | 説明 |
| --- | --- |
| 🖼️ DeepSeek で画像認識 | スクリーンショット、グラフ、UI をビジョンモデルが解析し、テキストで返却 |
| 🔗 Codex に接続 | ダッシュボードがユーザー設定をバックアップして切り替え、Codex 再起動後に反映 |
| 🧰 ツールループを維持 | ローカルツールを保ち、Go 非対応の hosted schema を変換 |
| 📊 一目でわかるダッシュボード | 使用量・遅延・直近のリクエストをブラウザで確認 |

## クイックスタート

**方法 A: 自分でセットアップ（約5分）**

**ステップ 0: プロジェクトを入手**

- 方法 A（推奨）: ターミナルで `git clone https://github.com/architectds/modeldock` を実行
- 方法 B: <https://github.com/architectds/modeldock> で緑の **Code** ボタン → **Download ZIP** をクリックし、好きな場所に解凍

`package.json`、`src`、`public` などが入ったフォルダができます。

**ステップ 1: Node.js の確認 / インストール**

ターミナルで `node -v` を実行:
- `v22.x` 以上が表示される → 次のステップへ
- 未インストールまたは古い場合 → <https://nodejs.org> から **LTS版** をダウンロードしてインストールし、ターミナルを開き直す

**ステップ 2: API トークンを設定（.env ファイル）**

**プロジェクトのルートフォルダ**（`package.json` と同じ場所）で:

1. `.env.example` ファイルを探す
2. コピーして、名前を `.env` に変更
3. テキストエディタで `.env` を開き、次の行を変更:

   ```
   OPENCODE_GO_TOKEN=あなたのトークン
   ```

   トークンは <https://opencode.ai/auth> にログインして取得します（OpenCode Go サブスクリプションの API キー）。

   （`.env` はローカルのみで有効。アップロードや GitHub へのコミットはされません。）

**ステップ 3: 依存関係をインストールして起動**

プロジェクトフォルダでターミナルを開き、`npm install`、続けて `npm start` を実行します。

Windows では `powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1` を一度実行すると、次回以降に使える `ModelDock` デスクトップショートカットを作成できます。

**ステップ 4: Codex と接続**

1. ブラウザで <http://127.0.0.1:4097> を開く
2. ページ上のスイッチをオンにする
3. **Codex を完全に終了して再起動**
4. Codex で ModelDock モデルを選択 — 完了

**方法 B: AI にやってもらう**

このリポジトリ URL を AI コーディングアシスタント（Codex / Claude Code / Cursor など）に渡します:

```
https://github.com/architectds/modeldock
```

「ModelDock をインストールして、.env.example に従ってトークンを設定して」と伝えるだけで、クローン・インストール・設定・起動まで全部やってくれます。

## 仕組み（やさしい説明）

```text
Codex ──> ModelDock ──> OpenCode Go / DeepSeek
                │
                └──> 画像はビジョンモデルへ ──> 結果を DeepSeek へフィードバック
```

ModelDock のゲートとダッシュボードはローカル（127.0.0.1）のみで待ち受けます。モデル、視覚、Exa 検索のリクエストは各クラウドサービスへ送信されます。ダッシュボードにはサニタイズ済みの使用量と状態だけが表示され、プロンプト本文、画像内容、キーは表示されません。
