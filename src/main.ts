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
	PluginSettings,
	DEFAULT_SETTINGS,
	TTSSettingTab,
} from "./settings";
import { TTSManager } from "./tts-manager";
import { PlayerUI } from "./player-ui";

export default class MistralTTSPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	ttsManager!: TTSManager;
	private playerUI!: PlayerUI;
	private isSpeaking = false;

	async onload() {
		await this.loadSettings();

		this.ttsManager = new TTSManager(
			() => this.settings,
			(state) => this.playerUI.update(state)
		);

		this.playerUI = new PlayerUI(
			() => this.togglePauseResume(),
			() => this.ttsManager.stop()
		);
		this.playerUI.attach(this);

		// Apply initial engine from saved settings
		this.applyEngine();

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
			callback: () => this.ttsManager.stop(),
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
			// @ts-ignore -- file-menu not in all Obsidian type versions
			this.app.workspace.on("file-menu", (menu: Menu, file: TFile) => {
				if (file.extension === "md") {
					menu.addItem((item) => {
						item.setTitle("Read file aloud")
							.setIcon("volume-2")
							.onClick(async () => {
								try {
									const content = await this.app.vault.read(file);
									await this.speakText(stripMarkdown(content));
								} catch (e) {
									new Notice(`Could not read file: ${(e as Error).message}`);
								}
							});
					});
				}
			})
		);

		// ── Settings Tab ───────────────────────────────────────────
		this.addSettingTab(new TTSSettingTab(this.app, this));
	}

	onunload() {
		this.ttsManager.stop();
	}

	/** Switch active engine and apply per-engine settings. Called from settings tab. */
	applyEngine() {
		this.ttsManager.setEngine(this.settings.engine);
		// Apply SpeechSynth-specific settings
		this.ttsManager.speechSynth.setVoice(this.settings.speechSynthVoice);
		this.ttsManager.speechSynth.setRate(this.settings.speechSynthRate);
	}

	// ── Core Speak Method ──────────────────────────────────────────

	private async speakText(text: string) {
		// Validate engine-specific requirements
		if (this.settings.engine === "mistral") {
			if (!this.settings.apiKey) {
				new Notice("Set your Mistral API key in TTS settings");
				return;
			}
			if (!this.settings.voiceId) {
				new Notice("Select or create a voice in TTS settings");
				return;
			}
		}
		if (!text.trim()) {
			new Notice("No text to read");
			return;
		}

		// Guard against concurrent speak requests
		if (this.isSpeaking) {
			this.ttsManager.stop();
		}
		this.isSpeaking = true;

		try {
			const result = await this.ttsManager.speak(text);

			// Save independently -- don't let save failures kill playback
			if (
				this.settings.saveToVault &&
				this.ttsManager.canSaveAudio &&
				result.audioData &&
				result.audioData.length > 0
			) {
				try {
					await this.saveAudio(result.audioData, result.format);
				} catch (e) {
					new Notice(`Audio plays fine but could not save: ${(e as Error).message}`);
				}
			}
		} catch (e) {
			this.ttsManager.stop();
			new Notice(`TTS error: ${(e as Error).message}`);
		} finally {
			this.isSpeaking = false;
		}
	}

	// ── Save Audio to Vault ────────────────────────────────────────

	private async saveAudio(data: Uint8Array, format: string) {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("Could not save audio: no active note");
			return;
		}

		const baseName = activeFile.basename;
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const fileName = `${baseName}_${timestamp}.${format}`;

		let folderPath: string;
		if (this.settings.saveLocation === "next-to-note") {
			folderPath = activeFile.parent?.path || "";
		} else {
			folderPath = this.settings.audioFolder;
		}

		// Reject path traversal attempts
		const normalized = normalizePath(
			folderPath ? `${folderPath}/${fileName}` : fileName
		);
		if (normalized.startsWith("..") || normalized.contains("/../")) {
			new Notice("Invalid audio folder path");
			return;
		}
		const fullPath = normalized;

		// Ensure folder exists
		if (folderPath) {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder) {
				await this.app.vault.createFolder(folderPath);
			}
		}

		const safeBuffer = data.buffer.slice(
			data.byteOffset,
			data.byteOffset + data.byteLength
		) as ArrayBuffer;
		await this.app.vault.createBinary(fullPath, safeBuffer);
		new Notice(`Audio saved: ${fileName}`);
	}

	// ── Helpers ────────────────────────────────────────────────────

	private togglePauseResume() {
		if (this.ttsManager.state === "playing") {
			this.ttsManager.pause();
		} else if (this.ttsManager.state === "paused") {
			this.ttsManager.resume();
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
		try {
			await this.saveData(this.settings);
		} catch (e) {
			new Notice(`Failed to save settings: ${(e as Error).message}`);
		}
	}
}

// ── Markdown Stripping ─────────────────────────────────────────────

function stripMarkdown(text: string): string {
	return (
		text
			// Remove YAML frontmatter
			.replace(/^---[\s\S]*?---\n?/, "")
			// Remove code blocks
			.replace(/```[\s\S]*?```/g, "")
			// Remove headings markers
			.replace(/^#{1,6}\s+/gm, "")
			// Remove bold/italic markers
			.replace(/(\*{1,3}|_{1,3})(.*?)\1/g, "$2")
			// Remove inline code
			.replace(/`([^`]+)`/g, "$1")
			// Remove images (before links)
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
			// Remove links, keep text
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			// Remove wiki links
			.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, page, alias) => alias || page)
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
