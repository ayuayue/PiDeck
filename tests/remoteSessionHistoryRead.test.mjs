import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

import { sessionIpcSource } from "./helpers/sessionIpcSources.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";
import { agentManagerSource } from "./helpers/agentManagerSources.mjs";
/**
 * 远端会话历史的有界窗口读取（`RemoteSessionHistoryReader`）。
 *
 * 不连真机：SSH 传输是**假 exec**——它按命令形状（`tail -c N` / `tail -c +K | head -c C`）在一个内存
 * 字节串上执行真实语义。于是「窗口边界」这类最容易写错的东西被真正测到，而不是靠 mock 返回现成结果
 * 把 bug 掩盖过去。测试同时断言命令**参数**（上界只出现在命令里），这是「必须有字节上界」那条要求的
 * 可执行证据。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createRemoteSessionHistoryReader, buildRemoteSessionWindowCommand, parseRemoteSessionWindow, validateRemoteSessionHistoryPath, joinRemoteSessionRoot, remoteSessionHistoryMarker, REMOTE_SESSION_HISTORY_CODES, REMOTE_SESSION_HISTORY_WINDOW_BYTES, REMOTE_SESSION_HISTORY_TRANSPORT_BYTES } =
	loadTsCommonJs("src/main/remote/RemoteSessionHistoryReader.ts");

const HOST_ID = "3f1d6a54-1b2c-4c6d-8f90-1a2b3c4d5e6f";

// 命令形状（唯一解析点）：两种形态各有一条正则，测试与假 exec 共用。
const TAIL_SHAPE = /^printf '([A-Za-z0-9_]+)'; wc -c < '([^'\\]+)'; tail -c (\d+) -- '([^'\\]+)'$/;
const RANGE_SHAPE = /^printf '([A-Za-z0-9_]+)'; tail -c \+(\d+) -- '([^'\\]+)' \| head -c (\d+)$/;

/** 跨 realm 归一：生产模块经 vm 加载，返回的数组/对象原型与测试 realm 不同。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** 一条按真实 `tail`/`head` 语义执行的假远端文件。 */
function fakeRemote(content) {
	const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
	const commands = [];
	return {
		bytes,
		commands,
		transport: {
			readRemoteWindow: async ({ remoteCommand }) => {
				commands.push(remoteCommand);
				const tail = TAIL_SHAPE.exec(remoteCommand);
				if (tail) {
					const window = Number(tail[3]);
					const from = Math.max(0, bytes.length - window);
					return { exitCode: 0, stdout: `${tail[1]}${bytes.length}\n${bytes.subarray(from).toString("utf8")}` };
				}
				const range = RANGE_SHAPE.exec(remoteCommand);
				if (!range) throw new Error(`UNEXPECTED_COMMAND: ${remoteCommand}`);
				const from = Number(range[2]) - 1;
				return { exitCode: 0, stdout: `${range[1]}${bytes.subarray(from, from + Number(range[4])).toString("utf8")}` };
			},
		},
	};
}

/** 假投影：形状与真实 `ChatMessage` 一致（真实投影管线由 AgentManager 单测覆盖）。 */
function fakeProject(rawMessages, activeEntryIds) {
	return rawMessages.map((message, index) => ({
		id: `viewer-history-${activeEntryIds?.[index] ?? index}`,
		role: message.role,
		text: typeof message.content === "string" ? message.content : "",
		timestamp: message.timestamp ?? 0,
		meta: { entryId: activeEntryIds?.[index] },
	}));
}

function line(id, parentId, role, content) {
	return `${JSON.stringify({ id, parentId, type: "message", message: { role, content, timestamp: 1_700_000_000_000 } })}\n`;
}

/** 会话 JSONL 夹具：n 轮 user/assistant。 */
function conversation(turns) {
	let jsonl = "";
	let parent = null;
	for (let index = 0; index < turns; index += 1) {
		const userId = `u${index}`;
		const assistantId = `a${index}`;
		jsonl += line(userId, parent, "user", `question-${index}`);
		jsonl += line(assistantId, userId, "assistant", `answer-${index}`);
		parent = assistantId;
	}
	return jsonl;
}

