/**
 * 本机 → 远端文件上传（stdin 分块通道）。
 *
 * 为什么要单测：这条通道的命令行里只有元数据，字节全走 stdin —— 一旦分块/结束符/校验任一处错了，
 * 远端会写出一个"看起来成功、其实内容不对"的文件（原子 rename 只在 sha 校验通过后才发生，所以
 * 测试要同时钉住「校验前失败不留文件」这条语义）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const stubs = {
	"./RemoteBrowseRoot": { readCanonicalBrowseRoot: (value) => ({ canonicalPath: value }) },
	"./SshVerifiedConnection": { buildPinnedSshInvocation: async (_dir, _host, _kind, { remoteCommand }) => ({ executable: "ssh", args: [remoteCommand] }) },
};

const { buildRemoteProjectPutCommand, uploadRemoteProjectFile, REMOTE_PROJECT_UPLOAD_MAX_BYTES, REMOTE_PROJECT_UPLOAD_CHUNK_BYTES, REMOTE_PROJECT_UPLOAD_CODES } = loadTsCommonJs("src/main/remote/RemoteProjectFileUpload.ts", {
	stubs,
});

const ROOT = "/srv/project";
const NODE = "/usr/local/bin/node";
const NONCE = "a".repeat(32);
const SHA = "b".repeat(64);

function buildArgs(patch = {}) {
	return { nodePath: NODE, root: ROOT, relative: "docs/a.md", bytes: 10, sha256: SHA, overwrite: false, nonce: NONCE, ...patch };
}

test("命令里只有元数据，字节内容绝不进命令行", () => {
	const { command, marker } = buildRemoteProjectPutCommand(buildArgs());
	assert.match(command, /'-e'/);
	assert.match(command, /'put'/);
	assert.ok(command.includes(marker), "marker 必须出现在命令里");
	assert.match(marker, /^PIDECK_PUT_[a-f0-9]{32}$/);
	// 元数据在 argv 里（JSON），内容不在。
	assert.match(command, /"bytes":10/);
	assert.match(command, /"sha256":"b+"/);
});

test("拒绝越界/非法输入（路径、大小、nonce、解释器）", () => {
	assert.throws(() => buildRemoteProjectPutCommand(buildArgs({ relative: "" })), /REMOTE_FILE_PATH_INVALID/);
	assert.throws(() => buildRemoteProjectPutCommand(buildArgs({ relative: ".pideck-trash/x" })), /REMOTE_FILE_PROTECTED_PATH/);
	assert.throws(() => buildRemoteProjectPutCommand(buildArgs({ bytes: 0 })), /REMOTE_FILE_TOO_LARGE/);
	assert.throws(() => buildRemoteProjectPutCommand(buildArgs({ bytes: REMOTE_PROJECT_UPLOAD_MAX_BYTES + 1 })), /REMOTE_FILE_TOO_LARGE/);
	assert.throws(() => buildRemoteProjectPutCommand(buildArgs({ nonce: "zz" })), /REMOTE_FILE_INPUT_INVALID/);
	assert.throws(() => buildRemoteProjectPutCommand(buildArgs({ sha256: "nothex" })), /REMOTE_FILE_INPUT_INVALID/);
	// 解释器必须是绝对路径且以 /node 结尾：远端 pi 是 shim，裸执行会落到系统 node。
	assert.throws(() => buildRemoteProjectPutCommand(buildArgs({ nodePath: "/usr/bin/nodejs" })), /REMOTE_FILE_INPUT_INVALID/);
});

/**
 * 记录 stdin 行的假 launcher。
 *
 * **必须复刻真实 `writeStdinLine` 的判据**：含换行/NUL 的行直接抛、超过 `maxLineBytes` 抛。
 * 第一版假 launcher 只收行不校验，于是「写 base64+"
"」这种必然在生产里第一步就失败的写法
 * 也能全绿通过（真实缺陷由独立 review 抓出来）。
 */
