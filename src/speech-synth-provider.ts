import type { PlaybackState, TTSProvider, TTSResult, VoiceInfo } from "./types";

const MAX_UTTERANCE_LENGTH = 250;

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

	setVoice(voiceName: string) { this.voiceName = voiceName; }
	setRate(rate: number) { this.rate = rate; }

	async speak(text: string, onStateChange: (s: PlaybackState) => void): Promise<TTSResult> {
		this._onStateChange = onStateChange;
		this.stop();
		this.setState("loading");

		const synth = window.speechSynthesis;
		if (!synth) {
			throw new Error("SpeechSynthesis not available in this environment");
		}

		const voice = this.resolveVoice();
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

	static async getVoices(): Promise<VoiceInfo[]> {
		const synth = window.speechSynthesis;
		if (!synth) return [];

		const rawVoices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
			const voices = synth.getVoices();
			if (voices.length > 0) {
				resolve(voices);
				return;
			}
			const handler = () => {
				synth.removeEventListener("voiceschanged", handler);
				resolve(synth.getVoices());
			};
			synth.addEventListener("voiceschanged", handler);
			setTimeout(() => resolve(synth.getVoices()), 1000);
		});

		return rawVoices.map((v) => ({
			id: v.name,
			name: `${v.name} (${v.lang})${v.localService ? "" : " [online]"}`,
			language: v.lang,
		}));
	}

	private resolveVoice(): SpeechSynthesisVoice | null {
		const synth = window.speechSynthesis;
		if (!synth) return null;

		const voices = synth.getVoices();
		if (!this.voiceName) return voices[0] ?? null;
		return voices.find((v) => v.name === this.voiceName) ?? voices[0] ?? null;
	}
}

// Split text without lookbehinds (iOS < 16.4 compatibility)
function splitForSpeechSynth(text: string): string[] {
	const sentences = splitAfterPunctuation(text, /[.!?]\s+/);
	const chunks: string[] = [];

	for (const sentence of sentences) {
		if (sentence.length <= MAX_UTTERANCE_LENGTH) {
			chunks.push(sentence);
		} else {
			const parts = splitAfterPunctuation(sentence, /[,;:]\s+/);
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

function splitAfterPunctuation(text: string, pattern: RegExp): string[] {
	const results: string[] = [];
	const globalPattern = new RegExp(pattern.source, "g");

	let lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = globalPattern.exec(text)) !== null) {
		const end = match.index + match[0].length;
		results.push(text.slice(lastIndex, end).trim());
		lastIndex = end;
	}
	const tail = text.slice(lastIndex).trim();
	if (tail) results.push(tail);

	return results;
}
