/** PiDeck DSH profile 配置兼容层：保留共享 settings.yaml，新配置只写私有 profile。 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dump, load, DEFAULT_SCHEMA, Type } from "js-yaml";
import { pideckDshHome } from "./pideckDshHome";
import { agentPresetsRow } from "./dshPresetComposition";

/** 与 Cordis include 同一 !!js 数据形状；解析不执行表达式。 */
const profileSchema = DEFAULT_SCHEMA.extend(
	new Type("tag:yaml.org,2002:js", {
		kind: "scalar",
		construct: (value: unknown) => ({ __jsExpr: value }),
		predicate: (value: unknown) => isRecord(value) && typeof value.__jsExpr === "string",
		represent: (value: unknown) => (isRecord(value) ? String(value.__jsExpr) : ""),
	}),
);

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function dshProfileDir(home: string): string {
	return join(pideckDshHome(home), "profile");
}

export function dshProfilePatchPath(home: string): string {
	return join(dshProfileDir(home), "cordis.patch.yml");
}

/** 旧设置的命名空间只在导入边界转换，runtime/UI 统一用新契约。 */
export function dshSettingsEntryId(namespace: string): string {
	if (namespace === "agent-presets") return "agent-preset-registry";
	if (namespace === "shell") return process.platform === "win32" ? "pwsh-sandbox" : "bash-sandbox";
	return namespace;
}

export function parseProfilePatches(text: string): Record<string, unknown>[] {
	const parsed: unknown = load(text, { schema: profileSchema });
	if (!Array.isArray(parsed) || !parsed.every(isRecord)) throw new Error("DSH profile patch must be a list of objects");
	return parsed;
}

export function dumpProfilePatches(rows: readonly unknown[]): string {
	return dump(rows, { schema: profileSchema, lineWidth: -1, noRefs: true });
}

/** Convert legacy namespaces without mutating input; selected default is a volatile registry field. */
export function legacySettingsPatches(text: string): Record<string, unknown>[] {
	const parsed: unknown = load(text);
	if (parsed == null) return [];
	if (!isRecord(parsed)) throw new Error("DSH legacy settings must be an object");
	return Object.entries(parsed).map(([namespace, value]) => {
		if (!isRecord(value)) throw new Error(`Invalid DSH settings section: ${namespace}`);
		const config = { ...value };
		if (namespace === "agent-presets" && typeof config.default === "string") {
			config.selectedDefault = config.default;
			delete config.default;
		}
		return { id: dshSettingsEntryId(namespace), config };
	});
}

/** 同目录原子替换；失败不破坏现有 profile。 */
function writeProfile(path: string, rows: readonly unknown[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, dumpProfilePatches(rows), { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** 首次启动才导入；以 profile 文件作为提交标记，原 settings.yaml 永远保留。 */
export function initializeDshProfileSettings(home: string, inheritedRows: readonly Record<string, unknown>[]): void {
	const target = dshProfilePatchPath(home);
	if (existsSync(target)) return;
	const legacy = join(home, "settings.yaml");
	const imported = existsSync(legacy) ? legacySettingsPatches(readFileSync(legacy, "utf8")) : [];
	// 只迁移用户设置，不快照整套部署默认；否则升级 bundle 的默认值永远不生效。
	// 离线供应商迁移会先于 host 初始化；registry.default 是必填部署值，不能因
	// 提前写入 profile 标记而丢失。使用同一个部署 owner，避免两处默认值漂移。
	const defaults: readonly Record<string, unknown>[] = [agentPresetsRow(), ...inheritedRows];
	const rows = imported.map((patch) => {
		const inherited = defaults.findLast((row) => row.id === patch.id);
		return { ...patch, config: { ...(isRecord(inherited?.config) ? inherited.config : {}), ...(isRecord(patch.config) ? patch.config : {}) } };
	});
	writeProfile(target, rows);
}

/** 无 host 的默认模型/用量/供应商迁移读取；返回旧领域对象而非执行 Cordis 表达式。 */
export function readDshSettingsSnapshot(home: string): Record<string, unknown> {
	const target = dshProfilePatchPath(home);
	if (!existsSync(target)) {
		const legacy = join(home, "settings.yaml");
		if (!existsSync(legacy)) return {};
		const value: unknown = load(readFileSync(legacy, "utf8"));
		if (!isRecord(value)) throw new Error("Invalid DSH legacy settings");
		return value;
	}
	const result: Record<string, unknown> = {};
	for (const row of parseProfilePatches(readFileSync(target, "utf8"))) {
		if (typeof row.id !== "string" || !isRecord(row.config)) continue;
		result[row.id] = row.config;
	}
	return result;
}

/** host 未启动时的单 namespace 合并；调用方已经确认无 host writer。 */
export function writeDshProfileSettings(home: string, namespace: string, config: Record<string, unknown>): void {
	const target = dshProfilePatchPath(home);
	initializeDshProfileSettings(home, []);
	const rows = parseProfilePatches(readFileSync(target, "utf8"));
	const id = dshSettingsEntryId(namespace);
	const row = rows.findLast((item) => item.id === id && !item.insert);
	if (row) row.config = { ...(isRecord(row.config) ? row.config : {}), ...config };
	else rows.push({ id, config });
	writeProfile(target, rows);
}
