import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

const entryLine = (id, parentId, role, text) =>
	JSON.stringify({
		id,
		parentId,
		type: "message",
		message: { id: `m-${id}`, role, content: [{ type: "text", text }] },
	});

/** 6 轮 × 每条 user/assistant，尾部 3 轮（e7..e12）在运行时缓存中。 */
async function createHarness() {
	const directory = await mkdtemp(join(tmpdir(), "pideck-runtime-cache-"));
	const sessionPath = join(directory, "session.jsonl");
	const ids = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11", "e12"];
	const lines = [];
	let parent = null;
	for (const id of ids) {
		lines.push(entryLine(id, parent, id.endsWith("e1") || id.endsWith("e3") || id.endsWith("e5") || id.endsWith("e7") || id.endsWith("e9") || id.endsWith("e11") ? "user" : "assistant", `${id} text`));
		parent = id;
	}
	await writeFile(sessionPath, lines.join("\n") + "\n", "utf8");

	const runtime = {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "idle",
			sessionPath,
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: { client: { request: async () => ({ success: true, data: {} }) } },
	};
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	manager.agents.set("agent-1", runtime);
	// 运行时缓存 = 尾部 5 轮（e4..e12 = 9 条），模拟运行中 12 轮窗口的一部分；
	// 文件里完整 6 轮（e1..e12），缓存只覆盖尾部——翻历史时 e7 之前的 e4..e6 可从缓存命中
	manager.messages.set(
		"agent-1",
		["e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11", "e12"].map((id) => ({
			id: `m-${id}`,
			agentId: "agent-1",
			role: id.endsWith("4") || id.endsWith("6") || id.endsWith("8") || id.endsWith("10") || id.endsWith("12") ? "user" : "assistant",
			text: `${id} text`,
			timestamp: 1,
			meta: { entryId: id },
		})),
	);
	return { manager, sessionPath, directory };
}

