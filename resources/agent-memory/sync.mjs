/**
 * 记忆的导出/导入：让多台设备共用同一份长期记忆。
 *
 * ## 为什么是「一个 JSON 文件」而不是数据库文件
 *
 * 真值本来就是可手改的 Markdown，SQLite 只是索引。如果导出数据库，跨设备就得处理
 * 索引版本、rowid、FTS 重建；导出条目则是幂等的——导进去以后索引会按文件重建。
 * 用户还能用任何编辑器看这个包（它就是个带 meta 的条目清单）。
 *
 * ## 条目身份（没有 id，只有内容）
 *
 * 真值是可手改的 Markdown，条目没有 id；身份 = `目标|作用域|作用域键|归一化内容`。
 * 同一份内容在任何机器上算出同一个 id，所以「勾选某几条导出」「导入时只挑几条」
 * 都能稳定对上，而 Markdown 保持干净、手改不会打破身份。
 *
 * ## 合并语义
 *
 * - **按内容去重**：`normalizeKey`（折叠空白 + 转小写）相等的条目视为同一条，导入即跳过。
 * - **同首行 = 同一条的两个版本**：首行（一句话事实的主体）相同、正文不同 → 冲突。
 *   由用户选 `append`（都留）或 `overwrite`（用包里的替换本地那条）。
 * - **删除靠墓碑传播**：A 机删掉的条目记一条墓碑（内容哈希），B 机导入时会跳过它
 *   并删掉自己那份；否则「删了又回来」是同步里最烦人的失败模式。墓碑可整体关掉。
 * - **设备专属记忆不出设备**：`devices/` 下的条目不进包（它们描述本机路径/盘符，
 *   拿到别的机器上是错的），也不参与导入。
 *
 * 刻意**不**实现：双向自动同步、条目级时间戳合并、三方 diff。记忆的量级是几十到几百条，
 * 一次导入几百条是毫秒级；把一个分布式协议塞进来，收益远小于维护成本。
 */

