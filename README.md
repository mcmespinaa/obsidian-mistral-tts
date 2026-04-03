# Obsidian Mistral TTS

Text-to-speech plugin for [Obsidian](https://obsidian.md) using [Mistral Voxtral](https://docs.mistral.ai/capabilities/audio/text_to_speech/speech).

## Features

- **Read notes aloud** -- entire note or selected text
- **Streaming playback** -- starts playing in ~0.8s using Web Audio API
- **Voice cloning** -- clone any voice from a 2-3 second audio sample
- **Save audio to vault** -- next to the note or in a dedicated folder
- **Markdown-aware** -- strips frontmatter, headings, code blocks, and formatting before speaking
- **Multiple entry points** -- command palette, right-click menus, ribbon icon, status bar controls

## Requirements

- [Mistral API key](https://console.mistral.ai/)
- At least one saved voice (create one in plugin settings by uploading an audio sample)

## Installation

1. Clone this repo into your vault's `.obsidian/plugins/` folder:
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/yourusername/obsidian-mistral-tts.git mistral-tts
   cd mistral-tts
   npm install
   npm run build
   ```
2. Restart Obsidian
3. Enable "Mistral TTS" in Settings > Community Plugins
4. Add your API key and create a voice in the plugin settings

## Commands

| Command | Description |
|---------|-------------|
| Read selection aloud | Speaks the currently selected text |
| Read entire note aloud | Speaks the full active note |
| Pause / resume playback | Toggle pause |
| Stop playback | Stop and reset |

## Audio Formats

| Format | Use case |
|--------|----------|
| MP3 | General use (default) |
| WAV | Highest quality |
| FLAC | Lossless compression |
| Opus | Low bitrate |

Streaming mode always uses PCM for lowest latency.

## Supported Languages

English, French, Spanish, Portuguese, Italian, Dutch, German, Hindi, Arabic.

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```

## License

MIT