function reader(remote, extra = {}) {
	return createRemoteSessionHistoryReader({
		transport: remote.transport,
		project: fakeProject,
		...extra,
	});
}

function sshLocator(remotePath, remoteSessionId) {
	return { kind: "ssh", hostId: HOST_ID, ...(remotePath === undefined ? {} : { remotePath }), ...(remoteSessionId === undefined ? {} : { remoteSessionId }) };
}

function texts(page) {
	return plain(page.messages.map((message) => message.text));
}

test("the read command carries the window bound and the validated absolute path", () => {
	const command = buildRemoteSessionWindowCommand({ remotePath: "/home/dev/.pi/agent/sessions/a/b.jsonl", windowBytes: 4096, nonce: "a1b2c3d4e5f6a7b8" });
	// 窗口上界是命令里唯一的数字：命令里**不允许**出现文件大小（有界读不等于整文件读）。
	assert.match(command, /^printf 'PIDECK_HISTORY_a1b2c3d4e5f6a7b8'; wc -c < '\/home\/dev\/\.pi\/agent\/sessions\/a\/b\.jsonl'; tail -c 4096 -- '\/home\/dev\/\.pi\/agent\/sessions\/a\/b\.jsonl'$/);
	assert.deepEqual(plain([...TAIL_SHAPE.exec(command)].slice(3, 4)), ["4096"]);
});

test("a cursor read asks only for the bounded range before the cursor", () => {
	const command = buildRemoteSessionWindowCommand({ remotePath: "/s/a.jsonl", windowBytes: 100, endOffset: 250, nonce: "abc12345abc12345" });
	assert.deepEqual(plain([...RANGE_SHAPE.exec(command)].slice(2, 5)), ["151", "/s/a.jsonl", "100"]);
	// 起点 clamp 到 1（文件更短时不会请求负偏移）。
	const clamped = buildRemoteSessionWindowCommand({ remotePath: "/s/a.jsonl", windowBytes: 100, endOffset: 40, nonce: "abc12345abc12345" });
	assert.deepEqual(plain([...RANGE_SHAPE.exec(clamped)].slice(2, 5)), ["1", "/s/a.jsonl", "40"]);
});

test("the window bound stays below the transport output bound and cannot be raised", () => {
	assert.ok(REMOTE_SESSION_HISTORY_WINDOW_BYTES < REMOTE_SESSION_HISTORY_TRANSPORT_BYTES);
	assert.throws(() => buildRemoteSessionWindowCommand({ remotePath: "/s/a.jsonl", windowBytes: REMOTE_SESSION_HISTORY_WINDOW_BYTES + 1, nonce: "abc12345abc12345" }), /REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID/);
	// 端口上界同样只能调小：装配传一个更大的窗口是接线错误，不是「读更多」。
	assert.throws(() => createRemoteSessionHistoryReader({ transport: { readRemoteWindow: async () => ({ exitCode: 0, stdout: "" }) }, project: fakeProject, windowBytes: 10 * 1024 * 1024 }), /REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID/);
});

test("paths that could break out of the quoted command are refused", () => {
	assert.equal(validateRemoteSessionHistoryPath("/home/dev/a.jsonl"), "/home/dev/a.jsonl");
	for (const bad of ["relative/a.jsonl", "/a/", "/a'; rm -rf /; echo '.jsonl", `${`/a/${"x".repeat(5000)}`}`]) {
		assert.equal(validateRemoteSessionHistoryPath(bad), undefined, `expected rejection: ${bad}`);
	}
	assert.throws(() => buildRemoteSessionWindowCommand({ remotePath: "/a'; rm -rf /.jsonl", windowBytes: 10, nonce: "abc12345abc12345" }), /REMOTE_SESSION_HISTORY_PATH_INVALID/);
});