import { randomBytes } from "node:crypto";
import { readdirSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

import { dedupeEntries, formatFailureEntry, normalizeKey, parseEntries, parseFailureEntry, renderEntries, trimEntries } from "./format.mjs";
import { readRaw, writeAtomic } from "./files.mjs";
import { DEVICE_SCOPE_PREFIX, FAILURE_CATEGORIES, FILE_BUDGETS, TARGET_FILES, deviceProfilePath, resolveProjectDir, targetFilePath, tombstonesPath } from "./paths.mjs";
import { scanMemoryContent } from "./scan.mjs";

export const BUNDLE_FORMAT = "pideck-agent-memory";
export const BUNDLE_VERSION = 1;

/** 墓碑只留最近这些条：它只为「不该复活」服务，不是审计日志。 */
const MAX_TOMBSTONES = 500;
/** 一个包最多带多少个项目作用域，防止导入一个巨大文件把磁盘写满。 */
const MAX_BUNDLE_PROJECTS = 200;
/** 单条内容上限与写入路径一致。 */
const MAX_BUNDLE_ENTRY_CHARS = 2000;

const SHARED_TARGETS = ["memory", "user", "standing", "failure"];

function readJsonFile(filePath, fallback) {
	try {
		return JSON.parse(readRaw(filePath));
	} catch {
		return fallback;
	}
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ───────────────────────────── 设备档案 ───────────────────────────── */

/** 设备档案：首次调用时生成并落盘，之后稳定不变（导出包靠它标注来源）。 */
export function readDeviceProfile(root) {
	const existing = readJsonFile(deviceProfilePath(root), null);
	if (isPlainObject(existing) && typeof existing.id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(existing.id)) {
		return { id: existing.id, name: typeof existing.name === "string" && existing.name.trim() ? existing.name.trim().slice(0, 60) : "unnamed-device" };
	}
	const profile = { id: randomBytes(8).toString("hex"), name: (hostname() || "unnamed-device").trim().slice(0, 60) };
	try {
		writeAtomic(deviceProfilePath(root), `${JSON.stringify(profile, null, 2)}\n`);
	} catch {
		// 只读目录（容器/受管环境）下不阻断记忆功能：id 本次进程内仍然可用
	}
	return profile;
}

/**
 * 重命名本机设备（导出包里的 device.name、设置页「本机」显示都跟着变）。
 * id 永不改变：设备作用域的记忆落目录靠 id，改名不能让旧记忆失联。
 * 档案不存在时先按既有规则生成一份再改名（与 readDeviceProfile 一致）。
 * @returns {id, name} 改名后的设备档案
 */
export function renameDevice(root, name) {
	const normalized = typeof name === "string" ? name.trim().slice(0, 60) : "";
	if (!normalized) throw new Error("device-name-required");
	const profile = readDeviceProfile(root);
	writeAtomic(deviceProfilePath(root), `${JSON.stringify({ id: profile.id, name: normalized }, null, 2)}\n`);
	return { id: profile.id, name: normalized };
}

/** 设备专属记忆的作用域 id（`device:<key>`），与项目作用域共用文件层。 */
export function deviceScopeId(root) {
	return `${DEVICE_SCOPE_PREFIX}${readDeviceProfile(root).id}`;
}

/* ───────────────────────────── 墓碑 ───────────────────────────── */

/** 读墓碑集合；形状不对就当没有，不让一个坏文件废掉整次导入。 */
export function readTombstones(root) {
	const value = readJsonFile(tombstonesPath(root), []);
	if (!Array.isArray(value)) return [];
	return value.filter((item) => isPlainObject(item) && typeof item.key === "string" && item.key.length > 0).slice(-MAX_TOMBSTONES);
}

/** 记一条墓碑（同 key 只留最新一条）。 */
export function addTombstone(root, { target, scope, projectKey = "", content, at = new Date().toISOString() }) {
	const key = normalizeKey(content);
	if (!key) return;
	const tombstones = readTombstones(root).filter((item) => !(item.key === key && item.target === target && item.scope === scope && item.projectKey === projectKey));
	tombstones.push({ key, target, scope, projectKey, at });
	writeAtomic(tombstonesPath(root), `${JSON.stringify(tombstones.slice(-MAX_TOMBSTONES), null, 2)}\n`);
}

/** 撤销删除时回收墓碑：同键的墓碑不回收，旧导出包会把刚恢复的条目再判成 tombstoned。 */
export function removeTombstone(root, { target, scope, projectKey = "", content }) {
	const key = normalizeKey(content);
	if (!key) return;
	const remaining = readTombstones(root).filter((item) => !(item.key === key && item.target === target && item.scope === scope && item.projectKey === projectKey));
	if (remaining.length === readTombstones(root).length) return; // 没有同键墓碑，避免一次多余的写盘。
	writeAtomic(tombstonesPath(root), `${JSON.stringify(remaining.slice(-MAX_TOMBSTONES), null, 2)}\n`);
}

function tombstoneIndex(tombstones) {
	const index = new Set();
	for (const item of tombstones) index.add(`${item.target}|${item.scope}|${item.projectKey}|${item.key}`);
	return index;
}

/* ───────────────────────────── 作用域 ───────────────────────────── */

/** 列的共享作用域：全局四份 + `projects/<key>/` 下真实存在的条目。 */
export function listSharedScopes(root) {
	const scopes = SHARED_TARGETS.map((target) => ({ target, scope: "global", projectId: "" }));
	const projectsDir = path.join(root, "projects");
	if (!existsSync(projectsDir)) return scopes;
	const keys = readdirSync(projectsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.slice(0, MAX_BUNDLE_PROJECTS);
	for (const key of keys) {
		for (const target of SHARED_TARGETS) {
			// 只为「真的有内容」的作用域生成条目，避免导出包被空作用域撑大
			if (parseEntries(readRaw(targetFilePath(root, target, key))).length === 0) continue;
			scopes.push({ target, scope: "project", projectId: key });
		}
	}
	return scopes;
}

/** 把条目块拆成「语义内容 + 分类」：failure 条目的 `[category]` 前缀单独放。 */
function toBundleEntry(target, scope, projectKey, block) {
	if (target === "failure") {
		const parsed = parseFailureEntry(block);
		return { target, scope, projectKey, content: parsed.content, category: parsed.category };
	}
	return { target, scope, projectKey, content: block };
}

/** 反向：包内条目 → 落盘用的条目块。 */
function fromBundleEntry(entry) {
	if (entry.target !== "failure") return entry.content;
	const category = FAILURE_CATEGORIES.includes(entry.category) ? entry.category : "insight";
	return formatFailureEntry(category, entry.content);
}

/* ───────────────────────────── 条目身份 ─────────────────────────── */

/**
 * 条目的跨机器身份：`目标|作用域|作用域键|归一化内容`。
 *
 * 导出弹窗的勾选、导入弹窗的勾选与去重都靠它，而它就是「内容算出来的」——
 * 所以不需要在 Markdown 里存 id，手改也不会打破身份。
 */
export function exportEntryId({ target, scope, projectKey = "", content }) {
	return `${target}|${scope === "project" ? "project" : "global"}|${projectKey}|${normalizeKey(content)}`;
}

/** 首行键：判断「同一条记忆的两个版本」。整句首行相同几乎不可能是巧合，正文不同即视为冲突。 */
function firstLineKey(content) {
	return normalizeKey(String(content).split("\n", 1)[0] ?? "");
}

/* ───────────────────────────── 导出 ───────────────────────────── */

/**
 * 生成导出包的数据（纯函数，不碰磁盘路径以外的状态）。
 * @returns {{ format: string, version: number, exportedAt: string, device: {id: string, name: string}, entries: object[], tombstones: object[] }}
 */
export function buildExportBundle(root, { exportedAt = new Date().toISOString(), selection = null } = {}) {
	const device = readDeviceProfile(root);
	// `null` = 全导（无 UI 场景、旧调用）；给了数组则只装勾选的那些。
	const wanted = selection === null ? null : new Set(selection);
	const entries = [];
	for (const { target, scope, projectId } of listSharedScopes(root)) {
		for (const block of parseEntries(readRaw(targetFilePath(root, target, projectId)))) {
			const entry = toBundleEntry(target, scope, projectId, block);
			if (wanted && !wanted.has(exportEntryId(entry))) continue;
			entries.push(entry);
		}
	}
	return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt, device, entries, tombstones: readTombstones(root) };
}

/** 导出包规范化成写盘文本：`2` 空格缩进 + 末尾换行，便于 diff 与手工检查。 */
export function serializeBundle(bundle) {
	return `${JSON.stringify(bundle, null, 2)}\n`;
}

/* ───────────────────────────── 导入 ───────────────────────────── */

/** 校验包结构；不合法直接抛（引导用户看格式而不是半途导入一半）。 */
export function validateBundle(value) {
	if (!isPlainObject(value)) throw new Error("bundle-invalid");
	if (value.format !== BUNDLE_FORMAT) throw new Error("bundle-format-unsupported");
	if (value.version !== BUNDLE_VERSION) throw new Error("bundle-version-unsupported");
	if (!Array.isArray(value.entries)) throw new Error("bundle-invalid");
	return value;
}

/**
 * 分析包与本地状态的差异。
 *
 * 导入弹窗（勾选、冲突提示）与 `mergeBundle`（真正落盘）读的是**同一份判断**，
 * 所以不会出现「弹窗说新增 3 条、导完只加了 2 条」这种自相矛盾。
 *
 * @returns {{ preview: object, groups: Map<string, object> }}
 */
function analyzeBundle(root, value, { localDeviceKey = deviceScopeId(root) } = {}) {
	const bundle = validateBundle(value);
	const localTombstones = readTombstones(root);
	const blocked = tombstoneIndex([...localTombstones, ...(Array.isArray(bundle.tombstones) ? bundle.tombstones : [])]);

	// 一个作用域只读一次文件：byKey 查「一模一样的条目」，byHead 查「同一条的另一个版本」。
	const groups = new Map();
	const groupFor = (target, projectKey) => {
		const groupKey = `${target}|${projectKey}`;
		const cached = groups.get(groupKey);
		if (cached) return cached;
		const blocks = dedupeEntries(parseEntries(readRaw(targetFilePath(root, target, projectKey))));
		const byKey = new Map();
		const byHead = new Map();
		blocks.forEach((block, index) => {
			const semantic = target === "failure" ? parseFailureEntry(block).content : block;
			byKey.set(normalizeKey(semantic), index);
			const head = firstLineKey(semantic);
			// 同首行有多条时只记第一条：覆盖只替换它，其余同首行的条目当独立记忆留着。
			if (head && !byHead.has(head)) byHead.set(head, index);
		});
		const group = { target, projectKey, blocks, byKey, byHead, drop: new Set(), append: [] };
		groups.set(groupKey, group);
		return group;
	};

	const entries = [];
	const counts = { total: 0, new: 0, duplicate: 0, conflict: 0, tombstoned: 0, invalid: 0 };
	const scopeNames = new Set();

	for (const raw of bundle.entries) {
		counts.total += 1;
		const reject = (reason) => {
			counts.invalid += 1;
			const text = isPlainObject(raw) && typeof raw.content === "string" ? raw.content.slice(0, MAX_BUNDLE_ENTRY_CHARS) : "";
			entries.push({ id: "", target: "", scope: "", projectId: "", content: text, category: "", status: "invalid", reason, localContent: "" });
		};
		if (!isPlainObject(raw)) {
			reject("entry-not-object");
			continue;
		}
		// 包里项目作用域记作 target=memory + scope=project；但工具面的说法是 target=project，
		// 手写/旧包两种写法都收（`project` 不是独立文件，只是 memory 的项目目录）。
		const declaredTarget = raw.target === "project" ? "memory" : raw.target;
		const target = SHARED_TARGETS.includes(declaredTarget) ? declaredTarget : "";
		const scope = raw.scope === "project" || raw.target === "project" ? "project" : "global";
		const projectKey = scope === "project" && typeof raw.projectKey === "string" ? raw.projectKey : "";
		// 设备专属条目永不出设备：别的机器的路径类事实在本机是错的，导入只会带来误导。
		// 判空再比：全局条目的 projectKey 也是空串，直接比会把所有全局记忆当设备记忆拒掉。
		if (raw.scope === "device" || (localDeviceKey && raw.projectKey === localDeviceKey)) {
			reject("device-scope");
			continue;
		}
		if (!target || (scope === "project" && !projectKey)) {
			reject("entry-invalid");
			continue;
		}
		const content = typeof raw.content === "string" ? raw.content.trim() : "";
		if (!content || content.length > MAX_BUNDLE_ENTRY_CHARS) {
			reject("entry-invalid");
			continue;
		}
		// 从别的设备来的内容同样是不可信输入：不可见字符/注入模板/密钥一律不入库。
		if (scanMemoryContent(content)) {
			reject("unsafe-content");
			continue;
		}
		const block = fromBundleEntry({ ...raw, target, scope, projectKey, content });
		const semantic = target === "failure" ? parseFailureEntry(block).content : block;
		const category = target !== "failure" ? "" : FAILURE_CATEGORIES.includes(raw.category) ? raw.category : "insight";
		const base = { id: exportEntryId({ target, scope, projectKey, content: semantic }), target, scope, projectId: projectKey, content: semantic, category, reason: "", localContent: "" };
		if (blocked.has(`${target}|${scope}|${projectKey}|${normalizeKey(semantic)}`)) {
			counts.tombstoned += 1;
			entries.push({ ...base, status: "tombstoned" });
			continue;
		}
		const group = groupFor(target, projectKey);
		const matched = group.byKey.get(normalizeKey(semantic));
		if (matched !== undefined) {
			counts.duplicate += 1;
			entries.push({ ...base, status: "duplicate", localContent: group.blocks[matched] ?? "" });
			continue;
		}
		const head = firstLineKey(semantic);
		const conflicting = head ? group.byHead.get(head) : undefined;
		if (conflicting !== undefined && group.blocks[conflicting] !== undefined) {
			counts.conflict += 1;
			entries.push({ ...base, status: "conflict", localContent: group.blocks[conflicting] });
			continue;
		}
		counts.new += 1;
		entries.push({ ...base, status: "new" });
		scopeNames.add(scope === "project" ? `project:${projectKey}` : `${target}:global`);
	}

	// 包内墓碑：导入时会删掉本地同一条内容，弹窗先告诉用户「会删掉哪几条」。
	const tombstones = [];
	for (const item of Array.isArray(bundle.tombstones) ? bundle.tombstones : []) {
		if (!isPlainObject(item) || typeof item.key !== "string") continue;
		const target = SHARED_TARGETS.includes(item.target) ? item.target : "";
		if (!target) continue;
		const projectKey = typeof item.projectKey === "string" ? item.projectKey : "";
		// 能对上本地条目就显示它的正文；对不上（本地早就没了）就只留空串，弹窗据此显示「已不存在」。
		let localContent = "";
		for (const block of parseEntries(readRaw(targetFilePath(root, target, projectKey)))) {
			const semantic = target === "failure" ? parseFailureEntry(block).content : block;
			if (normalizeKey(semantic) === item.key) {
				localContent = semantic;
				break;
			}
		}
		tombstones.push({ target, projectId: projectKey, at: typeof item.at === "string" ? item.at : "", localContent });
	}

	return {
		bundle,
		preview: {
			format: BUNDLE_FORMAT,
			version: BUNDLE_VERSION,
			exportedAt: typeof bundle.exportedAt === "string" ? bundle.exportedAt : "",
			device: isPlainObject(bundle.device) && typeof bundle.device.name === "string" ? bundle.device.name : "",
			entries,
			counts,
			tombstones,
			scopes: [...scopeNames].sort(),
		},
		groups,
	};
}

/** 只读预览：导入弹窗据此决定默认勾选哪些、哪些是冲突。不碰记忆文件。 */
export function previewBundle(root, value, options = {}) {
	return analyzeBundle(root, value, options).preview;
}

/**
 * 合并导入。
 *
 * 顺序：先按包内墓碑删掉本地对应条目，再逐条并入。这样「同一个包里既有删除又有新增」
 * 时语义明确：墓碑优先于新增（同一条内容同时被删和被加，说明对面也没想清楚，保守地删）。
 *
 * @param selection       只导入这些条目 id（`null` = 全部）；弹窗的勾选落到这里。
 * @param conflictPolicy  同首行冲突时：`append` 都留 / `overwrite` 用包里的替换本地那条。
 * @param applyTombstones 是否按包内墓碑删本地条目（关掉就只做新增/替换）。
 * @returns {{ added: number, duplicate: number, tombstoned: number, rejected: number, removed: number, replaced: number, scopes: string[], device: string }}
 */
export function mergeBundle(root, value, { selection = null, conflictPolicy = "append", applyTombstones = true, localDeviceKey = deviceScopeId(root) } = {}) {
	const { bundle, preview, groups } = analyzeBundle(root, value, { localDeviceKey });
	const wanted = selection === null ? null : new Set(selection);
	const overwrite = conflictPolicy === "overwrite";
	let duplicate = 0;
	let tombstoned = 0;
	let rejected = 0;
	let replaced = 0;

	for (const entry of preview.entries) {
		// 拒收条目无论如何都算 rejected：用户即使全选也没法让它进来。
		if (entry.status === "invalid") {
			rejected += 1;
			continue;
		}
		if (wanted && !wanted.has(entry.id)) continue;
		if (entry.status === "tombstoned") {
			tombstoned += 1;
			continue;
		}
		if (entry.status === "duplicate") {
			duplicate += 1;
			continue;
		}
		const group = groups.get(`${entry.target}|${entry.projectId}`);
		if (!group) {
			rejected += 1;
			continue;
		}
		if (entry.status === "conflict" && overwrite) {
			const index = group.byHead.get(firstLineKey(entry.content));
			// 只替换与这条冲突的那一行；同首行的其它条目不动（byHead 记的也是第一条）。
			if (index !== undefined && !group.drop.has(index)) {
				group.drop.add(index);
				replaced += 1;
			}
		}
		group.append.push(fromBundleEntry({ target: entry.target, category: entry.category, content: entry.content }));
	}

	// 落盘：每份文件都过一遍预算裁剪；只有真的变了才写。
	let added = 0;
	for (const group of groups.values()) {
		if (group.append.length === 0 && group.drop.size === 0) continue;
		const kept = group.blocks.filter((_, index) => !group.drop.has(index));
		const trimmed = trimEntries([...kept, ...group.append], FILE_BUDGETS[group.target]);
		added += Math.max(0, trimmed.entries.length - kept.length);
		writeAtomic(targetFilePath(root, group.target, group.projectKey), renderEntries(trimmed.entries));
	}

	// 墓碑落地：删掉本地还留着的同一条内容，并把墓碑记到本地（下次导入同样被挡住）。
	const removals = [];
	const localTombstones = readTombstones(root);
	for (const item of applyTombstones ? bundle.tombstones : []) {
		if (!isPlainObject(item) || typeof item.key !== "string") continue;
		const target = SHARED_TARGETS.includes(item.target) ? item.target : "";
		if (!target) continue;
		const sourcePath = targetFilePath(root, target, typeof item.projectKey === "string" ? item.projectKey : "");
		const entries = parseEntries(readRaw(sourcePath));
		const kept = entries.filter((entry) => normalizeKey(target === "failure" ? parseFailureEntry(entry).content : entry) !== item.key);
		if (kept.length !== entries.length) {
			writeAtomic(sourcePath, renderEntries(kept));
			removals.push({ target, projectKey: item.projectKey ?? "" });
		}
		if (!localTombstones.some((local) => local.key === item.key && local.target === item.target)) {
			addTombstone(root, { target, scope: item.scope === "project" ? "project" : "global", projectKey: item.projectKey ?? "", content: item.key, at: item.at });
		}
	}

	return { added, duplicate, tombstoned, rejected, removed: removals.length, replaced, scopes: preview.scopes, device: preview.device };
}

/** 统计包内条目数（设置页在确认导入前显示「这个包含 N 条」）。 */
export function countBundleEntries(value) {
	const bundle = validateBundle(value);
	return { entries: bundle.entries.length, device: isPlainObject(bundle.device) && typeof bundle.device.name === "string" ? bundle.device.name : "", exportedAt: typeof bundle.exportedAt === "string" ? bundle.exportedAt : "" };
}
