# Model Dock For Codex

Give DeepSeek eyes, ears, a voice, and a web connection - through a thin
Responses bridge for OpenCode Go and DeepSeek official.

<p align="center">
  English ·
  <a href="#中文">中文</a> ·
  <a href="#日本語">日本語</a> ·
  <a href="#Français">Français</a> ·
  <a href="#Español">Español</a>
</p>

<p align="center">
  <img src="assets/dashboard.png" alt="ModelDock dashboard" width="100%" />
</p>

## Why Model Dock For Codex

DeepSeek V4 Flash is fast and cheap, but it cannot see, speak, or listen, and
its Responses endpoint has no hosted search. Model Dock For Codex adds all four
as tools, without rewriting the conversation history:

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

The installer checks Node.js >= 22, downloads Model Dock For Codex to
`~/.modeldock`, starts it in the background, and opens the dashboard. Paste your
[opencode.ai](https://opencode.ai/auth) token in the Settings dialog that opens.

## Connect Codex

1. Open **http://127.0.0.1:4097** in your browser
2. Flip the switch on the page
3. Fully quit and restart Codex
4. Pick a Model Dock model in Codex's model picker

## Daily use

**Model picker** - switch the main model in Codex's own picker (bottom-right).
Model Dock shows the active provider and model read-only on the dashboard; it
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
Model Dock starts hidden at every login. A green Update button appears when a
new release is ready - one click downloads, restarts, and reloads.

---

## 中文

给 DeepSeek 装上眼睛、耳朵、声音和网络搜索能力——通过一个薄薄的
Responses 桥接层连接 OpenCode Go 与 DeepSeek 官方 API。

DeepSeek V4 Flash 又快又便宜，但它看不见、听不到、不会说话，Responses
端点也没有内置搜索。Model Dock For Codex 以工具的形式补全这四项能力，且不
改写对话历史：

- **看图** - 把图片粘贴进 Codex，请求会自动路由到视觉模型（默认
  gpt-5.6-luna）；也可以让模型对截图或文件调用 `vision_inspect`。
- **说话** - `speak` 工具把文本合成本地音频文件。
- **听写** - `hear` 工具把音频文件转写成文本。
- **搜索** - `web_search_exa` 工具通过 Exa 查询网络。

桥接层保持 Codex 到上游的 Responses 流逐字节一致：不翻译推理、不压缩工具
历史、不缓冲重组 SSE。多轮工具循环、流式输出和上下文压缩都像原生通道一样
工作。

### 安装

Windows：

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS：

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

安装程序会检查 Node.js >= 22，把 Model Dock For Codex 下载到
`~/.modeldock`，在后台启动并打开仪表盘。在弹出的设置对话框中粘贴你的
[opencode.ai](https://opencode.ai/auth) token。

### 接入 Codex

1. 浏览器打开 **http://127.0.0.1:4097**
2. 打开页面上的开关
3. 完全退出并重启 Codex
4. 在 Codex 的模型菜单里选择 Model Dock 模型

### 日常使用

**模型选择** - 在 Codex 自带的模型选择器（右下角）切换主模型。仪表盘只读
显示当前 provider 和模型，不会改动你的 Codex 模型。

**视觉模型** - 在仪表盘选择视觉模型，用于粘贴的图片和 `vision_inspect`
调用。

**上游** - 同时支持 OpenCode Go 和 DeepSeek 官方。模型 id 中的 owner 后缀
（例如 `deepseek-v4-flash@deepseek-official`）选择上游；不带后缀的 id 走
OpenCode Go。

**语音** - 打开仪表盘的 TTS / STT 磁贴并启用 TTS 或 STT，`speak` 和 `hear`
工具即可供模型使用。

**界面语言** - 仪表盘支持 English、简体中文、日本語、Français、Español，
可在设置 -> 界面语言中随时切换。

**开机自启与更新** - 打开仪表盘的 Autostart 开关，Model Dock 会在每次登录
时隐藏启动。有新版本时出现绿色更新按钮，一键下载、重启并刷新。

---

## 日本語

DeepSeek に目、耳、声、そしてウェブ検索を - 薄い Responses ブリッジ経由で
OpenCode Go と DeepSeek 公式 API をつなぎます。

DeepSeek V4 Flash は速くて安い一方、画像を見られず、話せず、聞けず、
Responses エンドポイントには検索機能もありません。Model Dock For Codex は
これら 4 つをツールとして追加し、会話履歴は書き換えません：

- **見る** - 画像を Codex に貼り付けると、リクエストはビジョンモデル
  （デフォルト gpt-5.6-luna）にルーティングされます。スクリーンショットや
  ファイルには `vision_inspect` を呼べます。
- **話す** - `speak` ツールがテキストをローカル音声ファイルに変換します。
- **聞く** - `hear` ツールが音声ファイルをテキストに書き起こします。
- **検索** - `web_search_exa` ツールが Exa 経由でウェブ検索します。

ブリッジは Codex から上流への Responses ストリームをバイト単位でそのまま
維持します：推論の翻訳なし、ツール履歴の圧縮なし、SSE のバッファ再合成
なし。マルチターンのツールループ、ストリーミング、圧縮はネイティブ同様に
動作します。

### インストール

Windows：

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS：

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

インストーラーは Node.js >= 22 を確認し、Model Dock For Codex を
`~/.modeldock` にダウンロードしてバックグラウンドで起動し、ダッシュボード
を開きます。表示された設定ダイアログに [opencode.ai](https://opencode.ai/auth)
のトークンを貼り付けます。

### Codex への接続

1. ブラウザで **http://127.0.0.1:4097** を開く
2. ページのスイッチをオンにする
3. Codex を完全に終了して再起動する
4. Codex のモデル選択で Model Dock モデルを選ぶ

### 日常使い

**モデル選択** - メインモデルは Codex 側のモデル選択（右下）で切り替えます。
ダッシュボードは現在のプロバイダーとモデルを読み取り専用で表示し、Codex の
モデルは変更しません。

**ビジョンモデル** - ダッシュボードでビジョンモデルを選択します。貼り付け
た画像と `vision_inspect` 呼び出しに使われます。

**上流** - OpenCode Go と DeepSeek 公式の両方をサポートします。モデル ID の
owner サフィックス（例 `deepseek-v4-flash@deepseek-official`）で上流を選択。
サフィックスなしは OpenCode Go になります。

**音声** - ダッシュボードの TTS / STT タイルで有効にすると、`speak` と
`hear` ツールがモデルから使えます。

**言語** - ダッシュボードは English、简体中文、日本語、Français、Español
に対応。設定 -> インターフェース言語でいつでも変更できます。

**自動起動と更新** - Autostart をオンにするとログイン時に隠れて起動します。
新バージョンがあると緑の更新ボタンが現れ、ワンクリックでダウンロード、
再起動、リロードします。

---

## Français

Donnez à DeepSeek des yeux, des oreilles, une voix et un accès au web - via un
mince pont Responses vers OpenCode Go et l'API officielle DeepSeek.

DeepSeek V4 Flash est rapide et économique, mais il ne voit pas, ne parle pas,
n'écoute pas, et son endpoint Responses n'a pas de recherche intégrée. Model
Dock For Codex ajoute ces quatre capacités comme outils, sans réécrire
l'historique de conversation :

- **Voir** - collez une image dans Codex et la requête est routée vers le modèle
  de vision (gpt-5.6-luna par défaut), ou laissez le modèle appeler
  `vision_inspect` sur une capture ou un fichier.
- **Parler** - l'outil `speak` transforme un texte en fichier audio local.
- **Écouter** - l'outil `hear` transcrit un fichier audio en texte.
- **Chercher** - l'outil `web_search_exa` interroge le web via Exa.

Le pont conserve le flux Responses Codex-vers-amont octet pour octet : aucune
traduction du raisonnement, aucune compaction de l'historique d'outils, aucune
resynthèse SSE en mémoire tampon. Les boucles d'outils multi-tours, le streaming
et la compaction fonctionnent comme sur le canal natif.

### Installation

Windows :

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS :

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

L'installeur vérifie Node.js >= 22, télécharge Model Dock For Codex dans
`~/.modeldock`, le démarre en arrière-plan et ouvre le tableau de bord. Collez
votre jeton [opencode.ai](https://opencode.ai/auth) dans la boîte de dialogue.

### Connecter Codex

1. Ouvrez **http://127.0.0.1:4097** dans votre navigateur
2. Activez l'interrupteur sur la page
3. Quittez et redémarrez complètement Codex
4. Choisissez un modèle Model Dock dans le sélecteur de Codex

### Usage quotidien

**Sélecteur de modèle** - changez le modèle principal dans le sélecteur de Codex
(en bas à droite). Model Dock affiche le fournisseur et le modèle actifs en
lecture seule sur le tableau de bord.

**Modèle de vision** - choisissez le modèle de vision sur le tableau de bord. Il
est utilisé pour les images collées et les appels `vision_inspect`.

**Amonts** - OpenCode Go et DeepSeek officiel sont pris en charge. Le suffixe
owner dans l'id du modèle (par exemple
`deepseek-v4-flash@deepseek-official`) sélectionne l'amont ; les ids simples
passent par OpenCode Go.

**Parole** - ouvrez la tuile TTS / STT sur le tableau de bord et activez TTS ou
STT. Les outils `speak` et `hear` deviennent disponibles.

**Langue** - le tableau de bord parle English, 简体中文, 日本語, Français,
Español. Changez-la dans Réglages -> Langue de l'interface.

**Démarrage auto & mises à jour** - activez Autostart ; Model Dock démarre en
caché à chaque connexion. Un bouton vert apparaît quand une nouvelle version est
prête - un clic télécharge, redémarre et recharge.

---

## Español

Dale a DeepSeek ojos, oídos, voz y acceso a la web - mediante un puente fino de
Responses hacia OpenCode Go y la API oficial de DeepSeek.

DeepSeek V4 Flash es rápido y barato, pero no ve, no habla, no escucha y su
endpoint Responses no tiene búsqueda integrada. Model Dock For Codex añade estas
cuatro capacidades como herramientas, sin reescribir el historial de la
conversación:

- **Ver** - pega una imagen en Codex y la solicitud se enruta al modelo de
  visión (gpt-5.6-luna por defecto), o deja que el modelo llame a
  `vision_inspect` sobre una captura o archivo.
- **Hablar** - la herramienta `speak` convierte texto en un archivo de audio
  local.
- **Escuchar** - la herramienta `hear` transcribe un archivo de audio a texto.
- **Buscar** - la herramienta `web_search_exa` consulta la web mediante Exa.

El puente mantiene el flujo Responses de Codex al upstream byte por byte: sin
traducir el razonamiento, sin compactar el historial de herramientas, sin
resintetizar SSE en buffer. Los bucles de herramientas multi-turno, el streaming
y la compactación funcionan como en el canal nativo.

### Instalación

Windows:

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS:

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

El instalador verifica Node.js >= 22, descarga Model Dock For Codex en
`~/.modeldock`, lo inicia en segundo plano y abre el panel. Pega tu token de
[opencode.ai](https://opencode.ai/auth) en el diálogo de configuración.

### Conectar Codex

1. Abre **http://127.0.0.1:4097** en tu navegador
2. Activa el interruptor de la página
3. Cierra y reinicia Codex por completo
4. Elige un modelo Model Dock en el selector de Codex

### Uso diario

**Selector de modelo** - cambia el modelo principal en el selector de Codex
(abajo a la derecha). Model Dock muestra el proveedor y el modelo activos en
solo lectura en el panel.

**Modelo de visión** - elige el modelo de visión en el panel. Se usa para
imágenes pegadas y llamadas `vision_inspect`.

**Upstreams** - se admiten OpenCode Go y DeepSeek oficial. El sufijo owner en el
id del modelo (por ejemplo `deepseek-v4-flash@deepseek-official`) selecciona el
upstream; los ids simples usan OpenCode Go.

**Voz** - abre la tarjeta TTS / STT en el panel y activa TTS o STT. Las
herramientas `speak` y `hear` quedan disponibles.

**Idioma** - el panel habla English, 简体中文, 日本語, Français, Español.
Cámbialo en Ajustes -> Idioma de la interfaz.

**Autostart y actualizaciones** - activa Autostart; Model Dock se inicia oculto
en cada inicio de sesión. Aparece un botón verde cuando hay una nueva versión -
un clic descarga, reinicia y recarga.
