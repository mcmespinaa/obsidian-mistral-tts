import type { EngineType, PlaybackState, TTSProvider, TTSResult } from "./types";
import type { MistralVoice } from "./types";
import { MistralProvider } from "./mistral-provider";
import { SpeechSynthProvider } from "./speech-synth-provider";
import type { PluginSettings } from "./settings";

/**
 * Manages multiple TTS providers and routes to the active one.
 * Holds provider instances and delegates playback control.
 */
export class TTSManager {
	readonly mistral: MistralProvider;
	readonly speechSynth: SpeechSynthProvider;
	private active: TTSProvider;
	private onStateChange: (s: PlaybackState) => void;

	constructor(
		getSettings: () => PluginSettings,
		onStateChange: (s: PlaybackState) => void,
	) {
		this.onStateChange = onStateChange;
		this.mistral = new MistralProvider(getSettings);
		this.speechSynth = new SpeechSynthProvider();
		this.active = this.mistral;
	}

	get state(): PlaybackState {
		return this.active.state;
	}

	get canSaveAudio(): boolean {
		return this.active.canSaveAudio;
	}

	get activeEngine(): TTSProvider {
		return this.active;
	}

	setEngine(engine: EngineType) {
		// Stop current before switching
		this.active.stop();
		switch (engine) {
			case "mistral":
				this.active = this.mistral;
				break;
			case "speech-synth":
				this.active = this.speechSynth;
				break;
			default:
				this.active = this.mistral;
		}
	}

	async speak(text: string): Promise<TTSResult> {
		return this.active.speak(text, this.onStateChange);
	}

	pause() { this.active.pause(); }
	resume() { this.active.resume(); }
	stop() { this.active.stop(); }

	// ── Mistral-specific voice management (delegated) ──────────────

	async listMistralVoices(): Promise<MistralVoice[]> {
		return this.mistral.listVoices();
	}

	async createMistralVoice(name: string, file: File): Promise<MistralVoice> {
		return this.mistral.createVoice(name, file);
	}

	async deleteMistralVoice(id: string): Promise<void> {
		return this.mistral.deleteVoice(id);
	}
}
