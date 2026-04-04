import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type MistralTTSPlugin from "./main";
import type { EngineType } from "./types";
import { SpeechSynthProvider } from "./speech-synth-provider";

// ── Settings Interface ─────────────────────────────────────────────

export interface PluginSettings {
	engine: EngineType;

	// Mistral settings
	apiKey: string;
	voiceId: string;
	voiceName: string;
	responseFormat: "mp3" | "wav" | "flac" | "opus";
	maxChunkLength: number;
	streaming: boolean;

	// SpeechSynthesis settings
	speechSynthVoice: string;
	speechSynthRate: number;

	// Audio output
	saveToVault: boolean;
	saveLocation: "next-to-note" | "dedicated-folder";
	audioFolder: string;
}

export type MistralTTSSettings = PluginSettings;

export const DEFAULT_SETTINGS: PluginSettings = {
	engine: "mistral",
	apiKey: "",
	voiceId: "",
	voiceName: "",
	responseFormat: "mp3",
	maxChunkLength: 4000,
	streaming: true,
	speechSynthVoice: "",
	speechSynthRate: 1.0,
	saveToVault: true,
	saveLocation: "next-to-note",
	audioFolder: "audio-tts",
};

// ── Settings Tab ───────────────────────────────────────────────────

export class TTSSettingTab extends PluginSettingTab {
	plugin: MistralTTSPlugin;