function createLauncher(onWrite) {
	const written = [];
	let stdout;
	let exit;
	let maxLineBytes = Infinity;
	const handle = {
		pid: 1,
		onExit: (listener) => {
			exit = listener;
			return () => {};
		},
		onStdoutLine: (listener) => {
			stdout = listener;
			return () => {};
		},
		write: (line) => {
			if (typeof line !== "string" || line.includes("\0") || line.includes("\n") || line.includes("\r")) throw new Error("SSH_LAUNCHER_STDIN_LINE_INVALID");
			if (line.trim().length === 0) throw new Error("SSH_LAUNCHER_STDIN_LINE_INVALID");
			if (Buffer.byteLength(line, "utf8") > maxLineBytes) throw new Error("SSH_LAUNCHER_STDIN_LINE_TOO_LARGE");
			written.push(line);
			onWrite?.(line, written, {
				stdout: (text) => stdout?.(text),
				exit: () => exit?.(),
			});
		},
		stop: async () => {},
	};
	const requests = [];
	return {
		written,
		requests,
		launcher: {
			start: async (request) => {
				requests.push(request);
				maxLineBytes = Number.isInteger(request.maxLineBytes) ? request.maxLineBytes : Infinity;
				return handle;
			},
		},
	};
}

async function upload(patch, onWrite) {
	const harness = createLauncher(onWrite);
	const bytes = patch.bytes ?? Buffer.from("hello");
	await uploadRemoteProjectFile({
		userDataDir: "/tmp/ud",
		hostId: "11111111-1111-4111-8111-111111111111",
		generation: 3,
		nodePath: NODE,
		root: ROOT,
		relative: "a.txt",
		bytes,
		client: {},
		launcher: harness.launcher,
		nonce: NONCE,
		timeoutMs: 5_000,
	});
	return harness;
}

test("分块写入 + END 结束符，成功时收尾干净", async () => {
	const payload = Buffer.alloc(REMOTE_PROJECT_UPLOAD_CHUNK_BYTES * 2 + 7, 65);
	const harness = await upload({ bytes: payload }, (line, written, remote) => {
		if (line === "END") remote.stdout(`PIDECK_PUT_${NONCE}{"ok":true,"bytes":${payload.length}}\n`);
	});
	// 3 块 base64 + 一行 END。
	assert.equal(harness.written.length, 4);
	assert.equal(harness.written.at(-1), "END");
	// 每块都是合法 base64，且拼回去等于原字节。
	const joined = Buffer.concat(harness.written.slice(0, -1).map((line) => Buffer.from(line, "base64")));
	assert.deepEqual(joined, payload);
	// 每条 stdin 行都远小于 8 MiB 帧上限。
	for (const line of harness.written) assert.ok(line.length < 2 * 1024 * 1024, "single stdin line must stay well under the frame cap");
	assert.equal(harness.requests.length, 1);
});

test("远端报错时抛出稳定码（不把自由文本当结果）", async () => {
	const harness = createLauncher((line, written, remote) => {
		if (line === "END") remote.stdout(`PIDECK_PUT_${NONCE}{"ok":false,"code":"REMOTE_FILE_TARGET_EXISTS"}\n`);
	});
	await assert.rejects(uploadRemoteProjectFile({ userDataDir: "/tmp/ud", hostId: "11111111-1111-4111-8111-111111111111", generation: 1, nodePath: NODE, root: ROOT, relative: "a.txt", bytes: Buffer.from("x"), client: {}, launcher: harness.launcher, nonce: NONCE, timeoutMs: 5_000 }), /REMOTE_FILE_TARGET_EXISTS/);
});

test("远端给出非稳定码的自由文本时折叠成 commandFailed", async () => {
	const harness = createLauncher((line, written, remote) => {
		if (line === "END") remote.stdout(`PIDECK_PUT_${NONCE}{"ok":false,"code":"permission denied by host"}\n`);
	});
	await assert.rejects(
		uploadRemoteProjectFile({ userDataDir: "/tmp/ud", hostId: "11111111-1111-4111-8111-111111111111", generation: 1, nodePath: NODE, root: ROOT, relative: "a.txt", bytes: Buffer.from("x"), client: {}, launcher: harness.launcher, nonce: NONCE, timeoutMs: 5_000 }),
		new RegExp(REMOTE_PROJECT_UPLOAD_CODES.commandFailed),
	);
});

