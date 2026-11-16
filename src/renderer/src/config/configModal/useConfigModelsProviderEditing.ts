import type { Dispatch, SetStateAction } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiConfigWriteOptions } from "../../../../shared/piConfig";
import type { FetchedModel, ConfigProxyMode } from "../../../../shared/types/fetchedModel";
import type { AuthFile, ModelsFile, SettingsFile } from "../configTypes";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { getProviderHeaders } from "../providerHeaders";
import { mergeProviderDraft, type AddProviderDraft } from "../addProviderDraft";
import { isValidProviderName } from "../../../../shared/providerName";
import { replaceModelThinkingLevels } from "../../../../shared/modelThinkingLevels";
import { replaceProviderHiddenIds, sameHiddenModelEntries } from "../hiddenModels";

type ConfigModelsProviderEditingDeps = {
	api: PiDesktopApi;
	/** WSL 目标的写选项：`undefined` = 本机（SSH 各自另走分支）。 */
	configTargetOption: PiConfigWriteOptions | undefined;
	modelsData: ModelsFile;
	setModelsData: Dispatch<SetStateAction<ModelsFile>>;
	authData: AuthFile;
	setAuthData: Dispatch<SetStateAction<AuthFile>>;
	settingsData: SettingsFile;
	setSettingsData: Dispatch<SetStateAction<SettingsFile>>;
	hiddenModels: string[];
	setHiddenModels: Dispatch<SetStateAction<string[]>>;
	expandedProvider: string | null;
	setExpandedProvider: Dispatch<SetStateAction<string | null>>;
	setAddingProvider: Dispatch<SetStateAction<boolean>>;
	setEditingProvider: Dispatch<SetStateAction<string | null>>;
	setDeleteConfirm: Dispatch<
		SetStateAction<{
			type: "provider" | "model" | "auth" | "batch";
			title: string;
			message: string;
			onConfirm: () => void;
		} | null>
	>;
	markDirty: (tabKey: string) => void;
	notify: (message: string) => void;
	setError: Dispatch<SetStateAction<string | null>>;
	/** 检测走通 /v1 时把表单 baseUrl 改成带版本路径（仅内存 + 脏标记）。 */
	applySuggestedBaseUrl: (providerName: string, suggestedBaseUrl?: string) => boolean;
	setFetchingProvider: Dispatch<SetStateAction<string | null>>;
	setFetchedModels: Dispatch<SetStateAction<Record<string, FetchedModel[]>>>;
	setFetchModelsErrorByProvider: Dispatch<SetStateAction<Record<string, string | undefined>>>;
	setTestingProvider: Dispatch<SetStateAction<string | null>>;
	setTestResult: Dispatch<
		SetStateAction<{
			providerName: string;
			success: boolean;
			model?: string;
			snippet?: string;
			tokens?: { input?: number; output?: number };
			latencyMs?: number;
			error?: string;
		} | null>
	>;
	testModelIdByProvider: Record<string, string>;
	testProxyModeByProvider: Record<string, ConfigProxyMode>;
};

/**
 * 根据 API 类型返回对应的获取模型提示。
 * 不同服务对 /models 端点的支持不同，提供针对性的指导。
 */
function getFetchModelsHintByApi(api: string | undefined, baseUrl: string): string {
	switch (api) {
		case "openai-completions":
			return t("config.fetchModelsHintOpenaiCompletions", { baseUrl });
		case "openai-responses":
			return t("config.fetchModelsHintOpenai", { baseUrl });
		case "openai-codex-responses":
			return t("config.fetchModelsHintOpenaiCodex");
		case "anthropic-messages":
			return t("config.fetchModelsHintAnthropic");
		case "google-generative-ai":
			return t("config.fetchModelsHintGoogle");
		case "mistral-conversations":
			return t("config.fetchModelsHintMistral");
		case "azure-openai-responses":
			return t("config.fetchModelsHintAzure");
		case "google-vertex":
			return t("config.fetchModelsHintVertex");
		case "bedrock-converse-stream":
			return t("config.fetchModelsHintBedrock");
		case "pi-messages":
			return t("config.fetchModelsHintPiMessages");
		default:
			// 未知 API 类型时使用通用提示
			return t("config.fetchModelsHint");
	}
}

/**
 * 模型页的「供应商级」动作：新增/编辑/删除/复制/批量删除供应商、拉取模型列表、测试连接。
 * 只搬数据与 IPC 动作，不渲染；列表级动作（模型行的增删改）在 useConfigModelRowsEditing。
 */
