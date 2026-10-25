/**
 * Security IPC handlers（src/main/ipc/securityIpc.ts）
 *
 * 渲染层 → SecurityStore 的薄适配层：
 * - 输入校验（类型/枚举）在边界完成，渲染层数据一律不可信；
 * - 返回结构化结果：业务错误转 { ok:false, error }，不裸抛异常跨 IPC。
 */

import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SecurityConfig } from "../../shared/types";
import type { SecurityStore } from "../security/SecurityStore";

export type SecurityIpcDeps = {
	securityStore: SecurityStore;
	log: (domain: string, message: string, details?: Record<string, unknown>) => void;
};

/** 校验传入的等级 id 是否为字符串且存在于配置中；不存在时返回 null */
function sanitizeLevelId(config: SecurityConfig, value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	return config.levels.some((level) => level.id === value) ? value : null;
}

/** 校验渲染层传来的更新补丁：只允许白名单键，其余忽略（防越权改无关字段） */
function sanitizePatch(value: unknown): Partial<SecurityConfig> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const patch: Partial<SecurityConfig> = {};
	if (typeof raw.enabled === "boolean") patch.enabled = raw.enabled;
	if (typeof raw.defaultLevelId === "string") patch.defaultLevelId = raw.defaultLevelId;
	if (Array.isArray(raw.levels)) patch.levels = raw.levels as SecurityConfig["levels"];
	if (raw.sessionOverrides && typeof raw.sessionOverrides === "object" && !Array.isArray(raw.sessionOverrides)) {
		patch.sessionOverrides = { ...(raw.sessionOverrides as Record<string, string>) };
	}
	return patch;
}

export function registerSecurityIpc({ securityStore, log }: SecurityIpcDeps): void {
	ipcMain.handle(ipcChannels.securityGetConfig, () => securityStore.getConfig());

	ipcMain.handle(ipcChannels.securityUpdateConfig, async (_event, value: unknown): Promise<{ ok: true; config: SecurityConfig } | { ok: false; error: string }> => {
		const patch = sanitizePatch(value);
		if (!patch) {
			return { ok: false, error: "安全配置补丁格式非法" };
		}
		try {
			const config = await securityStore.updateConfig(patch);
			return { ok: true, config };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log("security", "update-config failed", { error: message });
			return { ok: false, error: message };
		}
	});

	ipcMain.handle(ipcChannels.securitySetSessionLevel, async (_event, sessionId: unknown, levelId: unknown): Promise<{ ok: true; config: SecurityConfig } | { ok: false; error: string }> => {
		if (typeof sessionId !== "string" || !sessionId.trim()) {
			return { ok: false, error: "会话 id 非法" };
		}
		// levelId 允许为空字符串/null（清除覆盖）；非空时必须存在于配置
		if (levelId !== null && levelId !== undefined && levelId !== "") {
			const current = securityStore.getConfig();
			if (!sanitizeLevelId(current, levelId)) {
				return { ok: false, error: "等级 id 不存在" };
			}
		}
		try {
			const config = await securityStore.setSessionLevel(sessionId, levelId ? String(levelId) : null);
			return { ok: true, config };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log("security", "set-session-level failed", { error: message });
			return { ok: false, error: message };
		}
	});
}
