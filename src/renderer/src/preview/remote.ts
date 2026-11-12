import type { PiDesktopApi } from "../../../preload";

/**
 * 远程主机、远程会话与 WSL 执行环境的桩：预览环境一律返回 REMOTE_FEATURE_DISABLED。
 */
export function createRemotePreview(): Pick<PiDesktopApi, "remoteHosts" | "remoteTransfers" | "remoteSessions" | "remoteTrust" | "probeRemoteModels" | "wsl"> {
	return {
		remoteHosts: {
			// 预览模式没有主进程，也没有远端主机库：返回空目录而非报错，让列表页在静态预览下可渲染。
			// 连接类方法一律报「功能未启用」——预览环境不存在真实 SSH，静默假装成功会误导 UI。
			list: async () => ({ ok: true as const, status: "ready" as const, hosts: [] }),
			update: async () => ({ ok: false as const, hostId: "", code: "REMOTE_FEATURE_DISABLED" }),
			editDraft: async (hostId: string) => ({ ok: false as const, hostId, code: "REMOTE_FEATURE_DISABLED" }),
			pickIdentityFile: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			connect: async (hostId) => ({ ok: false as const, hostId, code: "REMOTE_FEATURE_DISABLED" }),
			disconnect: async (hostId) => ({ ok: false as const, hostId, code: "REMOTE_FEATURE_DISABLED" }),
			diagnostics: async (hostId) => ({ ok: false as const, hostId, code: "REMOTE_FEATURE_DISABLED" }),
			scanConfig: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			add: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			test: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			probePi: async (hostId: string) => ({ ok: false as const, hostId, code: "REMOTE_FEATURE_DISABLED" }),
			setPiPath: async (hostId: string) => ({ ok: false as const, hostId, code: "REMOTE_FEATURE_DISABLED" }),
			remove: async (hostId) => ({ ok: false as const, hostId, code: "REMOTE_FEATURE_DISABLED" }),
			listDirs: async (hostId) => ({ ok: false as const, hostId, code: "REMOTE_FEATURE_DISABLED" }),
			listWslHosts: async () => ({ ok: true as const, hosts: [] }),
			addWslHost: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			updateWslHost: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			removeWslHost: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			onStateChange: () => () => undefined,
			onProjectFactsChanged: () => () => undefined,
			diagnoseRepair: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			runRepair: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			answerRepair: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			onRepairConfirm: () => () => undefined,
			planRebind: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			answerRebind: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			describeRebind: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			resumeRebind: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			enrollProject: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			answerProjectEnroll: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			onProjectEnrollConfirm: () => () => undefined,
			answerProjectCreate: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			onProjectCreateConfirm: () => () => undefined,
			listProject: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			readProjectFile: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			openProjectText: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			saveProjectText: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			listProjectTrash: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			restoreProjectTrash: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			pruneProjectTrash: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			rootStatus: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
		},
		remoteTransfers: {
			start: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			cancel: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			onEvent: () => () => undefined,
		},
		remoteSessions: {
			scan: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			register: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			title: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
		},
		remoteTrust: {
			// 预览模式没有主进程、也没有主机 pin 事实：清单返回空表而非报错（静态预览下提示条/清单
			// 仍可渲染成「未决策」），写操作一律报「功能未启用」——静默假装成功会误导 UI。
			list: async () => ({ ok: true as const, value: { entries: [] } }),
			set: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			clear: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
		},
		// 预览模式没有主进程/远端 runtime：目录探测只报稳定码，不伪造模型列表。
		probeRemoteModels: async () => ({ ok: false as const, code: "REMOTE_MODEL_PROBE_UNAVAILABLE" }),

		wsl: {
			listDistros: async () => ["Ubuntu", "Debian"],
			validateConnection: async (_distro, _user) => ({
				ok: true,
				whoami: "preview",
				piVersion: "preview",
				piPath: "/usr/local/bin/pi",
				error: "",
			}),
		},
	};
}
