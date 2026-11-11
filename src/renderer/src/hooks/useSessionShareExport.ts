import { useEffect, useRef, useState } from "react";
import { useStore } from "jotai";
import { DEFAULT_SESSION_SHARE_OPTIONS, type SessionShareInventory, type SessionShareOptions, type SessionSharePreview } from "../../../shared/types/sessionExport";
import { desktopApi } from "../desktopApi";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { isLiveRuntimeStatus, requireSessionCommand, toSessionRuntimeTarget } from "../utils/sessionCommands";
import { showNotice } from "../utils/notice";
import { t } from "../i18n";

/** 导出只在显式预览后允许保存；选项一变就销毁旧预览，迟到响应也只能被释放。 */
export function useSessionShareExport(sessionId: string, onClose: () => void) {
	const store = useStore();
	const [options, setOptions] = useState<SessionShareOptions>({ ...DEFAULT_SESSION_SHARE_OPTIONS });
	const [preview, setPreview] = useState<SessionSharePreview | null>(null);
	const [inventory, setInventory] = useState<SessionShareInventory | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const previewId = useRef<string | null>(null);
	const request = useRef(0);

	const release = (id: string | null) => {
		if (id) void desktopApi.sessions.releaseShareExport(id).catch(() => undefined);
	};
	useEffect(
		() => () => {
			request.current += 1;
			release(previewId.current);
		},
		[sessionId],
	);

	const updateOption = (key: keyof SessionShareOptions, value: boolean) => {
		setOptions((current) => ({ ...current, [key]: value }));
		release(previewId.current);
		previewId.current = null;
		setPreview(null);
		setConfirmed(false);
		setError("");
	};
	const prepare = async () => {
		if (busy) return;
		const sequence = ++request.current;
		setBusy(true);
		setError("");
		setConfirmed(false);
		release(previewId.current);
		previewId.current = null;
		setPreview(null);
		try {
			const result = await desktopApi.sessions.prepareShareExport({ sessionId, options });
			if (request.current !== sequence) {
				if (result.ok) release(result.value.previewId);
				return;
			}
			if (!result.ok) {
				setError(t(result.error === "SESSION_SHARE_UNSUPPORTED" ? "sessionShare.unsupported" : result.error === "SESSION_SHARE_TOO_LARGE" ? "sessionShare.tooLarge" : result.error === "SESSION_SHARE_CHANGED" ? "sessionShare.changed" : "sessionShare.readFailed"));
				return;
			}
			previewId.current = result.value.previewId;
			setPreview(result.value);
			setInventory(result.value.inventory);
		} catch {
			if (request.current === sequence) setError(t("sessionShare.readFailed"));
		} finally {
			if (request.current === sequence) setBusy(false);
		}
	};
	const save = async () => {
		if (busy || !preview || !confirmed) return;
		setBusy(true);
		setError("");
		try {
			const result = await desktopApi.sessions.saveShareExport(preview.previewId);
			if (!result.ok) {
				setError(t(result.error === "SESSION_SHARE_PREVIEW_EXPIRED" ? "sessionShare.expired" : "sessionShare.writeFailed"));
				return;
			}
			previewId.current = null;
			showNotice(t("app.exportedPath", { path: result.value.path }), 5000);
			onClose();
		} catch {
			setError(t("sessionShare.writeFailed"));
		} finally {
			setBusy(false);
		}
	};
	const exportComplete = async () => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const runtime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
			const target = toSessionRuntimeTarget(sessionId, runtime);
			const result = target && isLiveRuntimeStatus(runtime?.status) ? requireSessionCommand(await desktopApi.sessions.exportRuntimeHtml(target)).value : await desktopApi.sessions.exportRecordHtml(sessionId);
			if (!result || typeof result !== "object" || !("path" in result) || typeof result.path !== "string") throw new Error("export failed");
			showNotice(t("truncated" in result && result.truncated ? "app.exportedPathTruncated" : "app.exportedPath", { path: result.path }), 5000);
			onClose();
		} catch {
			setError(t("sessionShare.fullFailed"));
		} finally {
			setBusy(false);
		}
	};
	return { options, preview, inventory, busy, error, confirmed, setConfirmed, updateOption, prepare, save, exportComplete };
}
