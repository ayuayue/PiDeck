/**
 * pi-ai 模型目录的运行时生成（纯函数，不触 fs / electron）。
 *
 * 设置页「模型目录」更新到「最新」时，直接从 @earendil-works/pi-ai 的 npm 包
 * dist/providers/data/*.json 重新生成 artifact，而不是从 PiDeck 仓库分支拉取
 * 预生成件（分支源会滞后于 npm 最新的 pi-ai，如 main 停在 0.85.0 而 npm 已 0.85.1）。
 *
 * 生成逻辑与 scripts/generate-pi-ai-catalog.mjs 逐字节对齐（同一输入得到相同输出），
 * 保证「运行时更新出的目录」与「构建期打包的目录」一致，避免同版本被误判为有更新。
 * tests/piAiCatalogGenerate.test.mjs 用本地 @earendil-works/pi-ai 数据生成并断言
 * 与 resources/pi-ai-catalog.json 逐字节相同，锁定该契约。
 */

import { createHash } from "node:crypto";

/** 上游来源 npm 包名（与 build 脚本、manifest 校验共用）。 */
export const PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";
/**
 * artifact 格式版本，必须与 scripts/generate-pi-ai-catalog.mjs 一致。
 * v2：取消字段白名单（条目透传官方全部字段，含 `type`），改为紧凑序列化。
 * v1 产物缺 `type` 等字段，无法在读取时可靠区分 chat / image / classifier，
 * 因此不兼容：旧覆盖层会被校验拒绝并回退到随包目录，不做迁移器。
 */
export const PI_AI_CATALOG_SCHEMA_VERSION = 2;

/** 运行时生成的来源文件：name 为 dist/providers/data 下的文件基名，content 为 utf8 文本。 */
export type CatalogSourceFile = {
	name: string;
	content: string;
};