test("超过单文件上限时在本地就拒绝，不开 ssh", async () => {
	const harness = createLauncher();
	await assert.rejects(
		uploadRemoteProjectFile({ userDataDir: "/tmp/ud", hostId: "11111111-1111-4111-8111-111111111111", generation: 1, nodePath: NODE, root: ROOT, relative: "a.txt", bytes: Buffer.alloc(REMOTE_PROJECT_UPLOAD_MAX_BYTES + 1), client: {}, launcher: harness.launcher, nonce: NONCE, timeoutMs: 5_000 }),
		/REMOTE_FILE_TOO_LARGE/,
	);
	assert.equal(harness.requests.length, 0);
});

test("进程提前退出视为失败（不会当成功收场）", async () => {
	const harness = createLauncher((line, written, remote) => {
		if (line === "END") remote.exit();
	});
	await assert.rejects(
		uploadRemoteProjectFile({ userDataDir: "/tmp/ud", hostId: "11111111-1111-4111-8111-111111111111", generation: 1, nodePath: NODE, root: ROOT, relative: "a.txt", bytes: Buffer.from("x"), client: {}, launcher: harness.launcher, nonce: NONCE, timeoutMs: 5_000 }),
		new RegExp(REMOTE_PROJECT_UPLOAD_CODES.commandFailed),
	);
});

