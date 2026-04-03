// Mistral API types

export interface MistralVoice {
	id: string;
	name: string;
	slug?: string;
	languages?: string[];
	gender?: string;
	age?: number;
	tags?: string[];
}

export interface MistralTTSRequest {
	model: string;
	input: string;
	voice_id?: string;
	ref_audio?: string;
	response_format?: string;
	stream?: boolean;
}

export interface MistralTTSResponse {
	audio_data: string; // base64-encoded audio
}

export interface MistralVoiceCreateRequest {
	name: string;
	sample_audio: string; // base64
	sample_filename?: string;
	languages?: string[];
	gender?: string;
	tags?: string[];
}

export interface MistralVoiceListResponse {
	items: MistralVoice[];
	total: number;
	page: number;
	page_size: number;
	total_pages: number;
}

// SSE streaming events
export interface MistralStreamDelta {
	event: "speech.audio.delta";
	data: {
		audio_data: string; // base64 chunk
	};
}

export interface MistralStreamDone {
	event: "speech.audio.done";
	data: {
		usage: {
			input_tokens: number;
			output_tokens: number;
		};
	};
}

export type MistralStreamEvent = MistralStreamDelta | MistralStreamDone;

// ── Plugin internal types ──────────────────────────────────────────

export type PlaybackState = "idle" | "loading" | "playing" | "paused";
export type EngineType = "mistral" | "kokoro" | "speech-synth";

/** Result of a TTS generation. audioData is null when engine plays directly (SpeechSynthesis). */
export interface TTSResult {
	audioData: Uint8Array | null;
	format: string;
}

/** Common interface all TTS engines implement */
export interface TTSProvider {
	readonly name: string;
	readonly canSaveAudio: boolean;

	speak(text: string, onStateChange: (s: PlaybackState) => void): Promise<TTSResult>;
	pause(): void;
	resume(): void;
	stop(): void;

	readonly state: PlaybackState;
}

/** Voice info for settings UI */
export interface VoiceInfo {
	id: string;
	name: string;
	language?: string;
	gender?: string;
}
