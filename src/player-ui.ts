import type { Plugin } from "obsidian";
import type { PlaybackState } from "./types";

const ICONS: Record<PlaybackState, string> = {
	idle: "",
	loading: "⟳",
	playing: "■",
	paused: "▶",
};

const LABELS: Record<PlaybackState, string> = {
	idle: "",
	loading: "Generating...",
	playing: "Playing (click to pause)",
	paused: "Paused (click to resume)",
};

export class PlayerUI {
	private statusBarEl: HTMLElement | null = null;
	private onPauseResume: () => void;
	private onStop: () => void;

	constructor(onPauseResume: () => void, onStop: () => void) {
		this.onPauseResume = onPauseResume;
		this.onStop = onStop;
	}

	attach(plugin: Plugin) {
		this.statusBarEl = plugin.addStatusBarItem();
		this.statusBarEl.addClass("mistral-tts-status");
		this.update("idle");

		this.statusBarEl.addEventListener("click", () => this.onPauseResume());
		this.statusBarEl.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.onStop();
		});
	}

	update(state: PlaybackState) {
		if (!this.statusBarEl) return;

		if (state === "idle") {
			this.statusBarEl.empty();
			this.statusBarEl.addClass("mistral-tts-hidden");
			return;
		}

		this.statusBarEl.removeClass("mistral-tts-hidden");
		this.statusBarEl.empty();
		this.statusBarEl.setText(`${ICONS[state]} TTS: ${LABELS[state]}`);
		this.statusBarEl.setAttribute("aria-label", LABELS[state]);
	}
}
