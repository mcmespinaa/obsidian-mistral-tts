import {
	Plugin,
	Notice,
	Editor,
	MarkdownView,
	Menu,
	TFile,
	normalizePath,
} from "obsidian";
import {
	MistralTTSSettings,
	DEFAULT_SETTINGS,
	MistralTTSSettingTab,
} from "./settings";
import { TTSEngine } from "./tts-engine";
import { PlayerUI } from "./player-ui";
import type { PlaybackState } from "./types";

export default class MistralTTSPlugin extends Plugin {
	settings: MistralTTSSettings = DEFAULT_SETTINGS;
	ttsEngine: TTSEngine;
	private playerUI: PlayerUI;

	async onload() {
		await this.loadSettings();

		this.ttsEngine = new TTSEngine(
			() => this.settings,
			(state) => this.playerUI.update(state)
		);

		this.playerUI = new PlayerUI(
			() => this.togglePauseResume(),
			() => this.ttsEngine.stop()
		);
		this.playerUI.attach(this);

		// ── Ribbon Icon ────────────────────────────────────────────
		this.addRibbonIcon("volume-2", "Read note aloud", async () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) {
				new Notice("Open a markdown note first");
				return;
			}
			await this.speakText(stripMarkdown(view.editor.getValue()));
		});

		// ── Commands ───────────────────────────────────────────────

		this.addCommand({
			id: "read-selection",
			name: "Read selection aloud",
			editorCallback: async (editor: Editor) => {
				const text = editor.getSelection();
				if (!text) {
					new Notice("Select some text first");
					return;
				}
				await this.speakText(stripMarkdown(text));
			},
		});

		this.addCommand({
			id: "read-note",
			name: "Read entire note aloud",
			editorCallback: async (editor: Editor) => {
				await this.speakText(stripMarkdown(editor.getValue()));
			},
		});

		this.addCommand({
			id: "pause-resume",
			name: "Pause / resume playback",
			callback: () => this.togglePauseResume(),
		});

		this.addCommand({
			id: "stop",
			name: "Stop playback",
			callback: () => this.ttsEngine.stop(),
		});

		// ── Context Menus ──────────────────────────────────────────

		this.registerEvent(
			this.app.workspace.on(
				"editor-menu",
				(menu: Menu, editor: Editor) => {
					const selection = editor.getSelection();
					if (selection) {
						menu.addItem((item) => {
							item.setTitle("Read aloud")
								.setIcon("volume-2")
								.onClick(() =>
									this.speakText(stripMarkdown(selection))
								);
						});
					}
				}
			)
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TFile) => {
				if (file.extension === "md") {
					menu.addItem((item) => {
						item.setTitle("Read file aloud")
							.setIcon("volume-2")
							.onClick(async () => {
								const content = await this.app.vault.read(file);
								await this.speakText(stripMarkdown(content));
							});
					});
				}
			})
		);

		// ── Settings Tab ───────────────────────────────────────────
		this.addSettingTab(new MistralTTSSettingTab(this.app, this));
	}

	onunload() {
		this.ttsEngine.stop();
	}

	// ── Core Speak Method ──────────────────────────────────────────

	private async speakText(text: string) {
		if (!this.settings.apiKey) {
			new Notice("Set your Mistral API key in Mistral TTS settings");
			return;
		}
		if (!this.settings.voiceId) {
			new Notice("Select or create a voice in Mistral TTS settings");
			return;
		}
		if (!text.trim()) {
			new Notice("No text to read");
			return;
		}

		try {
			let audioData: Uint8Array;

			if (this.settings.streaming) {
				audioData = await this.ttsEngine.speakStreaming(text);
			} else {
				audioData = await this.ttsEngine.speak(text);
			}

			if (this.settings.saveToVault && audioData.length > 0) {
				await this.saveAudio(audioData);
			}
		} catch (e) {
			this.ttsEngine.stop();
			new Notice(`TTS error: ${(e as Error).message}`);
		}
	}

	// ── Save Audio to Vault ────────────────────────────────────────

	private async saveAudio(data: Uint8Array) {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return;

		const ext = this.settings.streaming ? "pcm" : this.settings.responseFormat;
		const baseName = activeFile.basename;
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const fileName = `${baseName}_${timestamp}.${ext}`;

		let folderPath: string;
		if (this.settings.saveLocation === "next-to-note") {
			folderPath = activeFile.parent?.path || "";
		} else {
			folderPath = this.settings.audioFolder;
		}

		const fullPath = normalizePath(
			folderPath ? `${folderPath}/${fileName}` : fileName
		);

		// Ensure folder exists
		if (folderPath) {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder) {
				await this.app.vault.createFolder(folderPath);
			}
		}

		await this.app.vault.createBinary(fullPath, data.buffer as ArrayBuffer);
		new Notice(`Audio saved: ${fileName}`);
	}

	// ── Helpers ────────────────────────────────────────────────────

	private togglePauseResume() {
		if (this.ttsEngine.state === "playing") {
			this.ttsEngine.pause();
		} else if (this.ttsEngine.state === "paused") {
			this.ttsEngine.resume();
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ── Markdown Stripping ─────────────────────────────────────────────

function stripMarkdown(text: string): string {
	return (
		text
			// Remove YAML frontmatter
			.replace(/^---[\s\S]*?---\n?/, "")
			// Remove headings markers
			.replace(/^#{1,6}\s+/gm, "")
			// Remove bold/italic markers
			.replace(/(\*{1,3}|_{1,3})(.*?)\1/g, "$2")
			// Remove inline code
			.replace(/`([^`]+)`/g, "$1")
			// Remove code blocks
			.replace(/```[\s\S]*?```/g, "")
			// Remove links, keep text
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			// Remove images
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
			// Remove wiki links
			.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, "$3$1")
			// Remove HTML tags
			.replace(/<[^>]+>/g, "")
			// Remove blockquotes marker
			.replace(/^>\s+/gm, "")
			// Remove horizontal rules
			.replace(/^[-*_]{3,}\s*$/gm, "")
			// Remove list markers
			.replace(/^[\s]*[-*+]\s+/gm, "")
			.replace(/^[\s]*\d+\.\s+/gm, "")
			// Collapse multiple newlines
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}
