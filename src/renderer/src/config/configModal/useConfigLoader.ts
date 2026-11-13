import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiConfigTarget } from "../../../../shared/piConfig";
import type { ConfigFileDiagnostic } from "../../../../shared/types";
import { dirtyKeysClearedByReload, dirtyKeysPreservedOnReload } from "../configDirtyMarks";
import type { AuthFile, ConfigTab, ModelsFile, SettingsFile } from "../configTypes";
import { getProviderHeaders, KNOWN_PROVIDER_ENDPOINTS } from "../providerHeaders";
import { deepClone } from "../../utils/deepEqual";
import type { McpTabHandle } from "../McpTab";
import { normalizeModelsFile, parseJsonObject } from "./configModalStorage";

type ConfigLoaderDeps = {
	api: PiDesktopApi;
	/** 当前配置分页：raw 分页按它决定要读哪个源文件。 */
	tab: ConfigTab;
	/** 当前环境的稳定身份：ssh 目标不走本机读盘链路。 */
	targetKind: PiConfigTarget["kind"];
	/** WSL 目标的本地编辑器选项（undefined = 本机或 ssh）。 */
	configTargetOption: { target: PiConfigTarget } | undefined;
	/** 各 tab 的实时脏集合：带草稿的分页不被磁盘内容覆盖。 */
	dirtyTabsRef: RefObject<Set<string>>;
	/** 本机 MCP 页句柄：force 重载时让它自己重读。 */
	mcpTabRef: RefObject<McpTabHandle | null>;
	applySuggestedBaseUrl: (providerName: string, suggestedBaseUrl?: string) => boolean;
	clearDirty: (tabKey: string) => void;
	setLoading: Dispatch<SetStateAction<boolean>>;
	setError: Dispatch<SetStateAction<string | null>>;
	setConfigDiagnostic: Dispatch<SetStateAction<ConfigFileDiagnostic | null>>;
	setModelsData: Dispatch<SetStateAction<ModelsFile>>;
	setAuthData: Dispatch<SetStateAction<AuthFile>>;
	setSettingsData: Dispatch<SetStateAction<SettingsFile>>;
	setSettingsLoaded: Dispatch<SetStateAction<boolean>>;
	setTrustData: Dispatch<SetStateAction<Record<string, boolean>>>;
	setRawContent: Dispatch<SetStateAction<string>>;
	setRawFileName: Dispatch<SetStateAction<string>>;
	setWslMcpRaw: Dispatch<SetStateAction<string>>;
	setDiscoveredModels: Dispatch<SetStateAction<Record<string, Array<{ id: string; name?: string }>>>>;
	baselineModelsRef: RefObject<ModelsFile>;
	baselineAuthRef: RefObject<AuthFile>;
	baselineSettingsRef: RefObject<SettingsFile>;
	baselineTrustRef: RefObject<Record<string, boolean>>;
	baselineRawRef: RefObject<{ fileName: string; content: string }>;
	baselineWslMcpRef: RefObject<string>;
};

/**
 * Pi 配置分页的读盘链路（搬迁自 ConfigModal，行为不变）：
 * 本机与 WSL 目标共用同一套分支，带草稿的分页（dirtyKeysPreservedOnReload）不被磁盘内容覆盖，
 * force 才整页对齐磁盘；ssh 目标的所有分页由远端面板自加载，这里直接返回。
 */
