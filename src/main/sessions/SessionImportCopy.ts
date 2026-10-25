import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

export type SessionImportCopyKey = Extract<MainProcessTranslationKey, "session.importedTitle" | "session.importedPreview" | "session.codexUntitledTitle" | "session.importedOrphanToolResult">;

export type SessionImportCopy = (key: SessionImportCopyKey, params?: Record<string, string | number>) => string;

const defaultCopy: Record<SessionImportCopyKey, string> = {
	"session.importedTitle": "{source} session",
	"session.importedPreview": "{source} imported session",
	"session.codexUntitledTitle": "Codex session {date}",
	"session.importedOrphanToolResult": "[{tool} result, detached from its tool call in the source transcript, kept as text]\n{text}",
};

export function defaultSessionImportCopy(key: SessionImportCopyKey, params: Record<string, string | number> = {}): string {
	return defaultCopy[key].replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
}
