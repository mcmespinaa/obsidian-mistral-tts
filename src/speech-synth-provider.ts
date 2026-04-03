import { Notice } from "obsidian";
import type { PlaybackState, TTSProvider, TTSResult, VoiceInfo } from "./types";

const MAX_UTTERANCE_LENGTH = 250;

/**
 * Browser SpeechSynthesis API fallback.
 * Zero setup, works offline, but can't return audio data (plays directly to speakers).
 */
export class SpeechSynthProvider implements TTSProvider {
	readonly name = "System voices";
	readonly canSaveAudio = false;

	private _state: PlaybackState = "idle";
	private _onStateChange: (s: PlaybackState) => void = () => {};
	private voiceName: string;
	private rate: number;

	constructor(voiceName = "", rate = 1.0) {
		this.voiceName = voiceName;
		this.rate = rate;
	}

	get state(): PlaybackState {
		return this._state;
	}

	private setState(s: PlaybackState) {
		this._state = s;
		this._onStateChange(s);
	}

	setVoice(voiceName: string) {
		this.voiceName = voiceName;
	}

	setRate(rate: number) {
		this.rate = rate;
	}

	async speak(text: string, onStateChange: (s: PlaybackState) => void): Promise<TTSResult> {
		this._onStateChange = onStateChange;
		this.stop();
		this.setState("loading");

		const synth = window.speechSynthesis;
		if (!synth) {
			throw new Error("SpeechSynthesis not available in this environment");
		}

		const voice = await this.resolveVoice();
		const sentences = splitForSpeechSynth(text);

		if (sentences.length === 0) {
			this.setState("idle");
			return { audioData: null, format: "" };
		}

		return new Promise<TTSResult>((resolve, reject) => {
			let index = 0;

			const speakNext = () => {
				if (index >= sentences.length || this._state === "idle") {
					this.setState("idle");
					resolve({ audioData: null, format: "" });
					return;
				}

				const utterance = new SpeechSynthesisUtterance(sentences[index]);
				if (voice) utterance.voice = voice;
				utterance.rate = this.rate;

				utterance.onend = () => {
					index++;
					speakNext();
				};

				utterance.onerror = (e) => {
					if (e.error === "canceled" || e.error === "interrupted") {
						this.setState("idle");
						resolve({ audioData: null, format: "" });
					} else {
						this.setState("idle");
						reject(new Error(`Speech error: ${e.error}`));
					}
				};

				if (index === 0) {
					this.setState("playing");
				}

				synth.speak(utterance);
			};

			speakNext();
		});
	}

	pause() {
		if (this._state === "playing") {
			window.speechSynthesis?.pause();
			this.setState("paused");
		}
	}

	resume() {
		if (this._state === "paused") {
			window.speechSynthesis?.resume();
			this.setState("playing");
		}
	}

	stop() {
		window.speechSynthesis?.cancel();
		this.setState("idle");
	}

	/** Get available system voices. Handles the Chrome/Electron async voice loading quirk. */
	static async getVoices(): Promise<VoiceInfo[]> {
		const synth = window.speechSynthesis;
		if (!synth) return [];

		const rawVoices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
			const voices = synth.getVoices();
			if (voices.length > 0) {
				resolve(voices);
				return;
			}
			// Chrome/Electron: voices load async
			const handler = () => {
				synth.removeEventListener("voiceschanged", handler);
				resolve(synth.getVoices());
			};
			synth.addEventListener("voiceschanged", handler);
			// Timeout fallback in case event never fires
			setTimeout(() => resolve(synth.getVoices()), 1000);
		});

		return rawVoices.map((v) => ({
			id: v.name,
			name: `${v.name} (${v.lang})${v.localService ? "" : " [online]"}`,
			language: v.lang,
		}));
	}

	private async resolveVoice(): Promise<SpeechSynthesisVoice | null> {
		const synth = window.speechSynthesis;
		if (!synth) return null;

		const voices = synth.getVoices();
		if (!this.voiceName) return voices[0] ?? null;
		return voices.find((v) => v.name === this.voiceName) ?? voices[0] ?? null;
	}
}

// ── Text splitting for SpeechSynthesis ─────────────────────────────

function splitForSpeechSynth(text: string): string[] {
	// Split by sentences first
	const sentences = text.split(/(?<=[.!?])\s+/);
	const chunks: string[] = [];

	for (const sentence of sentences) {
		if (sentence.length <= MAX_UTTERANCE_LENGTH) {
			chunks.push(sentence);
		} else {
			// Long sentence: split at clause boundaries or word boundaries
			const parts = sentence.split(/(?<=[,;:])\s+/);
			let current = "";
			for (const part of parts) {
				if ((current + " " + part).length > MAX_UTTERANCE_LENGTH && current) {
					chunks.push(current.trim());
					current = part;
				} else {
					current += (current ? " " : "") + part;
				}
			}
			if (current.trim()) chunks.push(current.trim());
		}
	}

	return chunks.filter((c) => c.length > 0);
}
