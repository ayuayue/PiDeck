import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import { ipcChannels } from "../../shared/ipc";
import type { TerminalShell, TerminalTab } from "../../shared/types";

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

export function getTerminalShellCandidates(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): TerminalShellCandidate[] {
	if (platform === "win32") {
		return [
			{ shell: "pwsh", command: "pwsh.exe", args: [] },
			{ shell: "powershell", command: "powershell.exe", args: [] },
			{ shell: "cmd", command: "cmd.exe", args: [] },
		];
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
		private readonly getAgentCwd: (agentId: string) => string,
		private readonly emit: Emit,
	) {}

	list(agentId: string) {
		return [...(this.runtimes.get(agentId)?.values() ?? [])].map(
			(runtime) => this.snapshot(runtime),
		);
	}

	ensure(agentId: string) {
		const existing = this.list(agentId);
		if (existing.length > 0) return existing;
		// Renderer 在 StrictMode 下会重复触发 mount effect；这里提供原子兜底，
		// 避免 list -> create 两步之间的竞态导致“未点击却多出两个终端”。
		return [this.create(agentId)];
	}

	create(agentId: string): TerminalTab {
		const cwd = this.getAgentCwd(agentId);
		const runtimes = this.ensureAgent(agentId);
		const index = runtimes.size + 1;
		const id = randomUUID();
		const spawned = this.spawnShell(cwd);
		const tab: TerminalTab = {
			id,
			agentId,
			title: `${this.displayShell(spawned.shell)} ${index}`,
			cwd,
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
		const runtime = this.requireTab(tabId);
		if (runtime.tab.exited) return;
		runtime.pty.resize(Math.max(2, cols), Math.max(1, rows));
	}

	close(tabId: string) {
		const found = this.findRuntime(tabId);
		if (!found) return;
		found.runtime.pty.kill();
		found.tabs.delete(tabId);
		if (found.tabs.size === 0) this.runtimes.delete(found.runtime.tab.agentId);
	}

	closeAgent(agentId: string) {
		const tabs = this.runtimes.get(agentId);
		if (!tabs) return;
		for (const runtime of tabs.values()) {
			runtime.pty.kill();
		}
		this.runtimes.delete(agentId);
	}

	closeAll() {
		for (const agentId of this.runtimes.keys()) {
			this.closeAgent(agentId);
		}
	}

	private ensureAgent(agentId: string) {
		const existing = this.runtimes.get(agentId);
		if (existing) return existing;
		const next = new Map<string, TerminalRuntime>();
		this.runtimes.set(agentId, next);
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

	private spawnShell(cwd: string): { shell: TerminalShell; pty: pty.IPty } {
		const candidates = this.shellCandidates();
		let lastError: unknown;
		for (const candidate of candidates) {
			try {
				const terminal = pty.spawn(candidate.command, candidate.args, {
					name: "xterm-256color",
					cols: 80,
					rows: 24,
					cwd,
					env: process.env,
				});
				return { shell: candidate.shell, pty: terminal };
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error("No supported shell found");
	}

	private shellCandidates(): TerminalShellCandidate[] {
		return getTerminalShellCandidates(process.platform, process.env);
	}

	private displayShell(shell: TerminalShell) {
		if (shell === "pwsh" || shell === "powershell") return "PowerShell";
		if (shell === "cmd") return "cmd";
		if (shell === "zsh") return "zsh";
		if (shell === "bash") return "bash";
		if (shell === "fish") return "fish";
		return "shell";
	}
}
