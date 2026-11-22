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
const TAIL_SHAPE =
	/^printf '([A-Za-z0-9_]+)'; \(stat -c '%i\|%s\|%y' '([^'\\]+)' 2>\/dev\/null \|\| stat -f '%i\|%z\|%m' '([^'\\]+)'\); tail -c (\d+) -- '([^'\\]+)'; readStatus=\$\?; printf '([A-Za-z0-9_]+)_END'; \(stat -c '%i\|%s\|%y' '([^'\\]+)' 2>\/dev\/null \|\| stat -f '%i\|%z\|%m' '([^'\\]+)'\); exit "\$readStatus"$/;
const RANGE_SHAPE =
	/^printf '([A-Za-z0-9_]+)'; \(stat -c '%i\|%s\|%y' '([^'\\]+)' 2>\/dev\/null \|\| stat -f '%i\|%z\|%m' '([^'\\]+)'\); tail -c \+(\d+) -- '([^'\\]+)' \| head -c (\d+); readStatus=\$\?; printf '([A-Za-z0-9_]+)_END'; \(stat -c '%i\|%s\|%y' '([^'\\]+)' 2>\/dev\/null \|\| stat -f '%i\|%z\|%m' '([^'\\]+)'\); exit "\$readStatus"$/;

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
					const window = Number(tail[4]);
					const from = Math.max(0, bytes.length - window);
					return { exitCode: 0, stdout: `${tail[1]}42|${bytes.length}|1700000000\n${bytes.subarray(from).toString("utf8")}${tail[6]}_END42|${bytes.length}|1700000000\n` };
				}
				const range = RANGE_SHAPE.exec(remoteCommand);
				if (!range) throw new Error(`UNEXPECTED_COMMAND: ${remoteCommand}`);
				const from = Number(range[4]) - 1;
				return { exitCode: 0, stdout: `${range[1]}42|${bytes.length}|1700000000\n${bytes.subarray(from, from + Number(range[6])).toString("utf8")}${range[7]}_END42|${bytes.length}|1700000000\n` };
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
	assert.match(
		command,
		/^printf 'PIDECK_HISTORY_a1b2c3d4e5f6a7b8'; \(stat -c '%i\|%s\|%y' '\/home\/dev\/\.pi\/agent\/sessions\/a\/b\.jsonl' 2>\/dev\/null \|\| stat -f '%i\|%z\|%m' '\/home\/dev\/\.pi\/agent\/sessions\/a\/b\.jsonl'\); tail -c 4096 -- '\/home\/dev\/\.pi\/agent\/sessions\/a\/b\.jsonl'; readStatus=\$\?; printf 'PIDECK_HISTORY_a1b2c3d4e5f6a7b8_END'; \(stat -c '%i\|%s\|%y' '\/home\/dev\/\.pi\/agent\/sessions\/a\/b\.jsonl' 2>\/dev\/null \|\| stat -f '%i\|%z\|%m' '\/home\/dev\/\.pi\/agent\/sessions\/a\/b\.jsonl'\); exit "\$readStatus"$/,
	);
	assert.deepEqual(plain([...TAIL_SHAPE.exec(command)].slice(4, 5)), ["4096"]);
});

test("a cursor read asks only for the bounded range before the cursor", () => {
	const command = buildRemoteSessionWindowCommand({ remotePath: "/s/a.jsonl", windowBytes: 100, endOffset: 250, nonce: "abc12345abc12345" });
	// 组：1 marker / 2 GNU stat 路径 / 3 BSD stat 路径 / 4 start / 5 正文路径 / 6 count
	assert.deepEqual(plain([...RANGE_SHAPE.exec(command)].slice(4, 7)), ["151", "/s/a.jsonl", "100"]);
	// 起点 clamp 到 1（文件更短时不会请求负偏移）。
	const clamped = buildRemoteSessionWindowCommand({ remotePath: "/s/a.jsonl", windowBytes: 100, endOffset: 40, nonce: "abc12345abc12345" });
	assert.deepEqual(plain([...RANGE_SHAPE.exec(clamped)].slice(4, 7)), ["1", "/s/a.jsonl", "40"]);
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
	assert.match(page.indexVersion, /^remote:\d+:\d+:\d+$/);
	assert.equal(page.indexVersion, `remote:42:1700000000:${remote.bytes.length}`);
});

