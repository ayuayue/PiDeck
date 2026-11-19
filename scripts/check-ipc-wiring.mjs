#!/usr/bin/env node
/**
 * IPC 接线一致性校验（AGENTS.md 铁律「新 IPC 三处同步」的机械落地点）。
 *
 *   node scripts/check-ipc-wiring.mjs
 *
 * 校验 `src/shared/ipc.ts` 两张表的语义边界：
 *
 * 1. `ipcChannels`（真 IPC 通道）：每个 key 必须同时出现在
 *    - 主进程（`src/main/**` 按 `<任意>.key` 属性访问，即注册/发送/消费），
 *    - preload（`src/preload/**` 转发或订阅），
 *    漏一处 → 运行时 undefined / 收不到事件。
 * 2. `agentEventTags`（Agent 内部事件标签，不是 IPC 通道）：每个 key 必须出现在主进程，
 *    且**不得**出现在 preload —— 它们只经 `ipcChannels.sessionsRuntimeEvent` 单通道出去，
 *    一旦漏进 preload 就说明有人把它当独立通道用，语义又混回去了。
 * 3. 两张表之间不得有重复 key 或重复字符串值（同一事件名两处定义必然漂移）。
 *
 * 只读、无网络、约 1 秒；失败退出码 1。修复顺序：先补主进程 handler，再补 preload 转发，
 * 最后同步渲染层调用（见 docs/architecture.md「IPC 注册」）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IPC_FILE = join(ROOT, "src/shared/ipc.ts");

/** 取出 `export const NAME = { ... } as const;` 的对象体（花括号配对，忽略字符串里的花括号风险见下方断言）。 */
function extractObject(source, exportName) {
	const head = source.indexOf(`export const ${exportName} = {`);
	if (head < 0) throw new Error(`找不到 export const ${exportName}（脚本与 src/shared/ipc.ts 结构漂移了）`);
	const open = source.indexOf("{", head);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return source.slice(open, i + 1);
		}
	}
	throw new Error(`${exportName} 的花括号没有配对`);
}

function parseEntries(body) {
	const entries = [];
	for (const match of body.matchAll(/^\s*([A-Za-z0-9_$]+):\s*"([^"]+)"/gm)) {
		entries.push({ key: match[1], value: match[2] });
	}
	return entries;
}

function collectFiles(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) collectFiles(path, out);
		else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(path);
	}
	return out;
}

function readAll(dir) {
	return collectFiles(dir)
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");
}

/**
 * `ipcChannels` 由一个模块展开组装（Git 面板通道集中在那里，见文件体量门禁）。展开在运行时不丢任何键，
 * 但文本解析看不到——所以这里显式把被展开的模块一起解析，覆盖率与拆分前完全一致。
 */
const CHANNEL_MODULES = [{ file: "src/shared/ipcGitPanelChannels.ts", exportName: "gitPanelChannels" }];

const source = readFileSync(IPC_FILE, "utf8");
const channels = [...parseEntries(extractObject(source, "ipcChannels")), ...CHANNEL_MODULES.flatMap(({ file, exportName }) => parseEntries(extractObject(readFileSync(join(ROOT, file), "utf8"), exportName)))];
const tags = parseEntries(extractObject(source, "agentEventTags"));

const mainBlob = readAll(join(ROOT, "src/main"));
const preloadBlob = readAll(join(ROOT, "src/preload"));

const hasPropertyAccess = (blob, key) => new RegExp(`\\.${key}\\b`).test(blob);

const problems = [];

for (const { key, value } of channels) {
	if (!hasPropertyAccess(mainBlob, key)) problems.push(`通道 ${key}（${value}）在主进程没有任何注册/使用点`);
	if (!hasPropertyAccess(preloadBlob, key)) problems.push(`通道 ${key}（${value}）没有在 preload 转发/订阅 —— 渲染层拿到的是 undefined`);
}

for (const { key, value } of tags) {
	if (!hasPropertyAccess(mainBlob, key)) problems.push(`事件标签 ${key}（${value}）在主进程没有任何发射点`);
	if (hasPropertyAccess(preloadBlob, key)) problems.push(`事件标签 ${key}（${value}）出现在 preload —— 它只能走 sessionsRuntimeEvent 单通道，不能单独暴露`);
}

const seenKeys = new Map();
const seenValues = new Map();
for (const { key, value } of [...channels, ...tags]) {
	if (seenKeys.has(key)) problems.push(`key ${key} 在 ipcChannels / agentEventTags 里重复定义`);
	seenKeys.set(key, true);
	if (seenValues.has(value)) problems.push(`通道值 ${value} 重复定义（${seenValues.get(value)} 与 ${key}）`);
	seenValues.set(value, key);
}

const dupValueInTags = new Map();
for (const { key, value } of tags) {
	if (channels.some((channel) => channel.value === value)) problems.push(`事件标签 ${key}（${value}）与某个 IPC 通道同名`);
}

if (problems.length > 0) {
	console.error(`[check-ipc-wiring] ${problems.length} 处问题：`);
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error("\n口径：ipcChannels = 主进程注册 + preload 转发（缺一即运行时 undefined）；agentEventTags = 仅主进程内部事件标签。");
	process.exit(1);
}

console.log(`[check-ipc-wiring] ok：ipcChannels ${channels.length} 个（主进程 + preload 齐备），agentEventTags ${tags.length} 个（仅主进程），无重复`);