/** 运行时生成的 artifact 输出（catalogText/manifestText 为待写盘文本）。 */
export type GeneratedCatalogArtifact = {
	catalogText: string;
	manifestText: string;
	entryCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/** 与 build 脚本一致：只规范化模型 ID；provider/name/baseUrl 保留上游原值。 */
function normalizedModelId(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 生成一条目录条目：**保留官方原始字段**，只做最小结构校验。
 *
 * 为什么不再按白名单裁剪：旧版只留 9 个字段，把 `type` 一并丢掉，于是 image /
 * classifier 模型混进了聊天能力补全，且要用的价格、inputLimits、output 等字段
 * 一旦需要就得再来改一次生成器。现在直接透传官方对象，上游新增字段无需改脚本。
 *
 * 只做两件事：无有效 id 的条目丢弃；值为 undefined 的键去掉（JSON.stringify 本
 * 来也会丢，显式删掉让产物意图清晰）。键顺序必须与来源一致 —— 与 build 脚本输出
 * 逐字节对齐靠的就是这一点（tests/piAiCatalogGenerate.test.mjs 锁定）。
 */
function extractCatalogEntry(model: unknown): Record<string, unknown> | undefined {
	if (!isRecord(model)) return undefined;
	if (!normalizedModelId(model.id)) return undefined;
	const entry: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(model)) {
		if (value === undefined) continue;
		entry[key] = value;
	}
	return entry;
}

/** 解析单个来源文件（{ group: { modelId: model } }），收集合法条目。 */
function extractEntriesFromFile(fileName: string, content: string): Record<string, unknown>[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(`failed to parse pi-ai catalog file ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new Error(`invalid pi-ai catalog root in ${fileName}`);
	const entries: Record<string, unknown>[] = [];
	for (const group of Object.values(parsed)) {
		if (!isRecord(group)) continue;
		for (const model of Object.values(group)) {
			const entry = extractCatalogEntry(model);
			if (entry) entries.push(entry);
		}
	}
	return entries;
}

/** 输入的字节级 SHA-256：文件名与内容均参与（与 build 脚本的 sourceDataSha256 一致）。 */
function sourceDataSha256(files: readonly CatalogSourceFile[]): string {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file.name, "utf8");
		hash.update("\0", "utf8");
		// 用 utf8 字节哈希，与 build 脚本读文件字节等价（文件本身是合法 utf8）。
		hash.update(Buffer.from(file.content, "utf8"));
		hash.update("\0", "utf8");
	}
	return hash.digest("hex");
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 与 build 脚本 serializeJson 一致：紧凑序列化 + 尾随换行。 */
function serializeJson(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * 从来源文件集合生成 catalog + manifest artifact。
 * 文件须按 build 脚本相同顺序（localeCompare）传入，才能得到逐字节一致的输出。
 */
export function generatePiAiCatalogFromFiles(files: readonly CatalogSourceFile[], packageVersion: string): GeneratedCatalogArtifact {
	const entries: Record<string, unknown>[] = [];
	const sorted = [...files].sort((left, right) => left.name.localeCompare(right.name));
	for (const file of sorted) {
		if (!file.name.endsWith(".json") || file.name.startsWith(".")) continue;
		entries.push(...extractEntriesFromFile(file.name, file.content));
	}
	const catalog = { schemaVersion: PI_AI_CATALOG_SCHEMA_VERSION, entries };
	const catalogText = serializeJson(catalog);
	const manifest = {
		schemaVersion: PI_AI_CATALOG_SCHEMA_VERSION,
		source: {
			packageName: PI_AI_PACKAGE_NAME,
			packageVersion,
			dataSha256: sourceDataSha256(sorted),
			fileCount: sorted.filter((f) => f.name.endsWith(".json") && !f.name.startsWith(".")).length,
		},
		catalogSha256: sha256(catalogText),
		entryCount: entries.length,
	};
	return { catalogText, manifestText: serializeJson(manifest), entryCount: entries.length };
}

/**
 * 语义版本比较，用于更新防降级：远端版本 <= 当前生效版本时不得覆盖。
 * 支持 `x.y.z` 与可选 `-prerelease` 后缀（如 `-remote`、`-beta.1`）。
 * 返回负数表示 a < b，0 相等，正数表示 a > b。解析失败按最低处理（视作比任何有效版本都旧）。
 */
export function compareSemver(a: string, b: string): number {
	const parse = (value: string): { nums: number[]; pre: string[] } => {
		const [main, ...preParts] = value.trim().split("-");
		const nums = main.split(".").map((part) => {
			const n = Number(part);
			return Number.isFinite(n) ? n : 0;
		});
		while (nums.length < 3) nums.push(0);
		return { nums, pre: preParts.length > 0 ? preParts.join("-").split(".") : [] };
	};
	const left = parse(a);
	const right = parse(b);
	for (let index = 0; index < 3; index += 1) {
		if (left.nums[index] !== right.nums[index]) {
			return left.nums[index] - right.nums[index];
		}
	}
	// 主版本相同：无预发布 > 有预发布；均有则逐段比较（数字段按数值，文本段按字典序）。
	if (left.pre.length === 0 && right.pre.length === 0) return 0;
	if (left.pre.length === 0) return 1;
	if (right.pre.length === 0) return -1;
	const length = Math.max(left.pre.length, right.pre.length);
	for (let index = 0; index < length; index += 1) {
		const lp = left.pre[index];
		const rp = right.pre[index];
		if (lp === undefined) return -1;
		if (rp === undefined) return 1;
		if (lp === rp) continue;
		const ln = Number(lp);
		const rn = Number(rp);
		const lpNum = Number.isFinite(ln);
		const rpNum = Number.isFinite(rn);
		if (lpNum && rpNum) return ln - rn;
		if (lpNum) return -1; // 数字段小于文本段
		if (rpNum) return 1;
		return lp < rp ? -1 : 1;
	}
	return 0;
}