test("the tail page reaches EOF and reports an earlier cursor", async () => {
	const remote = fakeRemote(conversation(40));
	const page = await reader(remote, { windowBytes: 400 }).readPage({ hostId: HOST_ID, locator: sshLocator("/s/a.jsonl") });
	assert.ok(page.messages.length > 0);
	// 页边界按字节/行切分，不强行对齐轮起点（实测对不齐且要多读窗口）；最后一条必须是最新的。
	assert.equal(texts(page).at(-1), "answer-39");
	assert.equal(page.total, page.messages.length);
	// 仍给出更早游标（不是到顶）。
	assert.equal(typeof page.nextBefore, "number");
	assert.ok(page.nextBefore > 1);
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
	assert.deepEqual(plain(empty), { messages: [], total: 0, nextBefore: null, indexVersion: "remote:42:1700000000:0" });
	const single = await reader(fakeRemote(line("u0", null, "user", "only"))).readPage({ hostId: HOST_ID, locator: sshLocator("/s/one.jsonl") });
	assert.deepEqual(texts(single), ["only"]);
	assert.equal(single.nextBefore, null);
});

test("a screenshot-sized user line (one very long JSONL row) is readable within the default window", async () => {
	// 真实会话：pi 把「带截图的消息」写成**一整行** JSONL（实测 347 KiB / 681 KiB）。旧窗口 128 KiB
	// 让这一行永远读不全，而它的缺失会断开 parentId 链，把更早的历史一起锁死——用户看到的
	// 就是「往上翻翻不上去、自己发过的消息找不到」。默认窗口（1 MiB）必须能整行读出来。
	const image = "A".repeat(700 * 1024);
	const huge = `${JSON.stringify({
		id: "u1",
		parentId: "a0",
		type: "message",
		message: {
			role: "user",
			content: [
				{ type: "text", text: "规划：最小主机面板" },
				{ type: "image", data: image, mimeType: "image/png" },
			],
			timestamp: 1_700_000_000_000,
		},
	})}\n`;
	const remote = fakeRemote(`${line("u0", null, "user", "first")}${line("a0", "u0", "assistant", "ok")}${huge}${line("a1", "u1", "assistant", "after-image")}`);
	const page = await reader(remote).readPage({ hostId: HOST_ID, locator: sshLocator("/s/img.jsonl") });
	assert.deepEqual(plain(page.messages.map((message) => message.role)), ["user", "assistant", "user", "assistant"]);
	// 整份文件落在一页里：到文件头，游标为 null。
	assert.equal(page.nextBefore, null);
});

test("a row larger than the old 1 MiB bound remains on the active branch across seeded pages", async () => {
	const hugeUser = line("u1", "a0", "user", "image:" + "x".repeat(1300 * 1024));
	const afterHuge = line("a1", "u1", "assistant", "a".repeat(700 * 1024));
	const nextUser = line("u2", "a1", "user", "next:" + "u".repeat(700 * 1024));
	const latest = line("a2", "u2", "assistant", "latest:" + "z".repeat(700 * 1024));
	const remote = fakeRemote(`${line("u0", null, "user", "root")}${line("a0", "u0", "assistant", "root-answer")}${hugeUser}${afterHuge}${nextUser}${latest}`);
	const pageReader = reader(remote);
	const collected = [];
	let before;
	let beforeEntryId;
	let pages = 0;
	for (let guard = 0; guard < 8; guard += 1) {
		const page = await pageReader.readPage({
			hostId: HOST_ID,
			locator: sshLocator("/s/oversized-active-branch.jsonl"),
			...(before === undefined ? {} : { before }),
			...(beforeEntryId === undefined ? {} : { beforeEntryId }),
		});
		pages += 1;
		collected.unshift(...page.messages.map((message) => message.meta.entryId));
		if (page.nextBefore === null) break;
		before = page.nextBefore;
		beforeEntryId = page.nextBeforeEntryId;
	}
	assert.ok(hugeUser.length > 1024 * 1024, "fixture exceeds the previous production window");
	assert.ok(pages > 1, "fixture must cross a real page boundary");
	assert.deepEqual(collected, ["u0", "a0", "u1", "a1", "u2", "a2"], "all active ancestors survive the oversized row without duplicates");
});

