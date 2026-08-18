import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ipcChannels } from "../../shared/ipc";
import type { TerminalShell, TerminalTab, TerminalTarget } from "../../shared/types";
import { toWindowsHostPath, toWslLinuxPath } from "../wsl/WslPaths";
import { getWslExe } from "../wsl/wslExe";

// 简单日志，不依赖 appLogger 以避免循环引用
const log = (msg: string) => {
	console.error(`[TerminalSessionManager] ${msg}`);
};

type TerminalRuntime = {
	tab: TerminalTab;
	pty: pty.IPty;
	buffer: string;
};

type Emit = (channel: string, payload: unknown) => void;
const MAX_TERMINAL_REPLAY_BUFFER = 200_000;
type TerminalShellCandidate = {
	shell: TerminalShell;
	command: string;
	args: string[];
};

type TerminalWslSettings = {
	wslEnabled?: boolean;
	wslDistro?: string;
	wslUser?: string;
};

/**
 * 终端归属键：agent 用 `agent:<id>`，无 agent 的项目/历史会话终端用 `cwd:<normalized>`。
 * 主进程的 PTY 实例、回放 buffer 都按归属键隔离，保证项目间/agent 间终端绝不串台。
 */
export function terminalOwnerKeyFor(target: TerminalTarget): string {
	if (target.kind === "agent") return `agent:${target.agentId}`;
	// Windows 路径大小写不敏感且分隔符可混用：归一化（统一分隔符 + 去首尾斜杠 +
	// 小写）后做隔离键，避免同一目录因写法不同被当成两个终端桶。
	const normalized = target.cwd
		.replace(/[\\/]+/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.toLowerCase();
	return `cwd:${normalized}`;
}

export function isAgentOwnerKey(ownerKey: string): boolean {
	return ownerKey.startsWith("agent:");
}

export function getTerminalShellCandidates(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): TerminalShellCandidate[] {
	if (platform === "win32") {
		const candidates: TerminalShellCandidate[] = [
			{ shell: "pwsh", command: "pwsh.exe", args: [] },
			{ shell: "powershell", command: "powershell.exe", args: [] },
			{ shell: "cmd", command: "cmd.exe", args: [] },
		];
		// 检测 Git Bash（常见安装路径）
		const gitBashPaths = [
			"C:\\Program Files\\Git\\bin\\bash.exe",
			"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
		];
		for (const p of gitBashPaths) {
			if (existsSync(p)) {
				candidates.push({ shell: "git-bash", command: p, args: ["--login", "-i"] });
				break;
			}
		}
		// 检测 WSL：检查 wsl.exe 是否在 PATH 中
		try {
			execSync("where wsl.exe", { stdio: "ignore", timeout: 3000 });
			candidates.push({ shell: "wsl", command: "wsl.exe", args: [] });
		} catch {
			// wsl.exe 不可用，跳过 WSL
		}
		return dedupeShellCandidates(candidates);
	}

	if (platform === "darwin") {
		const userShell = normalizePosixShell(env.SHELL);
		const candidates: TerminalShellCandidate[] = [];
		if (userShell) candidates.push(userShell);
		// macOS GUI 应用拿到的进程环境通常不是用户登录 shell 环境；
		// 用登录 shell 启动可以让 zsh/bash 初始化 TTY 与用户 PATH，行为更接近 Terminal.app。
		candidates.push(
			{ shell: "zsh", command: "/bin/zsh", args: ["-l"] },
			{ shell: "bash", command: "/bin/bash", args: ["-l"] },
			{ shell: "sh", command: "/bin/sh", args: [] },
		);
		return dedupeShellCandidates(candidates);
	}

	const userShell = normalizePosixShell(env.SHELL);
	const candidates: TerminalShellCandidate[] = [];
	if (userShell) candidates.push(userShell);
	candidates.push(
		{ shell: "bash", command: "bash", args: [] },
		{ shell: "sh", command: "sh", args: [] },
	);
	return dedupeShellCandidates(candidates);
}

function normalizePosixShell(
	shellPath: string | undefined,
): TerminalShellCandidate | null {
	if (!shellPath) return null;
	const name = shellPath.split(/[\\/]/).pop();
	if (name === "zsh") return { shell: "zsh", command: shellPath, args: ["-l"] };
	if (name === "bash") return { shell: "bash", command: shellPath, args: ["-l"] };
	if (name === "fish") return { shell: "fish", command: shellPath, args: ["-l"] };
	if (name === "sh") return { shell: "sh", command: shellPath, args: [] };
	return { shell: "sh", command: shellPath, args: [] };
}

function dedupeShellCandidates(candidates: TerminalShellCandidate[]) {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = `${candidate.command}\0${candidate.args.join("\0")}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export class TerminalSessionManager {
	private readonly runtimes = new Map<string, Map<string, TerminalRuntime>>();

	constructor(
		private readonly getCwd: (agentId: string) => string,
		private readonly emit: Emit,
		private readonly getSettings: () => TerminalWslSettings = () => ({}),
	) {}

	/** 目标所属终端桶；project 目标不存在运行中的 agent，不查 runtime */
	private ownerKey(target: TerminalTarget): string {
		return terminalOwnerKeyFor(target);
	}

	/** 目标的工作目录：agent 用 runtime cwd，project 直接用目标携带的 cwd */
	private cwdFor(target: TerminalTarget): string {
		if (target.kind === "project") return target.cwd;
		return this.getCwd(target.agentId);
	}

	list(target: TerminalTarget) {
		return [...(this.runtimes.get(this.ownerKey(target))?.values() ?? [])].map(
			(runtime) => this.snapshot(runtime),
		);
	}

	/**
	 * 返回当前平台可用的终端 shell 列表，供前端下拉选择。
	 * 返回前检测每个候选是否可 spawn，不可用的标记为 available: false。
	 */
	listShells(): { shell: TerminalShell; label: string; available: boolean }[] {
		return this.shellCandidates().map((c) => ({
			shell: c.shell,
			label: this.displayShell(c.shell),
			available: true,
		}));
	}

	ensure(target: TerminalTarget) {
		const existing = this.list(target);
		if (existing.length > 0) return existing;
		// Renderer 在 StrictMode 下会重复触发 mount effect；这里提供原子兜底，
		// 避免 list -> create 两步之间的竞态导致“未点击却多出两个终端”。
		return [this.create(target)];
	}

	create(target: TerminalTarget, shell?: TerminalShell): TerminalTab {
		const ownerKey = this.ownerKey(target);
		const resolvedCwd = this.cwdFor(target);
		const runtimes = this.ensureOwner(ownerKey);
		const index = runtimes.size + 1;
		const id = randomUUID();
		const spawned = this.spawnShell(resolvedCwd, shell);
		const tab: TerminalTab = {
			id,
			agentId: target.kind === "agent" ? target.agentId : "",
			ownerKey,
			title: `${this.displayShell(spawned.shell)} ${index}`,
			cwd: resolvedCwd,
			shell: spawned.shell,
			createdAt: Date.now(),
		};
		const runtime: TerminalRuntime = { tab, pty: spawned.pty, buffer: "" };
		runtimes.set(id, runtime);

		spawned.pty.onData((data) => {
			this.appendBuffer(runtime, data);
			this.emit(ipcChannels.terminalData, { tabId: id, data });
		});
		spawned.pty.onExit((event) => {
			tab.exited = true;
			tab.exitCode = event.exitCode;
			const exitText = `\r\n[process exited${event.exitCode != null ? ` with code ${event.exitCode}` : ""}]\r\n`;
			this.appendBuffer(runtime, exitText);
			this.emit(ipcChannels.terminalExit, {
				tabId: id,
				exitCode: event.exitCode,
			});
		});

		return tab;
	}

	input(tabId: string, data: string) {
		const runtime = this.requireTab(tabId);
		if (runtime.tab.exited) return;
		runtime.pty.write(data);
	}

	resize(tabId: string, cols: number, rows: number) {
		// 终端已关闭时静默忽略 resize，避免已销毁的 tab 触发未处理异常
		const found = this.findRuntime(tabId);
		if (!found || found.runtime.tab.exited) return;
		found.runtime.pty.resize(Math.max(2, cols), Math.max(1, rows));
	}

	close(tabId: string) {
		const found = this.findRuntime(tabId);
		if (!found) return;
		found.runtime.pty.kill();
		found.tabs.delete(tabId);
		if (found.tabs.size === 0) this.runtimes.delete(found.runtime.tab.ownerKey);
	}

	/** 关闭某个 agent 的全部终端（agent 退出/重启时调用） */
	closeAgent(agentId: string) {
		const tabs = this.runtimes.get(`agent:${agentId}`);
		if (!tabs) return;
		for (const runtime of tabs.values()) {
			runtime.pty.kill();
		}
		this.runtimes.delete(`agent:${agentId}`);
	}

	closeAll() {
		for (const ownerKey of this.runtimes.keys()) {
			this.closeOwner(ownerKey);
		}
	}

	private closeOwner(ownerKey: string) {
		const tabs = this.runtimes.get(ownerKey);
		if (!tabs) return;
		for (const runtime of tabs.values()) {
			runtime.pty.kill();
		}
		this.runtimes.delete(ownerKey);
	}

	private ensureOwner(ownerKey: string) {
		const existing = this.runtimes.get(ownerKey);
		if (existing) return existing;
		const next = new Map<string, TerminalRuntime>();
		this.runtimes.set(ownerKey, next);
		return next;
	}

	private requireTab(tabId: string) {
		const found = this.findRuntime(tabId);
		if (!found) throw new Error(`Terminal not found: ${tabId}`);
		return found.runtime;
	}

	private findRuntime(tabId: string) {
		for (const tabs of this.runtimes.values()) {
			const runtime = tabs.get(tabId);
			if (runtime) return { tabs, runtime };
		}
		return undefined;
	}

	private snapshot(runtime: TerminalRuntime): TerminalTab {
		return {
			...runtime.tab,
			buffer: runtime.buffer,
		};
	}

	private appendBuffer(runtime: TerminalRuntime, data: string) {
		// Renderer 会在切换项目/agent 时卸载 TerminalDock；主进程保留有限回放，
		// 切回来才能重建 xterm scrollback，同时用字符上限避免长期终端占用过多内存。
		runtime.buffer = `${runtime.buffer}${data}`;
		if (runtime.buffer.length > MAX_TERMINAL_REPLAY_BUFFER) {
			runtime.buffer = runtime.buffer.slice(-MAX_TERMINAL_REPLAY_BUFFER);
		}
	}

	private spawnShell(cwd: string, preferredShell?: TerminalShell): { shell: TerminalShell; pty: pty.IPty } {
		const candidates = this.shellCandidates();
		// 如果有首选 shell，先在候选列表中查找匹配项
		const ordered = preferredShell
			? [
					...candidates.filter((c) => c.shell === preferredShell),
					...candidates.filter((c) => c.shell !== preferredShell),
			  ]
			: candidates;
		log(`spawnShell: preferred=${preferredShell}, ordered=${ordered.map((c) => c.shell).join(", ")}`);
		let lastError: unknown;
		for (const candidate of ordered) {
			try {
				// macOS GUI 应用（Electron）不继承登录 shell 的环境变量，
				// LANG/LC_CTYPE 可能为空或 C，导致 shell 内 UTF-8 输出乱码。
				// 显式注入 UTF-8 locale，让 shell 知道应以 UTF-8 解释字节流。
				const env = { ...process.env };
				if (!env.LANG) env.LANG = "en_US.UTF-8";
				if (!env.LC_ALL) env.LC_ALL = "en_US.UTF-8";
				const wsl = candidate.shell === "wsl" ? this.getSettings() : undefined;
				let command = candidate.command;
				let args = candidate.args;
				let spawnCwd = cwd;
				if (wsl?.wslEnabled && wsl.wslDistro && wsl.wslUser) {
					try {
						args = [
							...args,
							"--cd",
							toWslLinuxPath(cwd, { distro: wsl.wslDistro }),
						];
						spawnCwd = toWindowsHostPath(cwd, { distro: wsl.wslDistro });
					} catch (error) {
						log(`Failed to convert WSL terminal cwd: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				const terminal = pty.spawn(command, args, {
					name: "xterm-256color",
					cols: 80,
					rows: 24,
					cwd: spawnCwd,
					env,
				});
				return { shell: candidate.shell, pty: terminal };
			} catch (error) {
				lastError = error;
				log(`Failed to spawn ${candidate.shell} (${candidate.command}): ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error("No supported shell found");
	}

	private shellCandidates(): TerminalShellCandidate[] {
		const candidates = getTerminalShellCandidates(process.platform, process.env);
		const settings = this.getSettings();
		if (
			process.platform !== "win32" ||
			!settings.wslEnabled ||
			!settings.wslDistro ||
			!settings.wslUser
		) {
			return candidates;
		}
		const wslExe = getWslExe();
		return [
			{
				shell: "wsl" as const,
				command: wslExe.command,
				args: ["-d", settings.wslDistro, "-u", settings.wslUser],
			},
			...candidates.filter((candidate) => candidate.shell !== "wsl"),
		];
	}

	private displayShell(shell: TerminalShell) {
		if (shell === "pwsh") return "pwsh";
		if (shell === "powershell") return "Windows PowerShell";
		if (shell === "cmd") return "cmd";
		if (shell === "zsh") return "zsh";
		if (shell === "bash") return "bash";
		if (shell === "fish") return "fish";
		if (shell === "git-bash") return "Git Bash";
		if (shell === "wsl") return "WSL";
		return "shell";
	}
}