test("only already-canonical absolute paths are accepted (F6: no empty/./.. segments, no duplicate separators)", () => {
	// 审查探针：旧实现原样接受它，认为「反正远端 shell 会解析」。路径权威必须自己拒绝。
	assert.equal(validateRemoteSessionHistoryPath("/home/u/.pi/agent/sessions/../../../etc/passwd"), undefined);
	assert.equal(validateRemoteSessionHistoryPath("/home/u/.pi/agent/sessions/../x.jsonl"), undefined);
	// 其余非规范形式：重复分隔符、空段、当前目录段、尾斜杠、根、控制字符/单引号（原有判据）。
	for (const bad of ["//home/u/a.jsonl", "/home//u/a.jsonl", "/home/u/./a.jsonl", "/home/u/a.jsonl/.", "/home/u/a.jsonl/..", "/home/u/a.jsonl//", "/", "/home/u/\n.jsonl", "/home/u/it's.jsonl"]) assert.equal(validateRemoteSessionHistoryPath(bad), undefined, `expected rejection: ${JSON.stringify(bad)}`);
	// 合法形状保持不变：普通文件、隐藏目录、名字里带点、深路径。
	for (const good of ["/a", "/home/dev/a.jsonl", "/home/dev/.pi/agent/sessions/encoded-cwd/2026_x.jsonl", "/home/dev/a.b.c", "/x/.hidden/y"]) assert.equal(validateRemoteSessionHistoryPath(good), good);
	// 读写命令的构造期同样拒绝，且一个远端命令都不发：判据是同一实现，不存在第二套「宽松入口」。
	assert.throws(() => buildRemoteSessionWindowCommand({ remotePath: "/home/dev/.pi/../etc/passwd", windowBytes: 10, nonce: "abc12345abc12345" }), /REMOTE_SESSION_HISTORY_PATH_INVALID/);
	assert.equal(joinRemoteSessionRoot("/home/dev/.pi/agent/sessions", "/home/dev/elsewhere.jsonl"), undefined);
	assert.equal(joinRemoteSessionRoot("/home/dev//agent/sessions", "a.jsonl"), undefined);
	assert.equal(joinRemoteSessionRoot("/home/dev/.pi/agent/sessions", "./a.jsonl"), undefined);
	assert.equal(joinRemoteSessionRoot("/home/dev/.pi/agent/sessions", "a/../b.jsonl"), undefined);
});

test("a relative remote identity is joined onto the resolved session root, never guessed", () => {
	assert.equal(joinRemoteSessionRoot("/home/dev/.pi/agent/sessions", "encoded-cwd/2026_x.jsonl"), "/home/dev/.pi/agent/sessions/encoded-cwd/2026_x.jsonl");
	assert.equal(joinRemoteSessionRoot("/home/dev/.pi/agent/sessions", "../escape.jsonl"), undefined);
	assert.equal(joinRemoteSessionRoot("/home/dev/.pi/agent/sessions", "a\\b.jsonl"), undefined);
});

test("a non-empty page carries an indexVersion so the disk page survives the runtime handoff", async () => {
	// 没有这个字段，渲染层把磁盘页转成历史前缀时会因「无法证明同代」整段丢弃：
	// 远端会话被运行时接管后只剩窗口段（用户实拍：重开只看得到最后一条消息）。
	const remote = fakeRemote(conversation(40));
	const page = await reader(remote, { windowBytes: 400 }).readPage({ hostId: HOST_ID, locator: sshLocator("/s/a.jsonl") });
	assert.match(page.indexVersion, /^remote:\d+$/);
	assert.equal(page.indexVersion, `remote:${remote.bytes.length}`);
});

test("the tail window reaches EOF, drops the half line at its start and reports the earlier cursor", async () => {
	const remote = fakeRemote(conversation(40));
	const page = await reader(remote, { windowBytes: 400 }).readPage({ hostId: HOST_ID, locator: sshLocator("/s/a.jsonl") });
	const [leading, ...rest] = remote.bytes
		.subarray(Math.max(0, remote.bytes.length - 400))
		.toString("utf8")
		.split("\n");
	assert.ok(page.messages.length > 0);
	// 首行是半截（窗口起点落在行中间）：它既不在当页，游标也指向它的起点（下一页从这里往前读）。
	assert.equal(page.nextBefore, remote.bytes.length - 400 + Buffer.byteLength(`${leading}\n`, "utf8") + 1);
	assert.equal(texts(page).at(-1), "answer-39");
	assert.equal(page.total, page.messages.length);
	assert.ok(rest.length > 0);
});