test("a window that falls entirely inside a line longer than the page still advances", async () => {
	// 窗口比单行还小时，那一行无论如何读不全（已知取舍）。此时**不能**把「读不到行」说成
	// 「到文件头」：游标必须继续向前推进，否则更早历史永久不可达。上翻链必须收敛，不无限翻页。
	const huge = `${JSON.stringify({ id: "u3", parentId: "a2", type: "message", message: { role: "user", content: "x".repeat(4000) } })}\n`;
	const content = `${conversation(3)}${huge}${line("a3", "u3", "assistant", "tail")}`;
	const remote = fakeRemote(content);
	const pageReader = reader(remote, { windowBytes: 128 });
	const pages = [];
	let before;
	for (let guard = 0; guard < 200; guard += 1) {
		const page = await pageReader.readPage({ hostId: HOST_ID, locator: sshLocator("/s/huge.jsonl"), ...(before === undefined ? {} : { before }) });
		pages.push({ nextBefore: page.nextBefore });
		if (page.nextBefore === null) break;
		// 游标只能朝着文件头单调前进（不重复读同一页，也就不会死循环）。
		assert.ok(before === undefined || page.nextBefore < before, `cursor must advance: ${before} -> ${page.nextBefore}`);
		assert.ok(page.nextBefore >= 1);
		before = page.nextBefore;
	}
	assert.equal(pages.at(-1).nextBefore, null, "paging must converge to the file head");
	assert.ok(pages.length > 1, "an oversized line needs more than one page");
	// 读不全的那一行会造出没有内容的页：这类页必须仍然带着更早的游标（否则就是上翻死锁）。
	assert.ok(
		pages.slice(0, -1).every((page) => page.nextBefore !== null),
		"除了真正的文件头，每一页都必须能继续往前",
	);
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
	// 元数据是标记后的第一行（`inode|size|mtime`）；解析不出来即 fail-closed。
	assert.throws(() => parseRemoteSessionWindow(`${remoteSessionHistoryMarker("1".repeat(32))}42|not-a-number|1700000000\nx`, { marker: remoteSessionHistoryMarker("1".repeat(32)), windowBytes: 64 }), new RegExp(REMOTE_SESSION_HISTORY_CODES.metadataInvalid));
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

test("every page reports stable file identity, modification time, and real file size", async () => {
	// `indexVersion` 是 `remote:<inode>:<mtime>:<size>`，范围游标不得混作文件元数据。
	const remote = fakeRemote(conversation(40));
	const pageReader = reader(remote, { windowBytes: 300 });
	const versions = [];
	let before;
	for (let guard = 0; guard < 40; guard += 1) {
		const page = await pageReader.readPage({ hostId: HOST_ID, locator: sshLocator("/s/ver.jsonl"), ...(before === undefined ? {} : { before }) });
		if (page.messages.length > 0) versions.push(page.indexVersion);
		if (page.nextBefore === null) break;
		before = page.nextBefore;
	}
	assert.ok(versions.length > 1);
	assert.deepEqual([...new Set(versions)], [`remote:42:1700000000:${remote.bytes.length}`]);
});

test("replacement during a multi-window read retries once, then reports stale instead of file-head", async () => {
	const remote = fakeRemote(conversation(40));
	let identity = 0;
	const transport = {
		readRemoteWindow: async (input) => {
			const result = await remote.transport.readRemoteWindow(input);
			identity += 1;
			const shape = TAIL_SHAPE.exec(input.remoteCommand) ?? RANGE_SHAPE.exec(input.remoteCommand);
			const marker = shape?.[1];
			const suffix = `|${remote.bytes.length}|1700000000`;
			const stdout = marker ? result.stdout.replace(`${marker}_END42${suffix}`, `${marker}_END${identity}${suffix}`).replace(`${marker}42${suffix}`, `${marker}${identity}${suffix}`) : result.stdout;
			return { ...result, stdout };
		},
	};
	const pageReader = createRemoteSessionHistoryReader({ transport, project: fakeProject, windowBytes: 64 });
	await assert.rejects(pageReader.readPage({ hostId: HOST_ID, locator: sshLocator("/s/replaced.jsonl"), beforeEntryId: "missing-anchor" }), new RegExp(REMOTE_SESSION_HISTORY_CODES.stale));
	assert.ok(identity >= 2, "reader discarded the first generation and retried before returning stale");
});

test("same-size rewrite within a window retries once, then reports stale", async () => {
	const remote = fakeRemote(conversation(40));
	let attempts = 0;
	const transport = {
		readRemoteWindow: async (input) => {
			const result = await remote.transport.readRemoteWindow(input);
			attempts += 1;
			const shape = TAIL_SHAPE.exec(input.remoteCommand) ?? RANGE_SHAPE.exec(input.remoteCommand);
			const marker = shape?.[1];
			const revision = 1_700_000_000 + attempts;
			const oldMetadata = `${marker}42|${remote.bytes.length}|1700000000`;
			return { ...result, stdout: marker ? result.stdout.replace(oldMetadata, `${marker}42|${remote.bytes.length}|${revision}`) : result.stdout };
		},
	};
	const pageReader = createRemoteSessionHistoryReader({ transport, project: fakeProject, windowBytes: 64 });
	await assert.rejects(pageReader.readPage({ hostId: HOST_ID, locator: sshLocator("/s/in-place-window-rewrite.jsonl") }), new RegExp(REMOTE_SESSION_HISTORY_CODES.stale));
	assert.equal(attempts, 2, "one whole-window retry precedes the stable stale error");
});

test("an append during the tail window retries before calculating byte cursors", async () => {
	const remote = fakeRemote(conversation(4));
	let reads = 0;
	const transport = {
		readRemoteWindow: async (input) => {
			const result = await remote.transport.readRemoteWindow(input);
			reads += 1;
			if (reads !== 1) return result;
			const shape = TAIL_SHAPE.exec(input.remoteCommand);
			const marker = shape?.[1];
			const oldFooter = `${marker}_END42|${remote.bytes.length}|1700000000`;
			const newFooter = `${marker}_END42|${remote.bytes.length + 1}|1700000001`;
			return { ...result, stdout: marker ? result.stdout.replace(oldFooter, newFooter) : result.stdout };
		},
	};
	const page = await createRemoteSessionHistoryReader({ transport, project: fakeProject, windowBytes: 4096 }).readPage({ hostId: HOST_ID, locator: sshLocator("/s/appending.jsonl") });
	assert.deepEqual(texts(page), ["question-0", "answer-0", "question-1", "answer-1", "question-2", "answer-2", "question-3", "answer-3"]);
	assert.equal(page.indexVersion, `remote:42:1700000000:${remote.bytes.length}`);
	assert.equal(reads, 2, "the unstable tail read is discarded before returning a stable page");
});

test("same-size rewrite between windows retries once, then reports stale", async () => {
	const remote = fakeRemote(conversation(40));
	let revision = 0;
	const transport = {
		readRemoteWindow: async (input) => {
			const result = await remote.transport.readRemoteWindow(input);
			revision += 1;
			const shape = TAIL_SHAPE.exec(input.remoteCommand) ?? RANGE_SHAPE.exec(input.remoteCommand);
			const marker = shape?.[1];
			const oldHeader = `${marker}42|${remote.bytes.length}|1700000000`;
			const newHeader = `${marker}42|${remote.bytes.length}|${1_700_000_000 + revision}`;
			const oldFooter = `${marker}_END42|${remote.bytes.length}|1700000000`;
			const newFooter = `${marker}_END42|${remote.bytes.length}|${1_700_000_000 + revision}`;
			const stdout = marker ? result.stdout.replace(oldFooter, newFooter).replace(oldHeader, newHeader) : result.stdout;
			return { ...result, stdout };
		},
	};
	const pageReader = createRemoteSessionHistoryReader({ transport, project: fakeProject, windowBytes: 64 });
	await assert.rejects(pageReader.readPage({ hostId: HOST_ID, locator: sshLocator("/s/in-place-rewrite.jsonl"), beforeEntryId: "missing-anchor" }), new RegExp(REMOTE_SESSION_HISTORY_CODES.stale));
	assert.ok(revision >= 3, "reader discarded the first revision and retried before returning stale");
});

test("the earlier cursor carries a branch seed so the next page does not fall back to an abandoned branch", async () => {
	// 文件是 append-only 的：rewind 掉的旧分支就躺在中间。窗口尾行完全可能是旧分支条目——
	// 只拿它当叶子回溯，那一页就会把旧分支当正文（用户看到的「顺序乱、夹着别处的对话」）。
	const parts = [line("u0", null, "user", "root"), line("a0", "u0", "assistant", "root-answer"), line("x1", "a0", "user", "abandoned-question"), line("x2", "x1", "assistant", "abandoned-answer"), line("u1", "a0", "user", "current-question"), line("a1", "u1", "assistant", "current-answer")];
	const content = parts.join("");
	// 首屏窗口起点落在「活动分支第一句」这一行的中间（丢首半行是正常语义）：
	// 于是第一页只含 a1，而下一页窗口的尾行恰好是旧分支条目 x2。
	const tailStart = Buffer.byteLength(parts.slice(0, 4).join(""), "utf8") + 1 + 3;
	const windowBytes = Buffer.byteLength(content, "utf8") - tailStart + 1;
	const remote = fakeRemote(content);
	const pageReader = reader(remote, { windowBytes });
	// 沿游标往上翻：每页都把上一页的活动链种子带回去（生产的渲染层就是这么用的）。
	const pageAll = async (withSeed) => {
		const collected = [];
		let before;
		let seed;
		for (let guard = 0; guard < 10; guard += 1) {
			const page = await pageReader.readPage({
				hostId: HOST_ID,
				locator: sshLocator("/s/branch.jsonl"),
				...(before === undefined ? {} : { before }),
				...(withSeed && seed !== undefined ? { beforeEntryId: seed } : {}),
			});
			collected.unshift(...texts(page));
			if (page.nextBefore === null) break;
			before = page.nextBefore;
			seed = page.nextBeforeEntryId;
		}
		return collected;
	};
	assert.deepEqual(await pageAll(true), ["root", "root-answer", "current-question", "current-answer"]);
	// 回归钉：不带种子时，下一页会从窗口尾行（旧分支 x2）回溯，把 abandoned 内容当正文显示。
	assert.ok((await pageAll(false)).includes("abandoned-question"));
});

test("the window parser drops exactly the truncated line on each side", () => {
	const marker = remoteSessionHistoryMarker("abc12345abc12345");
	// 两种形状都带 stat 元数据：`<marker><inode>|<size>|<mtime>\n<payload>`。
	// 起点在行中间 + 终点被截断（文件比窗口大）：两侧各丢一行，中间三行完整。
	const window = parseRemoteSessionWindow(`${marker}42|120|1700000000\nalf\r\nb\nc\nd\ne-partial${marker}_END42|120|1700000000\n`, { marker, windowBytes: 64, windowEnd: 100 });
	assert.deepEqual(plain(window.lines.map((entry) => entry.text)), ["b", "c", "d"]);
	assert.equal(window.droppedLeadingPartial, true);
	assert.equal(window.droppedTrailingPartial, true);
	assert.equal(window.fileIdentity, "42");
	assert.equal(window.modifiedAt, "1700000000");
	// 读到文件尾（形状一）：尾行即使没有换行也是完整的；窗口贴到文件头时没有更早游标。
	const eof = parseRemoteSessionWindow(`${marker}42|3|1700000000\na\nb${marker}_END42|3|1700000000\n`, { marker, windowBytes: 64 });
	assert.deepEqual(plain(eof.lines.map((entry) => entry.text)), ["a", "b"]);
	assert.equal(eof.nextBefore, undefined);
	// 结束了整行（以自己的换行结尾）的窗口：尾行是完整的，不能当成半行丢掉。
	const ended = parseRemoteSessionWindow(`${marker}42|12|1700000000\na\nb\n${marker}_END42|12|1700000000\n`, { marker, windowBytes: 64, windowEnd: 4 });
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
