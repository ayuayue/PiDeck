import type { Dispatch, SetStateAction } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiConfigWriteOptions } from "../../../../shared/piConfig";
import type { FetchedModel, ConfigProxyMode } from "../../../../shared/types/fetchedModel";
import type { ModelThinkingLevel } from "../../../../shared/modelThinkingLevels";
import type { AuthFile, ConfigTab, ModelsFile, SettingsFile } from "../configTypes";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { applyAdaptiveTemplateReset, collectModelSpecPatches, deriveProviderCompat, mergeAdaptiveModelTemplate } from "../../utils/modelSpecAutoFill";
import { getProviderHeaders, pruneModelOverrides, readModelOverrides, setModelUserAgentOverride } from "../providerHeaders";
import { pruneHiddenModelOrphans, sameHiddenModelEntries } from "../hiddenModels";
import { withModelThinkingLevelDefault, withModelThinkingLevelEnabled } from "../../../../shared/modelThinkingLevels";
import { removeSelectedModelIndexes } from "../modelBatchSelection";
import { modelIdIndex } from "./modelIdIndex";

type ConfigModelRowsEditingDeps = {
	api: PiDesktopApi;
	/** WSL 目标的写选项：`undefined` = 本机（SSH 各自另走分支）。 */
	configTargetOption: PiConfigWriteOptions | undefined;
	modelsData: ModelsFile;
	setModelsData: Dispatch<SetStateAction<ModelsFile>>;
	setSettingsData: Dispatch<SetStateAction<SettingsFile>>;
	hiddenModels: string[];
	setHiddenModels: Dispatch<SetStateAction<string[]>>;
	markDirty: (tabKey: string) => void;
	clearDirty: (tabKey: string) => void;
	/** 保存成功后的宿主回调（清未保存提示等）。 */
	onSaved: () => void;
	notify: (message: string) => void;
	setError: Dispatch<SetStateAction<string | null>>;
	setSaving: Dispatch<SetStateAction<boolean>>;
	/** 保存后按磁盘重载该页（force 会清空草稿保留集）。 */
	reloadConfig: (target: ConfigTab, options?: { force?: boolean; silent?: boolean }) => Promise<void>;
	setDeleteConfirm: Dispatch<
		SetStateAction<{
			type: "provider" | "model" | "auth" | "batch";
			title: string;
			message: string;
			onConfirm: () => void;
		} | null>
	>;
	setResettingModelKey: Dispatch<SetStateAction<string | null>>;
	testProxyModeByProvider: Record<string, ConfigProxyMode>;
};

/**
 * 模型页的「模型行级」动作：增删改模型、按能力目录重置为自适应、逐模型 UA/思考档位、保存 models.json。
 * 只搬数据与 IPC 动作，不渲染；供应商级动作在 useConfigModelsProviderEditing。
 */
