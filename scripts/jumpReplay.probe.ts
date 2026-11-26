// 回灌探针：拿真实历史会话跑整条定位+取页链路。
// 由 tests/jumpReplay.history.test.mjs 用 tsx 子进程调用。这里 import 的两个模块用了 parameter property
import fs from "node:fs";
import path from "node:path";
import { AgentMessageProjector } from "../src/main/pi/AgentMessageProjector.ts";
import { pickJumpAnchorEntryId } from "../src/renderer/src/components/session/timeline/jumpTarget.ts";
import { SessionHistoryReader } from "../src/main/pi/SessionHistoryReader.ts";

const DIR = "C:/Users/15066212pp/.pi/agent/sessions/--c--users-15066212pp-appdata-roaming-pideck-chat-workspace--";

// 固定六份真实JSONL；缺样本必须报环境错误，不能静默缩小检查范围。
// 2026-11-26 两份旧样本已不在盘上，替换为盘上存在且已静止的两份会话。
// 每份遍历全部user刻度及末尾三条，最多1600刻度；正文仍经生产有界分页读取。
const SESSION_FILES = [
	"2026-11-18T14-10-43-047Z_01a1eefe-dee4-75ad-9ae6-7caebe9c7173.jsonl",
	"2026-11-19T11-35-33-288Z_01a1f397-2ca6-7231-9ac4-5ca7a7b06174.jsonl",
	"2026-11-20T00-42-25-558Z_01a1f667-9393-72f5-b518-117c480a3f15.jsonl",
	"2026-11-25T02-16-52-231Z_450b1175-c19d-4706-8554-3bf998322def.jsonl",
	"2026-11-20T05-43-06-541Z_01a1f77a-dc2b-7347-aa0d-cc81eedfa2ec.jsonl",
	"2026-11-20T05-43-15-807Z_01a1f77b-005d-7421-88b7-5bf1e6599d1b.jsonl",
];
const files = SESSION_FILES.map((n) => path.join(DIR, n)).filter((f) => fs.existsSync(f));
if (files.length === 0) {
	console.log("SKIP 没有固定历史样本");
	process.exit(2);
}
if (files.length !== SESSION_FILES.length) {
	console.error("固定历史样本不完整");
	process.exit(2);
}

const projector = new AgentMessageProjector({ translate: (k) => String(k), isAskAborted: () => false });
const reader = new SessionHistoryReader({
	toHostPath: (p) => p,
	convertMessages: (a, raw, ids) => projector.convert(a, raw, ids),
	trimMessages: (r) => r,
	translate: (k) => String(k),
});

async function main() {
	const failures = [];
	let checked = 0;
	let positioned = 0;
	let maxMsgs = 0;
	for (const file of files) {
		let index;
		try {
			index = await reader.getSessionDisplayIndex(file);
		} catch {
			throw new Error("真实历史索引读取失败：" + path.basename(file));
		}
		const act = index.activeMessageEntries;
		if (act.length === 0) continue;
		maxMsgs = Math.max(maxMsgs, act.length);
		const targets = [...new Map([...act.filter((entry) => entry.role === "user"), ...act.slice(-3)].map((entry) => [entry.id, entry])).values()];
		if (targets.length > 1600) throw new Error("回放超出单文件1600刻度上限");
		for (let i = 0; i < targets.length; i += 1) {
			const target = targets[i];
			if (!target) continue;
			const pos = await reader.resolveEntryPosition(file, target.id);
			if (pos === undefined || pos < 0) {
				failures.push(path.basename(file) + " i=" + i + " 定位失败");
				checked += 1;
				continue;
			}
			const page = await reader.readSessionDisplayJumpPage(file, "_viewer", target.id, 7, {});
			const lo = page.nextBefore ?? 0;
			if (!(pos >= lo && pos < page.total)) {
				failures.push(path.basename(file) + " i=" + i + " pos=" + pos + " 未覆盖(lo=" + lo + " total=" + page.total + ")");
				checked += 1;
				continue;
			}

			// 端到端：把主进程的取页结果喂进渲染层的锚点选择，判三态与锚点。
			// 这一段之前是空的 —— 回灌只验「页覆盖」，没验「拿到页之后判成什么、锚到哪里」。
			const hasTarget = (page.messages as Array<{ id: string; meta?: unknown }>).some((m) => String((m.meta as { entryId?: string } | undefined)?.entryId) === target.id);
			const anchor = pickJumpAnchorEntryId(page.messages as Array<{ id: string; meta?: unknown }>, target.id);
			// 契约：返回的必须是**这一页的 history 消息**里的 entryId，或 undefined。
			// 为什么不是「整页」：_viewer-custom-* / _viewer-meta-* 卡片也有 meta.entryId，
			// 用整页当域，锚点取到页尾卡片也算合法 —— 而卡片不在 agent-run 里，渲染层锚不上，
			// 窗口退回有界尾部。那正是 c4b3723dd 修的 bug，用「删掉 -history- 筛选」一行就能复发。
			// 反例（pr2 2026-11-25 实测）：域取整页时，谓词改成恒 false 仍然 PASS。
			// 域取 history 子集后，恒返回 target 会红 10 条、删筛选也会红 —— 两个变异都拦得住。
			const historyEntryIds = new Set(
				(page.messages as Array<{ id: string; meta?: unknown }>)
					.filter((m) => String(m.id).includes("-history-"))
					.map((m) => (m.meta as { entryId?: string } | undefined)?.entryId)
					.filter((v): v is string => typeof v === "string"),
			);
			if (anchor !== undefined && !historyEntryIds.has(anchor)) {
				failures.push(path.basename(file) + " i=" + i + " 锚点 " + anchor + " 不在这一页的 history 消息里(pos=" + pos + ")");
			}
			// 隐式契约：投影出来的每个 entryId 都必须能在索引里找到。
			// 搜索面板交出去的 message.id 就是文件原始条目 id，渲染层靠 meta.entryId 那一路对上；
			// 一旦投影改了 id 生成（加前缀、换 uuid 源），搜索跳转会静默全断——每一层单独看都对。
			for (const m of page.messages as Array<{ meta?: unknown }>) {
				const eid = (m.meta as { entryId?: string } | undefined)?.entryId;
				if (!eid) continue;
				if (!index.entries.has(eid)) {
					failures.push(path.basename(file) + " i=" + i + " 投影出的 entryId " + eid + " 不在索引里");
					break;
				}
			}
			if (hasTarget && anchor !== target.id) {
				failures.push(path.basename(file) + " i=" + i + " exact 但锚点不是目标(" + String(anchor) + ")");
			}
			if (!hasTarget && anchor === undefined && page.messages.some((m) => String((m as { id: string }).id).includes("-history-"))) {
				failures.push(path.basename(file) + " i=" + i + " 页里有 history 消息，锚点却是 undefined");
			}
			if (!hasTarget) positioned += 1;
			checked += 1;
		}
	}

	console.log("回灌 " + files.length + " 文件 / " + checked + " 处 / positioned " + positioned + " / 最大会话 " + maxMsgs + " 条");
	if (failures.length > 0) {
		console.log("FAIL " + failures.length + " 处");
		failures.slice(0, 10).forEach((f) => console.log("  " + f));
		process.exit(1);
	}
	console.log("PASS");
}

main().catch((e) => {
	console.log("FAIL " + (e && e.message ? e.message : String(e)));
	process.exit(1);
});