test("远端脚本先校验再 rename：脚本文本里同时存在临时文件与原子替换", () => {
	const source = loadTsCommonJs("src/main/remote/RemoteProjectFileUpload.ts", { stubs }).REMOTE_PROJECT_PUT_SCRIPT;
	// 临时文件 + 校验（大小与摘要）+ rename 提交，三者缺一不可。
	assert.match(source, /pideck-put/);
	assert.match(source, /args\.bytes/);
	assert.match(source, /args\.sha256/);
	assert.match(source, /fs\.renameSync\(temp, bound\.file\)/);
	// 失败路径要删临时文件。
	assert.match(source, /unlinkSync\(temp\)/);
	// 字节只从 stdin 读，不从 argv。
	assert.match(source, /fs\.readSync\(0,/);
});

test("上传/下载通道挂在项目域的传输模块上，且装配层真的注册了它", () => {
	const transfer = readFileSync("src/main/ipc/remoteProjectTransferIpc.ts", "utf8");
	assert.match(transfer, /ipcChannels\.remoteProjectUpload/);
	assert.match(transfer, /ipcChannels\.remoteProjectDownload/);
	// 读通道不许出现在传输模块里（否则就是第二套列表/读实现）。
	assert.doesNotMatch(transfer, /remoteProjectList\b/);
	const index = readFileSync("src/main/index.ts", "utf8");
	assert.match(index, /registerRemoteProjectTransferIpc\(\{/);
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	assert.match(shared, /remoteProjectUpload: "remote:project-upload"/);
	assert.match(shared, /remoteProjectDownload: "remote:project-download"/);
	// 拖放通道同样要四处同步：少一处就是运行时 undefined。
	assert.match(shared, /remoteProjectUploadPaths: "remote:project-upload-paths"/);
	assert.match(transfer, /ipcChannels\.remoteProjectUploadPaths/);
	assert.match(index, /registerRemoteProjectTransferIpc\(\{/);
	const preload = readFileSync("src/preload/index.ts", "utf8");
	for (const fn of ["uploadProjectFiles", "uploadProjectFilesFromPaths", "downloadProjectFile"]) assert.ok(preload.includes(fn + ":"), `preload 缺少 ${fn}`);
});

test("正好一个整块只写一行 base64（边界不产生空块）", async () => {
	const payload = Buffer.alloc(REMOTE_PROJECT_UPLOAD_CHUNK_BYTES, 66);
	const harness = await upload({ bytes: payload }, (line, written, remote) => {
		if (line === "END") remote.stdout(`PIDECK_PUT_${NONCE}{"ok":true,"bytes":${payload.length}}\n`);
	});
	assert.equal(harness.written.length, 2, "一块 + END");
	assert.equal(Buffer.from(harness.written[0], "base64").length, REMOTE_PROJECT_UPLOAD_CHUNK_BYTES);
});

test("overwrite 开关进命令元数据（默认 false，覆盖必须是显式动作）", () => {
	const off = buildRemoteProjectPutCommand(buildArgs()).command;
	const on = buildRemoteProjectPutCommand(buildArgs({ overwrite: true })).command;
	assert.match(off, /"overwrite":false/);
	assert.match(on, /"overwrite":true/);
});

test("空字节在本地被拒（不是远端错误）", async () => {
	await assert.rejects(uploadRemoteProjectFile({ userDataDir: "/tmp/ud", hostId: "11111111-1111-4111-8111-111111111111", generation: 1, nodePath: NODE, root: ROOT, relative: "a.txt", bytes: Buffer.alloc(0), client: {}, launcher: createLauncher().launcher, nonce: NONCE, timeoutMs: 5_000 }), /REMOTE_FILE_TOO_LARGE/);
});

test("stdin 行必须符合 launcher 契约：不含换行、且不超过 maxLineBytes", async () => {
	// 这条用例守的是真机上第一个字节就失败的那类缺陷：假 launcher 若不复刻契约，
	// 「base64 + \n」与「块大于 maxLineBytes」都会被误判为通过。
	const payload = Buffer.alloc(REMOTE_PROJECT_UPLOAD_CHUNK_BYTES * 2 + 1, 67);
	const harness = await upload({ bytes: payload }, (line, written, remote) => {
		if (line === "END") remote.stdout(`PIDECK_PUT_${NONCE}{"ok":true,"bytes":${payload.length}}\n`);
	});
	const frameCap = Math.ceil(REMOTE_PROJECT_UPLOAD_CHUNK_BYTES / 3) * 4 + 64;
	const request = harness.requests[0];
	assert.equal(request.maxLineBytes, frameCap, "maxLineBytes 必须容得下一整块 base64");
	for (const line of harness.written) {
		assert.ok(!line.includes("\n") && !line.includes("\r"), "stdin 行不得自带换行");
		assert.ok(Buffer.byteLength(line, "utf8") <= request.maxLineBytes, "每行必须在 launcher 上限内");
	}
});

test("拖放路径解析：只收本机绝对路径，任一条不合法就整批拒", () => {
	const { parseLocalUploadPaths, REMOTE_UPLOAD_MAX_FILES } = loadTsCommonJs("src/main/ipc/remoteUploadPaths.ts");
	// 合法形态：POSIX / Windows 盘符 / UNC。
	for (const paths of [["/etc/hosts"], [String.raw`C:\tmp\a.txt`], ["C:/tmp/a.txt"], [String.raw`\\server\share\x`]]) {
		const result = parseLocalUploadPaths(paths);
		assert.equal(result.ok, true, JSON.stringify(paths));
	}
	// 首尾空格是 POSIX 合法文件名的一部分：解析不得改写路径。
	// 不 trim、不改写：前导空格会让「绝对路径」判据不成立 → 拒。宁可拒也不悄悄换个路径去读。
	assert.equal(parseLocalUploadPaths([" /tmp/a "]).ok, false);
	// 非法：相对路径、空、控制字符、非字符串、超条数、空数组。
	assert.equal(parseLocalUploadPaths(["relative.txt"]).ok, false);
	assert.equal(parseLocalUploadPaths([""]).ok, false);
	assert.equal(parseLocalUploadPaths(["/tmp/a" + String.fromCharCode(0) + "b"]).ok, false);
	assert.equal(parseLocalUploadPaths([1]).ok, false);
	assert.equal(parseLocalUploadPaths([]).ok, false);
	assert.equal(parseLocalUploadPaths(Array.from({ length: REMOTE_UPLOAD_MAX_FILES + 1 }, (_, i) => `/tmp/${i}`)).ok, false);
	assert.equal(parseLocalUploadPaths(Array.from({ length: REMOTE_UPLOAD_MAX_FILES }, (_, i) => `/tmp/${i}`)).ok, true);
});

test("拖放只省掉对话框：两条通道共用同一个 uploadMany 与同一套大小门", () => {
	const source = readFileSync("src/main/ipc/remoteProjectTransferIpc.ts", "utf8");
	assert.match(source, /const uploadMany = async/);
	assert.match(source, /return await uploadMany\(target, directory, parsed\.paths\);/);
	assert.match(source, /return await uploadMany\(target, directory, choice\.filePaths\);/);
	// 条数上限在边界一次判（不再在写循环里 slice 静默截断）。
	assert.match(source, /parseLocalUploadPaths\(pathsValue\)/);
	assert.doesNotMatch(source, /localPaths\.slice\(0, 32\)/);
});

test("渲染层拖放：经 webUtils 解析本机路径，解析不出来的项不静默上传", () => {
	const hook = readFileSync("src/renderer/src/hooks/useRemoteProjectTransfer.ts", "utf8");
	// Electron 32+ 的 File 没有 path，必须走 preload 的 getPathForFile。
	assert.match(hook, /desktopApi\.files\.getPathForFile\(file\)/);
	assert.match(hook, /uploadProjectFilesFromPaths\(/);
	// dragOver 必须 preventDefault，否则 drop 根本不触发；且只认 Files。
	assert.match(hook, /onDragOver[\s\S]{0,300}?types\.includes\("Files"\)/);
	assert.match(hook, /onDragOver[\s\S]{0,400}?preventDefault\(\)/);
	// 一个可用路径都没有时给出明确文案，而不是当成「上传了 0 个」的成功。
	assert.match(hook, /dropUnsupported/);
	// 面板只接线，事件与上传逻辑都在 hook 里（否则又会把面板撑过 400 行）。
	const panel = readFileSync("src/renderer/src/components/session/RemoteProjectPanel.tsx", "utf8");
	assert.match(panel, /useRemoteProjectTransfer\(/);
	// 面板根的 drop 现在同时处理「内部移动」与「外部上传」，所以是包装函数而不是直接透传。
	assert.match(panel, /onDrop=\{\(event\) => \{/);
	assert.match(panel, /transfer\.onDrop\(event\)/);
	assert.doesNotMatch(panel, /getPathForFile/);
});

test("上传临时文件不出现在列表与搜索里（只有我们造的那个形状被隐藏）", () => {
	const { REMOTE_UPLOAD_TEMP_NAME } = loadTsCommonJs("src/main/remote/RemoteProjectFileUpload.ts", { stubs });
	assert.equal(REMOTE_UPLOAD_TEMP_NAME.test(".0123456789abcdef0123456789abcdef.pideck-put"), true);
	// 用户自己的同后缀文件、以及别的隐藏文件都照常显示。
	for (const name of [".env", ".gitignore", "my.pideck-put", ".short.pideck-put", ".0123456789abcdef0123456789abcdef.pideck-put.bak"]) {
		assert.equal(REMOTE_UPLOAD_TEMP_NAME.test(name), false, name);
	}
	// 列表过滤在目录事实层（已拆到 remoteProjectDirFacts），搜索过滤在读面 handler。
	const readIpc = readFileSync("src/main/ipc/remoteProjectReadIpc.ts", "utf8");
	const projectIpc = readFileSync("src/main/ipc/remoteProjectIpc.ts", "utf8");
	const dirFacts = readFileSync("src/main/ipc/remoteProjectDirFacts.ts", "utf8");
	const filters = (projectIpc + dirFacts + readIpc).match(/REMOTE_UPLOAD_TEMP_NAME\.test\(/g) ?? [];
	assert.equal(filters.length, 2, "列表与搜索都必须过滤临时文件");
});
