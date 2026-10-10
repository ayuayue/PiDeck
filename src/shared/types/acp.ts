/**
 * ACP（Agent Client Protocol）后端的跨进程契约。
 *
 * backend="acp" 的会话由外部 ACP agent CLI（gemini --acp / opencode acp /
 * kimi acp / codex-acp …）驱动；PiDeck 是通用 ACP client。用户在设置里登记
 * CLI 工具（AcpToolConfig），会话记录用 acpToolId 引用。
 */

/** 用户登记的一个 ACP agent CLI 工具。 */
export type AcpToolConfig = {
	/** 稳定 id（randomUUID）；会话记录 acpToolId 引用它，删除工具后旧会话只读降级。 */
	id: string;
	/** 显示名（如 "Gemini CLI"）；用户可改。 */
	name: string;
	/** 可执行命令（如 "gemini"、"npx"）；Windows .cmd 垫片由 PiLocator 启动通道还原。 */
	command: string;
	/** 启动参数（如 ["--acp"]）。 */
	args: string[];
	/** 追加注入子进程的环境变量（如 codex-acp 需要 ZAI_CODING_KEY）；键名限 [A-Za-z0-9_]，值不落日志。 */
	env?: Record<string, string>;
	/** 禁用后不出现在新建会话选择中；已建会话不受影响。 */
	enabled: boolean;
};

/** 保存/校验时的表单输入形态：id 缺省 = 新增行（主进程分配）；enabled 不参与编辑（保留服务端原值）。 */
export type AcpToolInput = {
	id?: string;
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
};

/** settings.acpTools 的运行时形态（数组保序，展示顺序即登记顺序）。 */
export type AcpToolsSettings = {
	tools: AcpToolConfig[];
};

/** 新建/编辑工具时的 IPC 输入校验产物：规范化后的字段与拒绝原因。 */
export type AcpToolValidation = {
	ok: boolean;
	/** 拒绝时的 i18n key（渲染层本地化）。 */
	reasonKey?: "acp.toolNameRequired" | "acp.toolCommandRequired" | "acp.toolDuplicateName" | "acp.toolInvalidCharacters";
};

/** 预设工具的安装状态（设置页徽章数据源；主/渲染共享契约）。 */
export type AcpToolStatus = {
	presetId: import("../acpToolPresets").AcpToolPresetId;
	/** installed=命令存在且 --version 成功；missing=命令不存在；npx-ready=npx 按需形态（node/npm 可用即永远可跑）；unknown=检测自身失败。 */
	state: "installed" | "missing" | "npx-ready" | "unknown";
	/** 版本号（解析自 --version 首个语义版本词）；npx-ready 时为 npm 版本。 */
	version?: string;
};

/** 安装/卸载进度事件（主→渲染 webContents 推送；preload 白名单转发）。 */
export type AcpLifecycleEvent = { presetId: import("../acpToolPresets").AcpToolPresetId; phase: "line"; line: string } | { presetId: import("../acpToolPresets").AcpToolPresetId; phase: "done"; ok: boolean; output: string };

/** 会话级配置选项(ACP configOptions 规范的渲染层 DTO,与主进程协议类型同构)。 */
export type AcpSessionConfigOption = {
	id: string;
	name: string;
	description?: string;
	type?: "select" | "boolean";
	currentValue?: string | boolean;
	options?: Array<{ value: string; name: string; description?: string } | { group: string; name: string; options: Array<{ value: string; name: string; description?: string }> }>;
	/** 语义类别(mode/model/model_config/thought_level):渲染层按它分组呈现。 */
	category?: string;
};

/** configOptions 变更事件载荷(按 agentId 隔离,渲染层按当前 runtime 过滤迟到结果)。 */
export type AcpSessionConfigChangedEvent = { agentId: string; options: AcpSessionConfigOption[] };

/** ACP agent 在 initialize/session 握手后暴露给 UI 的能力快照。 */
export type AcpAgentInfo = {
	/** initialize 返回的 agent 名（显示用，可能缺失）。 */
	name?: string;
	/** agent 声明的能力（loadSession / promptCapabilities / sessionCapabilities）。 */
	capabilities: {
		loadSession: boolean;
		agentThought: boolean;
		sessionList: boolean;
	};
	/** agent 声明的协议版本。 */
	protocolVersion: number;
};
