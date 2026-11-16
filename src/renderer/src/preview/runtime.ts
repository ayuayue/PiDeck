import type { PiDesktopApi } from "../../../preload";
import { terminalOwnerKeyFor } from "../../../shared/types";
import { ACP_TOOL_PRESETS } from "../../../shared/acpToolPresets";
import type { TerminalDataEvent, TerminalExitEvent, TerminalShell, TerminalTab, TerminalTarget } from "../../../shared/types";
import { now } from "./fixtures";

const terminalTabs: TerminalTab[] = [];
const terminalDataListeners = new Set<(payload: TerminalDataEvent) => void>();
const terminalExitListeners = new Set<(payload: TerminalExitEvent) => void>();

/**
 * pi / acp 运行后端、日志与终端桩；终端 tab 与订阅集合是跨实例共享的模块级状态。
 */
export function createRuntimePreview(): Pick<PiDesktopApi, "logs" | "rpcLogs" | "pi" | "acp" | "terminal"> {
	const createTerminalTab = async (target: TerminalTarget, shell?: TerminalShell) => {
		const shellName = shell ?? "powershell";
		const displayName = shellName === "git-bash" ? "Git Bash" : shellName === "bash" ? "bash" : shellName === "cmd" ? "cmd" : "PowerShell";
		const tab: TerminalTab = {
			id: `preview-terminal-${terminalTabs.length + 1}`,
			agentId: target.kind === "agent" ? target.agentId : "",
			ownerKey: terminalOwnerKeyFor(target),
			title: `${displayName} ${terminalTabs.length + 1}`,
			shell: shellName,
			createdAt: Date.now(),
		};
		terminalTabs.push(tab);
		setTimeout(() => {
			for (const listener of terminalDataListeners) {
				listener({
					tabId: tab.id,
					data: "Windows PowerShell\r\nPS C:\\\\Users\\\\14012\\\\preview-project> ",
				});
			}
		}, 0);
		return tab;
	};
	return {
		logs: {
			list: async () => [],
			listPage: async () => ({ entries: [], total: 0, page: 0, pageSize: 50, hasMore: false }),
			clear: async () => undefined,
			openFolder: async () => undefined,
			getSize: async () => 0,
		},
		rpcLogs: {
			getSize: async () => 0,
			get: async () => [],
			getLive: async () => [],
			getModelTrace: async () => null,
			save: async () => [],
			onLog: (_callback: unknown) => () => {},
			clear: async () => undefined,
			setLogging: async () => false,
			getLogging: async () => false,
			setWatching: async () => false,
		},
		pi: {
			check: async () => ({
				installed: true,
				command: "pi",
				version: "preview",
				searchedDirs: [],
			}),
			checkCustom: async (_path) => ({
				installed: true,
				command: _path,
				version: "preview",
				searchedDirs: [],
			}),
			// 预览模式固定给两份安装：用来验证「多安装让用户自己选」的 UI 分支。
			listInstallations: async () => [
				{
					path: "/usr/local/bin/pi",
					realPath: "/usr/local/bin/pi",
					version: "preview",
					source: "package-manager" as const,
					isActive: true,
				},
				{
					path: "/home/preview/.pi/agent/bin/pi",
					realPath: "/home/preview/.pi/agent/bin/pi",
					version: "preview",
					source: "managed" as const,
					managedRoot: "/home/preview/.pi/agent/install",
					isActive: false,
					shellDefault: true,
				},
			],
			/** 预览模式的「浏览…」：固定返回一个假路径，验证交互链路。 */
			chooseExecutable: async () => "/home/preview/.pi/agent/bin/pi",
			/** 预览模式：只回显，不落盘 */
			setCustomPaths: async (paths) => ({ paths: [...paths], clearedActive: false }),
			checkUpdate: async () => ({
				currentVersion: "preview",
				latestVersion: "preview",
				hasUpdate: false,
			}),
			releaseNotes: async () => ({
				markdown: "## [preview] - 2026-01-01\n\n- Preview mode: pi release notes",
				source: "github",
				versionCount: 1,
				pageUrl: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md",
				fetchedAt: null,
				truncated: false,
			}),
			update: async () => ({
				command: "pi update pi --no-approve",
				output: "Preview mode: pi update output",
				updated: false,
			}),
			execInstall: async (_command) => ({
				success: true,
				exitCode: 0,
				stdout: "preview: exec install output",
				stderr: "",
			}),
			checkNpm: async () => ({
				available: true,
				version: "preview",
			}),
			runtimeNodeCheck: async () => ({
				installed: false,
				systemNodeAvailable: true,
				systemNodeVersion: "v24.13.0",
				installSupported: true,
			}),
			runtimeNodeInstall: async () => ({
				ok: true,
				path: "preview",
				version: "v24.13.0",
				source: "preview",
			}),
			runtimePiInstall: async (_useMirror) => ({
				success: true,
				exitCode: 0,
				stdout: "preview: runtime pi install output",
				stderr: "",
			}),
		},

		acp: {
			// 预览模式：无 ACP 工具数据，返回空表/恒过校验保持 PiDesktopApi 形状完整；
			// 生命周期接口返回固定缺省值（无安装检测、无事件流）
			listTools: async () => [],
			saveTools: async () => [],
			validateTool: async () => ({ ok: true as const }),
			detectTool: async () => ({ presetId: ACP_TOOL_PRESETS[0]?.id ?? "gemini", state: "unknown" as const }),
			installTool: async () => ({ ok: false, output: "preview" }),
			uninstallTool: async () => ({ ok: false, output: "preview" }),
			onLifecycleEvent: () => () => undefined,
			getSessionConfig: async () => null,
			setSessionConfig: async () => [],
			onSessionConfigChanged: () => () => undefined,
		},

		terminal: {
			// 预览模式使用与主进程相同的 agent/project owner key
			list: async (target) => terminalTabs.filter((tab) => tab.ownerKey === terminalOwnerKeyFor(target)),
			ensure: async (target) => {
				const ownerKey = terminalOwnerKeyFor(target);
				const existing = terminalTabs.filter((tab) => tab.ownerKey === ownerKey);
				if (existing.length > 0) return existing;
				return [await createTerminalTab(target)];
			},
			create: (target, shell) => createTerminalTab(target, shell),
			input: async (tabId, data) => {
				for (const listener of terminalDataListeners) {
					listener({ tabId, data });
				}
			},
			acknowledge: async () => undefined,
			resize: async () => undefined,
			close: async (tabId) => {
				const index = terminalTabs.findIndex((tab) => tab.id === tabId);
				if (index >= 0) terminalTabs.splice(index, 1);
			},
			onData: (callback) => {
				terminalDataListeners.add(callback);
				return () => {
					terminalDataListeners.delete(callback);
				};
			},
			onExit: (callback) => {
				terminalExitListeners.add(callback);
				return () => {
					terminalExitListeners.delete(callback);
				};
			},
			shells: async () => [
				{ shell: "powershell", label: "PowerShell", available: true },
				{ shell: "pwsh", label: "pwsh", available: true },
				{ shell: "cmd", label: "cmd", available: true },
			],
			fonts: async () => [],
		},
	};
}
