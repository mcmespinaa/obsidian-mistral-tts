import { requestUrl, Notice } from "obsidian";
import type { MistralTTSSettings } from "./settings";
import type {
	MistralVoice,
	PlaybackState,
} from "./types";

const API_BASE = "https://api.mistral.ai/v1";
const MODEL = "voxtral-mini-tts-2603";

export class TTSEngine {
	private settings: () => MistralTTSSettings;
	private currentAudio: HTMLAudioElement | null = null;
	private currentObjectUrl: string | null = null;
	private audioContext: AudioContext | null = null;
	private abortController: AbortController | null = null;
	private playQueue: Uint8Array[] = [];
	private pcmCarry = new Uint8Array(0);
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
		this.playQueue = [];

		const chunks = this.splitText(text);
		const audioBuffers: Uint8Array[] = [];

		for (let i = 0; i < chunks.length; i++) {
			if (this._state === "idle") break; // stopped

			if (chunks.length > 1) {
				new Notice(`Generating audio ${i + 1}/${chunks.length}...`);
			}

			const buffer = await this.generateChunk(chunks[i]);
			audioBuffers.push(buffer);

			if (i === 0) {
				this.playBuffer(buffer);
			} else {
				// Queue remaining chunks for sequential playback
				this.playQueue.push(buffer);
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

		let response;
		try {
			response = await requestUrl({
				url: `${API_BASE}/audio/speech`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${s.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
		} catch (e: unknown) {
			const status = (e as Record<string, unknown>)?.status ?? "unknown";
			const errBody = (e as Record<string, unknown>)?.text ?? (e as Error)?.message ?? "No details";
			const msg = typeof errBody === "string" ? errBody.slice(0, 200) : String(errBody);
			throw new Error(`Mistral API error (${status}): ${msg}`);
		}

		const audioBase64 = response.json?.audio_data;
		if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
			throw new Error(
				"Mistral API returned no audio data. Check your API key, voice, and quota."
			);
		}
		return base64ToUint8Array(audioBase64);
	}

	// ── Streaming TTS ──────────────────────────────────────────────

	async speakStreaming(text: string): Promise<Uint8Array> {
		this.stop();
		this.setState("loading");
		this.pcmCarry = new Uint8Array(0);

		const s = this.settings();
		if (!s.voiceId) {
			throw new Error("No voice selected.");
		}

		this.abortController = new AbortController();

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
			const safeMsg = errText.length > 200 ? errText.slice(0, 200) + "..." : errText;
			throw new Error(`Mistral API error ${response.status}: ${safeMsg}`);
		}

		if (!response.body) {
			throw new Error("No response body for streaming");
		}

		try {
			this.audioContext = new AudioContext({ sampleRate: 24000 });
		} catch (e) {
			throw new Error(
				`Could not initialize audio: ${(e as Error).message}. Try closing other tabs using audio.`
			);
		}

		const allChunks: Uint8Array[] = [];
		let nextStartTime = this.audioContext.currentTime;
		let lastSource: AudioBufferSourceNode | null = null;
		let malformedCount = 0;

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let sseBuffer = "";

		this.setState("playing");

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				sseBuffer += decoder.decode(value, { stream: true });

				if (sseBuffer.length > 10_000_000) {
					throw new Error("SSE buffer exceeded 10MB -- aborting");
				}

				const lines = sseBuffer.split("\n");
				sseBuffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const jsonStr = line.slice(6).trim();
					if (!jsonStr || jsonStr === "[DONE]") continue;

					let event: Record<string, unknown>;
					try {
						event = JSON.parse(jsonStr);
					} catch {
						malformedCount++;
						if (malformedCount > 10) {
							throw new Error("Too many malformed events from API -- stream may be corrupted");
						}
						continue;
					}

					// Surface API errors returned mid-stream
					if (event.error) {
						const errMsg = typeof event.error === "string"
							? event.error
							: (event.error as Record<string, unknown>)?.message || "Unknown stream error";
						throw new Error(`Mistral stream error: ${errMsg}`);
					}

					if (event.type === "speech.audio.delta" || event.audio_data) {
						const audioB64 =
							(event.data as Record<string, unknown>)?.audio_data || event.audio_data;
						if (typeof audioB64 !== "string") continue;

						let pcmBytes: Uint8Array;
						try {
							pcmBytes = base64ToUint8Array(audioB64);
						} catch {
							new Notice("Warning: skipped corrupt audio chunk");
							continue;
						}

						allChunks.push(pcmBytes);
						const result = this.scheduleChunk(pcmBytes, nextStartTime);
						nextStartTime = result.nextTime;
						lastSource = result.source ?? lastSource;
					}
				}
			}
		} catch (e) {
			if ((e as Error).name === "AbortError") {
				// User stopped playback
			} else {
				throw e;
			}
		} finally {
			reader.releaseLock();
		}

		if (allChunks.length === 0) {
			this.setState("idle");
			throw new Error("No audio received from stream. Try again or disable streaming.");
		}

		// Transition to idle when last audio chunk finishes playing
		if (lastSource) {
			lastSource.onended = () => {
				this.setState("idle");
			};
		} else {
			this.setState("idle");
		}

