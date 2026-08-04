---
name: sherpa-onnx-tts
description: Local text-to-speech via sherpa-onnx (offline, no cloud)
metadata:
  {
    "mtbot":
      {
        "emoji": "🗣️",
        "os": ["win32"],
        "requires": { "env": ["SHERPA_ONNX_RUNTIME_DIR", "SHERPA_ONNX_MODEL_DIR"] },
        "install":
          [
            {
              "id": "download-runtime-win-x64",
              "kind": "download",
              "os": ["win32"],
              "url": "https://test-1258105840.cos.ap-chengdu.myqcloud.com/sherpa-onnx-v1.12.23-runtime.zip",
              "archive": "zip",
              "extract": true,
              "stripComponents": 1,
              "targetDir": "~/.mtbot/tools/sherpa-onnx-tts/runtime",
              "label": "Download sherpa-onnx runtime (Windows x64)",
            },
            {
              "id": "download-model-lessac",
              "kind": "download",
              "url": "https://test-1258105840.cos.ap-chengdu.myqcloud.com/vits-melo-tts-zh_en.zip",
              "archive": "zip",
              "extract": true,
              "targetDir": "~/.mtbot/tools/sherpa-onnx-tts/models",
              "label": "Download Piper en_US lessac (high)",
            },
          ],
      },
  }
---

# sherpa-onnx-tts

Local TTS using the sherpa-onnx offline CLI.

## Install

1. Download the runtime for your OS (extracts into `~/.mtbot/tools/sherpa-onnx-tts/runtime`)
2. Download a voice model (extracts into `~/.mtbot/tools/sherpa-onnx-tts/models`)

Update `~/.mtbot/mtbot.json`:

```json5
{
  skills: {
    entries: {
      "sherpa-onnx-tts": {
        env: {
          SHERPA_ONNX_RUNTIME_DIR: "~/.mtbot/tools/sherpa-onnx-tts/runtime",
          SHERPA_ONNX_MODEL_DIR: "~/.mtbot/tools/sherpa-onnx-tts/models/vits-melo-tts-zh_en",
        },
      },
    },
  },
}
```

## Usage

The skill is invoked automatically by the agent. Pass `text` in the skill parameters:

```json
{ "text": "今天天气真好！" }
```

Optional parameters:

| Parameter | Description | Default |
|---|---|---|
| `text` | Text to synthesize (required) | — |
| `outputFile` | Output WAV path | `%TEMP%/tts-TIMESTAMP.wav` |
| `runtimeDir` | Override `SHERPA_ONNX_RUNTIME_DIR` | `~/.mtbot/tools/sherpa-onnx-tts/runtime` |
| `modelDir` | Override `SHERPA_ONNX_MODEL_DIR` | `~/.mtbot/tools/sherpa-onnx-tts/models` |
| `speakerId` | Speaker ID (multi-speaker models) | `0` |
| `speed` | Speech speed (`vits-length-scale`) | `1.0` |

## skill-env.json

Place a `skill-env.json` file in this skill directory to configure paths without modifying `mtbot.json`:

```json
{
  "SHERPA_ONNX_RUNTIME_DIR": "~/.mtbot/tools/sherpa-onnx-tts/runtime",
  "SHERPA_ONNX_MODEL_DIR": "~/.mtbot/tools/sherpa-onnx-tts/models/vits-melo-tts-zh_en"
}
```

Tilde (`~`) paths are automatically expanded to the Windows home directory.

## Notes

- Pick a different model from the sherpa-onnx `tts-models` release if you want another voice.
- If the model dir has multiple `.onnx` files, the `int8` quantized version is preferred automatically.
- Set `SHERPA_ONNX_MODEL_FILE` env var to force a specific `.onnx` file.
- `--vits-dict-dir` is not passed as it is deprecated in newer sherpa-onnx versions.
