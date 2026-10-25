/**
 * ACP 工具生命周期:安装检测 / 版本探测 / npm 一键安装卸载。
 *
 * 边界(硬规则):
 * - 只接受内置预设表的 presetId 枚举,安装命令全部来自 ACP_TOOL_PRESETS 的 install 元数据,
 *   IPC 层不接受用户输入的命令串——「检测/安装/卸载」不是任意命令执行入口。
 * - 所有 spawn 挂 error 监听(未处理 error 事件崩主进程);可能长时间不返回的
 *   检测/安装/卸载都带超时 kill。
 * - Windows 的 npm/npx .cmd 垫片还原复用 PiLocator.createInvocation,不在此重复处理平台。
 */
import type { ChildProcess } from "node:child_process";
import { ACP_TOOL_PRESETS, type AcpToolPreset, type AcpToolPresetId } from "../../shared/acpToolPresets";
import type { AcpToolStatus } from "../../shared/types/acp";

export type { AcpToolStatus } from "../../shared/types/acp";

/** 依赖注入槽:测试用 fake child process 打桩,不碰真实进程。 */
export interface AcpToolLifecycleDeps {
	/** 还原平台垫片(Windows npm.cmd 等);与 AcpAgentManager.create 同一入口。 */
	createInvocation: (command: string, args: string[]) => { command: string; args: string[]; shell?: boolean };
	spawn: (command: string, args: string[], options: { timeout?: number }) => ChildProcess;
}

const DETECT_TIMEOUT_MS = 8000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** 从 --version 输出提取首个语义版本词:兼容 "gemini v0.5.0"、"opencode 1.15.4"、"Qwen Code 2.0.1-alpha.0" 等形态。 */
export function parseVersionFromOutput(text: string): string | undefined {
	const match = text.match(/(\d+(?:\.\d+)+(?:[-.][0-9A-Za-z]+)*)/);
	return match?.[1];
}

export function findPresetById(id: string): AcpToolPreset | undefined {
	return ACP_TOOL_PRESETS.find((preset) => preset.id === id);
}

/**
 * 跑一条短命令并收集 stdout+stderr(超时 kill)。
 * 返回 null = 进程启动失败(ENOENT 等,「命令不存在」信号);其余为合并输出与退出码。
 */
async function runShortCommand(deps: AcpToolLifecycleDeps, command: string, args: string[], timeoutMs: number): Promise<{ output: string; code: number | null } | null> {
	const invocation = deps.createInvocation(command, args);
	const proc = deps.spawn(invocation.command, invocation.args, { timeout: timeoutMs });
	return await new Promise((resolve) => {
		let output = "";
		let settled = false;
		const settle = (value: { output: string; code: number | null } | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			proc.kill();
			settle({ output, code: null });
		}, timeoutMs);
		proc.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		// ENOENT 走 error 事件(绝不留未处理 error 监听);已 exit 后再 error 忽略。
		proc.once("error", () => settle(null));
		proc.once("exit", (code) => settle({ output, code }));
	});
}

/** 检测预设工具:npm 形态跑 `<command> --version`;npx 形态只确认 npm 可用(adapter 按需下载,无需预装)。 */
export async function detectAcpPreset(deps: AcpToolLifecycleDeps, preset: AcpToolPreset): Promise<AcpToolStatus> {
	// npx 形态(claude-agent/codex adapter):无本地二进制可查,检测 npm 可用性即可。
	if (preset.command === "npx") {
		const npmProbe = await runShortCommand(deps, "npm", ["--version"], DETECT_TIMEOUT_MS);
		if (!npmProbe) return { presetId: preset.id, state: "unknown" };
		return { presetId: preset.id, state: "npx-ready", version: parseVersionFromOutput(npmProbe.output) };
	}
	const versionArgs = preset.versionArgs ?? ["--version"];
	const probe = await runShortCommand(deps, preset.command, versionArgs, DETECT_TIMEOUT_MS);
	if (!probe) return { presetId: preset.id, state: "missing" };
	// 退出码非零一律 missing(不因有输出而宽容):Windows shell 形态下「不是内部或外部命令」
	// 也走 stderr 输出文本,宽容规则会把未安装误报成 installed(2026-03 实测误报四例)。
	if (probe.code !== 0) return { presetId: preset.id, state: "missing" };
	return { presetId: preset.id, state: "installed", version: parseVersionFromOutput(probe.output) };
}

/** 安装/卸载的进度回调:phase=stdout/stderr 增量行,finish 由调用方结算。 */
export type AcpInstallListener = (line: string) => void;

/**
 * npm 全局安装/卸载预设工具(流式输出回调,超时 kill)。
 * 只接受 preset.install.kind === "npm"(manual 形态调用前就被 IPC 层拒绝)。
 */
export async function runNpmGlobalAction(deps: AcpToolLifecycleDeps, preset: AcpToolPreset, action: "install" | "uninstall", onLine?: AcpInstallListener): Promise<{ ok: boolean; output: string }> {
	if (preset.install?.kind !== "npm") throw new Error(`preset ${preset.id} is not npm-installable`);
	const invocation = deps.createInvocation("npm", [action === "install" ? "install" : "uninstall", "-g", preset.install.package]);
	const proc = deps.spawn(invocation.command, invocation.args, { timeout: INSTALL_TIMEOUT_MS });
	return await new Promise((resolve) => {
		let output = "";
		let settled = false;
		const settle = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok, output });
		};
		const timer = setTimeout(() => {
			proc.kill();
			settle(false);
		}, INSTALL_TIMEOUT_MS);
		const consume = (chunk: Buffer, stream: "stdout" | "stderr") => {
			const text = chunk.toString("utf8");
			output += text;
			// npm 进度条/告警走 stderr 也有诊断价值,全部透传给设置页日志区。
			for (const line of text.split(/\r?\n/)) {
				if (line.trim()) onLine?.(stream === "stderr" ? line : line);
			}
		};
		proc.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
		proc.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
		proc.once("error", () => settle(false));
		proc.once("exit", (code) => settle(code === 0));
	});
}
