# Model Dock For Codex

给 DeepSeek 装上眼睛、耳朵和嘴——让长会话稳定跑完。

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.es.md">Español</a>
</p>

<p align="center">
  <img src="assets/dashboard.png" alt="ModelDock 仪表盘" width="100%" />
</p>

## 为什么用 ModelDock

**多媒体能力**

DeepSeek V4 Flash 既快又省钱，但它天生看不见、听不到、也不会说话。ModelDock 一次补齐三项：

- **看图** — 把图片丢进 Codex，DeepSeek 就能看懂（路由到 MiMo V2.5 Free，兜底 MiniMax M3）
- **说话** — `speak` 工具把任意文字合成为音频文件
- **听写** — `hear` 工具把音频文件转写回文字

在仪表盘的 **TTS · STT** 栏开启一次，之后跨会话永久生效。

**长会话稳定性**

ModelDock 向 Codex 声明 250 k 上下文窗口，触发 Codex 在 80% 时自动压缩。
会话检查器会在模型停下来时主动追问，让一个长编码任务继续执行，而不是半途而废。

## 安装

Windows：

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS：

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

安装器检查 Node.js >= 22，将 ModelDock 下载到 `~/.modeldock`，在后台启动并打开仪表盘。在弹出的设置窗口里粘贴你的 [opencode.ai](https://opencode.ai/auth) token 即可。

## 接入 Codex

1. 浏览器打开 **http://127.0.0.1:4097**
2. 打开页面上的开关
3. 完全退出并重启 Codex
4. 在 Codex 的模型选单里选择任意 ModelDock 模型

## 日常使用

**模型选单** — 所有可用模型都会出现在 Codex 的模型选单（右下角），标注来源。无需重启即可切换。

**免费优先** — 选 `Auto - DeepSeek Free first`。ModelDock 先用免费额度，耗尽时静默切换到付费模型，一小时后自动再试免费。

**语音** — 在仪表盘打开 TTS · STT 栏。TTS 开启一次后，`speak` 工具即可供模型调用；STT 对应 `hear`。

**界面语言** — 仪表盘支持 English、简体中文、日本語、Français、Español。在「设置 → 界面语言」随时更改。

**开机自启与更新** — 在仪表盘打开 Autostart，之后每次登录自动后台启动。有新版本时顶部出现绿色「更新」按钮——点一下自动下载、重启、刷新页面。
