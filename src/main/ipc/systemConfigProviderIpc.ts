/**
 * provider 模型 / 连通性 / 用量查询 IPC 域（自 systemIpc.ts 拆出：handler 体、通道、日志与文案逐字未改）。
 * 通道：config:fetch-models / config:test-provider / config:fetch-usage /
 * config:get-usage-probes / config:save-usage-probes / config:list-usage-probe-states /
 * config:test-usage-probe / config:install-usage-skill / config:install-image-gen-skill /
 * config:install-mcp-setup-skill。
 */
import { ipcMain } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { ConfigProxyMode } from "../../shared/types/fetchedModel";
import type { UsageProbeProviderConfig, UsageProbeTestInput } from "../../shared/types/providerUsage";
import type { ConfigManager } from "../config/ConfigManager";
import { rejectRemotePiConfigTarget } from "../config/PiConfigRouter";
import { isDeclarativeTemplateId } from "../config/usageProbeTemplates";
import { USAGE_PROBE_CANDIDATES } from "../config/providerUsageProbe";
import { saveUsageProbeForProvider } from "../config/userUsageProbes";
import { PROBE_AGENT_DIR_ENV, buildProbeDraftFiles } from "../pi/probeDraftConfig";
import { probePiModel } from "../pi/PiModelProber";
import { resolveConfigProxyTarget } from "../sessions/sessionProxyPolicy";
import type { AppLogger } from "../logging/AppLogger";
import type { PiLocator } from "../pi/PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SkillManager } from "../skills/SkillManager";

export type SystemConfigProviderIpcDeps = {
	configManager: ConfigManager;
	settingsStore: SettingsStore;
	appLogger: AppLogger;
	piLocator: PiLocator;
	skillManager: SkillManager;
};

