import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * R1a：扫描、会话根解析、标题解析、登记**都不再抢 helper 的 root**。
 *
 * 背景（docs/remote-file-tree-and-git-unification-plan.md §1.2.1）：helper 一个 host 只有一个活动 root，
 * 借 `withProjectSession(会话根, …)` 读列表会 discard + 重建会话，用户的文件树/Git 因此被踢下线再连回来
 * （侧栏标题是进视口就按需取的，所以标题那条路也必须一起搬走，否则症状只是换了个触发点）。
 *
 * 这里的假远端是**按真实 shell 语义执行**那四条命令的内存实现（目录列表 / 批量描述 / 有界头读 / 有界窗口读），
 * 所以测到的是「命令形状 + 输出解析 + 结果语义」，而不是把 mock 返回的现成对象喂进去。
 */

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const HOME = "/home/dev";
const AGENT_DIR = HOME + "/.pi/agent";
const SESSION_ROOT = AGENT_DIR + "/sessions";

const { createRemoteSessionScanner } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");
const { REMOTE_SESSION_SCAN_SOURCE_CODES } = loadTsCommonJs("src/main/sessions/RemoteSessionScanSource.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

/** 一个远端普通文件节点（`bytes` 由内容长度给出，与真实 fs 一致）。 */
function fileNode(content, mtimeMs) {
	return { kind: "file", content: Buffer.isBuffer(content) ? content : Buffer.from(content), mtimeMs };
}

/** 远端目录树：绝对路径 → { kind, content?, mtimeMs? }。 */
function remoteTree(extra = {}) {
	const tree = new Map([
		[HOME, { kind: "directory" }],
		[AGENT_DIR, { kind: "directory" }],
		[SESSION_ROOT, { kind: "directory" }],
		[SESSION_ROOT + "/-srv-app-", { kind: "directory" }],
		[SESSION_ROOT + "/.pideck-archive", { kind: "directory" }],
		[SESSION_ROOT + "/-srv-app-/2026-02-03T10-00-00_abc.jsonl", fileNode("x".repeat(100), 1_700_000_000_000)],
		[SESSION_ROOT + "/root-level.jsonl", fileNode("root".repeat(2), 1_700_000_100_000)],
		[SESSION_ROOT + "/notes.txt", fileNode("abc", 1_700_000_200_000)],
	]);
	for (const [path, node] of Object.entries(extra)) tree.set(path, node);
	return tree;
}

/** 直接子项（名字 → 节点），顺序按插入序（真实 shell 的 glob 顺序由 locale 决定，来源侧会自己排序）。 */
function childrenOf(tree, directory) {
	const prefix = directory === "/" ? "/" : directory + "/";
	const children = [];
	for (const [path, node] of tree) {
		if (!path.startsWith(prefix)) continue;
		const name = path.slice(prefix.length);
		if (name.length === 0 || name.includes("/")) continue;
		children.push({ name, node });
	}
	return children;
}

function base64(bytes) {
	return Buffer.from(bytes).toString("base64");
}

/**
 * 一次性命令的假远端：按命令形状执行，不认的形状返回空输出（来源侧必须把它折成稳定码）。
 * 四种形状与 `RemoteSessionScanSource` 的构建器一一对应；退出码与生产约定一致
 * （6 = 不存在，5 = 不是普通文件，3 = 目录不可用，4 = 描述失败）。
 */
function commandRemote(tree, overrides = {}) {
	const commands = [];
	const transport = {
		async runRemoteCommand({ remoteCommand }) {
			commands.push(remoteCommand);
			if (overrides.runRemoteCommand) {
				const answer = overrides.runRemoteCommand(remoteCommand);
				if (answer) return answer;
			}
			const marker = /PIDECK_SCAN_[a-f0-9]{32}/.exec(remoteCommand)?.[0];
			if (marker === undefined) return { exitCode: 0, stdout: "" };
			// 有界窗口读：`<存在性校验>; printf '<marker>'; wc -c < '<p>'; tail -c +<start> -- '<p>' | head -c <n> | base64`
			if (remoteCommand.includes("tail -c +")) {
				const path = /^if \[ ! -e '([^']+)' \]/.exec(remoteCommand)?.[1];
				const start = Number(/tail -c \+(\d+)/.exec(remoteCommand)?.[1]);
				const maxBytes = Number(/head -c (\d+)/.exec(remoteCommand)?.[1]);
				const node = path === undefined ? undefined : tree.get(path);
				if (node === undefined) return { exitCode: 6, stdout: "" };
				if (node.kind !== "file") return { exitCode: 5, stdout: "" };
				const slice = node.content.subarray(start - 1, start - 1 + maxBytes);
				return { exitCode: 0, stdout: marker + String(node.content.length) + "\n" + base64(slice) };
			}
			// 有界头读：`<存在性校验>; printf '<marker>'; wc -c < '<p>'; head -c <n> -- '<p>' | base64`
			if (remoteCommand.includes("head -c")) {
				const path = /^if \[ ! -e '([^']+)' \]/.exec(remoteCommand)?.[1];
				const maxBytes = Number(/head -c (\d+)/.exec(remoteCommand)?.[1]);
				const node = path === undefined ? undefined : tree.get(path);
				if (node === undefined) return { exitCode: 6, stdout: "" };
				if (node.kind !== "file") return { exitCode: 5, stdout: "" };
				return { exitCode: 0, stdout: marker + String(node.content.length) + "\n" + base64(node.content.subarray(0, maxBytes)) };
			}
			// 目录列表：`cd <dir> || exit 3; printf '<marker>'; for entry in ...`
			if (remoteCommand.startsWith("cd ")) {
				const directory = /^cd '([^']+)' \|\| exit 3;/.exec(remoteCommand)?.[1];
				const node = directory === undefined ? undefined : tree.get(directory);
				if (node === undefined || node.kind !== "directory") return { exitCode: 3, stdout: "" };
				let stdout = marker;
				for (const child of childrenOf(tree, directory)) {
					const flag = child.node.kind === "directory" ? "D" : child.node.kind === "file" ? "F" : "O";
					stdout += flag + "\u0000" + child.name + "\u0000";
				}
				return { exitCode: 0, stdout };
			}
			// 批量描述：`printf '<marker>'; for f in '<p1>' '<p2>'; ...`
			if (remoteCommand.includes("for f in ")) {
				const block = /for f in (.+?); do/.exec(remoteCommand)?.[1] ?? "";
				const paths = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
				let stdout = marker;
				for (const path of paths) {
					const node = tree.get(path);
					if (node === undefined) {
						stdout += "X\u0000";
					} else if (node.kind === "directory") {
						stdout += "D\u0000";
					} else {
						// 生产用 `stat -c %Y`（秒）：mtimeMs 因此是秒×1000。
						stdout += "F\u0000" + String(node.content.length) + "\u0000" + String(Math.floor(node.mtimeMs / 1000)) + "\u0000";
					}
				}
				return { exitCode: 0, stdout };
			}
			return { exitCode: 0, stdout: "" };
		},
	};
	return { transport, commands };
}

