/**
 * preload config 域：供应商/模型配置与配置备份。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe } from "./ipcHelpers";
import type { TokendanceAuthMode, TokendancePaymentSessionResult } from "../../shared/tokendance";
import type { AvailableModel, ConfigFileDiagnostic, FetchedModel, ModelsVerifyResult, VisionBridgeConfig } from "../../shared/types";
import type { ProviderUsageResult, UsageProbeSaveInput, UsageProbeSaveResult, UsageProbeSettingsResult, UsageProbeStatesResult, UsageProbeTestInput } from "../../shared/types/providerUsage";
import type { WatchaAccessResult } from "../../shared/watcha";

export const configApi = {
	config: {
		previewProviderMigration: (direction: import("../../shared/types/providerMigration").ProviderMigrationDirection) => ipcRenderer.invoke(ipcChannels.configPreviewProviderMigration, direction) as Promise<import("../../shared/types/providerMigration").ProviderMigrationPreview>,
		applyProviderMigration: (direction: import("../../shared/types/providerMigration").ProviderMigrationDirection, provider: string) => ipcRenderer.invoke(ipcChannels.configApplyProviderMigration, direction, provider) as Promise<import("../../shared/types/providerMigration").ProviderMigrationResult>,
		/** 目标路由（Batch B）：options 缺省 = 本机，shape/返回值与旧调用逐字兼容；ssh 目标返回 remote 元数据。 */
		getModels: (options?: import("../../shared/piConfig").PiConfigReadOptions) =>
			ipcRenderer.invoke(ipcChannels.configGetModels, options) as Promise<{
				raw: string;
				parsed: { providers: Record<string, unknown> };
				diagnostic?: ConfigFileDiagnostic;
				remote?: import("../../shared/piConfig").RemotePiConfigSnapshot;
			}>,
		getAuth: () =>
			ipcRenderer.invoke(ipcChannels.configGetAuth) as Promise<{
				raw: string;
				parsed: Record<string, unknown>;
				diagnostic?: ConfigFileDiagnostic;
			}>,
		getSettings: (options?: import("../../shared/piConfig").PiConfigReadOptions) =>
			ipcRenderer.invoke(ipcChannels.configGetSettings, options) as Promise<{
				raw: string;
				parsed: Record<string, unknown>;
				diagnostic?: ConfigFileDiagnostic;
				remote?: import("../../shared/piConfig").RemotePiConfigSnapshot;
			}>,
		getTrust: () =>
			ipcRenderer.invoke(ipcChannels.configGetTrust) as Promise<{
				raw: string;
				parsed: Record<string, unknown>;
				diagnostic?: ConfigFileDiagnostic;
			}>,
		getMcp: (scope?: import("../../shared/types/mcp").McpConfigScope) => ipcRenderer.invoke(ipcChannels.configGetMcp, scope) as Promise<import("../../shared/types/mcp").McpConfigSnapshot>,
		saveMcp: (data: import("../../shared/types/mcp").McpConfigFile, scope?: import("../../shared/types/mcp").McpConfigScope, expectedRevision?: string) =>
			ipcRenderer.invoke(ipcChannels.configSaveMcp, data, scope, expectedRevision) as Promise<{
				valid: boolean;
				error?: string;
				conflict?: boolean;
			}>,
		probeMcp: (definition: import("../../shared/types/mcp").McpServerDefinition) => ipcRenderer.invoke(ipcChannels.configProbeMcp, definition) as Promise<import("../../shared/types/mcp").McpProbeResult>,
		// pi mcp CLI：真实连接检测 + OAuth 登录/登出（仅命令路线；登录授权 URL 经 onMcpLoginUrl 推送）。
		mcpListStatus: (scope?: import("../../shared/types/mcp").McpConfigScope) => ipcRenderer.invoke(ipcChannels.mcpListStatus, scope) as Promise<import("../../shared/types/mcp").McpCliListResult>,
		mcpLogin: (server: string, timeoutSec?: number, scope?: import("../../shared/types/mcp").McpConfigScope, operationId?: string) => ipcRenderer.invoke(ipcChannels.mcpLogin, server, timeoutSec, scope, operationId) as Promise<{ ok: boolean; output: string }>,
		mcpLogout: (server: string, scope?: import("../../shared/types/mcp").McpConfigScope) => ipcRenderer.invoke(ipcChannels.mcpLogout, server, scope) as Promise<{ ok: boolean; output: string }>,
		onMcpLoginUrl: (callback: (payload: { server: string; scope?: import("../../shared/types/mcp").McpConfigScope; operationId?: string; url: string }) => void) => {
			const listener = (_event: Electron.IpcRendererEvent, payload: { server: string; scope?: import("../../shared/types/mcp").McpConfigScope; operationId?: string; url: string }) => callback(payload);
			ipcRenderer.on(ipcChannels.mcpLoginUrl, listener);
			return () => {
				ipcRenderer.removeListener(ipcChannels.mcpLoginUrl, listener);
			};
		},
		// 只读：pi 全局配置目录（源文件编辑页标注实际路径用）。
		getConfigDir: () => ipcRenderer.invoke(ipcChannels.configGetDir) as Promise<string>,
		// pi 原生资源配置（内置扩展开关 + 四类资源数组原文）；作用域同 MCP：全局页/项目页。
		piResourcesSummary: (scope?: import("../../shared/types/mcp").McpConfigScope) => ipcRenderer.invoke(ipcChannels.piResourcesSummary, scope) as Promise<import("../../shared/types/piResources").PiResourceConfigSummary>,
		piResourcesSetBuiltin: (input: { scope?: import("../../shared/types/mcp").McpConfigScope; name: import("../../shared/types/piResources").PiBuiltinExtension; enabled: boolean; expectedRevision?: string }) =>
			ipcRenderer.invoke(ipcChannels.piResourcesSetBuiltin, input) as Promise<import("../../shared/types/piResources").PiResourceToggleResult>,
		saveModels: (data: unknown, options?: import("../../shared/piConfig").PiConfigWriteOptions) =>
			ipcRenderer.invoke(ipcChannels.configSaveModels, data, options) as Promise<{
				valid: boolean;
				error?: string;
				/** 即时验证：刚写入的 models.json 解析出的模型数（不含 pi fork 验证） */
				modelLoadOk?: boolean;
				modelCount?: number;
				modelLoadReason?: string | null;
				modelLoadDetail?: string;
				/** ssh 目标成功回执（本机目标不出现）。 */
				remote?: import("../../shared/piConfig").RemotePiConfigWriteReceipt;
			}>,
		// 保存 models 后的后台 pi 验证结果（fork 真实 pi ~17s，仅失败时推送）。
		onModelsVerifyResult: (callback: (payload: ModelsVerifyResult) => void) => subscribe<ModelsVerifyResult>(ipcChannels.configModelsVerifyResult, callback),
		saveAuth: (data: unknown) =>
			ipcRenderer.invoke(ipcChannels.configSaveAuth, data) as Promise<{
				valid: boolean;
				error?: string;
			}>,
		saveSettings: (settings: Record<string, unknown>, options?: import("../../shared/piConfig").PiConfigWriteOptions) =>
			ipcRenderer.invoke(ipcChannels.configSaveSettings, settings, options) as Promise<{
				valid: boolean;
				error?: string;
				remote?: import("../../shared/piConfig").RemotePiConfigWriteReceipt;
			}>,
		/** 源文件页统一读取：缺省 options = 本机；wsl 回原文（+ 诊断），ssh 只回脱敏快照；auth.json 的 ssh 分支回派生视图（raw 为空）。 */
		getRaw: (fileName: string, options?: import("../../shared/piConfig").PiConfigReadOptions) =>
			ipcRenderer.invoke(ipcChannels.configGetRaw, fileName, options) as Promise<{
				raw: string;
				diagnostic?: ConfigFileDiagnostic;
				remote?: import("../../shared/piConfig").RemotePiConfigSnapshot;
				/* 仅 ssh + auth.json：provider / 凭据类型 / 已配置，没有任何凭据值或原文 */
				remoteAuth?: import("../../shared/piConfig").RemotePiAuthSnapshot;
			}>,
		/** 源文件级保存：本机/WSL 整文件原文；ssh 只认 expectedVersion+patch（body 被忽略）。 */
		saveRaw: (fileName: string, rawJson: string, options?: import("../../shared/piConfig").PiConfigWriteOptions) =>
			ipcRenderer.invoke(ipcChannels.configSaveRaw, fileName, rawJson, options) as Promise<{
				valid: boolean;
				error?: string;
				remote?: import("../../shared/piConfig").RemotePiConfigWriteReceipt;
				wsl?: import("../../shared/piConfig").WslPiConfigWriteReceipt;
			}>,
		export: () => ipcRenderer.invoke(ipcChannels.configExport) as Promise<string>,
		import: (packageJson: string) => ipcRenderer.invoke(ipcChannels.configImport, packageJson) as Promise<{ valid: boolean; error?: string }>,
		/** 只读扫描本机其他 agent（Claude Code/Codex/OpenCode/Gemini CLI）的供应商配置；API key 只以掩码返回 */
		discoverExternalAgents: () => ipcRenderer.invoke(ipcChannels.configDiscoverExternalAgents) as Promise<import("../../shared/types/externalAgentDiscovery").ExternalAgentDiscoveryResult>,
		/** 外部 agent 导入确认后按 sourceId 取真实 API key（一次性响应；渲染层立即写进未保存草稿） */
		resolveExternalAgentKey: (sourceId: string) => ipcRenderer.invoke(ipcChannels.configResolveExternalAgentKey, sourceId) as Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }>,
		/** 从 provider 的 baseUrl + apiKey 拉取可用模型列表；headers 允许 provider 自定义（含 User-Agent）；proxyMode=follow 跟随全局 / pi 走 PI 代理 / desktop 走桌面代理 / off 强制直连 */
		fetchModels: (baseUrl: string, apiKey: string, apiType?: string, headers?: Record<string, string>, proxyMode?: "follow" | "pi" | "desktop" | "off") =>
			ipcRenderer.invoke(ipcChannels.configFetchModels, { baseUrl, apiKey, apiType, headers, proxyMode }) as Promise<{
				success: boolean;
				models?: FetchedModel[];
				error?: string;
				suggestedBaseUrl?: string;
			}>,
		/** 内置 TokenDance 模型目录：主进程 live fetch + userData 缓存；force=true 强制刷新（渲染层“刷新目录”按钮用） */
		getTokendanceModels: (force?: boolean) =>
			ipcRenderer.invoke(ipcChannels.configGetTokendanceModels, force) as Promise<{
				models: AvailableModel[];
				fromCache: boolean;
				at: number;
			}>,
		/** TokenDance 公开报价派生的模型徽章表（model id → 折扣/免费）；空表 = 没拉到或该模型无优惠 */
		getTokendancePriceTags: () => ipcRenderer.invoke(ipcChannels.configGetTokendancePriceTags) as Promise<import("../../shared/tokendance").TokendancePriceTagResult>,
		/**
		 * 启动 TokenDance OAuth 授权（PKCE S256）：返回授权 URL + flowId（verifier 仅主进程持有）。
		 * mode 默认 callback（本地回环自动收 code）；主进程绑定失败会降级成 headless 并回 fallbackReason。
		 */
		tokendanceAuthStart: (mode?: TokendanceAuthMode) => ipcRenderer.invoke(ipcChannels.configTokendanceAuthStart, { mode }) as Promise<{ ok: true; flowId: string; authUrl: string; mode: TokendanceAuthMode; fallbackReason?: string } | { ok: false; error: string }>,
		/** 等回环回调自动送达的 code 并交换成 Key（callback 模式免粘贴主路径；超时/失败返回 error）。 */
		tokendanceAuthAwait: (flowId: string) => ipcRenderer.invoke(ipcChannels.configTokendanceAuthAwait, { flowId }) as Promise<{ ok: true; key: string } | { ok: false; error: string }>,
		/** 放弃授权：释放本地回环端口并丢弃 verifier（弹窗关闭/取消时必调）。 */
		tokendanceAuthCancel: (flowId: string) => ipcRenderer.invoke(ipcChannels.configTokendanceAuthCancel, { flowId }) as Promise<{ ok: boolean; error?: string }>,
		/** 用一次性授权 code 交换 TokenDance API Key；成功后 key 只在本次响应出现，须立即写入配置。 */
		tokendanceAuthExchange: (flowId: string, code: string) => ipcRenderer.invoke(ipcChannels.configTokendanceAuthExchange, { flowId, code }) as Promise<{ ok: true; key: string } | { ok: false; error: string }>,
		/**
		 * 创建 TokenDance 充值会话（amount 为整数元，1–100000）。
		 * 成功回 paymentUrl（PC 渲染二维码）/ alipayUrl（移动端深链，可能缺失）/ statusUrl。
		 */
		tokendanceTopUpCreate: (amount: number) => ipcRenderer.invoke(ipcChannels.configTokendanceTopUpCreate, { amount }) as Promise<TokendancePaymentSessionResult>,
		/** 查询充值会话状态（只接受主进程校验过的 status_url；3 秒轮询，expired_at 后停）。 */
		tokendanceTopUpStatus: (statusUrl: string) => ipcRenderer.invoke(ipcChannels.configTokendanceTopUpStatus, { statusUrl }) as Promise<TokendancePaymentSessionResult>,
		/** 在用户点击后唤起支付宝 App（仅 alipays:// 深链；移动端链路，PC 扫码不需要）。 */
		tokendanceTopUpOpenAlipay: (url: string) => ipcRenderer.invoke(ipcChannels.configTokendanceTopUpOpenAlipay, { url }) as Promise<{ ok: boolean; error?: string }>,
		/** 查「请作者喝咖啡」剩余次数 + 当次购买入口（经主进程边缘代理，渲染层不接触平台密钥）。 */
		watchaAccess: (force?: boolean) => ipcRenderer.invoke(ipcChannels.configWatchaAccess, { force: force === true }) as Promise<WatchaAccessResult>,
		/** 用户点击后唤起支付宝 App（仅 alipays:// 深链；正式环境购买链接就是这种）。 */
		watchaOpenAlipay: (url: string) => ipcRenderer.invoke(ipcChannels.configWatchaOpenAlipay, { url }) as Promise<{ ok: boolean; error?: string }>,
		/** 一键安装 TokenDance：供应商信息 + 目录模型写入 pi models.json 与 DSH llm-pi-ai；apiKey 可选（OAuth 后已持有）。 */
		installTokendance: (apiKey?: string) =>
			ipcRenderer.invoke(ipcChannels.configInstallTokendance, { apiKey }) as Promise<{
				ok: boolean;
				modelCount: number;
				piSaved: boolean;
				dshSaved: boolean;
				dshWroteViaHost?: boolean;
				error?: string;
			}>,
		/** 视觉桥：读取当前配置（模型列表由渲染层经 listModels 拉全量） */
		visionGetConfig: () =>
			ipcRenderer.invoke(ipcChannels.visionGetConfig) as Promise<{
				config: VisionBridgeConfig | null;
				configDir: string;
			}>,
		/** 视觉桥：保存配置（主进程白名单校验后写 ~/.pi/agent/pi-deck-vision.json） */
		visionSaveConfig: (config: VisionBridgeConfig) =>
			ipcRenderer.invoke(ipcChannels.visionSaveConfig, config) as Promise<{
				ok: boolean;
				error?: string;
			}>,
		/** 视觉桥：读取运行日志（诊断“走没走”，不含敏感字段） */
		visionGetLog: () =>
			ipcRenderer.invoke(ipcChannels.visionGetLog) as Promise<{
				exists: boolean;
				size: number;
				content: string;
				truncated: boolean;
			}>,
		/** 视觉桥：清空运行日志 */
		visionClearLog: () => ipcRenderer.invoke(ipcChannels.visionClearLog) as Promise<{ ok: boolean }>,
		/** 视觉桥：读取结构化转换事件（会话渲染层展示「请求详情」，不含敏感字段） */
		visionGetEvents: () =>
			ipcRenderer.invoke(ipcChannels.visionGetEvents) as Promise<{
				exists: boolean;
				size: number;
				events: Array<{
					ts: number;
					kind: "input" | "tool_result" | "request";
					model: string;
					prompt: string;
					totalDurationMs: number;
					items: Array<{
						index: number;
						imageHash?: string;
						mimeType: string;
						ok: boolean;
						error?: string;
						durationMs: number;
						cached: boolean;
						description?: string;
						outputTokens?: number;
					}>;
				}>;
				truncated: boolean;
			}>,
		/** 视觉桥：清空事件文件 */
		visionClearEvents: () => ipcRenderer.invoke(ipcChannels.visionClearEvents) as Promise<{ ok: boolean }>,
		/** 测试 provider 连接（隔离探针）：临时 agent 目录 + PI_CODING_AGENT_DIR 跑真实 pi，测当前表单值且不落盘；proxyMode 控制探针进程代理（同 fetchModels 语义，pi 侧走 PI 代理配置） */
		testProvider: (providerName: string, modelId: string, provider: unknown, apiKey: string, proxyMode?: "follow" | "pi" | "desktop" | "off") =>
			ipcRenderer.invoke(ipcChannels.configTestProvider, { providerName, modelId, provider, apiKey, proxyMode }) as Promise<import("../../shared/types/fetchedModel").PiModelProbeResult>,
		/** 查询 provider 用量/余额（主进程按 provider 名 + backend 路由；backend=dsh 走 $DSH_HOME 链路） */
		fetchUsage: (provider: string, backend?: "pi" | "dsh") => ipcRenderer.invoke(ipcChannels.configFetchUsage, { provider, backend }) as Promise<ProviderUsageResult>,
		/** 安装内置「用量查询自定义」技能模板到 ~/.pi/agent/skills/usage-probe */
		installUsageSkill: () => ipcRenderer.invoke(ipcChannels.configInstallUsageSkill) as Promise<{ success: boolean; path?: string; error?: string }>,
		/** 读取该 provider 的用量查询配置 + 内置模板自动识别（探针配置弹窗数据源；backend=dsh 走 DSH 链路） */
		getUsageProbes: (provider: string, backend?: "pi" | "dsh") => ipcRenderer.invoke(ipcChannels.configGetUsageProbes, { provider, backend }) as Promise<UsageProbeSettingsResult>,
		/** 按 provider 合并保存用量查询配置（主进程校验后落盘，保留其它 providers 与旧 probes） */
		saveUsageProbes: (payload: UsageProbeSaveInput) => ipcRenderer.invoke(ipcChannels.configSaveUsageProbes, payload) as Promise<UsageProbeSaveResult>,
		/** 批量读取各 provider 用量查询状态（徽章开关 / 启动预热选源；只回开关/模板/间隔，不含密钥） */
		listUsageProbeStates: (payload: { providers?: string[]; backend?: "pi" | "dsh" } = {}) => ipcRenderer.invoke(ipcChannels.configListUsageProbeStates, payload) as Promise<UsageProbeStatesResult>,
		/** 单条模板测试（模板 id + 覆盖字段；provider 端点与密钥由主进程解析，不回传渲染层） */
		testUsageProbe: (payload: UsageProbeTestInput) => ipcRenderer.invoke(ipcChannels.configTestUsageProbe, payload) as Promise<ProviderUsageResult>,
		/** 安装内置「图片生成」技能模板到 ~/.pi/agent/skills/image-gen */
		installImageGenSkill: () => ipcRenderer.invoke(ipcChannels.configInstallImageGenSkill) as Promise<{ success: boolean; path?: string; error?: string }>,
		/** 安装内置「MCP 配置助手」技能模板到 ~/.pi/agent/skills/mcp-setup */
		installMcpSetupSkill: () => ipcRenderer.invoke(ipcChannels.configInstallMcpSetupSkill) as Promise<{ success: boolean; path?: string; error?: string }>,
	},
	configBackups: {
		/** 列出全部配置备份（仅元数据）。 */
		list: () => ipcRenderer.invoke(ipcChannels.configBackupList) as Promise<import("../../shared/types/backup").ConfigBackupListResult>,
		/** 立即创建一份配置备份（reason 只接受 manual；其余原因由主进程内部触发）。 */
		create: (reason?: import("../../shared/types/backup").ConfigBackupReason) => ipcRenderer.invoke(ipcChannels.configBackupCreate, reason ?? "manual") as Promise<import("../../shared/types/backup").ConfigBackupActionResult>,
		/** 读取备份详情（文件内容已脱敏）。 */
		read: (id: string) => ipcRenderer.invoke(ipcChannels.configBackupRead, id) as Promise<import("../../shared/types/backup").ConfigBackupDetail | null>,
		/** 恢复备份（恢复前主进程自动为当前配置建 pre-restore 保护备份）。
		 *  @param files 要恢复的文件 key 白名单（如 ["pi/models.json"]）；缺省 = 恢复全部。 */
		restore: (id: string, files?: string[]) => ipcRenderer.invoke(ipcChannels.configBackupRestore, id, files) as Promise<import("../../shared/types/backup").ConfigBackupActionResult>,
		/** 删除单个备份。 */
		delete: (id: string) => ipcRenderer.invoke(ipcChannels.configBackupDelete, id) as Promise<import("../../shared/types/backup").ConfigBackupActionResult>,
		/** 批量删除多个备份，返回实际删除数量。 */
		deleteMany: (ids: string[]) => ipcRenderer.invoke(ipcChannels.configBackupDeleteMany, ids) as Promise<import("../../shared/types/backup").ConfigBackupDeleteManyResult>,
		/** 清空全部备份。 */
		deleteAll: () => ipcRenderer.invoke(ipcChannels.configBackupDeleteAll) as Promise<import("../../shared/types/backup").ConfigBackupActionResult>,
	},
};