export function useConfigLoader(deps: ConfigLoaderDeps) {
	const {
		api,
		tab,
		targetKind,
		configTargetOption,
		dirtyTabsRef,
		mcpTabRef,
		applySuggestedBaseUrl,
		clearDirty,
		setLoading,
		setError,
		setConfigDiagnostic,
		setModelsData,
		setAuthData,
		setSettingsData,
		setSettingsLoaded,
		setTrustData,
		setRawContent,
		setRawFileName,
		setWslMcpRaw,
		setDiscoveredModels,
		baselineModelsRef,
		baselineAuthRef,
		baselineSettingsRef,
		baselineTrustRef,
		baselineRawRef,
		baselineWslMcpRef,
	} = deps;

	const loadConfig = useCallback(
		async (target: ConfigTab, options?: { force?: boolean; silent?: boolean }) => {
			// OAuth 页的数据来自 pi 认证服务（listProviders）而不是配置文件：不走这条读盘链路。
			if (target === "oauth") return;
			// SSH 环境的所有配置页都是自加载的远端面板（脱敏快照 + patch 编辑）：本机读盘链路一次都不走，
			// 否则会把 Windows HOME 的配置当成那台主机的配置显示出来。
			if (targetKind === "ssh") return;
			// silent：测试连接成功后回读磁盘用——不置 loading，避免 ModelsTab 在
			// `!loading && ...` 条件下被卸载重建、滚动容器内容塔缩后 scrollTop 归零。
			if (!options?.silent) setLoading(true);
			setError(null);
			setConfigDiagnostic(null);
			try {
				// 切 tab 时不要把仍有草稿的内存冲掉；保存/导入传 force 才整页对齐磁盘。
				const preserved = options?.force ? new Set<string>() : dirtyKeysPreservedOnReload(target, dirtyTabsRef.current);
				const skipModels = preserved.has("config:models");
				const skipAuth = preserved.has("config:auth");
				const skipSettings = preserved.has("config:settings");
				const skipTrust = preserved.has("config:trust");
				const skipMcp = preserved.has("config:mcp");
				const skipRaw = preserved.has("config:raw");
				if (target === "models") {
					// 模型页也要 settingsData：每模型默认思考档位写的就是 settings.json 的
					// modelThinkingLevels（与全局默认档位同一条写入链路）。
					// settings 读失败只降级（本页主数据是 models.json），settingsLoaded 保持 false
					// 让编辑入口不渲染，避免空对象被当成磁盘内容保存。
					/** models 页数据落内存：本机与 WSL 目标共用同一条路径（settings 读失败只降级，settingsLoaded 保持 false）。 */
					const applyModelsTab = (res: Awaited<ReturnType<typeof api.config.getModels>>, settingsRes: Awaited<ReturnType<typeof api.config.getSettings>> | null) => {
						if (!skipModels) {
							const parsed = normalizeModelsFile(res.parsed);
							setModelsData(parsed);
							baselineModelsRef.current = deepClone(parsed);
						}
						if (settingsRes) {
							if (!skipSettings) {
								setSettingsData(settingsRes.parsed as SettingsFile);
								baselineSettingsRef.current = deepClone(settingsRes.parsed as SettingsFile);
							}
							setSettingsLoaded(true);
						}
						if (!skipRaw) {
							setRawContent(res.raw);
							setRawFileName("models.json");
							baselineRawRef.current = { fileName: "models.json", content: res.raw };
						}
						setConfigDiagnostic(res.diagnostic ?? null);
					};
					if (configTargetOption) {
						// WSL 目标：读该档案的发行版 HOME（models/settings 走结构化通道；auth/trust/mcp 各自按文件读）。
						const [res, settingsRes] = await Promise.all([api.config.getModels(configTargetOption), api.config.getSettings(configTargetOption).catch(() => null)]);
						applyModelsTab(res, settingsRes);
					} else {
						const [res, settingsRes] = await Promise.all([api.config.getModels(), api.config.getSettings().catch(() => null)]);
						applyModelsTab(res, settingsRes);
					}
				} else if (target === "auth") {
					// 本机用 ConfigManager 的 parsed 结果；WSL 走该发行版 HOME 的 auth.json 原文（同一份 JSON 形状）。
					const authRaw = configTargetOption ? await api.config.getRaw("auth.json", configTargetOption) : null;
					const parsed = configTargetOption && authRaw ? parseJsonObject<AuthFile>(authRaw.raw, {}) : ((await api.config.getAuth()).parsed as AuthFile);
					if (!skipAuth) {
						setAuthData(parsed);
						baselineAuthRef.current = deepClone(parsed);
					}
					const rawText = authRaw?.raw ?? JSON.stringify(parsed, null, 2);
					if (!skipRaw) {
						setRawContent(rawText);
						setRawFileName("auth.json");
						baselineRawRef.current = { fileName: "auth.json", content: rawText };
					}
					setConfigDiagnostic(authRaw?.diagnostic ?? null);
				} else if (target === "settings") {
					// 同时加载 settings、auth 和 models 数据，确保 defaultProvider / defaultModel 下拉能聚合所有可用信息。
					// WSL 的 auth.json 也属于该作用域（本机 UNC 读），但 provider 探针仍只在本机执行——见下面的发现循环门禁。
					const [settingsRes, authRes, modelsRes] = await Promise.all([
						api.config.getSettings(configTargetOption),
						configTargetOption ? api.config.getRaw("auth.json", configTargetOption).then((res) => ({ raw: res.raw, parsed: parseJsonObject<AuthFile>(res.raw, {}) })) : api.config.getAuth(),
						api.config.getModels(configTargetOption),
					]);
					if (!skipSettings) {
						setSettingsData(settingsRes.parsed as SettingsFile);
						baselineSettingsRef.current = deepClone(settingsRes.parsed as SettingsFile);
					}
					setSettingsLoaded(true);
					if (!skipAuth && authRes) {
						setAuthData(authRes.parsed as AuthFile);
						baselineAuthRef.current = deepClone(authRes.parsed as AuthFile);
					}
					if (!skipModels) {
						const parsed = normalizeModelsFile(modelsRes.parsed);
						setModelsData(parsed);
						baselineModelsRef.current = deepClone(parsed);
					}
					if (!skipRaw) {
						setRawContent(settingsRes.raw);
						setRawFileName("settings.json");
						baselineRawRef.current = { fileName: "settings.json", content: settingsRes.raw };
					}
					setConfigDiagnostic(settingsRes.diagnostic ?? null);

					// 对于 auth 中有但 models 中没有模型的供应商，自动尝试获取模型列表。
					// provider 探针只从本机网络出口发起：非本机环境即便读到 key 也不发请求（否则会把该环境的 key 用在本机网络上）。
					const authProviders: AuthFile = targetKind === "local" && authRes ? (authRes.parsed as AuthFile) : {};
					const modelsProviders = normalizeModelsFile(modelsRes.parsed).providers;
					const discovered: Record<string, Array<{ id: string; name?: string }>> = {};
					const fetchPromises: Array<Promise<void>> = [];

					for (const [providerName, authEntry] of Object.entries(authProviders)) {
						// 跳过已有模型的供应商
						if (modelsProviders[providerName]?.models?.length) continue;
						const apiKey = typeof authEntry.key === "string" ? authEntry.key : "";
						if (!apiKey) continue;

						// 情况1：从 KNOWN_PROVIDER_ENDPOINTS 获知该供应商的 API 端点
						const knownEndpoint = KNOWN_PROVIDER_ENDPOINTS[providerName];
						// 情况2：从 models.json 中该供应商的配置获知 baseUrl
						const modelsProvider = modelsProviders[providerName];
						const modelsBaseUrl = modelsProvider && typeof modelsProvider.baseUrl === "string" ? modelsProvider.baseUrl : undefined;
						const baseUrl = knownEndpoint?.baseUrl ?? modelsBaseUrl;
						if (!baseUrl) continue;

						const apiType = knownEndpoint?.apiType ?? (typeof modelsProvider?.api === "string" ? modelsProvider.api : undefined);

						fetchPromises.push(
							api.config
								.fetchModels(baseUrl, apiKey, apiType, getProviderHeaders(modelsProvider?.headers))
								.then((result) => {
									if (result.success && result.models) {
										discovered[providerName] = result.models;
										// 后台发现与手动「获取模型」同源：检测走通了 /v1 而 models.json 仍是根路径时
										// 同步改写表单 baseUrl（仅内存 + markDirty，用户保存才落盘），
										// 避免「列表拉到了、会话仍 404」。KNOWN_PROVIDER_ENDPOINTS 的
										// provider 不在 modelsData 里时该调用是 no-op。
										applySuggestedBaseUrl(providerName, result.suggestedBaseUrl);
									}
								})
								.catch(() => {
									// 静默失败，不阻塞 UI
								}),
						);
					}

					if (fetchPromises.length > 0) {
						// 不 await，在后台获取后更新状态即可
						void Promise.allSettled(fetchPromises).then(() => {
							if (Object.keys(discovered).length > 0) {
								setDiscoveredModels(discovered);
							}
						});
					}
				} else if (target === "trust") {
					const trustRaw = configTargetOption ? await api.config.getRaw("trust.json", configTargetOption) : null;
					const parsed = configTargetOption && trustRaw ? parseJsonObject<Record<string, boolean>>(trustRaw.raw, {}) : ((await api.config.getTrust()).parsed as Record<string, boolean>);
					if (!skipTrust) {
						setTrustData(parsed);
						baselineTrustRef.current = deepClone(parsed);
					}
					const rawText = trustRaw?.raw ?? JSON.stringify(parsed, null, 2);
					if (!skipRaw) {
						setRawContent(rawText);
						setRawFileName("trust.json");
						baselineRawRef.current = { fileName: "trust.json", content: rawText };
					}
					setConfigDiagnostic(trustRaw?.diagnostic ?? null);
				} else if (target === "mcp") {
					if (configTargetOption) {
						// WSL：MCP 页是「该发行版 mcp.json 的文本编辑」（探测/登录/模板仍在本机执行）。
						const res = await api.config.getRaw("mcp.json", configTargetOption);
						if (!skipMcp) {
							setWslMcpRaw(res.raw);
							baselineWslMcpRef.current = res.raw;
						}
						if (!skipRaw) {
							setRawContent(res.raw);
							setRawFileName("mcp.json");
							baselineRawRef.current = { fileName: "mcp.json", content: res.raw };
						}
						setConfigDiagnostic(res.diagnostic ?? null);
					} else {
						// 本机：MCP 页自己拉盘；这里只同步源文件编辑器和 force 重载。
						if (!skipRaw) {
							const res = await api.config.getMcp();
							setRawContent(res.writableRaw);
							setRawFileName("mcp.json");
							baselineRawRef.current = { fileName: "mcp.json", content: res.writableRaw };
						}
						if (options?.force && !skipMcp) void mcpTabRef.current?.reload();
					}
				} else if (target === "raw") {
					// 源文件 tab 复用当前 tab 对应的文件；读取统一走 config:get-raw（本机/WSL 回原文，mcp 取可写层）。
					const fileName = tab === "models" ? "models.json" : tab === "auth" ? "auth.json" : tab === "trust" ? "trust.json" : tab === "mcp" ? "mcp.json" : "settings.json";
					if (!skipRaw) setRawFileName(fileName);
					// 基准快照随内容一起更新：切文件后新旧草稿都以新文件为比较基准
					const res = await api.config.getRaw(fileName, configTargetOption);
					if (!skipRaw) {
						setRawContent(res.raw);
						baselineRawRef.current = { fileName, content: res.raw };
					}
					setConfigDiagnostic(res.diagnostic ?? null);
				}
				// 被跳过的脏草稿保持黄点；其余被磁盘覆盖的 key 必须清掉，否则保存后假脏。
				for (const key of dirtyKeysClearedByReload(target)) {
					if (!preserved.has(key)) clearDirty(key);
				}
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoading(false);
			}
		},
		[tab, targetKind, clearDirty, applySuggestedBaseUrl, configTargetOption],
	);

	return { loadConfig };
}
