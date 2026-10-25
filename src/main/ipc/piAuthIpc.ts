/**
 * pi 供应商认证 IPC handler（薄层：只做入参校验与适配，业务在 PiAuthService）。
 *
 * 认证是 PiDeck 访问 pi 内部能力的唯一例外通道，因此这里的入参校验刻意收紧：
 * 供应商 id 只允许 pi 侧的标识符形态（`kimi-coding` / `anthropic` 这类），
 * 提问回填长度设上限——渲染层来的数据一律不可信，越界输入在边界就拦掉。
 */

import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { PiAuthLoginRequest, PiAuthMethod } from "../../shared/types/piAuth";
import type { PiAuthService } from "../pi/auth/PiAuthService";

/** 供应商 id 形态：pi 用的是小写连字符标识符，这里留出 `_`/`.` 的余地。 */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 提问回填上限：授权码/API key 都在几百字符内，4096 足够且能挡住误传的大文本。 */
const MAX_ANSWER_LENGTH = 4096;

function nonEmptyString(value: unknown, maxLength = 4096): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isProviderId(value: unknown): value is string {
	return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}

function isAuthMethod(value: unknown): value is PiAuthMethod {
	return value === "oauth" || value === "api_key";
}

/** 登录入参：两种方式都必须给齐，缺一项就拒绝（不做默认值猜测）。 */
function parseLoginRequest(value: unknown): PiAuthLoginRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid pi auth login input.");
	const record = value as Record<string, unknown>;
	if (!isProviderId(record.providerId) || !isAuthMethod(record.method)) throw new Error("Invalid pi auth login input.");
	return { providerId: record.providerId, method: record.method };
}

export function registerPiAuthIpc(ipc: IpcMain, service: PiAuthService | null): void {
	/** 装配失败（服务未创建）时抛结构化错误，而不是让渲染层拿到 undefined。 */
	const requireService = (): PiAuthService => {
		if (!service) throw new Error("Pi auth service is not available");
		return service;
	};

	ipc.handle(ipcChannels.piAuthListProviders, async () => requireService().listProviders());

	ipc.handle(ipcChannels.piAuthLogin, async (_event, input: unknown) => {
		const request = parseLoginRequest(input);
		return requireService().login(request);
	});

	// 回填提问：answerPrompt 返回 false 表示「问题已不存在」（超时/取消后迟到），
	// 属于正常竞态，不当错误处理，只把结果告诉渲染层。
	ipc.handle(ipcChannels.piAuthAnswerPrompt, async (_event, input: unknown) => {
		if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid pi auth answer input.");
		const record = input as Record<string, unknown>;
		if (!nonEmptyString(record.promptId, 128) || typeof record.value !== "string" || record.value.length > MAX_ANSWER_LENGTH) {
			throw new Error("Invalid pi auth answer input.");
		}
		return requireService().answerPrompt(record.promptId, record.value);
	});

	ipc.handle(ipcChannels.piAuthCancel, async () => requireService().cancel());

	ipc.handle(ipcChannels.piAuthLogout, async (_event, providerId: unknown) => {
		if (!isProviderId(providerId)) throw new Error("Invalid pi auth logout input.");
		return requireService().logout(providerId);
	});
}
