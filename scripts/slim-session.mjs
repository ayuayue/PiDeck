#!/usr/bin/env node
/**
 * 会话瘦身器：把超大 pi 会话写一份变体，结构与顺序不变，只做两件事——
 *   ① 同一个 targetId 的多次 context_edit 只留最后一条，其余**删除并把 parent 链重连**；
 *   ② 旧轮次（保留最近 N 轮之外）的正文/思考/工具输出截断成占位。
 *
 * 为什么需要：pi 的手动压缩在巨大会话上抛 RangeError（Maximum call stack size exceeded，
 * 实测 297 轮 / 1.8M tokens 的会话 1ms 就失败）。会话文件结构没坏（坏行 0、悬空 parent 0、
 * 最大行 1.4MB、嵌套深度 4），坏的是规模：
 *   2026-11-21 那份 301.8MB 里，context_edit 占 263.2MB —— 123186 条编辑快照，只覆盖
 *   2589 个 targetId，单个 targetId 最多被重写 49 次。按序应用时最终态只由最后一条决定。
 *
 * 不删条目也能省字节（把 replacement 换成占位），但 pi 要遍历的是**条目数**而非字节数，
 * 所以默认删条目（--keep-entries 可退回只换占位）。删条目时把每个被删条目的
 * parentId 解引用到最近的未删祖先，链保持单线、不产生悬空 parentId。
 *
 * 不改原文件：只写 --out 指定的新文件。
 *
 * 用法：
 *   node scripts/slim-session.mjs <源.jsonl> [--keep-turns 40] [--out 目标.jsonl] [--keep-entries]
 *   node scripts/slim-session.mjs <源.jsonl> --dry-run
 *
 * 判据（脚本自己打印并在不满足时 rc=1）：每行可 JSON.parse、无悬空 parentId、行数符合预期。
 */
import { createReadStream, statSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const TEXT_LIMIT = 400;
const THINKING_LIMIT = 200;
const TOOL_LIMIT = 300;

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const keepTurnsArg = args.indexOf("--keep-turns");
const keepTurns = keepTurnsArg >= 0 ? Number(args[keepTurnsArg + 1]) : 40;
const outArg = args.indexOf("--out");
const dryRun = args.includes("--dry-run");
// 默认删被覆盖的 context_edit 条目（省的是条目数）；--keep-entries 只换占位（省字节但条目数不变）。
const dropSuperseded = !args.includes("--keep-entries");
if (!src) {
	console.error("用法: node scripts/slim-session.mjs <源.jsonl> [--keep-turns N] [--out 目标.jsonl] [--dry-run] [--keep-entries]");
	process.exit(2);
}
const outPath = outArg >= 0 ? args[outArg + 1] : src.replace(/\.jsonl$/, ".slim.jsonl");

const lines = [];
const rl = readline.createInterface({ input: createReadStream(src, "utf8"), crlfDelay: Infinity });
for await (const line of rl) if (line.trim()) lines.push(line);
const srcBytes = statSync(src).size;

const entries = [];
for (const line of lines) {
	try {
		entries.push(JSON.parse(line));
	} catch {
		entries.push(null);
	}
}

// ① 每个 targetId 的最后一条 context_edit 留下，其余待删。
const lastEditIndexOf = new Map();
for (let i = 0; i < entries.length; i += 1) {
	const e = entries[i];
	if (e?.type === "context_edit" && typeof e.targetId === "string") lastEditIndexOf.set(e.targetId, i);
}
const droppedIndexes = new Set();
const parentOfDropped = new Map();
if (dropSuperseded) {
	for (let i = 0; i < entries.length; i += 1) {
		const e = entries[i];
		if (e?.type !== "context_edit" || typeof e.targetId !== "string") continue;
		if (lastEditIndexOf.get(e.targetId) === i) continue;
		droppedIndexes.add(i);
		if (typeof e.id === "string") parentOfDropped.set(e.id, typeof e.parentId === "string" ? e.parentId : null);
	}
}
/** 把一个 parentId 解引用到最近的未删祖先（自己没被删就直接返回）。 */
function resolveParent(parentId) {
	let current = parentId;
	const guard = new Set();
	while (typeof current === "string" && parentOfDropped.has(current)) {
		if (guard.has(current)) return null; // 环：不可能出现，但别让瘦身器自己死循环
		guard.add(current);
		current = parentOfDropped.get(current);
	}
	return typeof current === "string" ? current : null;
}

// ② 保留最近 keepTurns 轮：从尾部数第 keepTurns 个 user 消息起，之后原样。
const keptIndexes = [];
for (let i = 0; i < entries.length; i += 1) if (!droppedIndexes.has(i)) keptIndexes.push(i);
let cutAt = 0;
let seenUsers = 0;
for (let k = keptIndexes.length - 1; k >= 0; k -= 1) {
	const e = entries[keptIndexes[k]];
	if (e?.message?.role === "user") {
		seenUsers += 1;
		if (seenUsers >= keepTurns) {
			cutAt = keptIndexes[k];
			break;
		}
	}
}

function truncate(value, limit, note) {
	if (typeof value !== "string") return value;
	return value.length <= limit ? value : value.slice(0, limit) + note;
}

const outLines = [];
let truncatedBlocks = 0;
let rewrittenParents = 0;
const CONTEXT_EDIT_PLACEHOLDER = { content: [{ type: "text", text: "［已被后续编辑覆盖］" }] };
for (let i = 0; i < entries.length; i += 1) {
	const e = entries[i];
	if (!e) {
		outLines.push(lines[i]);
		continue;
	}
	let changed = false;
	// 只换占位、不删条目（--keep-entries 或未来兼容）：
	if (!dropSuperseded && e.type === "context_edit" && typeof e.targetId === "string" && lastEditIndexOf.get(e.targetId) !== i) {
		e.replacement = CONTEXT_EDIT_PLACEHOLDER;
		changed = true;
	}
	if (droppedIndexes.has(i)) continue;
	// parent 链重连：被删条目曾是别人的 parent，指回最近的未删祖先。
	if (typeof e.parentId === "string" && parentOfDropped.has(e.parentId)) {
		e.parentId = resolveParent(e.parentId);
		changed = true;
		rewrittenParents += 1;
	}
	// 最近 keepTurns 轮之内一律不截断。
	if (i < cutAt) {
		const content = e?.message?.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "text") {
					const next = truncate(block.text, TEXT_LIMIT, "…［已瘦身：原文 " + String(block.text.length) + " 字］");
					if (next !== block.text) {
						block.text = next;
						changed = true;
						truncatedBlocks += 1;
					}
				} else if (block.type === "thinking") {
					const next = truncate(block.thinking, THINKING_LIMIT, "…［已瘦身］");
					if (next !== block.thinking) {
						block.thinking = next;
						changed = true;
						truncatedBlocks += 1;
					}
				} else if (block.type === "toolResult" || block.type === "tool_call" || block.type === "toolCall") {
					const raw = JSON.stringify(block);
					if (raw.length > TOOL_LIMIT) {
						for (const key of ["output", "content", "result", "stdout", "text"]) {
							if (typeof block[key] === "string") block[key] = truncate(block[key], TOOL_LIMIT, "…［已瘦身］");
							else if (Array.isArray(block[key])) block[key] = [{ type: "text", text: "［已瘦身：工具输出 " + raw.length + " 字节］" }];
						}
						changed = true;
						truncatedBlocks += 1;
					}
				}
			}
		}
	}
	outLines.push(changed ? JSON.stringify(e) : lines[i]);
}

