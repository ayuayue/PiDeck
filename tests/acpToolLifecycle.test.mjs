/**
 * ACP 工具生命周期单测:检测/版本解析/npm 安装命令形态与安全边界。
 *
 * 覆盖:
 * - parseVersionFromOutput:各 CLI --version 输出形态(gemini v0.5.0 / opencode 1.15.4 / Qwen 2.0.1-alpha.0);
 * - detectAcpPreset:npx 形态只探 npm 可用性→npx-ready;本地命令 code=0→installed+version;
 *   ENOENT/error→missing;code!=0 且无输出→missing(有输出视为 installed,如某些 CLI --version 走 stderr);
 * - runNpmGlobalAction:命令形态恒为 npm install/uninstall -g <preset.package>(不接受任意命令);
 *   manual 形态直接 throw;退出码非 0→ok:false;
 * - 所有 fake 进程都必须挂 error 监听(生产代码里未处理 error 事件会崩主进程——测试反向锁定这条契约)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const lifecycle = loadTsCommonJs("src/main/acp/acpToolLifecycle.ts");
const { ACP_TOOL_PRESETS } = loadTsCommonJs("src/shared/acpToolPresets.ts");

/** fake child process:EventEmitter + stdout/stderr 流 + kill。 */
function fakeProc() {
	const proc = new EventEmitter();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.killed = false;
	proc.kill = () => {
		proc.killed = true;
	};
	return proc;
}

/** 注入 fake spawn 的 deps;spawn 调用记录在 calls 里供断言命令形态。 */
function makeDeps(onSpawn) {
	const calls = [];
	const deps = {
		createInvocation: (command, args) => ({ command, args }),
		spawn: (command, args, options) => {
			calls.push({ command, args, options });
			return onSpawn(command, args, options);
		},
	};
	return { deps, calls };
}

const getPreset = (id) => {
	const preset = ACP_TOOL_PRESETS.find((candidate) => candidate.id === id);
	assert.ok(preset, `preset ${id} must exist`);
	return preset;
};

test("parseVersionFromOutput 兼容各 CLI 版本输出形态", () => {
	assert.equal(lifecycle.parseVersionFromOutput("gemini v0.5.0\n"), "0.5.0");
	assert.equal(lifecycle.parseVersionFromOutput("opencode 1.15.4"), "1.15.4");
	assert.equal(lifecycle.parseVersionFromOutput("Qwen Code 2.0.1-alpha.0"), "2.0.1-alpha.0");
	assert.equal(lifecycle.parseVersionFromOutput("no digits here"), undefined);
});

test("detectAcpPreset npx 形态探 npm 可用性返回 npx-ready", async () => {
	const { deps } = makeDeps(() => {
		const proc = fakeProc();
		queueMicrotask(() => {
			proc.stdout.emit("data", Buffer.from("10.8.2\n"));
			proc.emit("exit", 0);
		});
		return proc;
	});
	const status = await lifecycle.detectAcpPreset(deps, getPreset("claude-agent"));
	assert.equal(status.state, "npx-ready");
	assert.equal(status.version, "10.8.2");
});

test("detectAcpPreset 本地命令 code=0 → installed 带版本", async () => {
	const { deps, calls } = makeDeps(() => {
		const proc = fakeProc();
		queueMicrotask(() => {
			proc.stdout.emit("data", Buffer.from("gemini v0.5.0\n"));
			proc.emit("exit", 0);
		});
		return proc;
	});
	const status = await lifecycle.detectAcpPreset(deps, getPreset("gemini"));
	assert.equal(status.state, "installed");
	assert.equal(status.version, "0.5.0");
	assert.deepEqual([...calls[0].args], ["--version"]);
});

test("detectAcpPreset 进程启动失败(error) → missing", async () => {
	const { deps } = makeDeps(() => {
		const proc = fakeProc();
		queueMicrotask(() => proc.emit("error", new Error("ENOENT")));
		return proc;
	});
	const status = await lifecycle.detectAcpPreset(deps, getPreset("gemini"));
	assert.equal(status.state, "missing");
});

