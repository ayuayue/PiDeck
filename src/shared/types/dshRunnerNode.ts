/** DSH 沙箱 runner 的 CUI node 探测来源。 */
export type DshRunnerNodeSource = "configured" | "path" | "known-location" | "env" | "sidecar" | "not-found";

/** 一次成功探测：绝对路径 + 版本号（如 24.13.0）。 */
export type DshRunnerNodeProbe = {
	resolvedPath: string;
	version: string;
};

/** 系统自动探测（忽略用户配置）。 */
export type DshRunnerNodeSystemProbe = DshRunnerNodeProbe & {
	source: Exclude<DshRunnerNodeSource, "configured" | "env" | "not-found">;
	/**
	 * PATH 命中是版本管理器垫片（mise/scoop/volta/chocolatey…）：能跑 `node -v`，
	 * 但绝不能当 Windows Job runner 的 spawn 目标——垫片会再转一次真实 node，
	 * runner 的 IPC 契约（fd3 ipc + fd4 control）过不去，run_code 会报清理失败。
	 */
	shimmed?: boolean;
};

/**
 * `dsh:detect-runner-node` 的返回值。
 * Windows 沙箱 runner 必须用 CUI node.exe（不能用 electron.exe），
 * 且主版本需与 DSH runtime 的 koffi ABI 对齐（当前钉 Node 24）。
 */
export type DshRunnerNodeInfo = {
	source: DshRunnerNodeSource;
	/** 实际会 spawn 的命令；未找到时为空。 */
	executable: string;
	resolvedPath: string;
	version: string;
	/** 失败原因，成功时为 null。 */
	error: string | null;
	/** 主版本是否满足 DSH runner ABI（Node 24）。 */
	compatible: boolean;
	system: DshRunnerNodeSystemProbe | null;
};

/** `dsh:install-runner-node`：把 Node 24 下到 userData，不改系统 PATH。 */
export type DshRunnerNodeInstallResult = {
	ok: boolean;
	path?: string;
	version?: string;
	error?: string;
};
