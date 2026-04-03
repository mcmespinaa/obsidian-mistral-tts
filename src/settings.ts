import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type MistralTTSPlugin from "./main";

export interface MistralTTSSettings {
	apiKey: string;
	voiceId: string;
	voiceName: string;
	responseFormat: "mp3" | "wav" | "flac" | "opus";
	saveToVault: boolean;
	saveLocation: "next-to-note" | "dedicated-folder";
	audioFolder: string;
	maxChunkLength: number;
	streaming: boolean;
}

export const DEFAULT_SETTINGS: MistralTTSSettings = {
	apiKey: "",
	voiceId: "",
	voiceName: "",
	responseFormat: "mp3",
	saveToVault: true,
	saveLocation: "next-to-note",
	audioFolder: "audio-tts",
	maxChunkLength: 4000,
	streaming: true,
};

export class MistralTTSSettingTab extends PluginSettingTab {
	plugin: MistralTTSPlugin;

	constructor(app: App, plugin: MistralTTSPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Mistral TTS Settings" });

		// --- API Configuration ---
		containerEl.createEl("h3", { text: "API Configuration" });

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Your Mistral API key")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
			});

		// --- Voice Configuration ---
		containerEl.createEl("h3", { text: "Voice" });

		const voiceSetting = new Setting(containerEl)
			.setName("Active voice")
			.setDesc(
				this.plugin.settings.voiceName
					? `Current: ${this.plugin.settings.voiceName}`
					: "No voice selected. Create or select one below."
			);

		// Voice list container (must be created before button references it)
		const voiceListEl = containerEl.createDiv("mistral-tts-voice-list");

		voiceSetting.addButton((btn) =>
			btn.setButtonText("Refresh voices").onClick(async () => {
				await this.renderVoiceList(voiceListEl);
			})
		);

		this.renderVoiceList(voiceListEl);

		// Clone voice section
		containerEl.createEl("h3", { text: "Clone a voice" });
		containerEl.createEl("p", {
			text: "Upload a short audio sample (2-3 seconds) to create a custom voice.",
			cls: "setting-item-description",
		});

		const cloneContainer = containerEl.createDiv("mistral-tts-clone");

		let cloneName = "";
		let cloneFile: File | null = null;

		new Setting(cloneContainer)
			.setName("Voice name")
			.addText((text) =>
				text.setPlaceholder("My voice").onChange((v) => {
					cloneName = v;
				})
			);

		new Setting(cloneContainer).setName("Audio sample").addButton((btn) =>
			btn.setButtonText("Choose file").onClick(() => {
				const input = document.createElement("input");
				input.type = "file";
				input.accept = "audio/*";
				input.onchange = () => {
					cloneFile = input.files?.[0] ?? null;
					if (cloneFile) {
						btn.setButtonText(`Selected: ${cloneFile.name}`);
					}
				};
				input.click();
			})
		);

		new Setting(cloneContainer).addButton((btn) =>
			btn
				.setButtonText("Create voice")
				.setCta()
				.onClick(async () => {
					if (!cloneName || !cloneFile) {
						new Notice("Provide a name and audio sample");
						return;
					}
					try {
						new Notice("Creating voice...");
						const voice = await this.plugin.ttsEngine.createVoice(
							cloneName,
							cloneFile
						);
						this.plugin.settings.voiceId = voice.id;
						this.plugin.settings.voiceName = voice.name;
						await this.plugin.saveSettings();
						new Notice(`Voice "${voice.name}" created and selected`);
						this.display(); // refresh
					} catch (e) {
						new Notice(`Failed to create voice: ${(e as Error).message}`);
					}
				})
		);

		// --- Audio Output ---
		containerEl.createEl("h3", { text: "Audio Output" });

		new Setting(containerEl)
			.setName("Audio format")
			.setDesc("Output format for generated audio")
			.addDropdown((d) =>
				d
					.addOptions({
						mp3: "MP3 (compressed)",
						wav: "WAV (uncompressed)",
						flac: "FLAC (lossless)",
						opus: "Opus (low bitrate)",
					})
					.setValue(this.plugin.settings.responseFormat)
					.onChange(async (v) => {
						this.plugin.settings.responseFormat = v as MistralTTSSettings["responseFormat"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Save audio to vault")
			.setDesc("Save generated audio files in your vault")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.saveToVault)
					.onChange(async (v) => {
						this.plugin.settings.saveToVault = v;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.saveToVault) {
			new Setting(containerEl)
				.setName("Save location")
				.setDesc("Where to save audio files")
				.addDropdown((d) =>
					d
						.addOptions({
							"next-to-note": "Next to the source note",
							"dedicated-folder": "In a dedicated folder",
						})
						.setValue(this.plugin.settings.saveLocation)
						.onChange(async (v) => {
							this.plugin.settings.saveLocation = v as MistralTTSSettings["saveLocation"];
							await this.plugin.saveSettings();
							this.display();
						})
				);

			if (this.plugin.settings.saveLocation === "dedicated-folder") {
				new Setting(containerEl)
					.setName("Audio folder")
					.setDesc("Folder path relative to vault root")
					.addText((t) =>
						t
							.setValue(this.plugin.settings.audioFolder)
							.onChange(async (v) => {
								this.plugin.settings.audioFolder = v;
								await this.plugin.saveSettings();
							})
					);
			}
		}

		// --- Playback ---
		containerEl.createEl("h3", { text: "Playback" });

		new Setting(containerEl)
			.setName("Streaming")
			.setDesc(
				"Start playback before full generation completes. Best for long texts. Desktop only."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.streaming).onChange(async (v) => {
					this.plugin.settings.streaming = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Chunk size")
			.setDesc(
				"Max characters per API call. Longer texts are split at sentence boundaries."
			)
			.addText((t) =>
				t
					.setValue(String(this.plugin.settings.maxChunkLength))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.maxChunkLength = n;
							await this.plugin.saveSettings();
						}
					})
			);
	}

	private async renderVoiceList(containerEl: HTMLElement): Promise<void> {
		containerEl.empty();

		if (!this.plugin.settings.apiKey) {
			containerEl.createEl("p", {
				text: "Set your API key to see available voices.",
				cls: "setting-item-description",
			});
			return;
		}

		try {
			const voices = await this.plugin.ttsEngine.listVoices();
			if (voices.length === 0) {
				containerEl.createEl("p", {
					text: "No saved voices. Clone one below or use a reference audio.",
					cls: "setting-item-description",
				});
				return;
			}

			for (const voice of voices) {
				const isActive = voice.id === this.plugin.settings.voiceId;
				new Setting(containerEl)
					.setName(voice.name + (isActive ? " (active)" : ""))
					.setDesc(
						[
							voice.gender,
							voice.languages?.join(", "),
							voice.tags?.join(", "),
						]
							.filter(Boolean)
							.join(" | ") || "No details"
					)
					.addButton((btn) =>
						btn
							.setButtonText(isActive ? "Selected" : "Use")
							.setDisabled(isActive)
							.onClick(async () => {
								this.plugin.settings.voiceId = voice.id;
								this.plugin.settings.voiceName = voice.name;
								await this.plugin.saveSettings();
								new Notice(`Voice set to "${voice.name}"`);
								this.display();
							})
					)
					.addButton((btn) =>
						btn
							.setButtonText("Delete")
							.setWarning()
							.onClick(async () => {
								try {
									await this.plugin.ttsEngine.deleteVoice(voice.id);
									if (this.plugin.settings.voiceId === voice.id) {
										this.plugin.settings.voiceId = "";
										this.plugin.settings.voiceName = "";
										await this.plugin.saveSettings();
									}
									new Notice(`Voice "${voice.name}" deleted`);
									this.display();
								} catch (e) {
									new Notice(`Failed: ${(e as Error).message}`);
								}
							})
					);
			}
		} catch (e) {
			containerEl.createEl("p", {
				text: `Error loading voices: ${(e as Error).message}`,
				cls: "setting-item-description",
			});
		}
	}
}