export function useConfigModelRowsEditing(deps: ConfigModelRowsEditingDeps) {
	const { api, configTargetOption, modelsData, setModelsData, setSettingsData, hiddenModels, setHiddenModels, markDirty, clearDirty, onSaved, notify: showToast, setError, setSaving, reloadConfig, setDeleteConfirm, setResettingModelKey, testProxyModeByProvider } = deps;

	const handleAddModel = (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		// 新模型先保持未知字段为空：ID 失焦/保存时由端点元数据或唯一 catalog 候选补齐。
		// 不能在这里写 1M/128K/reasoning/image 这类猜测值，否则真正规格永远无法覆盖。
		const newModel = {
			id: "",
			name: "",
		};
		const updated = {
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...provider, models: [...provider.models, newModel] },
			},
		};
		setModelsData(updated);
		markDirty("config:models");
	};

	const handleUpdateModel = (providerName: string, index: number, field: string, value: unknown) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const models = [...provider.models];
		models[index] = { ...models[index], [field]: value };
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...provider, models },
			},
		});
		markDirty("config:models");
	};

	/**
	 * 重置为自适应：
	 * 1. 显式拉取当前 provider 的 /models，取当前 modelId 的实报字段（失败也继续，listing 视为空）；
	 * 2. 查询模型规格（运行中 pi 模型列表优先 + bundled pi-ai catalog 兜底，见 resolveModelSpecFromCatalogs）；
	 * 3. endpoint 实报优先合并，然后只覆盖模板有值的字段。模板未提供的容量字段保留手填值，
	 *    不落空——否则 Pi 按 128k 回退，用户手填的 1000000 被静默丢掉。
	 */
	const handleResetModelToAdaptive = async (providerName: string, index: number) => {
		const provider = modelsData.providers[providerName];
		const model = provider?.models[index];
		if (!provider || !model) return;
		setResettingModelKey(`${providerName}\u0000${index}`);
		try {
			let listing: FetchedModel | undefined;
			if (provider.baseUrl && provider.apiKey) {
				const result = await api.config.fetchModels(
					provider.baseUrl,
					provider.apiKey,
					provider.api as string | undefined,
					getProviderHeaders(provider.headers),
					// 与列表拉取 / 测试连接同用 per-provider 代理选择，否则需要代理的网关在这里会直连失败。
					testProxyModeByProvider[providerName] ?? "follow",
				);
				if (result.success && result.models) {
					listing = result.models.find((item) => item.id === model.id);
				}
			}
			const spec = await api.projects.getModelSpec(providerName, model.id, model.name).catch(() => null);
			const template = mergeAdaptiveModelTemplate(listing, spec, model.id);
			const nextModel = applyAdaptiveTemplateReset(model, template);
			const models = [...provider.models];
			models[index] = nextModel;
			setModelsData({
				...modelsData,
				providers: {
					...modelsData.providers,
					[providerName]: { ...provider, models },
				},
			});
			markDirty("config:models");
			showNotice(template.matchedId ? t("config.modelResetAdaptiveDone", { model: template.matchedId }) : t("config.modelResetAdaptiveKept"), 3000);
		} finally {
			setResettingModelKey(null);
		}
	};

	/**
	 * 逐模型 User-Agent：写 provider.modelOverrides[modelId].headers["User-Agent"]。
	 * 该结构由 pi 在发请求前最后合并（优先级高于 provider.headers），用于
	 * 「同一供应商里只有个别模型需要特殊 UA」的场景（如某个模型走 Response 协议）。
	 * 按 modelId 建键：卡片与编辑页共用同一回调，编辑页的模型草稿可能增删/重排，
	 * 不能用下标（草稿下标与已保存数组会错位，写错模型）。
	 */
	const handleUpdateModelUserAgent = (providerName: string, modelId: string, value: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider || !modelId) return;
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: {
					...provider,
					modelOverrides: setModelUserAgentOverride(provider.modelOverrides, modelId, value),
				},
			},
		});
		markDirty("config:models");
	};

	const handleUpdateModelThinkingLevel = (providerName: string, index: number, level: ModelThinkingLevel, enabled: boolean) => {
		const provider = modelsData.providers[providerName];
		const currentModel = provider?.models[index];
		if (!provider || !currentModel) return;
		const models = [...provider.models];
		const nextThinkingLevelMap = withModelThinkingLevelEnabled(currentModel.thinkingLevelMap, level, enabled);
		const nextModel = {
			...currentModel,
			// xhigh/max 只有 reasoning 模型才有意义；打开任意档位时同步开启。
			reasoning: enabled ? true : currentModel.reasoning,
		};
		if (nextThinkingLevelMap) {
			nextModel.thinkingLevelMap = nextThinkingLevelMap;
		} else {
			delete nextModel.thinkingLevelMap;
		}
		models[index] = nextModel;

		const nextProvider = enabled
			? {
					...provider,
					compat: {
						supportsDeveloperRole: false,
						...(provider.compat ?? {}),
						supportsReasoningEffort: true,
					},
				}
			: { ...provider };
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...nextProvider, models },
			},
		});
		markDirty("config:models");
	};

	/**
	 * 每模型默认思考档位：写 pi settings.json 的 modelThinkingLevels（键 `provider/modelId`），
	 * 与 Settings 页的全局默认档位共用同一条草稿保存链路（脏标记记在 config:settings 上）。
	 * 值不做白名单裁剪——档位最终由 pi 按该模型可用档位收敛；空值 = 删键（跟随全局默认）。
	 */
	const handleUpdateModelThinkingLevelDefault = (providerName: string, modelId: string, level: string) => {
		// 键由 provider/modelId 拼成；空 id（未填完的新行）无法定位。
		if (!modelId) return;
		setSettingsData((previous) => withModelThinkingLevelDefault(previous, providerName, modelId, level));
		markDirty("config:settings");
	};

	const handleDeleteModel = (providerName: string, index: number) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const model = provider.models[index];
		if (!model) return;
		setDeleteConfirm({
			type: "model",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name: `${providerName}/${model.id}` }),
			onConfirm: () => {
				const models = provider.models.filter((_, i) => i !== index);
				setModelsData({
					...modelsData,
					providers: {
						...modelsData.providers,
						[providerName]: { ...provider, models },
					},
				});
				markDirty("config:models");
				setDeleteConfirm(null);
			},
		});
	};

	const handleDeleteModels = (providerName: string, indexes: number[]) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const validIndexes = [...new Set(indexes)].filter((index) => Number.isInteger(index) && index >= 0 && index < provider.models.length);
		if (validIndexes.length === 0) return;
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("config.deleteModelsBatchConfirm", {
				provider: providerName,
				count: validIndexes.length,
			}),
			onConfirm: () => {
				setModelsData((current) => {
					const currentProvider = current.providers[providerName];
					if (!currentProvider) return current;
					return {
						...current,
						providers: {
							...current.providers,
							[providerName]: {
								...currentProvider,
								models: removeSelectedModelIndexes(currentProvider.models, new Set(validIndexes)),
							},
						},
					};
				});
				markDirty("config:models");
				setDeleteConfirm(null);
			},
		});
	};

	const handleSaveModels = async (): Promise<boolean> => {
		// 保存前按能力目录批量补全空字段（端点/用户值不覆盖；未命中留空）。
		const { providers: filledProviders, filledCount } = await collectModelSpecPatches(modelsData, (providerName, modelId, modelName) => api.projects.getModelSpec(providerName, modelId, modelName));
		const base = filledCount > 0 ? { ...modelsData, providers: filledProviders } : modelsData;
		// 保存前规范化所有供应商的 compat 字段，确保布尔值显式写入而不依赖后端默认值；
		// supportsReasoningEffort 联动档位映射、requiresReasoningContentOnAssistantMessages
		// 按 DeepSeek 特征判定（均见 deriveProviderCompat，传名字以便按 provider 名识别）。
		// 显式标注 providers：铺开的字面量会丢掉 ProviderConfig 的索引签名，后面读 modelOverrides 等
		// 高级字段就拿不到了（不靠 as 强转，靠变量标注把类型钉死）。
		const normalizedProviders: ModelsFile["providers"] = Object.fromEntries(
			Object.entries(base.providers).map(([name, provider]) => [
				name,
				{
					...provider,
					compat: deriveProviderCompat(provider, name),
				},
			]),
		);
		const normalizedData: ModelsFile = { ...base, providers: normalizedProviders };
		// 设置跟着模型走：保存前清掉「模型已不在列表里」的孤儿（改过模型 ID / 删过模型之后）。
		// 只清 models.json 里存在的供应商；pi 内置 provider 的高级覆盖一律不碰。
		const prunedProviders = Object.fromEntries(
			Object.entries(normalizedData.providers).map(([name, provider]) => {
				const current = readModelOverrides(provider.modelOverrides);
				if (!current) return [name, provider];
				const pruned = pruneModelOverrides(
					current,
					provider.models.map((model) => model.id),
				);
				if (pruned === current) return [name, provider];
				const nextProvider = { ...provider };
				if (pruned) nextProvider.modelOverrides = pruned;
				else delete nextProvider.modelOverrides;
				return [name, nextProvider];
			}),
		);
		const prunedData = { ...normalizedData, providers: prunedProviders };
		const prunedHidden = pruneHiddenModelOrphans(hiddenModels, modelIdIndex(prunedProviders));
		if (!sameHiddenModelEntries(hiddenModels, prunedHidden)) {
			setHiddenModels(prunedHidden);
			void api.settings.update({ hiddenModels: prunedHidden }).catch(() => undefined);
		}
		setSaving(true);
		setError(null);
		try {
			const result = await api.config.saveModels(prunedData, configTargetOption);
			if (!result.valid) {
				setError(result.error ?? t("config.saveFailed"));
				return false;
			}
			onSaved();
			clearDirty("config:models");
			// 保存成功后才把补全值写回 UI：失败时保留原值，下次保存会重新补全（幂等）
			if (filledCount > 0) {
				setModelsData(base);
			}
			// 即时反馈：主进程已解析刚写入的 models.json（0 fork），count 是本地配置的模型数。
			// fork 真实 pi 的完整验证在主进程后台进行（~17-21s），失败时由全局
			// useModelsVerifyNotifier 弹 toast——保存动作本身不再被验证阻塞。
			// 非本机目标没有本机模型加载校验（主进程不 fork 本机 pi），只报保存成功。
			if (result.modelLoadOk) showToast(t("config.modelsSavedVerified", { count: result.modelCount ?? 0 }));
			else if (configTargetOption) showToast(t("config.saved"));
			else showNotice(t("config.modelsSavedButEmpty"), 6000, "warning");
			await reloadConfig("models", { force: true });
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setSaving(false);
		}
	};

	return {
		handleAddModel,
		handleUpdateModel,
		handleResetModelToAdaptive,
		handleUpdateModelUserAgent,
		handleUpdateModelThinkingLevel,
		handleUpdateModelThinkingLevelDefault,
		handleDeleteModel,
		handleDeleteModels,
		handleSaveModels,
	};
}