test("paging backwards keeps every turn exactly once and stops at the file head", async () => {
	const remote = fakeRemote(conversation(40));
	const pageReader = reader(remote, { windowBytes: 256 });
	const collected = [];
	let before;
	for (let guard = 0; guard < 40; guard += 1) {
		const page = await pageReader.readPage({ hostId: HOST_ID, locator: sshLocator("/s/a.jsonl"), before });
		collected.unshift(...texts(page));
		if (page.nextBefore === null) break;
		assert.ok(before === undefined || page.nextBefore < before, "cursor must move towards the file head");
		before = page.nextBefore;
	}
	// 40 轮全部取到，且顺序与文件一致（没有丢页、没有重复展示同一条消息）。
	const expected = [];
	for (let index = 0; index < 40; index += 1) expected.push(`question-${index}`, `answer-${index}`);
	assert.deepEqual(collected, expected);
	// 命令里出现的数字只有窗口上界与由游标推出的窗口长度：两者都必须 ≤ 端口上界。
	const requested = [...remote.commands.join("\n").matchAll(/tail -c (\d+) --|head -c (\d+)/g)].map((match) => Number(match[1] ?? match[2]));
	assert.ok(requested.length >= 2);
	assert.ok(
		requested.every((value) => value <= 256),
		`bounded requests only: ${requested.join(",")}`,
	);
});

test("an empty file and a single line both produce an honest page", async () => {
	const empty = await reader(fakeRemote("")).readPage({ hostId: HOST_ID, locator: sshLocator("/s/empty.jsonl") });
	assert.deepEqual(plain(empty), { messages: [], total: 0, nextBefore: null });
	const single = await reader(fakeRemote(line("u0", null, "user", "only"))).readPage({ hostId: HOST_ID, locator: sshLocator("/s/one.jsonl") });
	assert.deepEqual(texts(single), ["only"]);
	assert.equal(single.nextBefore, null);
});

test("a line longer than the whole window cannot be shown and does not loop", async () => {
	const huge = `${JSON.stringify({ id: "u0", parentId: null, type: "message", message: { role: "user", content: "x".repeat(2000) } })}\n`;
	const remote = fakeRemote(`${conversation(1)}${huge}`);
	const page = await reader(remote, { windowBytes: 128 }).readPage({ hostId: HOST_ID, locator: sshLocator("/s/huge.jsonl") });
	assert.deepEqual(texts(page), []);
	// 不返回游标：否则渲染层的「加载更早」会反复点出空页。
	assert.equal(page.nextBefore, null);
});

test("corrupt and non-JSON lines are skipped fail-soft while the page still returns its messages", async () => {
	const warnings = [];
	// 三种坏行：截断的 JSON、根本不是 JSON、合法 JSON 但没有 id。
	const broken = '{"id":"broken","parentId":"u0","type":"message","message":{"role":"assistant"}\nnot-json\n{"parentId":null}\n';
	const content = `${line("u0", null, "user", "kept-before")}${broken}${line("a0", "u0", "assistant", "kept-after")}`;
	const page = await reader(fakeRemote(content), { logger: { warn: (message, details) => warnings.push({ message, details }) } }).readPage({ hostId: HOST_ID, locator: sshLocator("/s/broken.jsonl") });
	assert.deepEqual(texts(page), ["kept-before", "kept-after"]);
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].details.corruptLines, 3);
	// 日志里只有身份与计数，没有远端路径/命令/正文。
	assert.equal(JSON.stringify(warnings[0]).includes("/s/broken.jsonl"), false);
});

test("invalid UTF-8 bytes fail soft in the affected line only", async () => {
	// 坏字节落在 JSON 的**值位置**上（解码成替换字符后这里不再是合法 JSON）：
	// 该行整行跳过，页面继续返回后面的完整行——fail-soft，不是整页失败。
	const head = Buffer.from('{"id":"u0","parentId":null,"type":"message","message":{"role":"user","content":', "utf8");
	const bad = Buffer.concat([head, Buffer.from([0xc3, 0x28, 0xff]), Buffer.from("}}\n", "utf8")]);
	const content = Buffer.concat([bad, Buffer.from(line("a0", "u0", "assistant", "still-here"), "utf8")]);
	const page = await reader(fakeRemote(content)).readPage({ hostId: HOST_ID, locator: sshLocator("/s/utf8.jsonl") });
	assert.deepEqual(texts(page), ["still-here"]);
});

