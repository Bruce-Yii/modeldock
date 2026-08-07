# Model Dock For Codex

DeepSeek に目、耳、そして声を — 長いセッションも最後まで安定して続ける。

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.es.md">Español</a>
</p>

<p align="center">
  <img src="assets/dashboard.png" alt="ModelDock ダッシュボード" width="100%" />
</p>

## ModelDock を使う理由

**マルチメディア機能**

DeepSeek V4 Flash は速くてコスパが高い一方、画像を見ることも、話すことも、聞くこともできません。ModelDock が三つをまとめて補います：

- **見る** — Codex に画像を貼り付けると DeepSeek が内容を説明（MiMo V2.5 Free 経由、フォールバックは MiniMax M3）
- **話す** — `speak` ツールでテキストを音声ファイルに変換
- **聞く** — `hear` ツールで音声ファイルをテキストに書き起こし

ダッシュボードの **TTS · STT** タイルで一度オンにすれば、以降のセッションでも有効のまま。

**長いセッションの安定性**

ModelDock は Codex に 250 k のコンテキストウィンドウを宣言し、Codex の自動圧縮を 80 % で起動させます。
セッションチェッカーがモデルの沈黙を検知して作業を促すため、長いコーディングタスクが途中で止まらず完走します。

## インストール

Windows:

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS:

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

インストーラーが Node.js >= 22 を確認し、ModelDock を `~/.modeldock` にダウンロードしてバックグラウンドで起動し、ダッシュボードを開きます。表示される設定ダイアログに [opencode.ai](https://opencode.ai/auth) のトークンを貼り付ければ完了です。

## Codex と接続する

1. ブラウザで **http://127.0.0.1:4097** を開く
2. ページ上のスイッチをオンにする
3. Codex を完全に終了して再起動する
4. Codex のモデル選択メニューで ModelDock のモデルを選ぶ

## 日常の使い方

**モデル選択** — Codex 自身のモデル選択（右下）に到達可能なすべてのモデルがソース付きで表示されます。再起動なしで切り替え可能。

**無料優先** — `Auto - DeepSeek Free first` を選ぶと、無料枠を使い切った瞬間に静かに有料モデルへ切り替わり、1 時間後に自動で無料に戻ります。

**音声** — ダッシュボードの TTS · STT タイルを開き、TTS を一度オンにすると `speak` ツールが使えるようになります。STT は `hear` に対応します。

**表示言語** — ダッシュボードは English・简体中文・日本語・Français・Español に対応。設定 → 表示言語からいつでも変更できます。

**自動起動とアップデート** — Autostart トグルをオンにすると、ログインのたびにバックグラウンドで起動します。新バージョンがあると緑の「更新」ボタンが表示され、クリック一つでダウンロード・再起動・ページリロードまで完了します。
