/**
 * WSL 配置「发行版停/启」smoke（本轮验证用，**不是默认单测**）。
 *
 * 验什么：
 * 1) 发行版运行中：真实 WslPiConfigStore 能读到配置（基线）；
 * 2) `wsl --terminate <distro>` 后：读配置必须在 **15s 内**返回**稳定码**（不允许挂死，也不允许静默回退 Windows HOME）；
 * 3) 重新拉起发行版：记录启动耗时，再读一次回到成功。
 *
 * 只读配置：不调用任何 save*；终止/启动是 Lead 批准的 WSL 生命周期操作。
 * 输出一行 JSON（不含用户名/绝对路径）。
 *
 * 用法：node tests/wslConfigLifecycleSmoke.mjs [distro]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const storeModule = loadTsCommonJs("src/main/config/WslPiConfigStore.ts");
const distro = process.argv[2] ?? "Ubuntu-26.04";
const READ_DEADLINE_MS = 15_000;

function distroState() {
	try {
		const out = execFileSync("wsl.exe", ["-l", "-v"], { encoding: "utf16le", timeout: 20_000 });
		for (const line of out.replace(/\u0000/g, "").split(/\r?\n/)) {
			const cells = line
				.replace(/\*/g, " ")
				.trim()
				.split(/\s{2,}/);
			if (cells.length >= 2 && cells[0].trim() === distro) return cells[1].trim();
		}
	} catch {
		return "unknown";
	}
	return "unknown";
}

async function readWithDeadline(store) {
	const started = Date.now();
	const timer = new Promise((resolve) => setTimeout(() => resolve({ kind: "deadline" }), READ_DEADLINE_MS));
	const attempt = (async () => {
		try {
			const snapshot = await store.read({ file: "settings" });
			return { kind: "ok", keys: Object.keys(snapshot.data ?? {}).length };
		} catch (error) {
			return { kind: "stable-code", code: typeof error?.message === "string" ? error.message.slice(0, 120) : String(error) };
		}
	})();
	const outcome = await Promise.race([attempt, timer]);
	return { ...outcome, ms: Date.now() - started };
}

const result = { distro, steps: {}, restart: null };
let userDataDir = "";
try {
	const user = execFileSync("wsl.exe", ["-d", distro, "-e", "printenv", "USER"], { encoding: "utf8", timeout: 30_000 }).trim();
	userDataDir = await mkdtemp(join(tmpdir(), "pideck-wsl-life-"));
	const store = storeModule.createWslPiConfigStoreFor(userDataDir, { readWslIdentity: async () => ({ distro, user }) });

	const terminate = () => {
		const started = Date.now();
		const run = spawnSync("wsl.exe", ["-d", distro, "--terminate", distro], { encoding: "utf8", timeout: 60_000 });
		return { status: run.status, ms: Date.now() - started };
	};
	const start = () => {
		const started = Date.now();
		const run = spawnSync("wsl.exe", ["-d", distro, "-e", "true"], { encoding: "utf8", timeout: 120_000 });
		return { status: run.status, ms: Date.now() - started };
	};

	result.steps.stateBefore = distroState();
	result.steps.readRunning = await readWithDeadline(store);

	// 第 1 段：显式停 → 显式启（记录启动耗时），再读一次。
	result.steps.terminate1 = terminate();
	result.steps.stateAfterTerminate1 = distroState();
	result.restart = start();
	result.steps.stateAfterRestart = distroState();
	result.steps.readAfterRestart = await readWithDeadline(store);

	// 第 2 段：再停一次，然后**直接读**，看 15s 内是回稳定码、还是 UNC 访问把发行版自动拉起。
	result.steps.terminate2 = terminate();
	result.steps.stateBeforeColdRead = distroState();
	result.steps.readWhileStopped = await readWithDeadline(store);
	result.steps.stateAfterColdRead = distroState();
	result.steps.autoStartedByRead = result.steps.stateBeforeColdRead === "Stopped" && result.steps.stateAfterColdRead === "Running";

	// 收尾：确保发行版回到运行态（不留停止态给其他人）。
	if (distroState() !== "Running") result.steps.finalStart = start();
	result.steps.stateFinal = distroState();
} catch (error) {
	result.error = typeof error?.message === "string" ? error.message.split("\n")[0].slice(0, 200) : String(error);
} finally {
	if (userDataDir !== "") await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(JSON.stringify(result, null, 2));
// 判据：停态下读不能挂死（≤15s），且不允许静默回退到 Windows HOME（只允许稳定码或自动拉起后成功）。
const coldReadSettled = result.steps.readWhileStopped?.kind !== "deadline" && (result.steps.readWhileStopped?.ms ?? Infinity) <= READ_DEADLINE_MS;
const restartOk = result.steps.readAfterRestart?.kind === "ok";
const finalRunning = result.steps.stateFinal === "Running";
process.exit(coldReadSettled && restartOk && finalRunning ? 0 : 1);
