import { requestUrl, Notice } from "obsidian";
import type { MistralTTSSettings } from "./settings";
import type {
	MistralVoice,
	MistralVoiceListResponse,
	PlaybackState,
} from "./types";

const API_BASE = "https://api.mistral.ai/v1";
const MODEL = "voxtral-mini-tts-2603";

export class TTSEngine {
	private settings: () => MistralTTSSettings;
	private currentAudio: HTMLAudioElement | null = null;
	private audioContext: AudioContext | null = null;
	private abortController: AbortController | null = null;
	private _state: PlaybackState = "idle";
	private onStateChange: (state: PlaybackState) => void;

	constructor(
		getSettings: () => MistralTTSSettings,
		onStateChange: (state: PlaybackState) => void
	) {
		this.settings = getSettings;
		this.onStateChange = onStateChange;
	}

	get state(): PlaybackState {
		return this._state;
	}

	private setState(state: PlaybackState) {
		this._state = state;
		this.onStateChange(state);
	}

	// ── Text Chunking ──────────────────────────────────────────────

	splitText(text: string): string[] {
		const max = this.settings().maxChunkLength;
		if (text.length <= max) return [text];

		const sentences = text.split(/(?<=[.!?])\s+/);
		const chunks: string[] = [];
		let current = "";

		for (const sentence of sentences) {
			if ((current + " " + sentence).length > max && current) {
				chunks.push(current.trim());
				current = sentence;
			} else {
				current += (current ? " " : "") + sentence;
			}
		}
		if (current.trim()) chunks.push(current.trim());
		return chunks;
	}

	// ── Non-Streaming TTS ──────────────────────────────────────────

	async speak(text: string): Promise<Uint8Array> {
		this.stop();
		this.setState("loading");

		const chunks = this.splitText(text);
		const audioBuffers: Uint8Array[] = [];

		for (let i = 0; i < chunks.length; i++) {
			if (this._state === "idle") break; // stopped

			if (chunks.length > 1) {
				new Notice(`Generating audio ${i + 1}/${chunks.length}...`);
			}

			const buffer = await this.generateChunk(chunks[i]);
			audioBuffers.push(buffer);

			// Start playing the first chunk immediately while generating the rest
			if (i === 0) {
				this.playBuffer(buffer);
			}
		}

		// Combine all chunks for saving
		const totalLength = audioBuffers.reduce((sum, b) => sum + b.length, 0);
		const combined = new Uint8Array(totalLength);
		let offset = 0;
		for (const buf of audioBuffers) {
			combined.set(buf, offset);
			offset += buf.length;
		}

		return combined;
	}