test("tryReadRuntimeTurnPage serves cache-resident turns without reading the file", async () => {
	const { manager, sessionPath, directory } = await createHarness();
	try {
		// 请求 e7（运行时窗口首条）之前的 3 轮 → 命中缓存：返回 e4..e6（文件里存在但缓存没有的部分）
		const page = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
			beforeEntryId: "e7",
			turnCount: 3,
		});
		assert.ok(page, "cache hit expected");
		assert.equal(page.messages.length, 3);
		assert.equal(page.messages[0].meta.entryId, "e4");
		assert.equal(page.messages[2].meta.entryId, "e6");
		// 游标换算回文件下标空间：e4 在文件里的位置 = 3
		assert.equal(page.nextBefore, 3);
		assert.equal(page.nextBeforeEntryId, "e4");
		assert.equal(page.total, 12);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("tryReadRuntimeTurnPage strips tool results on cache-hit pages", async () => {
	const { manager, sessionPath, directory } = await createHarness();
	try {
		const cached = manager.messages.get("agent-1");
		// 把 e6 伪装成工具消息：主进程缓存必须保留完整 result，但翻页回包必须剥离。
		cached[2] = {
			...cached[2],
			role: "tool",
			meta: { ...cached[2].meta, result: "full tool output that must not reach the renderer" },
		};
		const page = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
			beforeEntryId: "e7",
			turnCount: 3,
		});
		assert.ok(page, "cache hit expected");
		const deliveredTool = page.messages.find((message) => message.meta?.entryId === "e6");
		assert.ok(deliveredTool, "tool message is part of the cached page");
		assert.equal(deliveredTool.meta.result, undefined, "cache-hit pages must match file-path payloads");
		assert.equal(cached[2].meta.result, "full tool output that must not reach the renderer", "main cache stays intact");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("tryReadRuntimeTurnPage misses when anchor is outside the runtime cache", async () => {
	const { manager, sessionPath, directory } = await createHarness();
	try {
		// e2 不在缓存中 → 未命中，调用方回退读文件
		const miss = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
			beforeEntryId: "e2",
			turnCount: 3,
		});
		assert.equal(miss, null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("tryReadRuntimeTurnPage misses for inactive agents (history viewer path)", async () => {
	const { manager, sessionPath, directory } = await createHarness();
	try {
		manager.agents.delete("agent-1");
		const miss = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
			beforeEntryId: "e7",
			turnCount: 3,
		});
		assert.equal(miss, null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("tryReadRuntimeTurnPage misses when the runtime switched to another session", async () => {
	const { manager, sessionPath, directory } = await createHarness();
	try {
		// 运行时已切到别的会话（替换/重绑）：不得用其缓存应答本会话翻页
		const otherPath = join(directory, "other.jsonl");
		await writeFile(otherPath, "{}", "utf8");
		manager.agents.get("agent-1").tab.sessionPath = otherPath;
		const miss = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
			beforeEntryId: "e7",
			turnCount: 3,
		});
		assert.equal(miss, null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("tryReadRuntimeTurnPage cache pages carry the file indexVersion and cursor equivalence", async () => {
	const { manager, sessionPath, directory } = await createHarness();
	try {
		const version = await stat(sessionPath);
		const page = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
			beforeEntryId: "e7",
			turnCount: 3,
		});
		assert.ok(page, "cache hit expected");
		// 与文件路径同口径的版本串：渲染层据此检测压缩/外部改写
		assert.equal(page.indexVersion, `${version.mtimeMs}:${version.size}`);
		// 数值游标（文件消息下标）与 entryId 游标解析到同一页；
		// 注意：before 落在缓存最旧条目（pos===0）时正确行为是返回 null 交给文件路径。
		const byBefore = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
			before: 5,
			turnCount: 3,
		});
		assert.ok(byBefore, "numeric cursor cache hit expected");
		assert.equal(byBefore.messages[0].meta.entryId, "e4");
		const byEntryId = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
			beforeEntryId: "e6",
			turnCount: 3,
		});
		assert.ok(byEntryId);
		assert.deepEqual(
			byBefore.messages.map((m) => m.meta.entryId),
			byEntryId.messages.map((m) => m.meta.entryId),
		);
		assert.equal(byBefore.nextBefore, byEntryId.nextBefore);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("cache-miss edit/delete/resend locate the file entry via synthetic ids and restore the text draft", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-runtime-cache-miss-"));
	const sessionPath = join(directory, "session.jsonl");
	try {
		const lines = [];
		let parent = null;
		for (const id of ["e1", "e2", "e3", "e4", "e5", "e6"]) {
			lines.push(entryLine(id, parent, id.endsWith("1") || id.endsWith("3") || id.endsWith("5") ? "user" : "assistant", `${id} text`));
			parent = id;
		}
		await writeFile(sessionPath, lines.join("\n") + "\n", "utf8");

		const runtime = {
			tab: {
				id: "agent-1",
				projectId: "project-1",
				cwd: "C:/project",
				title: "Session",
				status: "idle",
				sessionPath,
				sessionEnvironment: "native",
				sessionSource: "pi",
				createdAt: 1,
			},
			process: { client: { request: async () => ({ success: true, data: {} }) } },
		};
		const calls = [];
		const editorStub = {
			editMessage: async (input) => {
				calls.push(["edit", input.target]);
				return {};
			},
			deleteMessage: async (input) => {
				calls.push(["delete", input.target]);
				return {};
			},
			truncateForResend: async (input) => {
				calls.push(["resend", input.target]);
				return {};
			},
		};
		const manager = new AgentManager(
			() => ({ id: "project-1", name: "Project", path: "C:/project" }),
			() => null,
			{ get: () => ({}) },
			{},
			undefined,
			undefined,
			editorStub,
		);
		manager.agents.set("agent-1", runtime);
		// 运行时缓存只覆盖尾部 e4..e6 → e1 全部走缓存未命中文件定位
		manager.messages.set(
			"agent-1",
			["e4", "e5", "e6"].map((id) => ({
				id: `m-${id}`,
				agentId: "agent-1",
				role: id.endsWith("4") || id.endsWith("6") ? "user" : "assistant",
				text: `${id} text`,
				timestamp: 1,
				meta: { entryId: id },
			})),
		);
		manager.loadMessages = async () => {}; // 文件编辑后的重载不属于本测试范围

		await manager.editMessage("agent-1", "agent-1-history-e1", "edited");
		assert.equal(calls[0][0], "edit");
		assert.equal(calls[0][1].entryId, "e1", "synthetic id must resolve to the real file entry");

		await manager.deleteMessage("agent-1", "agent-1-history-e1");
		assert.equal(calls[1][0], "delete");
		assert.equal(calls[1][1].entryId, "e1");

		// 纯文本 cache-miss 重发：截断前必须把草稿完整取回（修复前返回空文本）
		const draft = await manager.prepareResendFromMessage("agent-1", "agent-1-history-e1");
		assert.equal(calls[2][0], "resend");
		assert.equal(calls[2][1].entryId, "e1");
		assert.equal(draft.text, "e1 text");
		assert.equal(draft.images, undefined);

		// 缓存命中重发仍走缓存草稿
		const hit = await manager.prepareResendFromMessage("agent-1", "m-e4");
		assert.equal(hit.text, "e4 text");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("loadMessages aligns trimmed runtime messages with their real entry ids", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-runtime-cache-align-"));
	const sessionPath = join(directory, "session.jsonl");
	try {
		const messages = [];
		const entries = [];
		let parent = null;
		for (let i = 1; i <= 15; i += 1) {
			const uid = `u${i}`;
			const aid = `a${i}`;
			messages.push({ role: "user", content: [{ type: "text", text: `q${i}` }], id: `msg-u${i}` });
			entries.push({ id: uid, parentId: parent, type: "message", message: { role: "user", id: `msg-u${i}` } });
			parent = uid;
			messages.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }], id: `msg-a${i}` });
			entries.push({ id: aid, parentId: parent, type: "message", message: { role: "assistant", id: `msg-a${i}` } });
			parent = aid;
		}
		// 有 sessionPath 的 loadMessages 走 JSONL 安全读取；夹具必须提供真实文件内容，
		// 否则生产路径会正确读到空历史，而不会使用被禁用的 get_messages mock。
		await writeFile(
			sessionPath,
			entries
				.map((entry, index) =>
					JSON.stringify({
						...entry,
						message: messages[index],
					}),
				)
				.join("\n") + "\n",
			"utf8",
		);
		const runtime = {
			tab: {
				id: "agent-1",
				projectId: "project-1",
				cwd: "C:/project",
				title: "Session",
				status: "idle",
				sessionPath,
				sessionEnvironment: "native",
				sessionSource: "pi",
				createdAt: 1,
			},
			process: {
				client: {
					request: async ({ type }) => (type === "get_entries" ? { success: true, data: { entries, leafId: "a15" } } : { success: true, data: { messages } }),
				},
			},
		};
		const manager = new AgentManager(
			() => ({ id: "project-1", name: "Project", path: "C:/project" }),
			() => null,
			{ get: () => ({}) },
			{},
		);
		manager.agents.set("agent-1", runtime);
		const payloads = [];
		manager.onOutput((channel, payload) => {
			if (channel === "agents:message") payloads.push(payload);
		});

		await manager.loadMessages("agent-1");
		const cached = manager.messages.get("agent-1");
		// 15 轮裁到 12 轮：首条保留 q4，其 entryId 必须是 u4（修复前被错配成 u1）
		assert.equal(cached[0].text, "q4");
		assert.equal(cached[0].meta.entryId, "u4");
		assert.equal(cached[cached.length - 1].meta.entryId, "a15");
		// 全量 flush 携带 windowStartFilePos：DOM 3 / atom 9 / main 12 模型下窗口 = 尾部 9 轮，
		// 窗口首条（q7）在裁剪后数组下标 6，文件消息下标 = headOffset(6) + 6 = 12
		const full = payloads.find((p) => p.windowStart !== undefined);
		assert.ok(full, "windowed full flush expected");
		assert.equal(full.windowStart, 6);
		assert.equal(full.windowStartFilePos, 12);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("loadMessages keeps entryId slots aligned when the window contains pi 0.86 system entries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-runtime-cache-system-"));
	const sessionPath = join(directory, "session.jsonl");
	try {
		// 0.86 会话：首条 entry 是系统提示 sections，会话中段再插一条工具清单变更
		// （两者都是 type:"message" + role:"system"，落在尾部 12 轮窗口内）。
		const entries = [];
		let parent = null;
		const push = (id, role, text, extra = {}) => {
			entries.push({ id, parentId: parent, type: "message", message: { role, content: [{ type: "text", text }], ...extra } });
			parent = id;
		};
		push("sys0", "system", "", { sections: { preamble: "You are pi." } });
		for (let i = 1; i <= 15; i += 1) {
			push(`u${i}`, "user", `q${i}`);
			push(`a${i}`, "assistant", `a${i}`);
			if (i === 7) push("sys7", "system", "", { toolsRemoved: [{ name: "edit" }] });
		}
		await writeFile(sessionPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
		const runtime = {
			tab: {
				id: "agent-1",
				projectId: "project-1",
				cwd: "C:/project",
				title: "Session",
				status: "idle",
				sessionPath,
				sessionEnvironment: "native",
				sessionSource: "pi",
				createdAt: 1,
			},
			process: { client: { request: async () => ({ success: true, data: {} }) } },
		};
		const manager = new AgentManager(
			() => ({ id: "project-1", name: "Project", path: "C:/project" }),
			() => null,
			{ get: () => ({}) },
			{},
		);
		manager.agents.set("agent-1", runtime);
		const payloads = [];
		manager.onOutput((channel, payload) => {
			if (channel === "agents:message") payloads.push(payload);
		});

		await manager.loadMessages("agent-1");
		const cached = manager.messages.get("agent-1");
		const entryIdOf = (text) => cached.find((message) => message.text === text)?.meta?.entryId;
		// 窗口首条 q4 必须绑回 u4：修复前 sys7 会占掉一个 id 槽位，导致 q4→a4、q7→sys7。
		assert.equal(cached[0].text, "q4");
		assert.equal(cached[0].meta.entryId, "u4");
		assert.equal(entryIdOf("q7"), "u7");
		assert.equal(entryIdOf("q8"), "u8");
		assert.equal(cached[cached.length - 1].meta.entryId, "a15");
		// windowStartFilePos 用 message 条目空间：sys0 与 sys7 各占 1 条，窗口首条 q4 的文件下标
		// 从 6 变为 7，显示窗口（尾部 9 轮）起点偏移 6 ⇒ 13（无 system 的 15 轮用例是 12）。
		const full = payloads.find((p) => p.windowStart !== undefined);
		assert.ok(full, "windowed full flush expected");
		assert.equal(full.windowStart, 6);
		assert.equal(full.windowStartFilePos, 13);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("trimRuntimeCache keeps leading compaction summary cards", async () => {
	const { manager, sessionPath, directory } = await createHarness();
	try {
		const many = [];
		for (let i = 1; i <= 15; i += 1) {
			many.push({ id: `m-u${i}`, agentId: "agent-1", role: "user", text: `q${i}`, timestamp: 1, meta: { entryId: `u${i}` } });
			many.push({ id: `m-a${i}`, agentId: "agent-1", role: "assistant", text: `a${i}`, timestamp: 1, meta: { entryId: `a${i}` } });
		}
		manager.messages.set("agent-1", [{ id: "sum-1", agentId: "agent-1", role: "system", text: "compacted", timestamp: 1, meta: { type: "compaction" } }, ...many]);
		const payloads = [];
		manager.onOutput((channel, payload) => {
			if (channel === "agents:message") payloads.push(payload);
		});
		manager.trimRuntimeCache("agent-1");
		const after = manager.messages.get("agent-1");
		// 卡片保留在头部且不重复；尾部保留最近 12 轮（24 条）
		assert.equal(after.filter((m) => m.role === "system").length, 1);
		assert.equal(after[0].meta.type, "compaction");
		assert.equal(after.length, 25);
		assert.equal(after[1].text, "q4");
		assert.equal(after[24].text, "a15");
		// 数值游标不被卡片污染：窗口 = 尾部 9 轮（q7 起），裁剪后数组下标 7（卡片占 1 位），
		// 文件消息下标 = headOffset(6) + (7 − 卡片数 1) = 12
		const full = payloads.find((p) => p.windowStart !== undefined);
		assert.ok(full, "windowed full flush expected");
		assert.equal(full.windowStart, 7);
		assert.equal(full.windowStartFilePos, 12);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("flushMessageEmit slides the 9-turn window and carries slideOut, keeping anonymous headOffset (H2+M2 regression)", async () => {
	const { manager, sessionPath, directory } = await createHarness();
	try {
		const many = [];
		for (let i = 1; i <= 15; i += 1) {
			many.push({ id: `m-u${i}`, agentId: "agent-1", role: "user", text: `q${i}`, timestamp: 1, meta: { entryId: `u${i}` } });
			many.push({ id: `m-a${i}`, agentId: "agent-1", role: "assistant", text: `a${i}`, timestamp: 1, meta: { entryId: `a${i}` } });
		}
		// 新轮 q16 追加到尾部：窗口从 q7 起（下标 12）右移到 q8 起（下标 14）
		many.push({ id: "m-u16", agentId: "agent-1", role: "user", text: "q16", timestamp: 1, meta: { entryId: "u16" } });
		many.push({ id: "m-a16", agentId: "agent-1", role: "assistant", text: "a16", timestamp: 1, meta: { entryId: "a16" } });
		manager.messages.set("agent-1", many);
		// 旧窗口 = q7 起（DOM 3 / atom 9 / main 12 模型的尾部 9 轮起点）
		manager.displayWindowStartByAgent.set("agent-1", 12);
		// 匿名会话（无文件路径/无 entryId 映射）：headOffset 未知 = -1，flush 后必须保持 -1（M2）
		manager.messageHeadOffsetByAgent.set("agent-1", -1);
		const payloads = [];
		manager.onOutput((channel, payload) => {
			if (channel === "agents:message") payloads.push(payload);
		});
		manager.flushMessageEmit("agent-1");
		// H2：窗口右移滑出的旧窗口头部轮随全量 flush 下发（渲染层并入历史前缀，锚点轮不消失）
		const slidePayload = payloads.find((p) => p.slideOut !== undefined);
		assert.ok(slidePayload, "full flush must carry slideOut");
		assert.deepEqual(
			Array.from(slidePayload.slideOut, (m) => m.meta.entryId),
			["u7", "a7"],
		);
		assert.equal(slidePayload.windowStart, 14, "窗口右移到 q8 起（下标 14）");
		assert.equal(slidePayload.messages[0].meta.entryId, "u8");
		assert.equal(manager.pendingSlideOutByAgent.get("agent-1"), undefined, "flush 后待发滑出已清空");
		// M2：-1 保持 -1（修复前被递增成 5 的伪造游标）
		assert.equal(manager.messageHeadOffsetByAgent.get("agent-1"), -1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("trimRuntimeCache increments headOffset for file-backed sessions only (M2 regression)", async () => {
	const { manager, sessionPath, directory } = await createHarness();
	try {
		const many = [];
		for (let i = 1; i <= 15; i += 1) {
			many.push({ id: `m-u${i}`, agentId: "agent-1", role: "user", text: `q${i}`, timestamp: 1, meta: { entryId: `u${i}` } });
			many.push({ id: `m-a${i}`, agentId: "agent-1", role: "assistant", text: `a${i}`, timestamp: 1, meta: { entryId: `a${i}` } });
		}
		manager.messages.set("agent-1", many);
		manager.messageHeadOffsetByAgent.set("agent-1", 0);
		const payloads = [];
		manager.onOutput((channel, payload) => {
			if (channel === "agents:message") payloads.push(payload);
		});
		manager.trimRuntimeCache("agent-1");
		// 被裁 q1..a3 = 6 条角色消息 → 数值游标前移 6；
		// 窗口 = 尾部 9 轮（q7 起，trim 后数组下标 6），文件消息下标 = 6 + 6 = 12
		assert.equal(manager.messageHeadOffsetByAgent.get("agent-1"), 6);
		const full = payloads.find((p) => p.windowStart !== undefined);
		assert.ok(full, "windowed full flush expected");
		assert.equal(full.windowStart, 6);
		assert.equal(full.windowStartFilePos, 12);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("delete uses the JSONL leaf even when get_entries reports a foreign leaf", async () => {
	const { manager, directory } = await createHarness();
	const rpcCalls = [];
	const editorCalls = [];
	try {
		const runtime = manager.agents.get("agent-1");
		runtime.process.client.request = async (command) => {
			rpcCalls.push(command.type);
			if (command.type === "get_entries") {
				return { success: true, data: { leafId: "not-in-file" } };
			}
			return { success: true, data: {} };
		};
		manager.sessionFileEditor = {
			deleteMessage: async (input) => {
				editorCalls.push(input.target);
				return {};
			},
		};
		manager.loadMessages = async () => {};
		await manager.deleteMessage("agent-1", "m-e12");
		assert.equal(editorCalls.length, 1);
		assert.equal(editorCalls[0].entryId, "e12");
		// 文件活动分支末条是 e12；RPC 的陌生 leaf 不得传给 SessionFileEditor。
		assert.equal(editorCalls[0].activeLeafId, "e12");
		assert.equal(rpcCalls.includes("get_entries"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("cache-miss delete of a message absent from the file rejects with Message not found", async () => {
	const { manager, sessionPath, directory } = await createHarness();
	try {
		manager.loadMessages = async () => {};
		await assert.rejects(manager.deleteMessage("agent-1", "agent-1-history-nope"), /Message not found/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("delete after send+abort locates the user bubble by the renderer requestId", async () => {
	const { manager, directory } = await createHarness();
	const requestId = "optimistic-request-id";
	const editorCalls = [];
	try {
		const runtime = manager.agents.get("agent-1");
		runtime.tab.status = "idle";
		runtime.process.isRunning = () => true;
		runtime.process.client.request = async ({ type }) => {
			if (type === "prompt") return { success: true, data: {} };
			if (type === "abort") return { success: true, data: {} };
			if (type === "get_entries") return { success: true, data: { leafId: "e12" } };
			return { success: true, data: {} };
		};
		manager.sessionFileEditor = {
			deleteMessage: async (input) => {
				editorCalls.push(input.target);
				return {};
			},
		};
		manager.loadMessages = async () => {};

		const sent = await manager.sendPrompt({
			agentId: "agent-1",
			message: "send-then-abort-then-delete",
			requestId,
		});
		assert.equal(sent.accepted, true);
		await manager.abort("agent-1");

		// 渲染层乐观气泡 id = requestId；中断后用户立刻删这条，必须命中同一条缓存，不能再抛 Message not found
		await manager.deleteMessage("agent-1", requestId);
		assert.equal(editorCalls.length, 1);
		assert.equal(editorCalls[0].legacyMessageId, requestId);
		assert.equal(editorCalls[0].role, "user");
		assert.equal(editorCalls[0].text, "send-then-abort-then-delete");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("delete after abort drops an unpersisted turn from runtime cache instead of failing", async () => {
	const { manager, directory } = await createHarness();
	try {
		manager.messages.set("agent-1", [
			{
				id: "optimistic-request-id",
				agentId: "agent-1",
				role: "user",
				text: "unpersisted prompt",
				timestamp: 1,
				meta: { requestId: "optimistic-request-id" },
			},
			{
				id: "aborted-assistant",
				agentId: "agent-1",
				role: "assistant",
				text: "partial",
				timestamp: 2,
			},
		]);
		manager.sessionFileEditor = {
			deleteMessage: async () => {
				const error = new Error("Message was not found on the active session branch");
				error.code = "SESSION_ENTRY_NOT_FOUND";
				throw error;
			},
		};
		manager.loadMessages = async () => {
			throw new Error("unpersisted delete must not reload from file");
		};
		// 中断后 JSONL 还没这条：不能把「文件未命中」当成用户可见的删除失败
		await manager.deleteMessage("agent-1", "optimistic-request-id");
		const remaining = manager.messages.get("agent-1");
		assert.equal(
			remaining.some((message) => message.text === "unpersisted prompt"),
			false,
		);
		assert.equal(
			remaining.some((message) => message.id === "aborted-assistant"),
			false,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
