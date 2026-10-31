/**
 * pi 全局 settings.json 的推荐默认项补齐（启动时调用）。
 *
 * 三条必须守住的边界（2026-10 用户反馈：打开 PiDeck 后 settings.json 的 `packages` 全部消失、
 * 其余字段也被重置，只有 PiDeck 认识的键被陆续写回）：
 * 1. 读不懂就不写：文件存在但解析失败（典型是 UTF-8 BOM、手改留下的注释/尾逗号）时，旧实现把
 *    current 退回 `{}`，接着用默认项整份写盘 → 用户的 packages / 供应商 / 主题一次性全丢。
 *    这里改为记录诊断并跳过，绝不用默认值覆盖无法解析的用户文件。
 * 2. 只加不改：只在锁内重读的磁盘内容上补缺失键；已有键（含 packages 等未知键）原样保留，
 *    默认项也已齐全时一个字节都不写（不重排格式、不丢注释缩进）。
 * 3. 走 pi 同款锁协议：写入经 `writePiConfigFile`（文件锁内重读 → 只改目标键 → 原子替换），
 *    避免与 pi / TUI 的并发写互相覆盖——旧的裸 writeFile 读改写落在「别人写完、我们写回」之间
 *    就会静默吞掉对方的改动，这也是「有几率」的另一个来源。
 */

import { join } from "node:path";
import { getAppLogger } from "../logging/sharedLogger";
import { readPiConfigFile, writePiConfigFile } from "./piConfigFileStore";

/** 新装/精简配置时补齐的推荐默认项；只补缺失键，不覆盖用户已有值。 */
export const PI_SETTINGS_DEFAULTS: Readonly<Record<string, unknown>> = {
	theme: "dark",
	hideThinkingBlock: false,
	defaultProjectTrust: "ask",
	compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	// retry 是「嵌套也补」的设置项：用户机器上常见的形态是 `retry: {maxRetries:50, baseDelayMs:5000}`
	// （只有整键判定时永远补不进 provider 层），而 provider.maxRetries 缺失 = **传输层重试关闭**，
	// 网关/本地代理一断开就是整个回合失败（用户反馈「magpie 断开，任务直接停」）。
	// provider 层覆盖建连/TLS/HTTP 状态码/429，agent 层（上面的 maxRetries）只负责流中途断的文本分类。
	// provider.maxRetries=4：建连/断连/HTTP 状态/429 由 provider 层兜，退避是 0.5s/1s/2s/4s
	// （+25% 抖动，服务端 retry-after 提示上限 60s），最坏多等十几秒换「不用手动再发」。
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000, provider: { maxRetries: 4 } },
};

/**
 * 允许「只补缺失子键」的顶层键。其它对象（如 compaction）保持整键语义：
 * 用户故意删掉的子键不应该变成我们每次启动都写一次盘的理由。
 */
const NESTED_DEFAULT_KEYS: ReadonlySet<string> = new Set(["retry"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 递归算缺失键（只用于 NESTED_DEFAULT_KEYS 内部）。 */
function missingNestedKeys(current: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> | null {
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(defaults)) {
		if (!(key in current)) {
			patch[key] = value;
			continue;
		}
		const existing = current[key];
		if (isPlainRecord(existing) && isPlainRecord(value)) {
			const nested = missingNestedKeys(existing, value);
			if (nested) patch[key] = nested;
		}
	}
	return Object.keys(patch).length > 0 ? patch : null;
}

/** 把 patch 合并回 current：NESTED_DEFAULT_KEYS 深合并（保留用户已有子键），其余键直接赋值。 */
function applyDefaults(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const next = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		const existing = next[key];
		if (NESTED_DEFAULT_KEYS.has(key) && isPlainRecord(existing) && isPlainRecord(value)) {
			next[key] = applyNestedDefaults(existing, value);
		} else {
			next[key] = value;
		}
	}
	return next;
}

function applyNestedDefaults(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const next = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		const existing = next[key];
		next[key] = isPlainRecord(existing) && isPlainRecord(value) ? applyNestedDefaults(existing, value) : value;
	}
	return next;
}

/**
 * 纯函数：算出还需要补哪些键。返回 null = 已经齐全，无需写盘。
 * `lastChangelogVersion` 只用于 PiDeck 自己的更新说明判定，同样只补缺失。
 */
export function missingPiSettingsDefaults(current: Record<string, unknown>, piVersionHint?: string): Record<string, unknown> | null {
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(PI_SETTINGS_DEFAULTS)) {
		if (!(key in current)) {
			patch[key] = value;
			continue;
		}
		const existing = current[key];
		if (NESTED_DEFAULT_KEYS.has(key) && isPlainRecord(existing) && isPlainRecord(value)) {
			const nested = missingNestedKeys(existing, value);
			if (nested) patch[key] = nested;
		}
	}
	if (piVersionHint && !("lastChangelogVersion" in current)) patch.lastChangelogVersion = piVersionHint;
	return Object.keys(patch).length > 0 ? patch : null;
}

export type EnsurePiSettingsDefaultsResult = {
	filePath: string;
	/** 是否真的写了盘。 */
	written: boolean;
	/** unchanged = 默认项已齐全；unparsable = 文件存在但读不懂（已跳过，未改动）；writeFailed = 写入被锁/IO 拒绝。 */
	reason: "written" | "unchanged" | "unparsable" | "writeFailed";
	error?: string;
};

/** 补齐指定 configDir 下 settings.json 的缺失默认项。永不覆盖已存在的内容。 */
export async function ensurePiSettingsDefaults(configDir: string, piVersionHint?: string): Promise<EnsurePiSettingsDefaultsResult> {
	const filePath = join(configDir, "settings.json");
	const read = await readPiConfigFile(filePath);
	// 解析失败/顶层不是对象：内容不可信，写回任何东西都是破坏（旧实现就在这一步清空过 user 配置）。
	if (read.error) {
		getAppLogger()?.warn("settings", "Skipped pi settings defaults (file is not parsable)", { filePath, error: read.error });
		return { filePath, written: false, reason: "unparsable", error: read.error };
	}
	if (!missingPiSettingsDefaults(read.data, piVersionHint)) return { filePath, written: false, reason: "unchanged" };

	// 锁内重读后再判定一次：读与写之间若 pi/TUI 刚补过默认项或改过其它键，这里以磁盘为准。
	const result = await writePiConfigFile(filePath, (current) => {
		const patch = missingPiSettingsDefaults(current, piVersionHint);
		return patch ? applyDefaults(current, patch) : current;
	});
	if (!result.ok) {
		getAppLogger()?.warn("settings", "Failed to ensure pi settings defaults", { filePath, error: result.error });
		return { filePath, written: false, reason: "writeFailed", error: result.error };
	}
	getAppLogger()?.info("settings", "Ensured pi settings defaults", { filePath, keys: Object.keys(missingPiSettingsDefaults(read.data, piVersionHint) ?? {}) });
	return { filePath, written: true, reason: "written" };
}