test("transport failure, non-zero exit, missing marker and bad metadata become stable codes", async () => {
	const passingThrough = createRemoteSessionHistoryReader({ transport: { readRemoteWindow: async () => Promise.reject(new Error("SSH_HOST_NOT_READY")) }, project: fakeProject });
	await assert.rejects(passingThrough.readPage({ hostId: HOST_ID, locator: sshLocator("/s/a.jsonl") }), /^Error: SSH_HOST_NOT_READY$/);
	const unknown = createRemoteSessionHistoryReader({
		transport: {
			readRemoteWindow: async () => {
				throw { message: "spawn /usr/bin/ssh ENOENT" };
			},
		},
		project: fakeProject,
	});
	await assert.rejects(unknown.readPage({ hostId: HOST_ID, locator: sshLocator("/s/a.jsonl") }), new RegExp(REMOTE_SESSION_HISTORY_CODES.transportFailed));
	const exitCode = createRemoteSessionHistoryReader({ transport: { readRemoteWindow: async () => ({ exitCode: 1, stdout: "" }) }, project: fakeProject });
	await assert.rejects(exitCode.readPage({ hostId: HOST_ID, locator: sshLocator("/s/a.jsonl") }), new RegExp(REMOTE_SESSION_HISTORY_CODES.commandFailed));
	const noiseOnly = createRemoteSessionHistoryReader({ transport: { readRemoteWindow: async () => ({ exitCode: 0, stdout: "Welcome to the host!\n" }) }, project: fakeProject });
	await assert.rejects(noiseOnly.readPage({ hostId: HOST_ID, locator: sshLocator("/s/a.jsonl") }), new RegExp(REMOTE_SESSION_HISTORY_CODES.markerMissing));
	// 元数据只能是形状一里标记后的第一行（`wc -c` 的文件大小）：解析不出来即 fail-closed。
	assert.throws(() => parseRemoteSessionWindow(`${remoteSessionHistoryMarker("1".repeat(32))}not-a-number\nx`, { marker: remoteSessionHistoryMarker("1".repeat(32)), windowBytes: 64 }), new RegExp(REMOTE_SESSION_HISTORY_CODES.metadataInvalid));
});

test("identity is validated before any command leaves the process", async () => {
	const remote = fakeRemote(conversation(2));
	const pageReader = reader(remote);
	await assert.rejects(pageReader.readPage({ hostId: "not-a-uuid", locator: sshLocator("/s/a.jsonl") }), new RegExp(REMOTE_SESSION_HISTORY_CODES.hostIdInvalid));
	await assert.rejects(pageReader.readPage({ hostId: HOST_ID, locator: { kind: "ssh", hostId: HOST_ID, remotePath: "relative.jsonl" } }), new RegExp(REMOTE_SESSION_HISTORY_CODES.pathUnresolved));
	assert.equal(remote.commands.length, 0);
});

test("a relative locator is resolved through the shared session root port", async () => {
	const remote = fakeRemote(conversation(2));
	const roots = [];
	const pageReader = reader(remote, {
		resolveSessionRoot: async (hostId) => {
			roots.push(hostId);
			return { ok: true, root: "/home/dev/.pi/agent/sessions" };
		},
	});
	const page = await pageReader.readPage({ hostId: HOST_ID, locator: sshLocator(undefined, "encoded-cwd/2026_x.jsonl") });
	assert.deepEqual(plain(roots), [HOST_ID]);
	assert.match(remote.commands[0], /'\/home\/dev\/\.pi\/agent\/sessions\/encoded-cwd\/2026_x\.jsonl'/);
	assert.deepEqual(texts(page), ["question-0", "answer-0", "question-1", "answer-1"]);
	// 根解析失败是稳定码，并且**没有**发生任何读取。
	const commandsBefore = remote.commands.length;
	const failing = reader(remote, { resolveSessionRoot: async () => ({ ok: false, code: "REMOTE_SESSION_SESSION_DIR_INVALID" }) });
	await assert.rejects(failing.readPage({ hostId: HOST_ID, locator: sshLocator(undefined, "encoded-cwd/2026_x.jsonl") }), /REMOTE_SESSION_SESSION_DIR_INVALID/);
	assert.equal(remote.commands.length, commandsBefore);
});

