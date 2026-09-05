import {
	normalizeVoiceTranscriptionUrl,
	VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
	VOICE_TRANSCRIPTION_TIMEOUT_MS,
} from "../../shared/voiceTranscriptionConfig";
import type {
	VoiceTranscriptionRequest,
	VoiceTranscriptionResult,
} from "../../shared/types/voiceTranscription";
import type { VoiceTranscriptionCredentials } from "./VoiceTranscriptionConfigStore";

const MAX_RESPONSE_BYTES = 128 * 1024;
const AUDIO_EXTENSIONS = new Map([
	["audio/webm", "webm"],
	["audio/ogg", "ogg"],
	["audio/mp4", "m4a"],
	["audio/mpeg", "mp3"],
	["audio/mp3", "mp3"],
	["audio/wav", "wav"],
	["audio/wave", "wav"],
	["audio/x-wav", "wav"],
]);

/** Calls an OpenAI-compatible multipart transcription endpoint from main only. */
export class VoiceTranscriptionService {
	private readonly inFlight = new Map<string, AbortController>();

	constructor(private readonly deps: {
		getCredentials: () => Promise<VoiceTranscriptionCredentials | null>;
		fetch?: typeof fetch;
		timeoutMs?: number;
		log: (message: string, details?: Record<string, unknown>) => void;
	}) {}

	async transcribe(input: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
		const mimeType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		const extension = AUDIO_EXTENSIONS.get(mimeType);
		if (!extension || input.audio.byteLength === 0 || input.audio.byteLength > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
			return { ok: false, error: "invalidRequest" };
		}
		const previous = this.inFlight.get(input.requestId);
		if (previous) previous.abort();
		const controller = new AbortController();
		this.inFlight.set(input.requestId, controller);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		try {
			const credentials = await this.deps.getCredentials();
			if (controller.signal.aborted) return { ok: false, error: "cancelled" };
			if (!credentials) return { ok: false, error: "notConfigured" };
			const endpoint = normalizeVoiceTranscriptionUrl(credentials.baseUrl);
			if (!endpoint || !credentials.model.trim()) return { ok: false, error: "notConfigured" };

			const body = new FormData();
			body.append("file", new Blob([input.audio], { type: mimeType }), `recording.${extension}`);
			body.append("model", credentials.model.trim());
			if (credentials.language.trim()) body.append("language", credentials.language.trim());
			timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, this.deps.timeoutMs ?? VOICE_TRANSCRIPTION_TIMEOUT_MS);
			const response = await (this.deps.fetch ?? fetch)(endpoint, {
				method: "POST",
				headers: { Authorization: `Bearer ${credentials.apiKey}` },
				body,
				signal: controller.signal,
			});
			if (!response.ok) {
				const error = response.status === 401 || response.status === 403
					? "invalidKey"
					: response.status === 404 || response.status === 405
						? "badBaseUrl"
						: "http";
				this.deps.log("request rejected", { status: response.status, error });
				return { ok: false, error };
			}
			const textBody = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
			if (textBody === null) return { ok: false, error: "http" };
			const text = parseTranscriptionText(textBody);
			return text ? { ok: true, text } : { ok: false, error: "empty" };
		} catch {
			const error = controller.signal.aborted
				? timedOut ? "timeout" : "cancelled"
				: "network";
			this.deps.log("request failed", { error });
			return { ok: false, error };
		} finally {
			if (timeout) clearTimeout(timeout);
			if (this.inFlight.get(input.requestId) === controller) {
				this.inFlight.delete(input.requestId);
			}
		}
	}

	cancel(requestId: string): void {
		this.inFlight.get(requestId)?.abort();
	}
}

async function readBoundedResponseText(response: Response, limit: number): Promise<string | null> {
	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > limit) return null;
	if (!response.body) {
		const text = await response.text();
		return new TextEncoder().encode(text).byteLength <= limit ? text : null;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		total += chunk.value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return null;
		}
		text += decoder.decode(chunk.value, { stream: true });
	}
	return text + decoder.decode();
}

function parseTranscriptionText(raw: string): string {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || !("text" in parsed)) return "";
		const text = Reflect.get(parsed, "text");
		return typeof text === "string" && text.length <= 100_000 ? text.trim() : "";
	} catch {
		return "";
	}
}