// 判据：每行可解析、parent 链无悬空、行数与预期一致。
let reparsed = 0;
let bad = 0;
const ids = new Set();
const parents = [];
for (const line of outLines) {
	try {
		const e = JSON.parse(line);
		reparsed += 1;
		if (typeof e.id === "string") ids.add(e.id);
		if (typeof e.parentId === "string") parents.push(e.parentId);
	} catch {
		bad += 1;
	}
}
const orphan = parents.filter((parentId) => !ids.has(parentId)).length;
const outBytes = Buffer.byteLength(outLines.join("\n") + "\n");
const expectedLines = lines.length - droppedIndexes.size;
const ok = bad === 0 && orphan === 0 && outLines.length === expectedLines;

console.log("源        " + src);
console.log("          行 " + lines.length + " / " + (srcBytes / 1048576).toFixed(1) + "MB");
console.log("删除条目  " + droppedIndexes.size + " 条（被覆盖的 context_edit" + (dropSuperseded ? "" : "，--keep-entries 时不删") + "）");
console.log("重连 parent " + rewrittenParents + " 处");
console.log("保留最近  " + keepTurns + " 轮（第 " + (cutAt + 1) + " 行之前截断）");
console.log("截断块数  " + truncatedBlocks);
console.log("输出      行 " + outLines.length + " / " + (outBytes / 1048576).toFixed(1) + "MB" + (dryRun ? "（dry-run，未写盘）" : " → " + outPath));
console.log("判据      可解析 " + reparsed + " / " + outLines.length + "，坏行 " + bad + "，悬空 parent " + orphan + "，期望行数 " + expectedLines);
if (!dryRun && ok) writeFileSync(outPath, outLines.join("\n") + "\n");
console.log(ok ? "结果      PASS" : "结果      FAIL（不写盘）");
process.exit(ok ? 0 : 1);
