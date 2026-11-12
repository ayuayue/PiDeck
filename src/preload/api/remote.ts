/**
 * preload remote 域：远端主机：连接档案、传输、信任、远端会话与 WSL 档案。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe } from "./ipcHelpers";
import type { WslConnectionValidation } from "../../shared/types";

export const remoteApi = {
	remoteHosts: {
		/** 只读：列出已登记主机（不发请求、不启动 SSH）。功能未启用时返回稳定码。 */
		list: () => ipcRenderer.invoke(ipcChannels.remoteHostsList) as Promise<import("../../shared/types/remoteHost").RemoteHostListResult>,
		/** 连接一台主机。这是本组里唯一会启动真实 SSH 的方法；密码只随本次调用进入 main 内存。 */
		connect: (hostId: string, password?: string) => ipcRenderer.invoke(ipcChannels.remoteHostConnect, hostId, password) as Promise<import("../../shared/types/remoteHost").RemoteHostConnectResult>,
		/** 打开系统文件选择器挑选私钥；返回绝对路径。 */
		/** Edit an added host in place; an address change re-probes and re-pins in main. */
		update: (input: { hostId: string; patch: import("../../shared/types/remoteHost").RemoteHostUpdatePatch; secret?: string }) => ipcRenderer.invoke(ipcChannels.remoteHostUpdate, input) as Promise<import("../../shared/types/remoteHost").RemoteHostUpdateResult>,
		/** The edit form's starting values, including the stored secret (plaintext); null when none is saved. */
		editDraft: (hostId: string) => ipcRenderer.invoke(ipcChannels.remoteHostEditDraft, hostId) as Promise<import("../../shared/types/remoteHost").RemoteHostEditDraftResult>,
		pickIdentityFile: () => ipcRenderer.invoke(ipcChannels.remoteHostPickIdentityFile) as Promise<import("../../shared/types/remoteHost").RemoteHostPickIdentityFileResult>,
		/** 断开一台主机（不忘记已验证的 bootstrap，重连会复用）。 */
		disconnect: (hostId: string) => ipcRenderer.invoke(ipcChannels.remoteHostDisconnect, hostId) as Promise<import("../../shared/types/remoteHost").RemoteHostDisconnectResult>,
		/** 读取脱敏诊断历史（只读）。 */
		diagnostics: (hostId: string) => ipcRenderer.invoke(ipcChannels.remoteHostDiagnostics, hostId) as Promise<import("../../shared/types/remoteHost").RemoteHostDiagnosticsResult>,
		/** 扫描 ~/.ssh/config 列出可添加的候选（只读，不联网、不改配置）。 */
		scanConfig: () => ipcRenderer.invoke(ipcChannels.remoteHostScanConfig) as Promise<import("../../shared/types/remoteHost").RemoteHostConfigScanResult>,
		/** 添加主机：建立 draft、完成首次 host key 信任（TOFU）并落盘 pin；成功即 verified，可直接连接。 */
		add: (input: import("../../shared/types/remoteHost").RemoteHostAddInput) => ipcRenderer.invoke(ipcChannels.remoteHostAdd, input) as Promise<import("../../shared/types/remoteHost").RemoteHostAddResult>,
		test: (input: import("../../shared/types/remoteHost").RemoteHostAddInput) => ipcRenderer.invoke(ipcChannels.remoteHostTest, input) as Promise<import("../../shared/types/remoteHost").RemoteHostTestResult>,
		/** 探测远端 pi：必要时建立会话并读登录 shell 的 PATH；只读，不改任何配置。 */
		probePi: (hostId: string) => ipcRenderer.invoke(ipcChannels.remoteHostPiProbe, hostId) as Promise<import("../../shared/types/remoteHost").RemoteHostPiProbeResult>,
		/** 记住远端 pi 的绝对路径（null = 回到自动探测），并立刻重新探测。 */
		setPiPath: (hostId: string, path: string | null) => ipcRenderer.invoke(ipcChannels.remoteHostPiPath, hostId, path) as Promise<import("../../shared/types/remoteHost").RemoteHostPiProbeResult>,
		/** 移除连接：主进程先断开再退役 profile/pin；仍被项目引用时拒绝。 */
		remove: (hostId: string) => ipcRenderer.invoke(ipcChannels.remoteHostRemove, hostId) as Promise<import("../../shared/types/remoteHost").RemoteHostRemoveResult>,
		/** 只读列目录：path 缺省从远端 home 开始；只返回目录名。 */
		listDirs: (hostId: string, path?: string) => ipcRenderer.invoke(ipcChannels.remoteHostListDirs, hostId, path) as Promise<import("../../shared/types/remoteHost").RemoteDirectoryListResult>,
		/** WSL 连接档案：只读写本机档案，不启动 wsl.exe。 */
		listWslHosts: () => ipcRenderer.invoke(ipcChannels.remoteHostsWslList) as Promise<import("../../shared/types/wslHost").WslHostListResult>,
		addWslHost: (input: import("../../shared/types/wslHost").WslHostAddInput) => ipcRenderer.invoke(ipcChannels.remoteHostsWslAdd, input) as Promise<import("../../shared/types/wslHost").WslHostMutationResult>,
		updateWslHost: (id: string, patch: import("../../shared/types/wslHost").WslHostUpdateInput) => ipcRenderer.invoke(ipcChannels.remoteHostsWslUpdate, id, patch) as Promise<import("../../shared/types/wslHost").WslHostMutationResult>,
		removeWslHost: (id: string) => ipcRenderer.invoke(ipcChannels.remoteHostsWslRemove, id) as Promise<import("../../shared/types/wslHost").WslHostRemoveResult>,
		/** 订阅连接状态推送；返回 unsubscribe，组件卸载必须退订。 */
		onStateChange: (callback: (change: import("../../shared/types/remoteHost").RemoteHostStateChange) => void) => subscribe(ipcChannels.remoteHostStateChanged, callback),
		/**
		 * 订阅一个项目的目录/Git 事实变化（只标脏，不触发装载）：返回 unsubscribe。
		 * 订阅绑定 sender + project：主进程只推送这个项目的变化，别的项目不会串到本监听。
		 */
		onProjectFactsChanged: (projectId: string, callback: (change: import("../../shared/types/remoteHost").RemoteProjectFactsChange) => void) => {
			const handler = (_event: unknown, change: import("../../shared/types/remoteHost").RemoteProjectFactsChange) => {
				if (change?.projectId === projectId) callback(change);
			};
			ipcRenderer.on(ipcChannels.remoteProjectFactsChanged, handler);
			void ipcRenderer.invoke(ipcChannels.remoteProjectFactsSubscribe, projectId).catch(() => undefined);
			return () => {
				ipcRenderer.removeListener(ipcChannels.remoteProjectFactsChanged, handler);
				void ipcRenderer.invoke(ipcChannels.remoteProjectFactsUnsubscribe, projectId).catch(() => undefined);
			};
		},
		/** 只读：诊断 needs-repair 的原因与合法动作。 */
		diagnoseRepair: () => ipcRenderer.invoke(ipcChannels.remoteHostRepairDiagnose) as Promise<import("../../shared/types/remoteHost").RemoteHostRepairDiagnosisResult>,
		/** 发起修复：推送确认请求，用户回答后才真正执行。 */
		runRepair: (action: import("../../shared/types/remoteHost").RemoteHostRepairAction, hostId?: string) => ipcRenderer.invoke(ipcChannels.remoteHostRepairRun, action, hostId) as Promise<import("../../shared/types/remoteHost").RemoteHostRepairRunResult>,
		/** 回答修复确认：只能回答 main 签发的 requestId。 */
		answerRepair: (requestId: string, choice: "approve" | "deny") => ipcRenderer.invoke(ipcChannels.remoteHostRepairAnswer, requestId, choice) as Promise<import("../../shared/types/remoteHost").RemoteHostRepairAnswerResult>,
		/** 订阅修复确认请求；返回 unsubscribe。 */
		onRepairConfirm: (callback: (request: import("../../shared/types/remoteHost").RemoteHostRepairRequest) => void) => subscribe(ipcChannels.remoteHostRepairConfirm, callback),
		/** 重新绑定预检（只读）：返回计数与一次性确认 requestId；写入只发生在 answer 批准之后。 */
		planRebind: (sourceHostId: string, targetHostId: string) => ipcRenderer.invoke(ipcChannels.remoteHostRebindPlan, sourceHostId, targetHostId) as Promise<import("../../shared/types/remoteHost").RemoteHostRebindPlanResult>,
		/** 回答重新绑定确认；deny 不执行，approve 后开始且不可取消（设计 F2）。 */
		answerRebind: (requestId: string, choice: "approve" | "deny") => ipcRenderer.invoke(ipcChannels.remoteHostRebindAnswer, requestId, choice) as Promise<import("../../shared/types/remoteHost").RemoteHostRebindAnswerResult>,
		/** 只读：是否有未完成的重新绑定 journal（横幅用）。 */
		describeRebind: () => ipcRenderer.invoke(ipcChannels.remoteHostRebindDescribe) as Promise<import("../../shared/types/remoteHost").RemoteHostRebindDescribeResult>,
		/** 继续收敛残留 journal（幂等）。 */
		resumeRebind: () => ipcRenderer.invoke(ipcChannels.remoteHostRebindResume) as Promise<import("../../shared/types/remoteHost").RemoteHostRebindResumeResult>,
		/** 登记远端目录为持久项目：canonical 化并推送确认（推送经 onProjectEnrollConfirm 到达）。 */
		enrollProject: (hostId: string, path: string, mode?: "existing" | "create") => ipcRenderer.invoke(ipcChannels.remoteProjectEnroll, hostId, path, mode) as Promise<import("../../shared/types/remoteHost").RemoteProjectEnrollResult>,
		/** 回答登记确认：只能回答 main 签发的 requestId；批准后才写 ProjectStore。 */
		answerProjectEnroll: (requestId: string, choice: "approve" | "deny") => ipcRenderer.invoke(ipcChannels.remoteProjectAnswer, requestId, choice) as Promise<import("../../shared/types/remoteHost").RemoteProjectEnrollAnswerResult>,
		/** 订阅项目登记确认请求；返回 unsubscribe。 */
		onProjectEnrollConfirm: (callback: (request: import("../../shared/types/remoteHost").RemoteProjectEnrollRequest) => void) => subscribe(ipcChannels.remoteProjectEnrollConfirm, callback),
		/** 回答「新建空远端项目」确认：只能回答 main 签发的 requestId。 */
		answerProjectCreate: (requestId: string, choice: "approve" | "deny") => ipcRenderer.invoke(ipcChannels.remoteProjectCreateAnswer, requestId, choice) as Promise<import("../../shared/types/remoteHost").RemoteProjectCreateAnswerResult>,
		/** 订阅「新建空远端项目」确认请求（与既有目录登记确认分成两条推送）；返回 unsubscribe。 */
		onProjectCreateConfirm: (callback: (request: import("../../shared/types/remoteHost").RemoteProjectCreateRequest) => void) => subscribe(ipcChannels.remoteProjectCreateConfirm, callback),
		/** 按 projectId 列目录（相对路径；根为空串）。 */
		listProject: (projectId: string, path: string) => ipcRenderer.invoke(ipcChannels.remoteProjectList, projectId, path) as Promise<import("../../shared/types/remoteHost").RemoteProjectListResult>,
		/** 按 projectId 读文件（相对路径）；内容为 base64。 */
		readProjectFile: (projectId: string, path: string) => ipcRenderer.invoke(ipcChannels.remoteProjectRead, projectId, path) as Promise<import("../../shared/types/remoteHost").RemoteProjectReadResult>,
		openProjectText: (projectId: string, path: string): Promise<import("../../shared/types/remoteFiles").RemoteTextOpenResult> => ipcRenderer.invoke(ipcChannels.remoteProjectTextOpen, projectId, path),
		saveProjectText: (projectId: string, path: string, content: string, version: string): Promise<import("../../shared/types/remoteFiles").RemoteTextSaveResult> => ipcRenderer.invoke(ipcChannels.remoteProjectTextSave, projectId, path, content, version),
		/** 列出项目内回收站（只读、有界；不创建回收站目录）。 */
		listProjectTrash: (projectId: string) => ipcRenderer.invoke(ipcChannels.remoteProjectTrashList, projectId) as Promise<import("../../shared/types/remoteFiles").RemoteTrashListResult>,
		/** 还原回收站条目到 manifest 记录的原路径（目标必须不存在）。 */
		restoreProjectTrash: (projectId: string, trashId: string) => ipcRenderer.invoke(ipcChannels.remoteProjectTrashRestore, projectId, trashId) as Promise<import("../../shared/types/remoteFiles").RemoteTrashRestoreResult>,
		/** 永久删除回收站条目（显式确认即授权；invalid 条目不会被自动删除）。 */
		pruneProjectTrash: (projectId: string, trashIds: string[]) => ipcRenderer.invoke(ipcChannels.remoteProjectTrashPrune, projectId, trashIds) as Promise<import("../../shared/types/remoteFiles").RemoteTrashPruneResult>,
		/** 该项目已确认 root 的最近一次复核结果（只读；不建会话、不产生 helper 请求）。 */
		rootStatus: (projectId: string) => ipcRenderer.invoke(ipcChannels.remoteProjectRootStatus, projectId) as Promise<import("../../shared/types/remoteHost").RemoteProjectRootStatusResult>,
	},
	remoteTransfers: {
		/** Start one opaque upload/download job. Picker paths are resolved in main. */
		start: (input: import("../../shared/types/remoteTransfers").RemoteTransferStartInput) => ipcRenderer.invoke(ipcChannels.remoteProjectTransferStart, input) as Promise<import("../../shared/types/remoteTransfers").RemoteTransferStartReceipt>,
		/** Cancel by the original sender + project + opaque job id; repeated requests are idempotent. */
		cancel: (projectId: string, jobId: string) => ipcRenderer.invoke(ipcChannels.remoteProjectTransferCancel, projectId, jobId) as Promise<import("../../shared/types/remoteTransfers").RemoteTransferCancelReceipt>,
		/** One job yields monotonic progress frames and exactly one settlement frame. */
		onEvent: (callback: (event: import("../../shared/types/remoteTransfers").RemoteTransferEvent) => void) => subscribe(ipcChannels.remoteProjectTransferEvent, callback),
	},
	/**
	 * 远端项目 trust（P4.4b）：清单 / 决策 / 撤销。
	 *
	 * 渲染层只能按 `(hostId, 项目根)` 寻址：trust key、endpoint 摘要、指纹都不出主进程
	 *（返回的条目类型里结构上就没有这些字段，见 `shared/types/remoteTrust.ts`）。
	 * 决策只影响**下一次 spawn** 传给远端 pi 的参数（`--approve/--no-approve`）。
	 */
	/**
	 * 远端 Pi 模型目录（Phase 5 row 819 的“在目标主机执行模型拉取”）：只传 hostId，main 自己解析该主机的
	 * 远端项目并找一台存活的远端 runtime；返回的是脱敏 allowlist，不含 apiKey/baseUrl/agentId。
	 * 功能未启用或探测服务未装配时返回稳定码。
	 */
	probeRemoteModels: (hostId: string) => ipcRenderer.invoke(ipcChannels.remotePiModels, hostId) as Promise<import("../../shared/types/remoteModel").RemoteModelProbeResult>,
	remoteTrust: {
		/** 只读：列出已记录决策（含因 endpoint 变更已作废的条目）。功能未启用时返回稳定码。 */
		list: () => ipcRenderer.invoke(ipcChannels.remoteTrustList) as Promise<import("../../shared/types/remoteTrust").RemoteProjectTrustListResult>,
		/** 记录一条决策（approve=信任该项目根的 `.pi` 资源 / deny=不信任）；下一次 spawn 生效。 */
		set: (input: import("../../shared/types/remoteTrust").RemoteProjectTrustSetInput) => ipcRenderer.invoke(ipcChannels.remoteTrustSet, input.hostId, input.remoteRoot, input.decision) as Promise<import("../../shared/types/remoteTrust").RemoteProjectTrustSetResult>,
		/** 撤销某 (hostId, 项目根) 的决策（已作废的条目一并删除）。 */
		clear: (hostId: string, remoteRoot: string) => ipcRenderer.invoke(ipcChannels.remoteTrustClear, hostId, remoteRoot) as Promise<import("../../shared/types/remoteTrust").RemoteProjectTrustClearResult>,
	},
	/** 远端会话只读发现与登记（Phase 3 第三段）；本批无侧栏 UI，通道先按 IPC 契约收口。 */
	remoteSessions: {
		scan: (hostId: string, projectId: string) => ipcRenderer.invoke(ipcChannels.remoteSessionScan, hostId, projectId) as Promise<import("../../shared/types/remoteHost").RemoteSessionScanIpcResult>,
		register: (hostId: string, remoteSessionId: string) => ipcRenderer.invoke(ipcChannels.remoteSessionRegister, hostId, remoteSessionId) as Promise<import("../../shared/types/remoteHost").RemoteSessionRegisterIpcResult>,
		/** 按需解析标题（有界头读；头内没有权威名时再补一次有界尾读）；`titleOrigin` 三档：authoritative（名字字段）/ inferred（首条消息弱兜底）/ fallback（文件名 stem）。 */
		title: (hostId: string, remoteSessionId: string) => ipcRenderer.invoke(ipcChannels.remoteSessionTitle, hostId, remoteSessionId) as Promise<import("../../shared/types/remoteHost").RemoteSessionTitleIpcResult>,
	},
	/** WSL 相关操作（仅 Windows 有效） */
	wsl: {
		/** 获取已安装的 WSL 发行版列表 */
		listDistros: () => ipcRenderer.invoke(ipcChannels.wslListDistros) as Promise<string[]>,
		/** 验证 WSL 连接：检查 distro + user 是否可达，以及 pi 是否已安装 */
		validateConnection: (distro: string, user: string) => ipcRenderer.invoke(ipcChannels.wslValidateConnection, distro, user) as Promise<WslConnectionValidation>,
	},
};