export function registerSystemConfigProviderIpc(deps: SystemConfigProviderIpcDeps): void {
	const { configManager, settingsStore, appLogger, piLocator, skillManager } = deps;

	// 渲染层传入的代理模式收窄：非白名单一律回退 follow（跟随全局），保证 IPC 边界不信任任意字符串。
	function asConfigProxyMode(raw: unknown): ConfigProxyMode {
		return raw === "pi" || raw === "desktop" || raw === "off" ? raw : "follow";
	}

	ipcMain.handle(ipcChannels.configFetchModels, async (_event, payload: { baseUrl: string; apiKey: string; apiType?: string; headers?: Record<string, string>; proxyMode?: string; target?: unknown }) => {
		// remote target is explicitly deferred: the provider network call and its key must stay local-only.
		rejectRemotePiConfigTarget(payload?.target);
		// proxyMode 白名单收窄（渲染层不可信），再解析成主进程代理策略。
		const proxyTarget = resolveConfigProxyTarget(settingsStore.get(), asConfigProxyMode(payload?.proxyMode));
		const result = await configManager.fetchProviderModels(payload.baseUrl, payload.apiKey, payload.apiType, payload.headers, proxyTarget);
		void appLogger.info("config", "Provider models fetched", {
			baseUrl: payload.baseUrl,
			apiType: payload.apiType,
			modelCount: Array.isArray(result) ? result.length : undefined,
		});
		return result;
	});

	ipcMain.handle(ipcChannels.configTestProvider, async (_event, payload: unknown) => {
		// remote target is explicitly deferred: no local key/network may be used for another host.
		rejectRemotePiConfigTarget(payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { target?: unknown }).target : undefined);
		// 1) 边界校验：provider/model 名必须是有限的非空字符串；provider 必须是普通对象；
		//    key 只写临时目录且不落日志，但仍限制长度防滥用。
		const raw =
			payload && typeof payload === "object" && !Array.isArray(payload)
				? (payload as {
						providerName?: unknown;
						modelId?: unknown;
						provider?: unknown;
						apiKey?: unknown;
						proxyMode?: unknown;
					})
				: {};
		const providerName = typeof raw.providerName === "string" ? raw.providerName.trim() : "";
		const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
		const provider = raw.provider;
		const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
		if (!providerName || providerName.length > 128 || !modelId || modelId.length > 256 || !provider || typeof provider !== "object" || Array.isArray(provider) || apiKey.length > 4096) {
			return { success: false, error: "Invalid provider name or model id" };
		}

		// 2) 隔离探针：把「当前表单值」写进临时 agent 目录（models.json/auth.json + 正式
		//    settings.json 副本），PI_CODING_AGENT_DIR 指向它，探针结束后整目录删除。
		//    测的是用户眼前的值（含未保存修改），正式配置零接触——测试 ≠ 保存。
		const tempDir = await mkdtemp(join(tmpdir(), "pideck-probe-"));
		try {
			const settingsConfig = await configManager.getSettingsConfig();
			const { modelsJson, authJson, settingsJson } = buildProbeDraftFiles(providerName, provider as Record<string, unknown>, apiKey || undefined, settingsConfig.parsed);
			await writeFile(join(tempDir, "models.json"), modelsJson, "utf8");
			await writeFile(join(tempDir, "auth.json"), authJson, "utf8");
			// 正式 settings.json 副本：扩展注册的 api 协议靠它加载；空配置不写。
			if (settingsJson) await writeFile(join(tempDir, "settings.json"), settingsJson, "utf8");
			// 模型探针只跑本机 pi；WSL 内的自定义配置由该发行版的 pi 自己处理。
			const agentDirEnv = tempDir;
			// 3) 用真实 pi 做一次最小调用（走 pi 的 provider 解析 + SDK，与真实会话同路径）。
			//    测试连接显式选了代理时，把它覆盖到探针进程的代理环境（pi 侧只认 piProxy* 配置）。
			const result = await probePiModel(piLocator, settingsStore, providerName, modelId, resolveConfigProxyTarget(settingsStore.get(), asConfigProxyMode(raw.proxyMode)), { [PROBE_AGENT_DIR_ENV]: agentDirEnv });
			void appLogger.info("config", "Provider connection tested via pi (isolated)", {
				providerName,
				modelId,
				success: result.success,
				error: result.error,
			});
			return result;
		} finally {
			// 无论成败都清掉临时目录（含待测密钥），不留给磁盘。
			await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});
	ipcMain.handle(ipcChannels.configFetchUsage, async (_event, payload: { provider: string; backend?: "pi" | "dsh"; target?: unknown }) => {
		// usage query stays v1-disabled for remote targets (arbitrary probe templates are not redacted yet).
		rejectRemotePiConfigTarget(payload?.target);
		// 1) 边界校验：provider 名必须是有限的非空字符串，避免把任意 IPC 载荷当路径/URL 用。
		const provider = payload?.provider?.trim() ?? "";
		if (!provider || provider.length > 128) {
			return { success: false, error: "Invalid provider name" };
		}
		// backend 白名单：pi（缺省）/ dsh（DSH 链路：$DSH_HOME 配置 + 凭据库）。
		const backend = payload?.backend === "dsh" ? "dsh" : "pi";
		// 2) 主进程按 provider 名路由：门控（未开启）→ 端点解析 → 模板探测，key 不出主进程。
		const result = await configManager.fetchProviderUsage(provider, backend);
		void appLogger.info("config", "Provider usage fetched", {
			provider,
			backend,
			success: result.success,
			error: result.error,
		});
		return { ...result, provider };
	});
	// ── 用量查询配置（usage-probes.json：per-provider 开关 + 模板） ──
	// 读取：该 provider 已保存配置 + 内置模板自动识别（弹窗打开时拉取）。
	ipcMain.handle(ipcChannels.configGetUsageProbes, async (_event, payload: unknown) => {
		const raw = payload && typeof payload === "object" ? (payload as { provider?: unknown; backend?: unknown }) : {};
		const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
		if (!provider || provider.length > 128) {
			return { success: false, error: "Invalid provider name" };
		}
		const backend = raw.backend === "dsh" ? "dsh" : "pi";
		return configManager.getUsageProbeSettings(provider, backend);
	});
	// 按 provider 合并保存：入口校验与落盘同一套规则，零错误才写（保留文件里其它 providers 与旧 probes）。
	ipcMain.handle(ipcChannels.configSaveUsageProbes, async (_event, payload: unknown) => {
		const input = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { provider?: unknown; config?: unknown; backend?: unknown }) : {};
		const provider = typeof input.provider === "string" ? input.provider.trim() : "";
		if (!provider || provider.length > 128) {
			return { ok: false, error: "Invalid provider name" };
		}
		const backend = input.backend === "dsh" ? "dsh" : "pi";
		const result = await saveUsageProbeForProvider(configManager.getUsageProbeConfigDir(backend), provider, input.config as UsageProbeProviderConfig);
		// 日志只记 provider 与结果；apiKey/accessToken 等字段一律不落日志。
		void appLogger.info("config", "Usage probe config saved", {
			provider,
			backend,
			ok: result.ok,
		});
		return result;
	});
	// 批量状态表（徽章开关 / 启动预热选源）：只回开关/模板/间隔，不回传任何密钥。
	ipcMain.handle(ipcChannels.configListUsageProbeStates, async (_event, payload: unknown) => {
		const raw = payload && typeof payload === "object" ? (payload as { backend?: unknown; providers?: unknown }) : {};
		const backend = raw.backend === "dsh" ? "dsh" : "pi";
		// 渲染层数据不可信：只接受字符串数组，并限制条目数（防超大 payload 触发 N 次解析）。
		const providers = Array.isArray(raw.providers) ? raw.providers.filter((name): name is string => typeof name === "string").slice(0, 512) : [];
		return configManager.listUsageProbeStates(backend, providers);
	});
	// 单条模板测试（弹窗「测试」按钮）：按模板 id + 覆盖字段构建候选，主进程解析端点与密钥。
	ipcMain.handle(ipcChannels.configTestUsageProbe, async (_event, payload: unknown) => {
		// usage query stays v1-disabled for remote targets.
		rejectRemotePiConfigTarget(payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { target?: unknown }).target : undefined);
		const input = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as UsageProbeTestInput) : ({} as UsageProbeTestInput);
		const provider = typeof input.provider === "string" ? input.provider.trim() : "";
		if (!provider || provider.length > 128) {
			return { success: false, error: "Invalid provider name" };
		}
		const template = typeof input.template === "string" ? input.template.trim() : undefined;
		// 白名单：声明式模板 id + 内置候选 templateId。火山方舟/sub2api 是声明式但不在候选表里
		// （它们没有内置默认 provider），必须显式放行，否则弹窗「测试」会被判成未知模板。
		if (template && !isDeclarativeTemplateId(template)) {
			// 内置模板 id 也接受（识别命中后的「测试」按钮走这条路径）。
			const knownBuiltin = USAGE_PROBE_CANDIDATES.some((c) => c.templateId === template);
			if (!knownBuiltin) {
				return { success: false, error: "Unknown template" };
			}
		}
		const result = await configManager.testUsageProbe({
			provider,
			backend: input.backend === "dsh" ? "dsh" : "pi",
			...(template ? { template } : {}),
			...(typeof input.apiKey === "string" ? { apiKey: input.apiKey } : {}),
			...(typeof input.baseUrl === "string" ? { baseUrl: input.baseUrl } : {}),
			...(typeof input.accessToken === "string" ? { accessToken: input.accessToken } : {}),
			...(typeof input.userId === "string" ? { userId: input.userId } : {}),
			// Cookie 模板字段：弹窗测试必须透传，否则构建候选时校验失败（必填三件套）。
			...(typeof input.cookie === "string" ? { cookie: input.cookie } : {}),
			...(typeof input.cookiePath === "string" ? { cookiePath: input.cookiePath } : {}),
			...(typeof input.valuePath === "string" ? { valuePath: input.valuePath } : {}),
			...(typeof input.currencyPath === "string" ? { currencyPath: input.currencyPath } : {}),
			// 火山方舟 AK/SK：必填透传（缺任一项模板构建即报错，测试按钮才能给出人话提示）。
			...(typeof input.accessKeyId === "string" ? { accessKeyId: input.accessKeyId } : {}),
			...(typeof input.secretAccessKey === "string" ? { secretAccessKey: input.secretAccessKey } : {}),
			// Sub2API 面板 JWT（可选）：透传后模板构建才会挂 panelBalance 追加余额请求。
			...(typeof input.panelJwt === "string" ? { panelJwt: input.panelJwt } : {}),
			// 配套 refresh token：JWT 过期时测试按钮也能就地续期（不落盘）。
			...(typeof input.panelRefreshToken === "string" ? { panelRefreshToken: input.panelRefreshToken } : {}),
			...(typeof input.timeoutSecs === "number" ? { timeoutSecs: input.timeoutSecs } : {}),
		});
		void appLogger.info("config", "Usage probe tested", {
			provider,
			backend: input.backend === "dsh" ? "dsh" : "pi",
			template: template ?? "(auto)",
			success: result.success,
		});
		return result;
	});
	// 安装内置「用量查询自定义」技能模板：从 app resources 复制 SKILL.md 到 PiDeck 专属技能目录
	// （只由 PiDeck spawn 时 --skill 注入，TUI 不扫）。
	// 幂等：内容直接覆盖；启动时也会自动安装（见 index.ts），此处保留手动触发兑底。
	ipcMain.handle(ipcChannels.configInstallUsageSkill, async () => {
		const result = await skillManager.installTemplate("usage-probe");
		if (result.success) {
			void appLogger.info("skill", "Usage probe skill template installed", { path: result.path });
			return { success: true, path: result.path };
		}
		void appLogger.warn("skill", "Failed to install usage probe skill template", { error: result.error });
		return { success: false, error: result.error };
	});

	// 内置生图技能手动安装入口：与 usage-probe 同理，供 UI/调试触发兑底（启动时已自动装，此处幂等覆盖）。
	ipcMain.handle(ipcChannels.configInstallImageGenSkill, async () => {
		const result = await skillManager.installTemplate("image-gen");
		if (result.success) {
			void appLogger.info("skill", "Image-gen skill template installed", { path: result.path });
			return { success: true, path: result.path };
		}
		void appLogger.warn("skill", "Failed to install image-gen skill template", { error: result.error });
		return { success: false, error: result.error };
	});

	// 内置「MCP 配置助手」技能安装入口：MCP 页「让 AI 帮你配」按钮触发（幂等覆盖，重装即更新模板）。
	ipcMain.handle(ipcChannels.configInstallMcpSetupSkill, async () => {
		const result = await skillManager.installTemplate("mcp-setup", "pi-global");
		if (result.success) {
			void appLogger.info("skill", "MCP setup skill template installed", { path: result.path });
			return { success: true, path: result.path };
		}
		void appLogger.warn("skill", "Failed to install mcp-setup skill template", { error: result.error });
		return { success: false, error: result.error };
	});
}
