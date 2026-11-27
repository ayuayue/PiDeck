import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 跳转定位的回灌判据：拿本机真实会话，验证「按 entryId 定位 → 一次取页」能不能把目标带回来。
 *
 * 为什么要回灌：纯函数单测用小样本全绿，真机「点一条消息一次到位」仍失败过不止一次。
 * 差别不在逻辑，在真实文件的规模（上万条、跨页、非显示条目），小样本造不出来。
 *
 * 口径（决定这条判据能不能红）：
 * - 锚点语义是「取锚点之前的一页」，所以 before = position + 1 才取到「含目标」的页。
 *   写成 before = position 会得到不含目标的一页，全 miss —— 那不是 bug，是量错了。
 * - 命中 = 该 entryId 出现在返回页里（meta.entryId 或 id 的 -history- 后缀）。
 * - 豁免 = position 0 且返回空页：第一条活动条目常常不可显示，属于产物限制，不是定位失败。
 *   豁免要计数打印，不静默吞掉。
 */
const SESSIONS_DIR = process.env.PIDE_SESSIONS_DIR || process.env.SESSIONS_DIR || join(homedir(), ".pi", "agent", "sessions");
const MAX_FILES = Number(process.env.JUMP_REPLAY_FILES || 3);
const SAMPLES = [1, 0.25, 0.5, 0.75, 1];

function listSessions(root) {
	const out = [];
	(function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl")) out.push({ path: full, size: statSync(full).size });
		}
	})(root);
	out.sort((left, right) => right.size - left.size);
	return out;
}

function entryIdOf(message) {
	const meta = message?.meta;
	if (meta && typeof meta === "object" && typeof meta.entryId === "string" && meta.entryId) return meta.entryId;
	const id = message?.id;
	if (typeof id === "string" && id.includes("-history-")) return id.split("-history-")[1];
	return undefined;
}

const available = (() => {
	try {
		return listSessions(SESSIONS_DIR).length > 0;
	} catch {
		return false;
	}
})();

test("真实会话回灌：按 entryId 定位后一次取页，页里必须含目标", { skip: available ? false : "没有历史会话目录 " + SESSIONS_DIR + "（skip 不算通过）" }, async () => {
	const { createPiSessionShareReader } = loadTsCommonJs("src/main/pi/piSessionShareReader.ts");
	const reader = createPiSessionShareReader(() => "");
	const files = listSessions(SESSIONS_DIR).slice(0, MAX_FILES);
	assert.ok(files.length > 0, "没有会话文件");

	let sampled = 0;
	let hit = 0;
	const exempt = [];
	const failures = [];

	for (const file of files) {
		const total = await reader.getActiveEntryCount(file.path);
		if (total < 10) continue;
		const positions = [...new Set(SAMPLES.map((ratio) => Math.min(total - 1, Math.max(0, Math.floor(total * ratio)))))];
		for (const position of positions) {
			const entryId = await reader.resolveEntryIdAtPosition(file.path, position);
			if (!entryId) continue;
			const resolved = await reader.resolveEntryPosition(file.path, entryId);
			const page = await reader.readSessionDisplayTurnPage(file.path, "_viewer", (resolved ?? 0) + 1, 200);
			const present = page.messages.map(entryIdOf).filter(Boolean);
			sampled += 1;
			if (present.includes(entryId)) {
				hit += 1;
				continue;
			}
			if ((resolved ?? 0) === 0 && page.messages.length === 0) {
				exempt.push(file.path);
				continue;
			}
			failures.push({ file: file.path.slice(-24), position: resolved, entryId, pageMessages: page.messages.length, nextBefore: page.nextBefore });
		}
	}

	console.log(JSON.stringify({ sessionsDir: SESSIONS_DIR, files: files.length, sampled, hit, exempt: exempt.length, failures: failures.slice(0, 5) }));
	assert.deepEqual(failures, [], "有目标没被一次取页带回来（这是真失败，不是豁免）");
	assert.ok(sampled >= 5, "采样太少，判据没真正跑");
});