	private async generateChunk(text: string): Promise<Uint8Array> {
		const s = this.settings();
		const body: Record<string, unknown> = {
			model: MODEL,
			input: text,
			response_format: s.responseFormat,
		};

		if (s.voiceId) {
			body.voice_id = s.voiceId;
		} else {
			throw new Error(
				"No voice selected. Set a voice in settings or create one."
			);
		}

		const response = await requestUrl({
			url: `${API_BASE}/audio/speech`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${s.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		const audioBase64: string = response.json.audio_data;
		return base64ToUint8Array(audioBase64);
	}

	// ── Streaming TTS ──────────────────────────────────────────────

	async speakStreaming(text: string): Promise<Uint8Array> {
		this.stop();
		this.setState("loading");

		const s = this.settings();
		if (!s.voiceId) {
			throw new Error("No voice selected.");
		}

		this.abortController = new AbortController();

		// Use fetch for SSE streaming (requestUrl doesn't support it)
		const response = await fetch(`${API_BASE}/audio/speech`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${s.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: MODEL,
				input: text,
				voice_id: s.voiceId,
				response_format: "pcm",
				stream: true,
			}),
			signal: this.abortController.signal,
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Mistral API error ${response.status}: ${errText}`);
		}

		if (!response.body) {
			throw new Error("No response body for streaming");
		}

		// Set up Web Audio API for real-time playback
		this.audioContext = new AudioContext({ sampleRate: 24000 });
		const allChunks: Uint8Array[] = [];
		let nextStartTime = this.audioContext.currentTime;

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		this.setState("playing");

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const jsonStr = line.slice(6).trim();
					if (!jsonStr || jsonStr === "[DONE]") continue;

					try {
						const event = JSON.parse(jsonStr);

						if (event.type === "speech.audio.delta" || event.audio_data) {
							const audioB64 =
								event.data?.audio_data || event.audio_data;
							if (!audioB64) continue;

							const pcmBytes = base64ToUint8Array(audioB64);
							allChunks.push(pcmBytes);

							// Schedule this chunk for playback
							nextStartTime = await this.scheduleChunk(
								pcmBytes,
								nextStartTime
							);
						}
					} catch {
						// Skip malformed JSON lines
					}
				}
			}
		} catch (e) {
			if ((e as Error).name === "AbortError") {
				// User stopped playback
			} else {
				throw e;
			}
		}

		// Combine all chunks
		const totalLength = allChunks.reduce((sum, b) => sum + b.length, 0);
		const combined = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of allChunks) {
			combined.set(chunk, offset);
			offset += chunk.length;
		}

		return combined;
	}

	private async scheduleChunk(
		pcmBytes: Uint8Array,
		startTime: number
	): Promise<number> {
		if (!this.audioContext) return startTime;

		// PCM float32 little-endian -> Float32Array
		const float32 = new Float32Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 4);
		const audioBuffer = this.audioContext.createBuffer(
			1,
			float32.length,
			24000
		);
		audioBuffer.copyToChannel(float32, 0);

		const source = this.audioContext.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(this.audioContext.destination);

		const now = this.audioContext.currentTime;
		const playAt = Math.max(startTime, now);
		source.start(playAt);

		return playAt + audioBuffer.duration;
	}

	// ── Playback Controls ──────────────────────────────────────────

	private playBuffer(data: Uint8Array) {
		const mimeType = `audio/${this.settings().responseFormat}`;
		const blob = new Blob([data], { type: mimeType });
		const url = URL.createObjectURL(blob);

		this.currentAudio = new Audio(url);
		this.currentAudio.addEventListener("ended", () => {
			URL.revokeObjectURL(url);
			this.setState("idle");
		});
		this.currentAudio.play();
		this.setState("playing");
	}

	pause() {
		if (this.currentAudio && this._state === "playing") {
			this.currentAudio.pause();
			this.setState("paused");
		}
		if (this.audioContext?.state === "running") {
			this.audioContext.suspend();
			this.setState("paused");
		}
	}

	resume() {
		if (this.currentAudio && this._state === "paused") {
			this.currentAudio.play();
			this.setState("playing");
		}
		if (this.audioContext?.state === "suspended") {
			this.audioContext.resume();
			this.setState("playing");
		}
	}

	stop() {
		if (this.currentAudio) {
			this.currentAudio.pause();
			this.currentAudio = null;
		}
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		if (this.audioContext) {
			this.audioContext.close();
			this.audioContext = null;
		}
		this.setState("idle");
	}

	// ── Voice Management ───────────────────────────────────────────

	async listVoices(): Promise<MistralVoice[]> {
		const response = await requestUrl({
			url: `${API_BASE}/voices`,
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.settings().apiKey}`,
			},
		});
		const body: MistralVoiceListResponse = response.json;
		return body.data;
	}

	async createVoice(name: string, audioFile: File): Promise<MistralVoice> {
		const arrayBuffer = await audioFile.arrayBuffer();
		const base64Audio = uint8ArrayToBase64(new Uint8Array(arrayBuffer));

		const response = await requestUrl({
			url: `${API_BASE}/voices`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.settings().apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name,
				sample_audio: base64Audio,
				sample_filename: audioFile.name,
			}),
		});

		return response.json as MistralVoice;
	}

	async deleteVoice(voiceId: string): Promise<void> {
		await requestUrl({
			url: `${API_BASE}/voices/${voiceId}`,
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.settings().apiKey}`,
			},
		});
	}
}

// ── Helpers ────────────────────────────────────────────────────────

function base64ToUint8Array(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}
