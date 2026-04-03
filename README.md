# Obsidian Mistral TTS

Text-to-speech plugin for [Obsidian](https://obsidian.md) with two engines: [Mistral Voxtral](https://docs.mistral.ai/capabilities/audio/text_to_speech/speech) (cloud, best quality) and system voices (local, instant).

## Features

- **Two TTS engines** -- switch between Mistral cloud TTS and your OS system voices
- **Read notes aloud** -- entire note or selected text
- **Streaming playback** -- starts playing in ~0.8s using Web Audio API (Mistral)
- **Voice cloning** -- clone any voice from a 2-3 second audio sample (Mistral)
- **Voice preview** -- listen to any voice before selecting it
- **Save audio to vault** -- next to the note or in a dedicated folder
- **Markdown-aware** -- strips frontmatter, headings, code blocks, and formatting before speaking
- **Multiple entry points** -- command palette, right-click menus, ribbon icon, status bar controls

## Installation

### From Obsidian Community Plugins

1. Open Obsidian Settings > Community Plugins > Browse
2. Search for "Mistral TTS"
3. Install and enable

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/mcmespinaa/obsidian-mistral-tts/releases)
2. Create a folder `mistral-tts` in your vault's `.obsidian/plugins/` directory
3. Copy the three files into that folder
4. Restart Obsidian and enable "Mistral TTS" in Settings > Community Plugins

## Setup

### Mistral Voxtral (cloud)

1. Get an API key from [console.mistral.ai](https://console.mistral.ai/)
2. Open plugin settings, paste your API key
3. Create a voice by uploading a short audio sample (2-3 seconds), or use a pre-existing one
4. Select text and use "Read aloud" from the right-click menu or command palette

### System Voices (local)

1. Open plugin settings, switch the TTS engine dropdown to "System voices"
2. Pick a voice from the dropdown (uses your OS built-in voices)
3. No API key needed, works offline

## Commands

| Command | Description |
|---------|-------------|
| Read selection aloud | Speaks the currently selected text |
| Read entire note aloud | Speaks the full active note |
| Pause / resume playback | Toggle pause |
| Stop playback | Stop and reset |

## Audio Formats (Mistral)

| Format | Use case |
|--------|----------|
| MP3 | General use (default) |
| WAV | Highest quality |
| FLAC | Lossless compression |
| Opus | Low bitrate |

Streaming mode uses PCM for lowest latency (~0.8s to first audio).

## Supported Languages

English, French, Spanish, Portuguese, Italian, Dutch, German, Hindi, Arabic.

## Development

```bash
git clone https://github.com/mcmespinaa/obsidian-mistral-tts.git
cd obsidian-mistral-tts
npm install
npm run dev    # watch mode
npm run build  # production build
```

## Support

If you find this plugin useful, you can [buy me a coffee](https://buymeacoffee.com/mcmespinaa).

## License

[MIT](LICENSE)