test("detectAcpPreset 非零退出 → missing(shell 下的「不是内部或外部命令」也退非零,不得误报 installed)", async () => {
	const { deps } = makeDeps(() => {
		const proc = fakeProc();
		queueMicrotask(() => proc.emit("exit", 1));
		return proc;
	});
	assert.equal((await lifecycle.detectAcpPreset(deps, getPreset("gemini"))).state, "missing");

	// Windows 误报实测形态:code=1 但 stderr 有「无法识别」类文本——仍必须 missing
	const { deps: deps2 } = makeDeps(() => {
		const proc = fakeProc();
		queueMicrotask(() => {
			proc.stderr.emit("data", Buffer.from("gemini : 无法将“gemini”项识别为 cmdlet…"));
			proc.emit("exit", 1);
		});
		return proc;
	});
	assert.equal((await lifecycle.detectAcpPreset(deps2, getPreset("gemini"))).state, "missing");
});

test("runNpmGlobalAction 命令形态恒为 npm install/uninstall -g <package>", async () => {
	const { deps, calls } = makeDeps(() => {
		const proc = fakeProc();
		queueMicrotask(() => proc.emit("exit", 0));
		return proc;
	});
	const lines = [];
	const result = await lifecycle.runNpmGlobalAction(deps, getPreset("gemini"), "install", (line) => lines.push(line));
	assert.equal(result.ok, true);
	const gemini = getPreset("gemini");
	assert.equal(gemini.install.kind, "npm");
	assert.equal(calls[0].command, "npm");
	assert.deepEqual([...calls[0].args], ["install", "-g", gemini.install.package]);
	assert.equal(calls[0].options?.timeout, 10 * 60 * 1000);

	const { deps: deps2, calls: calls2 } = makeDeps(() => {
		const proc = fakeProc();
		queueMicrotask(() => proc.emit("exit", 0));
		return proc;
	});
	await lifecycle.runNpmGlobalAction(deps2, getPreset("gemini"), "uninstall");
	assert.deepEqual([...calls2[0].args], ["uninstall", "-g", gemini.install.package]);
});

test("runNpmGlobalAction 流式回调透传 stdout/stderr 行,退出码非 0 → ok:false", async () => {
	const { deps } = makeDeps(() => {
		const proc = fakeProc();
		queueMicrotask(() => {
			proc.stdout.emit("data", Buffer.from("added 1 package\n"));
			proc.stderr.emit("data", Buffer.from("warn something\n"));
			proc.emit("exit", 1);
		});
		return proc;
	});
	const lines = [];
	const result = await lifecycle.runNpmGlobalAction(deps, getPreset("gemini"), "install", (line) => lines.push(line));
	assert.equal(result.ok, false);
	assert.deepEqual([...lines], ["added 1 package", "warn something"]);
});

test("runNpmGlobalAction manual 形态直接拒绝", async () => {
	const { deps } = makeDeps(() => fakeProc());
	const cursor = getPreset("cursor-agent");
	assert.notEqual(cursor.install.kind, "npm");
	await assert.rejects(() => lifecycle.runNpmGlobalAction(deps, cursor, "install"), /not npm-installable/);
});

test("每个 npm 预设的 install 元数据与 command 一致性(预设在册形态守卫)", () => {
	for (const preset of ACP_TOOL_PRESETS) {
		if (preset.command !== "npx") continue;
		assert.equal(preset.install, undefined, `npx 形态 ${preset.id} 不应有 npm install 元数据`);
	}
	const npmInstallable = ACP_TOOL_PRESETS.filter((preset) => preset.install?.kind === "npm");
	assert.ok(npmInstallable.length >= 4, "npm 可安装预设至少 4 个(gemini/kimi/qwen/opencode)");
});
