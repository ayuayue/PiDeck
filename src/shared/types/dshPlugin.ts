/**
 * DSH 动态 Cordis 插件管理（G13 深化）的跨进程契约类型。
 * 与 src/main/dsh/pideckPluginBridge.ts 的视图/入参形状一一对应。
 */

/** 动态插件清单行（inventory 的安全 JSON 视图）。 */
export type DshPluginView = {
	pluginId: string;
	/** 归属会话（DSH host 的 sessionId，与 catalog 的 dshSessionId 对照）。 */
	agentId: string;
	packages: Array<{
		packageId: string;
		name: string;
		purpose: string;
		hasHostHalf: boolean;
		hasClientHalf: boolean;
	}>;
	currentPackageId?: string;
	nextPackageId?: string;
	activeRun?: { pluginRunId: string; packageId: string };
	status?: string;
	mode?: string;
	error?: string;
};

/** 静态 Loader 条目视图（pluginInventory 的安全 JSON 视图）。 */
export type DshStaticPluginView = {
	entryId: string;
	moduleName: string;
	enabled: boolean;
	fiberPhase: string | null;
	/**
	 * 条目来源：user = $DSH_HOME/cordis.patch.yml 用户补丁层声明（用户自装插件）；
	 * builtin = dsh base / 随包预设 / PiDeck 自有组合。缺省视为 builtin
	 * （旧 host 未带该字段时的兼容语义）。
	 */
	origin?: "builtin" | "user";
};

/** 卸载用户自装静态插件的入参（IPC dsh:plugin-user-uninstall）。 */
export type DshUserPluginUninstallInput = {
	/** 目标条目（与插件列表行一致）。 */
	entryId: string;
	moduleName: string;
	/** 同时把插件目录移入回收站；仅当目录位于 userData/dsh-plugins 下才生效。 */
	deleteFiles?: boolean;
};

/** 卸载用户自装静态插件的结果。 */
export type DshUserPluginUninstallResult = {
	/** 是否从 $DSH_HOME/cordis.patch.yml 移除了对应行（卸载的主体动作）。 */
	rowRemoved: boolean;
	/** 移除成功时的补丁文件备份路径（同目录 .bak-<时间戳>）。 */
	backupPath?: string;
	/** 同时移入回收站的插件目录（deleteFiles 且位于 PiDeck 管理目录时给出）。 */
	removedPluginDir?: string;
	/** rowRemoved=false / 删除文件失败时的原因。 */
	reason?: string;
	/** 文件删除失败但行已移除时的原因（不影响卸载主体动作）。 */
	fileError?: string;
	/** 保留了文件的插件目录（位于管理目录之外时给出，供用户手动删除）。 */
	keptPluginDir?: string;
};

/** 安装（define）入参。 */
export type DshPluginInstallInput = {
	sessionId: string;
	/** 3-6 个小写英文字母语义前缀；host 分配最终 pluginId。 */
	idPrefix: string;
	name: string;
	purpose: string;
	hostCode?: string;
	clientCode?: string;
};

/** 生命周期操作入参（run/stop/uninstall）。 */
export type DshPluginLifecycleInput = {
	sessionId: string;
	pluginId: string;
	packageId?: string;
	mode?: "run" | "update";
};

/** 桥 RPC 响应（主进程 rawFetch 解析用；{ ok:false } 时主进程抛 error 文本）。 */
export type DshPluginBridgeResponse<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 会话命令枚举桥（D15）的跨进程契约类型：host 侧 `ctx.commands.list(agent)`
 * 的 CommandDescriptor 安全 JSON 视图（pideck-command-bridge 服务）。
 */
export type DshCommandView = {
	/** 命令名（不带前导斜杠的小写名；Composer `/` 补全用）。 */
	name: string;
	/** 命令描述（host 注册表原文，`CommandDescriptor.description`）。 */
	description: string;
	/** 可选自由输入占位提示（`CommandDescriptor.input.hint`）。 */
	inputHint?: string;
};

/**
 * DSH 技能目录行（G7）：wire `skill.list` 的 SkillEntry 安全 JSON 视图。
 * 技能经 composer 的 `/name` 斜杠调用（dsh-tool-skill 在 pre-step 注入正文），
 * 本目录只做只读呈现，不做管理。
 */
export type DshSkillView = {
	/** Kebab-case 标识（composer 以 /name 引用）。 */
	name: string;
	/** 简短路由描述。 */
	description: string;
	/** 可选额外路由指导。 */
	whenToUse?: string;
	/** false = 用户专用技能（disable-model-invocation）：模型目录不可见、仅用户可调用。 */
	modelInvocable: boolean;
};
