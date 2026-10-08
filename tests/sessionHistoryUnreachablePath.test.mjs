/**
 * 「路径不可达」不能伪装成「空历史」。
 *
 * 现场症状（2026-10-08，Linux）：fork/copy 出的新会话永远停在「正在加载会话历史」。
 * 链路：pi 返回相对 sessionFile（.pi/sessions/x.jsonl）→ PiDeck 旧解析把它拼成
 * `\home\zhadainian\PiDeck\.pi\sessions\x.jsonl`（POSIX 不可寻址）→ 读盘 ENOENT →
 * readRecentMessages 把 ENOENT 当「新会话尚未落盘」静默返回空历史 → 运行时下发 0 条
 * → 渲染层把空缓存当「已加载」跳过读盘，loadState 永远停在 undefined → 骨架屏永驻。
 *
 * 契约：readRecentMessages 的 ENOENT 兜底只允许「新会话竞态」——即父目录存在
 * （pi 打开持久会话时 mkdirSync(recursive) 会话目录，见 pi SessionManager 构造），
 * 文件本身还没写。路径不可达（父目录不存在，POSIX 反斜杠路径/错根路径）必须如实抛出，
 * 让 AgentManager 落「历史加载失败」错误卡片，而不是无声空历史。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

function createReader(logs = []) {
	return new SessionHistoryReader({
		toHostPath: (sessionPath) => sessionPath,
		convertMessages: (_agentId, rawMessages, entryIds = []) =>
			rawMessages.map((message, index) => ({
				id: entryIds[index] ?? `message-${index}`,
				role: message.role,
				text: typeof message.content === "string" ? message.content : (message.content?.[0]?.text ?? ""),
			})),
		trimMessages: (messages) => messages,
		translate: () => "Summary unavailable.",
		logger: {
			debug: () => undefined,
			info: (channel, message, meta) => logs.push({ level: "info", channel, message, meta }),
			warn: (channel, message, meta) => logs.push({ level: "warn", channel, message, meta }),
			error: (channel, message, meta) => logs.push({ level: "error", channel, message, meta }),
		},
	});
}

function oneTurnSessionJsonl() {
	return [
		JSON.stringify({ id: "session", type: "session" }),
		JSON.stringify({ id: "u1", parentId: "session", type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
	].join("\n") + "\n";
}

test("readRecentMessages keeps the legitimate new-session race: missing file, existing directory", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-enoent-race-"));
	const sessionPath = join(directory, "session.jsonl");
	try {
		const reader = createReader();
		const response = await reader.readRecentMessages(sessionPath, 3);
		assert.equal(response.success, true);
		assert.equal((response.data?.messages ?? []).length, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("readRecentMessages surfaces an unreachable path instead of faking empty history", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-enoent-unreachable-"));
	try {
		// 模拟现场坏路径形态：父目录不存在（无论它是 POSIX 反斜杠产物还是错根路径）。
		const sessionPath = join(directory, "missing-dir", "session.jsonl");
		const reader = createReader();
		await assert.rejects(
			() => reader.readRecentMessages(sessionPath, 3),
			(error) => {
				// vm 加载下 error instanceof Error 跨 realm 不成立，按结构与名字断言。
				assert.ok(error instanceof Error || (error && typeof error === "object" && typeof error.message === "string"));
				assert.equal(error?.name, "SessionHistoryUnreachablePathError");
				// 错误必须可定位：带上坏路径本身，便于主进程日志与错误卡片诊断。
				assert.ok(error.message.includes(sessionPath));
				// 不得是裸 ENOENT（否则上层难以区分「文件未创建」与「路径坏了」）。
				assert.match(error.message, /unreachable|not addressable|invalid session path/i);
				return true;
			},
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("readRecentMessages still reads history when the file appears before the first poll", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-enoent-existing-"));
	const sessionPath = join(directory, "session.jsonl");
	try {
		await writeFile(sessionPath, oneTurnSessionJsonl(), "utf8");
		const reader = createReader();
		const response = await reader.readRecentMessages(sessionPath, 3);
		assert.equal(response.data?.messages?.length, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("readRecentMessages unreachable-path error is a loud, diagnosable failure", async () => {
	// 回归保险：路径不可达时不允许出现「treating recent history as empty」info 日志，
	// 否则现场排查又被引导回「新会话竞态」这条错误线索。
	const directory = await mkdtemp(join(tmpdir(), "pideck-enoent-quiet-"));
	try {
		const sessionPath = join(directory, "nope", "session.jsonl");
		const logs = [];
		const reader = createReader(logs);
		await assert.rejects(() => reader.readRecentMessages(sessionPath, 3));
		assert.ok(
			!logs.some((entry) => typeof entry.message === "string" && entry.message.includes("treating recent history as empty")),
			"must not log the empty-history excuse for an unreachable path",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("readRecentMessages tolerates a session whose directory is created alongside the file", async () => {
	// pi 打开会话时目录已存在；目录与文件同帧出现也属于合法竞态窗口。
	const directory = await mkdtemp(join(tmpdir(), "pideck-enoent-mkdir-"));
	const nested = join(directory, "sessions");
	const sessionPath = join(nested, "session.jsonl");
	try {
		await mkdir(nested, { recursive: true });
		const reader = createReader();
		const response = await reader.readRecentMessages(sessionPath, 3);
		assert.equal((response.data?.messages ?? []).length, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