	constructor(app: App, plugin: MistralTTSPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("TTS engine")
			.setDesc("Choose between cloud (Mistral Voxtral) or local (system voices)")
			.addDropdown((d) =>
				d
					.addOptions({
						mistral: "Mistral Voxtral (cloud, best quality)",
						"speech-synth": "System voices (local, instant)",
					})
					.setValue(this.plugin.settings.engine)
					.onChange(async (v) => {
						this.plugin.settings.engine = v as EngineType;
						this.plugin.applyEngine();
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.engine === "mistral") {
			this.displayMistralSettings(containerEl);
		} else {
			this.displaySpeechSynthSettings(containerEl);
		}

		this.displayAudioOutput(containerEl);
	}

	// ── Mistral Settings ───────────────────────────────────────────

	private displayMistralSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName("Mistral API").setHeading();

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

		new Setting(containerEl).setName("Voice").setHeading();

		const voiceSetting = new Setting(containerEl)
			.setName("Active voice")
			.setDesc(
				this.plugin.settings.voiceName
					? `Current: ${this.plugin.settings.voiceName}`
					: "No voice selected. Create or select one below."
			);

		const voiceListEl = containerEl.createDiv("mistral-tts-voice-list");

		voiceSetting.addButton((btn) =>
			btn.setButtonText("Refresh voices").onClick(async () => {
				await this.renderMistralVoiceList(voiceListEl);
			})
		);

		void this.renderMistralVoiceList(voiceListEl);

		// Clone voice
		new Setting(containerEl).setName("Clone a voice").setHeading();
		new Setting(containerEl).setDesc(
			"Upload a short audio sample (2-3 seconds) to create a custom voice."
		);

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
					if (cloneFile) btn.setButtonText(`Selected: ${cloneFile.name}`);
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
						const voice = await this.plugin.ttsManager.createMistralVoice(
							cloneName,
							cloneFile
						);
						this.plugin.settings.voiceId = voice.id;
						this.plugin.settings.voiceName = voice.name;
						await this.plugin.saveSettings();
						new Notice(`Voice "${voice.name}" created and selected`);
						this.display();
					} catch (e) {
						new Notice(`Failed: ${(e as Error).message}`);
					}
				})
		);

		new Setting(containerEl).setName("Playback").setHeading();

		new Setting(containerEl)
			.setName("Audio format")
			.addDropdown((d) =>
				d
					.addOptions({
						mp3: "MP3",
						wav: "WAV",
						flac: "FLAC",
						opus: "Opus",
					})
					.setValue(this.plugin.settings.responseFormat)
					.onChange(async (v) => {
						this.plugin.settings.responseFormat = v as PluginSettings["responseFormat"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Streaming")
			.setDesc("Start playback before full generation completes")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.streaming).onChange(async (v) => {
					this.plugin.settings.streaming = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Chunk size")
			.setDesc("Max characters per API call")
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

	// ── SpeechSynthesis Settings ───────────────────────────────────

	private displaySpeechSynthSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName("System voice").setHeading();
		new Setting(containerEl).setDesc(
			"Uses your OS built-in voices. No API key needed, works offline. Audio cannot be saved to vault."
		);

		const voiceContainer = containerEl.createDiv();
		void this.renderSpeechSynthVoices(voiceContainer);

		new Setting(containerEl)
			.setName("Speech rate")
			.setDesc("1.0 = normal speed")
			.addSlider((s) =>
				s
					.setLimits(0.5, 2.0, 0.1)
					.setValue(this.plugin.settings.speechSynthRate)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.speechSynthRate = v;
						this.plugin.ttsManager.speechSynth.setRate(v);
						await this.plugin.saveSettings();
					})
			);
	}

	private async renderSpeechSynthVoices(containerEl: HTMLElement) {
		containerEl.empty();
		const voices = await SpeechSynthProvider.getVoices();

		if (voices.length === 0) {
			new Setting(containerEl).setDesc("No system voices available.");
			return;
		}

		const options: Record<string, string> = { "": "Default" };
		for (const v of voices) {
			options[v.id] = v.name;
		}

		new Setting(containerEl)
			.setName("Voice")
			.addDropdown((d) =>
				d
					.addOptions(options)
					.setValue(this.plugin.settings.speechSynthVoice)
					.onChange(async (v) => {
						this.plugin.settings.speechSynthVoice = v;
						this.plugin.ttsManager.speechSynth.setVoice(v);
						await this.plugin.saveSettings();
					})
			);
	}

	// ── Audio Output (shared) ──────────────────────────────────────

	private displayAudioOutput(containerEl: HTMLElement) {
		const canSave = this.plugin.ttsManager.canSaveAudio;

		new Setting(containerEl).setName("Audio output").setHeading();

		if (!canSave) {
			new Setting(containerEl).setDesc(
				"Audio saving is not available with system voices (audio plays directly to speakers)."
			);
			return;
		}

		new Setting(containerEl)
			.setName("Save audio to vault")
			.setDesc("Save generated audio files in your vault")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.saveToVault).onChange(async (v) => {
					this.plugin.settings.saveToVault = v;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (this.plugin.settings.saveToVault) {
			new Setting(containerEl)
				.setName("Save location")
				.addDropdown((d) =>
					d
						.addOptions({
							"next-to-note": "Next to the source note",
							"dedicated-folder": "In a dedicated folder",
						})
						.setValue(this.plugin.settings.saveLocation)
						.onChange(async (v) => {
							this.plugin.settings.saveLocation = v as PluginSettings["saveLocation"];
							await this.plugin.saveSettings();
							this.display();
						})
				);

			if (this.plugin.settings.saveLocation === "dedicated-folder") {
				new Setting(containerEl)
					.setName("Audio folder")
					.setDesc("Folder path relative to vault root")
					.addText((t) =>
						t.setValue(this.plugin.settings.audioFolder).onChange(async (v) => {
							this.plugin.settings.audioFolder = v;
							await this.plugin.saveSettings();
						})
					);
			}
		}
	}

	// ── Mistral Voice List ─────────────────────────────────────────

	private async renderMistralVoiceList(containerEl: HTMLElement): Promise<void> {
		containerEl.empty();

		if (!this.plugin.settings.apiKey) {
			new Setting(containerEl).setDesc("Set your API key to see available voices.");
			return;
		}

		try {
			const voices = await this.plugin.ttsManager.listMistralVoices();
			if (voices.length === 0) {
				new Setting(containerEl).setDesc("No saved voices. Clone one below.");
				return;
			}

			for (const voice of voices) {
				const isActive = voice.id === this.plugin.settings.voiceId;
				new Setting(containerEl)
					.setName(voice.name + (isActive ? " (active)" : ""))
					.setDesc(
						[voice.gender, voice.languages?.join(", "), voice.tags?.join(", ")]
							.filter(Boolean)
							.join(" | ") || "No details"
					)
					.addButton((btn) =>
						btn
							.setButtonText("Preview")
							.setIcon("play")
							.onClick(async () => {
								try {
									btn.setButtonText("...");
									await this.plugin.ttsManager.previewMistralVoice(voice.id);
									btn.setButtonText("Preview");
								} catch (e) {
									new Notice(`Preview failed: ${(e as Error).message}`);
									btn.setButtonText("Preview");
								}
							})
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
									await this.plugin.ttsManager.deleteMistralVoice(voice.id);
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
			new Setting(containerEl).setDesc(`Error loading voices: ${(e as Error).message}`);
		}
	}
}