/** helper 会话的假远端（旧路径）：只认识 fs.list / fs.statMany / fs.stat / fs.read。 */
function helperRemote(tree) {
	const calls = { withProjectSession: 0, sessionRequests: 0 };
	const port = {
		async remoteHome() {
			return HOME;
		},
		async withProjectSession(hostId, root, task) {
			calls.withProjectSession += 1;
			const absolute = (path) => (path === "." ? root : root + "/" + path);
			const session = {
				async request(method, params) {
					calls.sessionRequests += 1;
					/** 绝对路径 → helper 的 `{kind, bytes, mtimeMs}`（目录/链接不报字节，与契约一致）。 */
					const describe = (relative) => {
						const node = tree.get(absolute(relative));
						if (node === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
						return node.kind === "file" ? { kind: "file", bytes: node.content.length, mtimeMs: node.mtimeMs } : { kind: node.kind, bytes: 0, mtimeMs: 0 };
					};
					if (method === "fs.statMany") return { entries: params.paths.map((relative) => ({ path: relative, ...describe(relative) })) };
					if (method === "fs.stat") return describe(params.path);
					if (method === "fs.list") {
						const node = tree.get(absolute(params.path));
						if (node === undefined || node.kind !== "directory") throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
						return {
							entries: childrenOf(tree, absolute(params.path)).map((child) => (child.node.kind === "file" ? { name: child.name, kind: "file", bytes: child.node.content.length } : { name: child.name, kind: child.node.kind })),
						};
					}
					if (method === "fs.read") {
						const node = tree.get(absolute(params.path));
						if (node === undefined || node.kind !== "file") throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
						const chunk = node.content.subarray(params.offset, params.offset + params.bytes);
						return { chunk: base64(chunk), bytes: chunk.length, eof: params.offset + chunk.length >= node.content.length };
					}
					throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
				},
				async cancel() {
					return { cancelled: true };
				},
			};
			return { ok: true, value: await task(session) };
		},
	};
	return { port, calls };
}

test("扫描会话列表走一次性命令：与 helper 路径结果逐字一致，且 withProjectSession 零调用", async () => {
	const tree = remoteTree();
	const helper = helperRemote(tree);
	const viaHelper = await createRemoteSessionScanner({ port: helper.port }).scan(HOST);
	assert.equal(viaHelper.ok, true, JSON.stringify(viaHelper));
	assert.equal(helper.calls.withProjectSession, 2, "旧路径：配置探测 + 会话列表各建一次会话（这就是要消掉的 root 切换）");

	const command = commandRemote(tree);
	const viaCommand = await createRemoteSessionScanner({ port: helper.port, transport: command.transport }).scan(HOST);
	assert.equal(viaCommand.ok, true, JSON.stringify(viaCommand));
	assert.deepEqual(plain(viaCommand), plain(viaHelper), "同一棵远端树的两次扫描结果必须逐字可比");
	assert.equal(helper.calls.withProjectSession, 2, "注入 transport 后扫描不得再借 helper 会话（root 不被切走）");
	// 命令形状：配置探测（settings.json 不存在 ⇒ 直接 exit 6）+ 根列表 + 两个工作区目录列表 + 一批描述。
	assert.equal(command.commands.filter((line) => line.includes("head -c")).length, 1);
	assert.equal(command.commands.filter((line) => line.startsWith("cd ")).length, 2);
	assert.equal(command.commands.filter((line) => line.includes("for f in ")).length, 1);
});

test("会话根解析也走一次性命令：settings.json 的 sessionDir 生效，且不切 root", async () => {
	const settings = Buffer.from(JSON.stringify({ sessionDir: HOME + "/my-sessions" }), "utf8");
	const tree = remoteTree({
		[AGENT_DIR + "/settings.json"]: fileNode(settings, 1_700_000_300_000),
		[HOME + "/my-sessions"]: { kind: "directory" },
		[HOME + "/my-sessions/custom.jsonl"]: fileNode("x".repeat(12), 1_700_000_400_000),
	});
	const command = commandRemote(tree);
	const helper = helperRemote(tree);
	const resolved = await createRemoteSessionScanner({ port: helper.port, transport: command.transport }).resolveSessionRoot(HOST);
	assert.deepEqual(plain(resolved), { ok: true, root: HOME + "/my-sessions" });
	assert.equal(helper.calls.withProjectSession, 0, "根解析不得再借 helper 会话");

	const scanned = await createRemoteSessionScanner({ port: helper.port, transport: command.transport }).scan(HOST);
	assert.equal(scanned.ok, true, JSON.stringify(scanned));
	assert.deepEqual(
		plain(scanned.entries).map((entry) => entry.remoteSessionId),
		["custom.jsonl"],
	);
	assert.equal(helper.calls.withProjectSession, 0);
});

test("标题解析走一次性命令：小文件只读头，结果与 helper 路径一致且不切 root", async () => {
	const tree = remoteTree({
		[SESSION_ROOT + "/named.jsonl"]: fileNode(`{"type":"session_info","name":"Refactor the parser"}\n`, 1_700_000_000_000),
	});
	const helper = helperRemote(tree);
	const expected = await createRemoteSessionScanner({ port: helper.port }).title({ hostId: HOST, remoteSessionId: "named.jsonl" });
	assert.deepEqual(plain(expected), { ok: true, title: "Refactor the parser", titleOrigin: "authoritative" });
	const helperCalls = helper.calls.withProjectSession;
	assert.equal(helperCalls, 2, "旧路径：配置探测 + 标题读取各一次会话（= 两次 root 切换）");

	const command = commandRemote(tree);
	const actual = await createRemoteSessionScanner({ port: helper.port, transport: command.transport }).title({ hostId: HOST, remoteSessionId: "named.jsonl" });
	assert.deepEqual(plain(actual), plain(expected));
	assert.equal(helper.calls.withProjectSession, helperCalls, "title 不得再借 helper 会话");
	// 头内已有权威名 ⇒ 只发一次头读，不补尾窗（配置探测也是头读，按路径区分）。
	const titleCommands = command.commands.filter((line) => line.includes("named.jsonl"));
	assert.equal(titleCommands.length, 1);
	assert.equal(titleCommands.filter((line) => line.includes("tail -c +")).length, 0);
});

test("标题解析：权威名在文件尾时补一次有界尾窗，两段与 helper 路径一致", async () => {
	// 200 KiB 填充 + 尾部的 session_info：头窗（64 KiB）里没有名字，必须读尾窗才拿得到。
	const content = Buffer.concat([Buffer.alloc(200 * 1024, 0x20), Buffer.from(`\n${JSON.stringify({ type: "session_info", name: "Tail name" })}\n`)]);
	const tree = remoteTree({ [SESSION_ROOT + "/big.jsonl"]: fileNode(content, 1_700_000_000_000) });
	const helper = helperRemote(tree);
	const expected = await createRemoteSessionScanner({ port: helper.port }).title({ hostId: HOST, remoteSessionId: "big.jsonl" });
	assert.deepEqual(plain(expected), { ok: true, title: "Tail name", titleOrigin: "authoritative" });
	const helperCalls = helper.calls.withProjectSession;

	const command = commandRemote(tree);
	const actual = await createRemoteSessionScanner({ port: helper.port, transport: command.transport }).title({ hostId: HOST, remoteSessionId: "big.jsonl" });
	assert.deepEqual(plain(actual), plain(expected));
	assert.equal(helper.calls.withProjectSession, helperCalls);
	// 头读 + 尾窗读各一条（配置探测与本次文件无关，按路径区分），尾窗贴住文件尾、两段都 ≤64 KiB。
	const titleCommands = command.commands.filter((line) => line.includes("big.jsonl"));
	const heads = titleCommands.filter((line) => line.includes("head -c") && !line.includes("tail -c +"));
	const windows = titleCommands.filter((line) => line.includes("tail -c +"));
	assert.equal(heads.length, 1);
	assert.equal(windows.length, 1);
	const start = Number(/tail -c \+(\d+)/.exec(windows[0])?.[1]);
	assert.equal(start - 1, content.length - 64 * 1024, "尾窗起点贴住文件尾");
	assert.ok(Number(/head -c (\d+)/.exec(windows[0])?.[1]) <= 64 * 1024);
});

test("登记走一次性命令：仍先确认文件存在，失败码与 helper 通道逐字一致，且不切 root", async () => {
	const tree = remoteTree({ [SESSION_ROOT + "/importme.jsonl"]: fileNode("x".repeat(30), 1_700_000_500_000) });
	const ensured = [];
	const catalog = {
		async ensureRemoteSession(input) {
			ensured.push(input);
			return { record: { id: "stable-1" }, created: true };
		},
	};
	const helper = helperRemote(tree);
	const command = commandRemote(tree);
	const scanner = createRemoteSessionScanner({ port: helper.port, transport: command.transport, catalog, projectIdForHost: () => "p-1" });
	const registered = await scanner.register({ hostId: HOST, remoteSessionId: "importme.jsonl" });
	assert.equal(registered.ok, true, JSON.stringify(registered));
	assert.deepEqual(plain(ensured[0]), { projectId: "p-1", hostId: HOST, remoteSessionId: "importme.jsonl", remotePath: "/home/dev/.pi/agent/sessions/importme.jsonl", title: "importme", updatedAt: 1_700_000_500_000 });
	assert.equal(helper.calls.withProjectSession, 0, "登记不得再借 helper 会话");

	// 路径已消失 ⇒ PATH_NOT_FOUND；存在的非普通文件 ⇒ NOT_A_FILE（与 helper 通道同一词汇）。
	assert.deepEqual(plain(await scanner.register({ hostId: HOST, remoteSessionId: "gone.jsonl" })), { ok: false, code: "PATH_NOT_FOUND" });
	assert.deepEqual(plain(await scanner.register({ hostId: HOST, remoteSessionId: "-srv-app-" })), { ok: false, code: "REMOTE_SESSION_ID_INVALID" });
	assert.equal(helper.calls.withProjectSession, 0);
});

test("命令源的失败折叠成闭集稳定码，且不退回 helper 会话", async () => {
	const tree = remoteTree();
	const cases = [
		[async () => ({ exitCode: 3, stdout: "" }), REMOTE_SESSION_SCAN_SOURCE_CODES.commandFailed],
		[async () => ({ exitCode: 0, stdout: "PIDECK_SCAN_" + "0".repeat(32) + "PIDECK_SCAN_" + "0".repeat(32) }), REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid],
		[async () => ({ exitCode: 0, stdout: "" }), REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid],
	];
	for (const [runRemoteCommand, expected] of cases) {
		const helper = helperRemote(tree);
		const result = await createRemoteSessionScanner({ port: helper.port, transport: { runRemoteCommand } }).scan(HOST);
		assert.deepEqual(plain(result), { ok: false, code: expected }, String(expected));
		assert.equal(helper.calls.withProjectSession, 0, "失败也不许退回 helper 会话（那会重新切 root）");
	}
	// 传输层自己的稳定码原样转述（与 helper 路径同口径）。
	const failing = async () => {
		throw new Error("SSH_HOST_NOT_READY");
	};
	const helper = helperRemote(tree);
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: helper.port, transport: { runRemoteCommand: failing } }).scan(HOST)), {
		ok: false,
		code: "SSH_HOST_NOT_READY",
	});
	assert.equal(helper.calls.withProjectSession, 0);
});