		// Combine all chunks for saving
		const totalLength = allChunks.reduce((sum, b) => sum + b.length, 0);
		const combined = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of allChunks) {
			combined.set(chunk, offset);
			offset += chunk.length;
		}

		return combined;
	}

	private scheduleChunk(
		pcmBytes: Uint8Array,
		startTime: number
	): { nextTime: number; source: AudioBufferSourceNode | null } {
		if (!this.audioContext || this.audioContext.state === "closed") {
			return { nextTime: startTime, source: null };
		}

		// Handle PCM byte alignment (Float32 requires 4-byte alignment)
		const combined = new Uint8Array(this.pcmCarry.length + pcmBytes.length);
		combined.set(this.pcmCarry);
		combined.set(pcmBytes, this.pcmCarry.length);
		const remainder = combined.length % 4;
		if (remainder > 0) {
			this.pcmCarry = combined.slice(combined.length - remainder);
		} else {
			this.pcmCarry = new Uint8Array(0);
		}
		const aligned = combined.slice(0, combined.length - remainder);
		if (aligned.length === 0) {
			return { nextTime: startTime, source: null };
		}

		// PCM float32 little-endian -> Float32Array
		const ab = aligned.buffer.slice(
			aligned.byteOffset,
			aligned.byteOffset + aligned.byteLength
		) as ArrayBuffer;
		const float32 = new Float32Array(ab);
		const audioBuffer = this.audioContext.createBuffer(1, float32.length, 24000);
		audioBuffer.copyToChannel(float32, 0);

		const source = this.audioContext.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(this.audioContext.destination);

		const now = this.audioContext.currentTime;
		const playAt = Math.max(startTime, now);
		source.start(playAt);

		return { nextTime: playAt + audioBuffer.duration, source };
	}

	// ── Playback Controls ────────────────────────────────��─────────

	private playBuffer(data: Uint8Array) {
		const mimeType = `audio/${this.settings().responseFormat}`;
		const safeBuffer = data.buffer.slice(
			data.byteOffset,
			data.byteOffset + data.byteLength
		) as ArrayBuffer;
		const blob = new Blob([safeBuffer], { type: mimeType });
		const url = URL.createObjectURL(blob);
		this.currentObjectUrl = url;

		this.currentAudio = new Audio(url);
		this.currentAudio.addEventListener("ended", () => {
			URL.revokeObjectURL(url);
			this.currentObjectUrl = null;
			// Play next queued chunk if available
			if (this.playQueue.length > 0) {
				this.playBuffer(this.playQueue.shift()!);
			} else {
				this.setState("idle");
			}
		});
		this.currentAudio.addEventListener("error", () => {
			const msg = this.currentAudio?.error?.message || "Unknown playback error";
			new Notice(`Audio playback failed: ${msg}`);
			this.stop();
		});
		this.currentAudio.play().catch((err: Error) => {
			new Notice(`Could not start playback: ${err.message}`);
			this.stop();
		});
		this.setState("playing");
	}

	pause() {
		if (this.currentAudio && this._state === "playing") {
			this.currentAudio.pause();
			this.setState("paused");
		} else if (this.audioContext?.state === "running") {
			this.audioContext.suspend().catch(() => {
				new Notice("Could not pause audio stream");
			});
			this.setState("paused");
		}
	}

	resume() {
		if (this.currentAudio && this._state === "paused") {
			this.currentAudio.play().catch((err: Error) => {
				new Notice(`Could not resume: ${err.message}`);
			});
			this.setState("playing");
		} else if (this.audioContext?.state === "suspended") {
			this.audioContext.resume().catch(() => {
				new Notice("Could not resume audio stream");
			});
			this.setState("playing");
		}
	}

	stop() {
		this.playQueue = [];
		if (this.currentAudio) {
			this.currentAudio.pause();
			this.currentAudio = null;
		}
		if (this.currentObjectUrl) {
			URL.revokeObjectURL(this.currentObjectUrl);
			this.currentObjectUrl = null;
		}
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		if (this.audioContext) {
			try { this.audioContext.close(); } catch { /* already closed */ }
			this.audioContext = null;
		}
		this.pcmCarry = new Uint8Array(0);
		this.setState("idle");
	}

	// ── Voice Management ───────────────────────────────────────────

	async listVoices(): Promise<MistralVoice[]> {
		const response = await requestUrl({
			url: `${API_BASE}/audio/voices`,
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.settings().apiKey}`,
			},
		});
		const body = response.json;
		const voices = body?.items ?? body?.data;
		if (!Array.isArray(voices)) {
			throw new Error("Unexpected response from Mistral Voices API");
		}
		return voices as MistralVoice[];
	}

	async createVoice(name: string, audioFile: File): Promise<MistralVoice> {
		const MAX_VOICE_SAMPLE_SIZE = 10 * 1024 * 1024; // 10MB
		if (audioFile.size > MAX_VOICE_SAMPLE_SIZE) {
			throw new Error("Audio sample must be under 10MB");
		}
		const arrayBuffer = await audioFile.arrayBuffer();
		const base64Audio = uint8ArrayToBase64(new Uint8Array(arrayBuffer));

		const response = await requestUrl({
			url: `${API_BASE}/audio/voices`,
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

		const voice = response.json;
		if (!voice?.id || !voice?.name) {
			throw new Error("Voice was created but API response was missing expected fields. Check your voices list.");
		}
		return voice as MistralVoice;
	}

	async deleteVoice(voiceId: string): Promise<void> {
		await requestUrl({
			url: `${API_BASE}/audio/voices/${voiceId}`,
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.settings().apiKey}`,
			},
		});
	}
}

// ── Helpers ────────────────────────────────────────────────────────

function base64ToUint8Array(base64: string): Uint8Array {
	let binary: string;
	try {
		binary = atob(base64);
	} catch {
		throw new Error("Invalid audio data received (base64 decode failed)");
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = "";
	const CHUNK = 8192;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
