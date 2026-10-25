/**
 * 生视频 IPC 域：只做入参校验与装配。
 * 通道：videogen:submit / videogen:cancel / videogen:get-config /
 *       videogen:save-config / videogen:list-jobs（事件经 videogen:event 推送）。
 *
 * 凭据来自独立 VideoGenConfigStore（userData/videogen.json），不读 pi models.json。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";

const MAX_PROMPT = 4000;
const MAX_PARAM = 32;

/** 参数白名单：短字符串、去空白；非法丢弃回 undefined（由供应商默认接管）。 */
function parseParam(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().slice(0, MAX_PARAM);
	return trimmed || undefined;
}

export function registerVideoGenIpc(deps: {
	submit: (request: { provider: string; model: string; prompt: string; sessionId?: string; resolution?: string; duration?: string; ratio?: string }) => Promise<{ ok: true; jobId: string; messageId: string } | { ok: false; error: string; detail?: string }>;
	cancel: (jobId: string) => Promise<boolean>;
	getConfig: () => Promise<unknown>;
	saveConfig: (input: unknown) => Promise<{ ok: true; config: unknown } | { ok: false; error: string }>;
	listJobs: (sessionId: string) => Array<unknown>;
	log: (message: string, ...args: unknown[]) => void;
}) {
	ipcMain.handle(ipcChannels.videogenGetConfig, async () => deps.getConfig());

	ipcMain.handle(ipcChannels.videogenSaveConfig, async (_event, input: unknown) => {
		const result = await deps.saveConfig(input);
		deps.log("videogen", "config save", { ok: result.ok });
		return result;
	});

	ipcMain.handle(ipcChannels.videogenListJobs, async (_event, sessionId: unknown) => {
		if (typeof sessionId !== "string" || !sessionId.trim()) return [];
		return deps.listJobs(sessionId.trim());
	});

	ipcMain.handle(ipcChannels.videogenCancel, async (_event, jobId: unknown) => {
		if (typeof jobId !== "string" || !jobId.trim()) return { ok: false };
		const ok = await deps.cancel(jobId.trim());
		return { ok };
	});

	ipcMain.handle(ipcChannels.videogenSubmit, async (_event, input: unknown) => {
		// 渲染层数据不可信：必填字段有限长度非空字符串；可选参数白名单收窄
		const candidate = input as {
			provider?: unknown;
			model?: unknown;
			prompt?: unknown;
			sessionId?: unknown;
			resolution?: unknown;
			duration?: string | unknown;
			ratio?: unknown;
		} | null;
		const provider = typeof candidate?.provider === "string" ? candidate.provider.trim() : "";
		const model = typeof candidate?.model === "string" ? candidate.model.trim() : "";
		const prompt = typeof candidate?.prompt === "string" ? candidate.prompt.trim() : "";
		const sessionId = typeof candidate?.sessionId === "string" ? candidate.sessionId.trim() : "";
		if (!model || !prompt || prompt.length > MAX_PROMPT) {
			return { ok: false, error: "http", detail: "invalid request" } as const;
		}
		const result = await deps.submit({
			provider,
			model,
			prompt,
			sessionId: sessionId || undefined,
			resolution: parseParam(candidate?.resolution),
			duration: parseParam(candidate?.duration),
			ratio: parseParam(candidate?.ratio),
		});
		if (!result.ok) {
			deps.log("videogen", "submit rejected", { error: result.error, provider });
		}
		return result;
	});
}
