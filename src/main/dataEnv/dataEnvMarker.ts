// 数据环境决策指针：pideck-env.json（决策指针与数据目录标记同构）。
// 由任务 4（启动序列）与任务 5（导入）消费；读取失败一律回 null，由调用方决定弹窗/日志。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DataEnvDecisionFile, DataEnvMode } from "../../shared/types/dataEnv";
import type { UpdateChannel } from "../../shared/types/app";

export const DATA_ENV_DECISION_FILENAME = "pideck-env.json";

/** 读取决策指针/目录标记；不存在或损坏返回 null（损坏写 appLogger 由调用方负责，此处保持纯读取）。 */
export function readDataEnvDecision(dir: string): DataEnvDecisionFile | null {
	try {
		const raw = readFileSync(path.join(dir, DATA_ENV_DECISION_FILENAME), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const candidate = parsed as Record<string, unknown>;
		if (candidate.dataMode !== "shared" && candidate.dataMode !== "channel-dev") return null;
		return {
			schemaVersion: 1,
			dataMode: candidate.dataMode,
			lastAppVersion: typeof candidate.lastAppVersion === "string" ? candidate.lastAppVersion : "",
			createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : "",
		};
	} catch {
		return null;
	}
}

/** 原子风格写入（tmp 写 + rename，复用 SettingsStore.writeAtomic 思路；目录由 mkdirSync 兜底创建）。 */
export function writeDataEnvDecision(dir: string, dataMode: DataEnvMode, appVersion: string): DataEnvDecisionFile {
	mkdirSync(dir, { recursive: true });
	const file: DataEnvDecisionFile = { schemaVersion: 1, dataMode, lastAppVersion: appVersion, createdAt: new Date().toISOString() };
	const target = path.join(dir, DATA_ENV_DECISION_FILENAME);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, JSON.stringify(file, null, "\t"), "utf8");
	renameSync(tmp, target);
	return file;
}

export type DataEnvValidation = "ok" | "mismatch";

/**
 * 启动期目录标记与自身通道的匹配校验（规格 §6）：
 * stable 包落在 channel-dev 目录 → mismatch（用户手动指错目录）；其余组合 ok。
 * 无目录标记的存量目录视为 shared，返回 ok。
 */
export function validateStartupDataEnv(channel: UpdateChannel, decisionInDataDir: DataEnvDecisionFile | null): DataEnvValidation {
	if (!decisionInDataDir) return "ok";
	if (channel === "stable" && decisionInDataDir.dataMode === "channel-dev") return "mismatch";
	return "ok";
}