test("only entries that are on the window's parent chain are projected", async () => {
	// 一条被 rewind 甩掉的分支：文件里存在，但活动链（leaf = a1）走不到它。
	const content = `${line("u0", null, "user", "first")}${line("a0", "u0", "assistant", "answer")}${line("x0", "u0", "user", "rewound-away")}${line("u1", "a0", "user", "second")}${line("a1", "u1", "assistant", "answer2")}`;
	let projectedEntryIds;
	const page = await reader(fakeRemote(content), {
		project: (rawMessages, activeEntryIds) => {
			projectedEntryIds = activeEntryIds;
			return fakeProject(rawMessages, activeEntryIds);
		},
	}).readPage({ hostId: HOST_ID, locator: sshLocator("/s/branch.jsonl") });
	assert.deepEqual(texts(page), ["first", "answer", "second", "answer2"]);
	assert.deepEqual(plain(projectedEntryIds), ["u0", "a0", "u1", "a1"]);
});

test("the window parser drops exactly the truncated line on each side", () => {
	const marker = remoteSessionHistoryMarker("abc12345abc12345");
	// 起点在行中间 + 终点被截断：两侧各丢一行，中间三行完整。
	const window = parseRemoteSessionWindow(`${marker}alf\r\nb\nc\nd\ne-partial`, { marker, windowBytes: 64, knownEnd: 100 });
	assert.deepEqual(plain(window.lines.map((entry) => entry.text)), ["b", "c", "d"]);
	assert.equal(window.droppedLeadingPartial, true);
	assert.equal(window.droppedTrailingPartial, true);
	// 读到文件尾（形状一）：尾行即使没有换行也是完整的；窗口贴到文件头时没有更早游标。
	const eof = parseRemoteSessionWindow(`${marker}a\nb`, { marker, windowBytes: 64, knownSize: 3 });
	assert.deepEqual(plain(eof.lines.map((entry) => entry.text)), ["a", "b"]);
	assert.equal(eof.nextBefore, undefined);
	// 结束了整行（以自己的换行结尾）的窗口：尾行是完整的，不能当成半行丢掉。
	const ended = parseRemoteSessionWindow(`${marker}a\nb\n`, { marker, windowBytes: 64, knownEnd: 12 });
	assert.deepEqual(plain(ended.lines.map((entry) => entry.text)), ["a", "b"]);
	assert.equal(ended.droppedTrailingPartial, false);
});

test("wiring: the message-page path routes ssh locators to the remote reader", () => {
	const ipc = sessionIpcSource;
	const assembly = mainIpcSource;
	const manager = agentManagerSource;
	// 读消息页的 handler 必须先按 locator 分流，且远端口缺失时按稳定码拒绝（绝不落回本机读空页）。
	assert.match(ipc, /sessionsCatalogReadMessagePage[\s\S]{0,4000}?locator\?\.kind === "ssh"[\s\S]{0,600}?REMOTE_SESSION_HISTORY_UNAVAILABLE/);
	assert.match(assembly, /readRemoteSessionHistoryPage,/);
	assert.match(assembly, /createRemoteSessionHistoryReader\(\{/);
	assert.match(manager, /projectRemoteHistoryMessages\(/);
});

test("a cursor at the first byte is answered locally instead of asking the remote", async () => {
	const remote = fakeRemote(conversation(2));
	const page = await reader(remote).readPage({ hostId: HOST_ID, locator: sshLocator("/s/a.jsonl"), before: 1 });
	assert.deepEqual(plain(page), { messages: [], total: 0, nextBefore: null });
	assert.equal(remote.commands.length, 0);
});
