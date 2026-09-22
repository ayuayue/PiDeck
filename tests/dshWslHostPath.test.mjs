import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 回归背景（WSL 模式下 DSH 会话必然创建失败）：
// DSH host 是 Windows 原生进程，它拿 node:fs realpath 归一化 workspace 路径——
// Windows 上 realpath('/mnt/h/proj') 会被当成当前盘根目录（C:\mnt）而报 ENOENT。
// WSL 模式下项目记录的是 Linux 路径，因此凡是要交给 host 的路径（workspace 解析、
// 会话目录编码、归档/删除定位）都必须先转成 Windows 主机路径。
const { DshHost } = loadTsCommonJs("src/main/dsh/DshHost.ts");
const { workspaceDirFor } = loadTsCommonJs("src/main/dsh/dshSessionPath.ts");

/** WSL 环境替身：转换只依赖 distro。 */
const WSL_ENV = { distro: "debian", user: "tester", linuxHome: "/home/tester", windowsHome: "\\\\wsl.localhost\\debian\\home\\tester" };
/** 同一个 H 盘项目：Linux 记录形式与 host 视角形式。 */
const LINUX_CWD = "/mnt/h/minimax h3/piying";
const HOST_CWD = "H:\\minimax h3\\piying";

function makeHost(trashPath) {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-wsl-"));
	const host = new DshHost(
		() => join(home, "userData"),
		() => home,
		() => undefined,
		() => home,
		undefined,
		undefined,
		trashPath,
	);
	return { host, home };
}

/** 在 sessions 树里造一个假 host 会话目录（session.jsonl.zstd 占位）。 */
function makeSessionDir(home, cwd, sessionId) {
	const dir = join(home, "sessions", workspaceDirFor(cwd), sessionId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "session.jsonl.zstd"), "fake-log");
	return dir;
}

test("DshHost.sessionFilePath：WSL 模式下按 host 视角路径编码（H:\\... 而非 /mnt/...）", () => {
	const { host, home } = makeHost();
	try {
		// 未配置 WSL：保持原样，行为与修复前一致（非 WSL 场景不受影响）
		assert.ok(host.sessionFilePath(LINUX_CWD, "session-a").includes(workspaceDirFor(LINUX_CWD)));
		host.configureWsl(WSL_ENV);
		const resolved = host.sessionFilePath(LINUX_CWD, "session-a");
		assert.ok(resolved.includes(workspaceDirFor(HOST_CWD)), `应按主机路径编码: ${resolved}`);
		assert.ok(!resolved.includes(workspaceDirFor(LINUX_CWD)), "不能用 /mnt/... 编码（host 从未写过该目录）");
		// 已经是主机路径（非 WSL 项目/重复调用）时转换应是幂等的
		assert.equal(host.sessionFilePath(HOST_CWD, "session-a"), resolved);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.resolveWorkspaceId：WSL 模式下 workspace.create 收到 Windows 主机路径", async () => {
	const { host, home } = makeHost();
	const calls = [];
	try {
		host.configureWsl(WSL_ENV);
		// client 存在时 ensureStarted 直接返回，不会 fork 真实 host（纯边界替身）
		host.client = {
			workspaceCreate: async (payload) => {
				calls.push(payload.path);
				return { result: { ok: true, value: { workspace: { workspaceId: "ws-1" } } } };
			},
		};
		const workspaceId = await host.resolveWorkspaceId(LINUX_CWD);
		assert.equal(workspaceId, "ws-1");
		assert.deepEqual(calls, [HOST_CWD], "发给 host 的必须是 Windows 主机路径，否则 realpath 落到 C:\\mnt");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.archiveSession：WSL 模式下按主机路径定位会话目录，manifest 保留项目路径 + 记录 hostCwd", async () => {
	const { host, home } = makeHost();
	try {
		host.configureWsl(WSL_ENV);
		const sessionId = "session-wsl-1";
		// host 实际落盘位置由它收到的 Windows 路径决定
		const sourceDir = makeSessionDir(home, HOST_CWD, sessionId);

		const archived = await host.archiveSession(sessionId, LINUX_CWD, "WSL 项目会话");
		assert.ok(archived, "WSL 项目会话必须能归档（修复前按 /mnt/... 推导目录 → 找不到 → undefined）");
		assert.ok(!existsSync(sourceDir), "原 sessions 树目录应已移走");

		const manifest = JSON.parse(readFileSync(join(archived, "pideck-manifest.json"), "utf8"));
		// cwd 必须是上层传入的项目路径形式：sessionIpc 恢复时按它 findByPath 匹配项目记录，
		// 写主机路径会让匹配落空并新建一个重复项目
		assert.equal(manifest.cwd, LINUX_CWD);
		assert.equal(manifest.hostCwd, HOST_CWD);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.unarchiveSession：归档期间切回本机模式也能移回 host 编码的原目录", async () => {
	const { host, home } = makeHost();
	try {
		host.configureWsl(WSL_ENV);
		const sessionId = "session-wsl-2";
		makeSessionDir(home, HOST_CWD, sessionId);
		await host.archiveSession(sessionId, LINUX_CWD, "WSL 项目会话");

		// 用户在归档期间关掉了「使用 WSL」：目标目录仍必须按 host 路径还原
		host.configureWsl(null);
		const restored = await host.unarchiveSession(sessionId);
		assert.ok(restored, "应能恢复");
		assert.equal(restored.cwd, LINUX_CWD, "返回给上层的 cwd 仍是项目路径形式（用于匹配项目）");
		const expectedDir = join(home, "sessions", workspaceDirFor(HOST_CWD), sessionId);
		assert.equal(restored.restoredPath, expectedDir);
		assert.ok(existsSync(join(expectedDir, "session.jsonl.zstd")), "会话日志应回到 host 实际使用的 workspace 目录");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.deleteSession：WSL 模式下按主机路径精确命中（不依赖 sessionId 兜底扫描）", async () => {
	const trashed = [];
	const { host, home } = makeHost(async (path) => {
		trashed.push(path);
		rmSync(path, { recursive: true, force: true });
	});
	try {
		host.configureWsl(WSL_ENV);
		const sessionId = "session-wsl-3";
		const sessionDir = makeSessionDir(home, HOST_CWD, sessionId);
		// 兜底扫描会命中任意同名目录：放一个同 id 的干扰目录，验证走的是精确推导
		const decoy = makeSessionDir(home, "D:/other", sessionId);

		const deleted = await host.deleteSession(sessionId, LINUX_CWD);
		assert.equal(deleted, true);
		assert.deepEqual(trashed, [join(home, "sessions", workspaceDirFor(HOST_CWD), sessionId)], "应按主机路径编码目录删除");
		assert.ok(!existsSync(sessionDir), "目标会话目录应已移走");
		assert.ok(existsSync(decoy), "同 id 的无关联目录不应被误删");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