export function useConfigModelsProviderEditing(deps: ConfigModelsProviderEditingDeps) {
	const {
		api,
		configTargetOption,
		modelsData,
		setModelsData,
		authData,
		setAuthData,
		settingsData,
		setSettingsData,
		hiddenModels,
		setHiddenModels,
		expandedProvider,
		setExpandedProvider,
		setAddingProvider,
		setEditingProvider,
		setDeleteConfirm,
		markDirty,
		notify: showToast,
		setError,
		applySuggestedBaseUrl,
		setFetchingProvider,
		setFetchedModels,
		setFetchModelsErrorByProvider,
		setTestingProvider,
		setTestResult,
		testModelIdByProvider,
		testProxyModeByProvider,
	} = deps;

	/**
	 * 供应商页确认后落盘两项「按 provider/modelId 建键」的设置（新增与编辑共用）。
	 *
	 * 页面把这两份设置整页读进草稿，确认时交回**绝对快照**，所以这里是替换而不是增删：
	 * 页内删掉的模型不会留下设置（设置跟着模型走），页内改名也不会把键留在旧名字下。
	 * 草稿里没带某项 = 页面没有这个入口（settings 未加载 / 未提供隐藏列表）→ 该项一个都不动。
	 */
	const applyProviderPageModelSettings = (draft: AddProviderDraft, savedName: string, finalName: string) => {
		if (draft.modelThinkingLevelDefaults) {
			const nextSettings = replaceModelThinkingLevels(settingsData, savedName, finalName, draft.modelThinkingLevelDefaults);
			if (nextSettings !== settingsData) {
				setSettingsData(nextSettings);
				markDirty("config:settings");
			}
		}
		if (draft.hiddenModelIds) {
			// hiddenModels 是 AppSettings（没有配置草稿），与卡片眼睛按钮同一语义：立即持久化
			const nextHidden = replaceProviderHiddenIds(hiddenModels, savedName, finalName, draft.hiddenModelIds);
			if (!sameHiddenModelEntries(hiddenModels, nextHidden)) {
				setHiddenModels(nextHidden);
				void api.settings.update({ hiddenModels: nextHidden }).catch(() => undefined);
			}
		}
	};

	const handleAddProvider = (draft: AddProviderDraft) => {
		const providerName = draft.name.trim();
		// 非法字符：提示规则，避免 DSH credentialRefFor 把含特殊字符的名字转成
		// 非法环境变量名 → 密钥读不到（弹窗内已禁用确定，这里仅兜底）。
		if (!isValidProviderName(providerName)) {
			showNotice(t("config.providerNameRule"));
			return;
		}
		const provider = mergeProviderDraft(undefined, draft);
		const updated = {
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: provider,
			},
		};
		setModelsData(updated);
		markDirty("config:models");
		// 页内草稿里的两项设置按最终名字落盘（新增时没有旧名字，savedName 传空）
		applyProviderPageModelSettings(draft, "", providerName);
		setExpandedProvider(providerName);
		setAddingProvider(false);
	};

	/**
	 * 编辑供应商（弹窗确认）：名字可改（走 rename 语义：provider key + auth key 同步），
	 * 字段与模型列表整体写回 modelsData。
	 */
	const handleEditProvider = (oldName: string, draft: AddProviderDraft) => {
		const newName = draft.name.trim();
		if (!isValidProviderName(newName)) {
			showNotice(t("config.providerNameRule"));
			return;
		}
		if (newName !== oldName && modelsData.providers[newName]) {
			showNotice(t("config.providerNameDuplicate"));
			return;
		}
		// 编辑页保存以原 provider 为基底合并：保留表单不拥有的高级字段
		// （oauth / authHeader / modelOverrides / 自定义字段与自定义 headers），
		// 避免「编辑页重建 provider」把未知字段静默丢掉（与卡片内联编辑行为对齐）。
		const provider = mergeProviderDraft(modelsData.providers[oldName], draft);
		const providers = { ...modelsData.providers };
		if (newName !== oldName) {
			// 改名：新 key 承接旧 provider，删旧 key；auth.json 同步（pi 按新名称查认证）。
			providers[newName] = provider;
			delete providers[oldName];
			if (authData[oldName]) {
				const updatedAuth = { ...authData };
				updatedAuth[newName] = updatedAuth[oldName];
				delete updatedAuth[oldName];
				setAuthData(updatedAuth);
				markDirty("config:auth");
			}
			if (expandedProvider === oldName) setExpandedProvider(newName);
		} else {
			providers[oldName] = provider;
		}
		setModelsData({ ...modelsData, providers });
		markDirty("config:models");
		// 页内草稿的两项设置按最终名字替换式落盘：改名时旧名字下的键一并清掉（无需单独的改名迁移）
		applyProviderPageModelSettings(draft, oldName, newName);
		setEditingProvider(null);
	};

	const handleDeleteProvider = (name: string) => {
		setDeleteConfirm({
			type: "provider",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name }),
			onConfirm: () => {
				const providers = { ...modelsData.providers };
				delete providers[name];
				setModelsData({ ...modelsData, providers });
				markDirty("config:models");
				if (expandedProvider === name) setExpandedProvider(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDuplicateProvider = (name: string) => {
		const sourceProvider = modelsData.providers[name];
		if (!sourceProvider) return;

		// 生成新名称：用连字符后缀（符合 provider 名严格白名单，避免空格/特殊字符）。
		let newName = `${name}-copy`;
		let counter = 2;
		while (modelsData.providers[newName]) {
			newName = `${name}-copy-${counter}`;
			counter++;
		}

		// 深拷贝 provider 配置，包括 models 数组（含 apiKey）。
		const duplicatedProvider = structuredClone(sourceProvider);

		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[newName]: duplicatedProvider,
			},
		});
		markDirty("config:models");
		// 同步 auth.json：复制后的 provider 若有独立 auth key，也需要复制，
		// 否则 pi 按新名称查不到认证 → 模型列表加载为空。
		if (authData[name]) {
			setAuthData({ ...authData, [newName]: { ...authData[name] } });
			markDirty("config:auth");
		}

		// 展开新复制的 provider
		setExpandedProvider(newName);
	};

	// 导入面板把合并结果写入未保存草稿；用户在配置页检查后点「保存」才落盘（设计决策 #7）
	const handleApplyModelsTransfer = (next: ModelsFile) => {
		setModelsData(next);
		markDirty("config:models");
	};

	const handleDeleteProviders = (names: string[]) => {
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("common.deleteBatchConfirm", { count: names.length }),
			onConfirm: () => {
				const providers = { ...modelsData.providers };
				for (const name of names) delete providers[name];
				setModelsData({ ...modelsData, providers });
				markDirty("config:models");
				if (names.includes(expandedProvider ?? "")) setExpandedProvider(null);
				setDeleteConfirm(null);
			},
		});
	};

	// 从 provider 的 baseUrl + apiKey 拉取可用模型列表
	const handleFetchModels = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setFetchModelsErrorByProvider((prev) => ({
				...prev,
				[providerName]: t("config.missingBaseUrlApiKey"),
			}));
			return;
		}
		setFetchingProvider(providerName);
		setFetchModelsErrorByProvider((prev) => ({
			...prev,
			[providerName]: undefined,
		}));
		try {
			const result = await api.config.fetchModels(
				provider.baseUrl,
				provider.apiKey,
				provider.api as string | undefined,
				getProviderHeaders(provider.headers),
				// 拉取列表与测试同用 per-provider 代理选择（海外网关需代理时不用改全局开关）。
				testProxyModeByProvider[providerName] ?? "follow",
			);
			if (result.success && result.models) {
				setFetchedModels((prev) => ({
					...prev,
					[providerName]: result.models!,
				}));
				setFetchModelsErrorByProvider((prev) => ({
					...prev,
					[providerName]: undefined,
				}));
				const normalized = applySuggestedBaseUrl(providerName, result.suggestedBaseUrl);
				if (normalized && result.suggestedBaseUrl) {
					showToast(
						t("config.baseUrlAutoNormalized", {
							url: result.suggestedBaseUrl,
						}),
					);
				} else {
					showToast(t("config.fetchedModels", { count: result.models.length }));
				}
			} else {
				// 根据 API 类型提供不同的错误提示
				const apiTypeHint = getFetchModelsHintByApi(provider.api as string | undefined, provider.baseUrl);
				setFetchModelsErrorByProvider((prev) => ({
					...prev,
					[providerName]: (result.error ?? t("config.fetchModelsFailed")) + "\n" + apiTypeHint,
				}));
			}
		} catch (e) {
			setFetchModelsErrorByProvider((prev) => ({
				...prev,
				[providerName]: e instanceof Error ? e.message : String(e),
			}));
		} finally {
			setFetchingProvider(null);
		}
	};

	// 测试 provider 连接：先落盘表单配置，再用真实 pi 做一次最小调用。
	// 保存的目的：pi 只读磁盘上的 models.json（baseUrl/apiKey 都从那里解析），
	// 用真实 pi 测试才能与会话结果一致（不再用 net.fetch 模拟请求）。
	const handleTestProvider = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setError(t("config.missingBaseUrlApiKey"));
			return;
		}
		// 确定测试用的模型：优先用户指定的 testModelId，否则取第一个模型 id
		const modelId = (testModelIdByProvider[providerName] ?? "").trim() || provider.models[0]?.id || "";
		if (!modelId) {
			setError(t("config.missingTestModel"));
			return;
		}
		setTestingProvider(providerName);
		setTestResult(null);
		setError(null);
		try {
			// 统一隔离探针：测「当前表单值」（含未保存修改），不落盘正式配置。
			// 测试 ≠ 保存：成功后仍需用户显式点保存按钮（与添加/编辑供应商页同一语义）。
			const result = await api.config.testProvider(providerName, modelId, provider, provider.apiKey ?? "", testProxyModeByProvider[providerName] ?? "follow");
			setTestResult({ providerName, ...result });
		} catch (e) {
			setTestResult({
				providerName,
				success: false,
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setTestingProvider(null);
		}
	};

	return {
		handleAddProvider,
		handleEditProvider,
		handleDeleteProvider,
		handleDuplicateProvider,
		handleApplyModelsTransfer,
		handleDeleteProviders,
		handleFetchModels,
		handleTestProvider,
	};
}
