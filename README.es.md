# ModelDock

Dale a DeepSeek ojos, oidos y voz -- y mantén las sesiones largas hasta el final.

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.fr.md">Français</a>
</p>

<p align="center">
  <img src="assets/dashboard.png" alt="Panel de ModelDock" width="100%" />
</p>

## Por que ModelDock

**Multimedia**

DeepSeek V4 Flash es rapido y economico, pero no puede ver, hablar ni escuchar. ModelDock anade las tres capacidades de golpe:

- **Ver** -- arrastra una imagen a Codex; DeepSeek recibe una descripcion (enrutada a MiMo V2.5 Free, respaldo MiniMax M3)
- **Hablar** -- la herramienta `speak` convierte cualquier texto en un archivo de audio
- **Escuchar** -- la herramienta `hear` transcribe un archivo de audio de vuelta a texto

Activa el habla en el panel **TTS · STT** del tablero una vez; la configuracion se mantiene entre sesiones.

**Sesiones largas**

ModelDock declara una ventana de contexto de 250 k a Codex, lo que activa la compactacion automatica integrada al 80 %. Un verificador de sesion activa el modelo cuando se detiene, para que una tarea de codificacion larga llegue hasta el final sin pararse a mitad.

## Instalacion

Windows:

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
```

macOS:

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

El instalador verifica Node.js >= 22, descarga ModelDock en `~/.modeldock`, lo inicia en segundo plano y abre el tablero. Pega tu token de [opencode.ai](https://opencode.ai/auth) en el dialogo de Configuracion que aparece.

## Conectar Codex

1. Abre **http://127.0.0.1:4097** en tu navegador
2. Activa el interruptor de la pagina
3. Cierra Codex completamente y vuelve a abrirlo
4. Elige cualquier modelo de ModelDock en el selector de modelos de Codex

## Uso diario

**Selector de modelos** -- todos los modelos accesibles aparecen en el selector de Codex (abajo a la derecha), etiquetados por origen. Cambia sin reiniciar.

**Gratis primero** -- elige `Auto - DeepSeek Free first`. ModelDock usa la cuota gratuita, cambia silenciosamente al modelo de pago cuando se agota, y vuelve a intentar el gratuito una hora despues.

**Habla** -- abre el panel TTS · STT en el tablero. Activa TTS una vez; la herramienta `speak` queda disponible para el modelo. STT corresponde a `hear`.

**Idioma de la interfaz** -- el tablero habla English, 简体中文, 日本語, Français, Español. Cambia en cualquier momento en Configuracion -> Idioma de la interfaz.

**Inicio automatico y actualizaciones** -- activa el boton Autostart; ModelDock se inicia en segundo plano en cada inicio de sesion. Un boton verde Actualizar aparece cuando hay una nueva version disponible -- un clic descarga, reinicia y recarga la pagina.
