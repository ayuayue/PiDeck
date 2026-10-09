import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 终端标签关闭确认策略回归测试（terminalDockState.shouldConfirmTerminalClose）。
 *
 * 背景：上游 listShells 曾恒返回 available: true，关闭确认无从判断「前台进程」；
 * 现在按「关闭前确认」三档（never/running/always）+ 前台进程名与 shell 默认进程名
 * 比对决定是否弹确认。这里锁住判定矩阵，防止把「正在编译时误关终端」的护栏改丢。
 */
function loadDockState() {
	return loadTsCommonJs("src/renderer/src/terminalDockState.ts");
}

test("SHELL_DEFAULT_PROCESS 覆盖全部候选 shell", () => {
	const { SHELL_DEFAULT_PROCESS } = loadDockState();
	for (const shell of ["pwsh", "powershell", "cmd", "zsh", "bash", "fish", "sh", "git-bash", "wsl"]) {
		assert.ok(shell in SHELL_DEFAULT_PROCESS, `SHELL_DEFAULT_PROCESS 缺 ${shell}`);
	}
	assert.equal(SHELL_DEFAULT_PROCESS["git-bash"], "bash");
});

test("never 档：任何情况都不确认", () => {
	const { shouldConfirmTerminalClose } = loadDockState();
	assert.equal(shouldConfirmTerminalClose("never", "node.exe", "pwsh"), false);
	assert.equal(shouldConfirmTerminalClose("never", "", "bash"), false);
	assert.equal(shouldConfirmTerminalClose("never", undefined, "zsh"), false);
});

test("always 档：有前台进程就确认（含空进程名也确认——保守方向）", () => {
	const { shouldConfirmTerminalClose } = loadDockState();
	assert.equal(shouldConfirmTerminalClose("always", "node.exe", "pwsh"), true);
	// 空名无法证明没有进程，always 语义下选择确认（弹窗可取消，误弹代价低）
	assert.equal(shouldConfirmTerminalClose("always", "", "bash"), true);
	assert.equal(shouldConfirmTerminalClose("always", undefined, "zsh"), true);
});

test("running 档：空前台进程名（shell 空闲）不确认", () => {
	const { shouldConfirmTerminalClose } = loadDockState();
	assert.equal(shouldConfirmTerminalClose("running", "", "pwsh"), false);
	assert.equal(shouldConfirmTerminalClose("running", undefined, "bash"), false);
});

test("running 档：前台进程名与 shell 默认进程一致 = 空闲，不确认", () => {
	const { shouldConfirmTerminalClose } = loadDockState();
	// pwsh 终端空闲时前台进程是 pwsh.exe（带扩展名/路径形态都要归一化）
	assert.equal(shouldConfirmTerminalClose("running", "pwsh.exe", "pwsh"), false);
	assert.equal(shouldConfirmTerminalClose("running", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell"), false);
	assert.equal(shouldConfirmTerminalClose("running", "bash", "zsh"), true, "zsh 终端里跑 bash 子进程是用户动作，要确认");
	// wsl shell 的默认前台进程是 wsl.exe
	assert.equal(shouldConfirmTerminalClose("running", "wsl.exe", "wsl"), false);
	// git-bash 的默认前台进程映射到 bash
	assert.equal(shouldConfirmTerminalClose("running", "bash.exe", "git-bash"), false);
	// 用户在 pwsh 里启动了 node：不是默认进程，要确认
	assert.equal(shouldConfirmTerminalClose("running", "node.exe", "pwsh"), true);
	assert.equal(shouldConfirmTerminalClose("running", "npm", "bash"), true);
});

test("normalizeProcessName（经 running 档间接覆盖）：剥路径与 Windows 扩展名、大小写不敏感", () => {
	const { shouldConfirmTerminalClose } = loadDockState();
	// "  NODE.EXE " 归一化成 node，与 pwsh 默认进程不同 → 确认（若归一化失效则误判为空闲）
	assert.equal(shouldConfirmTerminalClose("running", "  NODE.EXE ", "pwsh"), true);
	assert.equal(shouldConfirmTerminalClose("running", "C:\\Program Files\\Git\\bin\\bash.exe", "bash"), false);
	assert.equal(shouldConfirmTerminalClose("running", "/usr/bin/zsh", "zsh"), false);
});