test("目录项越过上限是拒绝（不是截断）：T 标记 ⇒ LIST_LIMIT_EXCEEDED", async () => {
	const tree = remoteTree();
	const marker = (line) => /PIDECK_SCAN_[a-f0-9]{32}/.exec(line)?.[0] ?? "";
	const runRemoteCommand = async ({ remoteCommand }) => {
		// 让根列表（cd 命令）返回「到上限了」的形状：一条正常项 + T 标记。
		if (!remoteCommand.startsWith("cd ")) return { exitCode: 6, stdout: "" };
		return { exitCode: 0, stdout: marker(remoteCommand) + "F\u0000a.jsonl\u0000T\u0000" };
	};
	const helper = helperRemote(tree);
	const result = await createRemoteSessionScanner({ port: helper.port, transport: { runRemoteCommand } }).scan(HOST);
	assert.deepEqual(plain(result), { ok: false, code: REMOTE_SESSION_SCAN_SOURCE_CODES.listLimitExceeded });
	assert.equal(helper.calls.withProjectSession, 0);
});

test("输出长度必须与远端自报的大小一致：少字节/多字节都是 OUTPUT_INVALID", async () => {
	const markerOf = (line) => /PIDECK_SCAN_[a-f0-9]{32}/.exec(line)?.[0] ?? "";
	const truncated = async ({ remoteCommand }) => {
		// 配置探测 / 其它路径照常不存在，只让本次会话的头读返回「自报 100 字节却只回 2 字节」。
		if (!remoteCommand.includes("root-level.jsonl")) return { exitCode: 6, stdout: "" };
		return { exitCode: 0, stdout: markerOf(remoteCommand) + "100\n" + base64(Buffer.from("ab")) };
	};
	const result = await createRemoteSessionScanner({ port: helperRemote(remoteTree()).port, transport: { runRemoteCommand: truncated } }).title({ hostId: HOST, remoteSessionId: "root-level.jsonl" });
	assert.deepEqual(plain(result), { ok: false, code: REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid });
});

test("装配：给了不可用的 transport 就在构造期拒绝（不等到第一次扫描）", () => {
	const helper = helperRemote(remoteTree());
	for (const transport of [{}, { runRemoteCommand: 42 }, "command"]) {
		assert.throws(
			() => createRemoteSessionScanner({ port: helper.port, transport }),
			(error) => error.message === "REMOTE_SESSION_SCANNER_OPTIONS_INVALID",
			JSON.stringify(transport),
		);
	}
});
