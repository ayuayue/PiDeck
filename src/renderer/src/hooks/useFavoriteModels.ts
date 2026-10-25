/**
 * 设置页模型选择器共用的收藏态（settings.favoriteModels）。
 *
 * 输入框里的模型选择器由 useSessionPreferenceState 自己维护收藏；设置页的几个选择器
 * （提示词增强 / 输入预测 / 视觉桥接 / 微信优先级链）只借用收藏做「置顶 + 星标」，
 * 没必要拖进会话偏好那一整套状态，所以单独收成一个小 hook：
 *
 * - 收藏以磁盘为唯一真相：打开选择器前 refresh 一次，避免多个选择器同页并存时
 *   各缓存一份、出现「这个亮那个不亮」；
 * - 切换收藏当场落盘（与 composer 同语义：乐观更新 + 失败回滚 + toast 错误）；
 * - 当前值走 ref 镜像，连点不同模型时不会互相覆盖（闭包里的旧数组会丢一次收藏）。
 */
import { useCallback, useRef, useState } from "react";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { modelKey } from "../utils/preferenceCycle";

export function useFavoriteModels(): {
	favoriteModels: string[];
	refreshFavoriteModels: () => Promise<void>;
	toggleFavorite: (provider: string, modelId: string) => void;
} {
	const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
	const favoritesRef = useRef<string[]>([]);

	const apply = useCallback((next: string[]) => {
		favoritesRef.current = next;
		setFavoriteModels(next);
	}, []);

	/** 读取磁盘上的收藏（读失败就沿用当前值：星标是辅助信息，不该阻断选择器）。 */
	const refreshFavoriteModels = useCallback(async () => {
		try {
			apply((await desktopApi.settings.get()).favoriteModels ?? []);
		} catch {
			// 见上：静默保留旧值
		}
	}, [apply]);

	const toggleFavorite = useCallback(
		(provider: string, modelId: string) => {
			const previous = favoritesRef.current;
			const key = modelKey(provider, modelId);
			const next = previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key];
			apply(next);
			void desktopApi.settings.update({ favoriteModels: next }).catch((error: unknown) => {
				apply(previous);
				showNotice(error instanceof Error ? error.message : String(error), 4000);
			});
		},
		[apply],
	);

	return { favoriteModels, refreshFavoriteModels, toggleFavorite };
}
