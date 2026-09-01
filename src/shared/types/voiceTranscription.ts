export type VoiceTranscriptionPublicConfig = {
	baseUrl: string;
	model: string;
	language: string;
	hasApiKey: boolean;
};

export type VoiceTranscriptionSaveInput = {
	baseUrl: string;
	model: string;
	language: string;
	apiKey?: string;
	clearApiKey?: boolean;
};

export type VoiceTranscriptionConfigErrorCode =
	| "invalidConfig"
	| "secureStorageUnavailable"
	| "saveFailed";

export type VoiceTranscriptionSaveResult =
	| { ok: true; config: VoiceTranscriptionPublicConfig }
	| { ok: false; error: VoiceTranscriptionConfigErrorCode };

export type VoiceTranscriptionRequest = {
	requestId: string;
	audio: ArrayBuffer;
	mimeType: string;
};

export type VoiceTranscriptionErrorCode =
	| "invalidRequest"
	| "notConfigured"
	| "invalidKey"
	| "badBaseUrl"
	| "network"
	| "timeout"
	| "cancelled"
	| "http"
	| "empty";

export type VoiceTranscriptionResult =
	| { ok: true; text: string }
	| { ok: false; error: VoiceTranscriptionErrorCode };
