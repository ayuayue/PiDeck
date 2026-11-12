import type { PiDesktopApi } from "../../../preload";

/**
 * pi 配置文件域桩：读写、备份列表与还原。
 */
export function createConfigPreview(): Pick<PiDesktopApi, "config" | "configBackups"> {
	return {
		config: {
			previewProviderMigration: async () => ({ direction: "pi-to-dsh" as const, providers: [] }),
			applyProviderMigration: async (direction, provider) => ({
				ok: true,
				provider,
				direction,
				copiedKey: false,
				wroteViaHost: false,
			}),
			getModels: async () => ({
				raw: '{"providers":{}}',
				parsed: { providers: {} },
			}),
			getAuth: async () => ({ raw: "{}", parsed: {} }),
			getSettings: async () => ({ raw: "{}", parsed: {} }),
			getTrust: async () => ({ raw: "{}", parsed: {} }),
			getRaw: async () => ({ raw: "{}" }),
			getMcp: async () => ({
				writablePath: "",
				writableFile: { mcpServers: {} },
				writableRaw: '{\n  "mcpServers": {}\n}\n',
				revision: "missing",
				lowerLayerNames: [],
				oauthCredentialNames: [],
				layers: [],
				servers: [],
				invalidServers: [],
			}),
			saveMcp: async () => ({ valid: true }),
			probeMcp: async () => ({ ok: true, transport: "stdio" as const, detail: "preview" }),
			// 预览模式无 pi CLI：连接检测返回空集，登录/登出静默失败，授权 URL 无订阅源。
			mcpListStatus: async () => ({ servers: [], errors: [] }),
			mcpLogin: async () => ({ ok: false, output: "preview" }),
			mcpLogout: async () => ({ ok: false, output: "preview" }),
			onMcpLoginUrl: () => () => undefined,
			// 预览模式无真实 pi 配置目录，返回占位（源文件页不显示路径行）。
			getConfigDir: async () => "",
			// 预览模式没有真实 settings.json：返回空摘要，开关操作直接失败。
			piResourcesSummary: async () => ({ settingsPath: "", exists: false, revision: "preview", builtins: [], entries: { extensions: [], skills: [], prompts: [], themes: [] } }),
			piResourcesSetBuiltin: async () => ({ ok: false, error: "preview" }),
			saveModels: async () => ({ valid: true, modelLoadOk: true, modelCount: 2, modelLoadReason: null, modelLoadDetail: "" }),
			// 预览模式无主进程验证链路：返回空订阅函数保持 API 形状一致。
			onModelsVerifyResult: () => () => {},
			saveAuth: async () => ({ valid: true }),
			saveSettings: async () => ({ valid: true }),
			saveRaw: async () => ({ valid: true }),
			export: async () =>
				JSON.stringify({
					version: 1,
					exportedAt: new Date().toISOString(),
					files: { "models.json": {}, "auth.json": {}, "settings.json": {}, "mcp.json": { mcpServers: {} } },
				}),
			import: async () => ({ valid: true }),
			// 设计预览：外部 agent 发现无真实文件可扫，返回空结果（不触真实文件系统）
			discoverExternalAgents: async () => ({ sources: [], providers: [] }),
			resolveExternalAgentKey: async () => ({ ok: false, error: "preview" }),
			fetchModels: async () => ({
				success: true,
				models: [
					{ id: "gpt-4o", name: "GPT-4o" },
					{ id: "gpt-4o-mini", name: "GPT-4o Mini" },
				],
			}),
			// 设计预览：内置 TokenDance 目录返回空（不触真实网络）
			getTokendanceModels: async () => ({ models: [], fromCache: false, at: 0 }),
			// 设计预览：价格徽章表同样为空（预览不请求报价端点）
			getTokendancePriceTags: async () => ({ tags: {}, at: 0 }),
			tokendanceAuthStart: async () => ({ ok: false, error: "preview" }),
			tokendanceAuthAwait: async () => ({ ok: false, error: "preview" }),
			tokendanceAuthCancel: async () => ({ ok: true }),
			tokendanceAuthExchange: async () => ({ ok: false, error: "preview" }),
			// 设计预览：充值接口不触真实网络（弹窗能看到完整链路，但创建会话必然失败）
			watchaAccess: async () => ({ ok: false, code: "not-configured" }),
			watchaOpenAlipay: async () => ({ ok: false, error: "unavailable in preview" }),
			tokendanceTopUpCreate: async () => ({ ok: false, code: "not-configured" }),
			tokendanceTopUpStatus: async () => ({ ok: false, code: "not-configured" }),
			tokendanceTopUpOpenAlipay: async () => ({ ok: false, error: "preview" }),
			installTokendance: async () => ({ ok: false, modelCount: 0, piSaved: false, dshSaved: false, error: "preview" }),
			testProvider: async () => ({
				success: true,
				model: "gpt-4o-mini",
				snippet: "Hello! How can I help you today?",
				tokens: { input: 8, output: 7 },
				latencyMs: 320,
			}),
			visionGetConfig: async () => ({
				config: null,
				configDir: "/tmp/preview/.pi/agent",
			}),
			visionSaveConfig: async () => ({ ok: true }),
			visionGetLog: async () => ({ exists: false, size: 0, content: "", truncated: false }),
			visionClearLog: async () => ({ ok: true }),
			visionGetEvents: async () => ({ exists: false, size: 0, events: [], truncated: false }),
			visionClearEvents: async () => ({ ok: true }),
			fetchUsage: async () => ({
				success: false,
				error: "preview",
			}),
			getUsageProbes: async () => ({ recognized: null, templates: [], errors: [] }),
			saveUsageProbes: async () => ({ ok: false, error: "preview" }),
			listUsageProbeStates: async () => ({ providers: {}, errors: [] }),
			testUsageProbe: async () => ({ success: false, error: "preview" }),
			installUsageSkill: async () => ({ success: false, error: "preview" }),
			installImageGenSkill: async () => ({ success: false, error: "preview" }),
			installMcpSetupSkill: async () => ({ success: false, error: "preview" }),
		},
		configBackups: {
			list: async () => ({ ok: true, backups: [] }),
			create: async () => ({ ok: true, id: "backup-preview.json" }),
			read: async () => null,
			restore: async () => ({ ok: false, error: "preview" }),
			delete: async () => ({ ok: true }),
			deleteMany: async () => ({ ok: true, deleted: 0 }),
			deleteAll: async () => ({ ok: true }),
		},
	};
}
