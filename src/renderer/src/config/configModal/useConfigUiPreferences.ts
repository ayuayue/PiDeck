import { useCallback, useEffect, useMemo, useState } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { AuthFile, ModelsFile } from "../configTypes";
import { buildProviderOrderScope } from "../../utils/providerOrder";
import { pruneHiddenModelOrphans, toggleHiddenModelKey } from "../hiddenModels";
import { modelIdIndex } from "./modelIdIndex";

type ConfigUiPreferencesDeps = {
	api: PiDesktopApi;
	/** 当前 config:models 文件：隐藏模型写盘前要顺手清孤儿，顺序作用域也要取它的键。 */
	modelsData: ModelsFile;
	/** 认证页的 auth.json：排序作用域取它和 models.json 的并集（两页各自独立增删）。 */
	authData: AuthFile;
};

/**
 * 供应商卡片 / 模型的隐藏与排序偏好：全部落在 AppSettings，属于纯 UI 展示偏好，
 * 不写进 models.json / DSH 配置，因此无需担心被外部改写 pi 配置的工具覆盖。
 * 本地立即生效 + 持久化，读盘时机沿用「打开配置页读一次」。
 */
export function useConfigUiPreferences({ api, modelsData, authData }: ConfigUiPreferencesDeps) {
	/** 用户隐藏的供应商 key 列表（模型页眼睛开关持久化到 AppSettings.hiddenProviders）。 */
	const [hiddenProviders, setHiddenProviders] = useState<string[]>([]);
	/** 用户隐藏的模型列表（格式："provider/modelId"，持久化到 AppSettings.hiddenModels）。 */
	const [hiddenModels, setHiddenModels] = useState<string[]>([]);
	/** 用户隐藏的认证供应商列表（持久化到 AppSettings.hiddenAuthProviders）。 */
	const [hiddenAuthProviders, setHiddenAuthProviders] = useState<string[]>([]);
	/**
	 * 供应商卡片自定义顺序（Pi 页与 DSH 页各存一份，持久化到 AppSettings）。
	 * 与 hiddenProviders 同类：属于 UI 展示偏好，不写进 models.json / DSH 配置，
	 * 因此无需担心被外部改写 pi 配置的工具覆盖。
	 */
	const [providerOrder, setProviderOrder] = useState<string[]>([]);
	const [dshProviderOrder, setDshProviderOrder] = useState<string[]>([]);
	/** 切换供应商隐藏状态：本地立即生效 + 持久化到 AppSettings（不影响 models.json 配置本身）。 */
	const handleToggleHiddenProvider = useCallback((name: string) => {
		setHiddenProviders((prev) => {
			const next = prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name];
			void api.settings.update({ hiddenProviders: next }).catch(() => undefined);
			return next;
		});
	}, []);
	/** 切换模型隐藏状态：本地立即生效 + 持久化到 AppSettings。 */
	const handleToggleHiddenModel = (provider: string, modelId: string) => {
		setHiddenModels((prev) => {
			// 写盘前顺手清孤儿（模型已不在列表里的旧 ID），与保存时同一套规则
			const next = pruneHiddenModelOrphans(toggleHiddenModelKey(prev, provider, modelId), modelIdIndex(modelsData.providers));
			void api.settings.update({ hiddenModels: next }).catch(() => undefined);
			return next;
		});
	};
	/** 切换认证供应商隐藏状态：本地立即生效 + 持久化到 AppSettings（auth.json 保留不变供运行时读取）。 */
	const handleToggleHiddenAuthProvider = useCallback((name: string) => {
		setHiddenAuthProviders((prev) => {
			const next = prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name];
			void api.settings.update({ hiddenAuthProviders: next }).catch(() => undefined);
			return next;
		});
	}, []);
	/**
	 * 供应商卡片重排：本地立即生效 + 持久化。
	 * 顺序未变（例如拖回原位）也照常写一次——主进程 SettingsStore 会把无变化的键从 patch 里剔除，
	 * 这里不再重复一份比较逻辑。
	 */
	const handleReorderProviders = useCallback((next: string[]) => {
		setProviderOrder(next);
		void api.settings.update({ providerOrder: next }).catch(() => undefined);
	}, []);
	/** DSH 模型页的供应商卡片重排（与 Pi 页分开存，两页的供应商集合不同）。 */
	const handleReorderDshProviders = useCallback((next: string[]) => {
		setDshProviderOrder(next);
		void api.settings.update({ dshProviderOrder: next }).catch(() => undefined);
	}, []);
	/** 恢复默认顺序：清空自定义顺序（空数组）——两页与模型选择器立即回到配置本身的顺序。 */
	const handleResetProviderOrder = useCallback(() => {
		setProviderOrder([]);
		void api.settings.update({ providerOrder: [] }).catch(() => undefined);
	}, []);
	/** DSH 页的「恢复默认顺序」（与 Pi 页分开清，避免改一页把另一页也重置）。 */
	const handleResetDshProviderOrder = useCallback(() => {
		setDshProviderOrder([]);
		void api.settings.update({ dshProviderOrder: [] }).catch(() => undefined);
	}, []);
	/**
	 * 「模型」与「认证」页共享的排序作用域：两页的供应商集合可能不同（models.json 与 auth.json
	 * 各自独立增删），把并集交给排序 hook 当「完整顺序」，在任一页拖动都只会改变该项在并集里的位置，
	 * 另一页独有的供应商保持原位。仅收录仍然存在的供应商，已删除的名字会在下次拖动时被顺带清掉。
	 */
	const providerOrderScope = useMemo(() => buildProviderOrderScope([Object.keys(modelsData.providers), Object.keys(authData)], providerOrder), [modelsData.providers, authData, providerOrder]);
	// 打开配置页时读取 AppSettings.hiddenProviders、hiddenModels 与 hiddenAuthProviders
	useEffect(() => {
		let cancelled = false;
		void api.settings
			.get()
			.then((settings) => {
				if (!cancelled) {
					setHiddenProviders(settings.hiddenProviders ?? []);
					setHiddenModels(settings.hiddenModels ?? []);
					setHiddenAuthProviders(settings.hiddenAuthProviders ?? []);
					setProviderOrder(settings.providerOrder ?? []);
					setDshProviderOrder(settings.dshProviderOrder ?? []);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	return {
		hiddenProviders,
		hiddenModels,
		setHiddenModels,
		hiddenAuthProviders,
		providerOrder,
		dshProviderOrder,
		handleToggleHiddenProvider,
		handleToggleHiddenModel,
		handleToggleHiddenAuthProvider,
		handleReorderProviders,
		handleReorderDshProviders,
		handleResetProviderOrder,
		handleResetDshProviderOrder,
		providerOrderScope,
	};
}
