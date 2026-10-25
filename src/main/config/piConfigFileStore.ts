/**
 * pi settings.json 的安全读写（计划 A1）。
 *
 * 目标：
 * - 读：保留原文、报告 JSON 损坏、计算 revision（内容哈希）；
 * - 写：与 pi 相同的锁协议（proper-lockfile，realpath:false）内「重读 → 修改 → 原子写」，
 *   只改目标键，未知字段/注释顺序尽量保留；
 * - 并发：revision 不匹配时拒绝覆盖（页面缓存过期），调用方提示刷新。
 *
 * 不能把整份页面 JSON 写回：那会冲掉用户手写的 glob、包 source/ref、未知字段
 * 或在别处（TUI）刚做的修改。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";

export type PiConfigFileRead = {
	exists: boolean;
	/** 原文；文件不存在时为空串。 */
	raw: string;
	/** 解析后的对象；文件不存在/损坏时为 {}（并给 error）。 */
	data: Record<string, unknown>;
	/** JSON 损坏或顶层不是对象时的诊断；此时禁止可视化写入。 */
	error?: string;
	revision: string;
};

/** 内容哈希；不存在的文件用固定标记，便于判断「文件从无到有」。 */
export function revisionOf(raw: string, exists: boolean): string {
	return exists ? createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32) : "missing";
}

/** pi 与 PiDeck 一致：读取时兼容 UTF-8 BOM。 */
export function stripBom(raw: string): string {
	return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

export async function readPiConfigFile(path: string): Promise<PiConfigFileRead> {
	let raw = "";
	let exists = false;
	try {
		raw = await readFile(path, "utf8");
		exists = true;
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
	}
	if (!exists) return { exists: false, raw: "", data: {}, revision: revisionOf("", false) };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(raw));
	} catch (error) {
		return { exists: true, raw, data: {}, error: error instanceof Error ? error.message : String(error), revision: revisionOf(raw, true) };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { exists: true, raw, data: {}, error: "settings.json must be a JSON object", revision: revisionOf(raw, true) };
	}
	return { exists: true, raw, data: parsed as Record<string, unknown>, revision: revisionOf(raw, true) };
}

export type PiConfigMutation = (current: Record<string, unknown>) => Record<string, unknown> | { abort: string };

export type PiConfigWriteOptions = {
	/** 期望的当前 revision；不匹配则拒绝写入（页面草稿过期）。undefined = 不校验。 */
	expectedRevision?: string;
	/** 写前钩子（供调用方做边界/权限校验）；抛错则放弃写入。 */
	precheck?: () => Promise<void> | void;
};

export type PiConfigWriteResult = { ok: true; revision: string; data: Record<string, unknown> } | { ok: false; error: string; revision?: string; conflict?: boolean };

/**
 * 在 pi 兼容的文件锁内完成「重读 → mutate → 原子写」。
 *
 * 锁目标与 pi 相同（settings.json 路径，realpath:false），因此 TUI 与 PiDeck
 * 的写入会互斥。不在这里拼 second lock 协议；异步锁 + 有限重试。
 */
export async function writePiConfigFile(path: string, mutate: PiConfigMutation, options: PiConfigWriteOptions = {}): Promise<PiConfigWriteResult> {
	await options.precheck?.();
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });

	// realpath:false 可直接锁住尚不存在的文件；占位文件会把 missing revision 改成内容哈希，
	// 导致首次开关误报冲突，并在写入失败时留下用户未请求的 settings.json。
	let release: (() => Promise<void>) | undefined;
	let temporary: string | undefined;
	try {
		release = await lockfile.lock(path, { realpath: false, retries: { retries: 20, minTimeout: 20, maxTimeout: 200 } });
	} catch (error) {
		return { ok: false, error: `Could not lock ${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		const current = await readPiConfigFile(path);
		// The first write may have no file at all. Keep the synthetic lock target
		// out of the revision comparison so a missing-file summary can be saved.
		const currentRevision = current.exists ? current.revision : "missing";
		if (current.error) {
			return { ok: false, error: current.error, revision: current.revision };
		}
		if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
			return { ok: false, error: "settings.json changed on disk; reload before saving.", revision: currentRevision, conflict: true };
		}
		const next = mutate(current.data);
		if ("abort" in next && typeof next.abort === "string") {
			return { ok: false, error: next.abort, revision: currentRevision };
		}
		const raw = `${JSON.stringify(next, null, 2)}\n`;
		if (raw === current.raw) return { ok: true, revision: currentRevision, data: next };
		// 原子替换：临时文件放在同目录，避免跨设备 rename。
		temporary = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
		await writeFile(temporary, raw, "utf8");
		await rename(temporary, path);
		return { ok: true, revision: revisionOf(raw, true), data: next };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		// 仅清理本次写入的临时文件，rename 失败也不能残留或动到原配置。
		if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
		await release().catch(() => undefined);
	}
}

/** 读取对象里的字符串数组（非数组/非字符串元素一律忽略，不改写原文）。 */
export function readStringArraySetting(data: Record<string, unknown>, key: string): string[] {
	const value = data[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
