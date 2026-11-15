import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ModelsFile } from "../configTypes";

type ConfigBaseUrlAutofixDeps = {
	setModelsData: Dispatch<SetStateAction<ModelsFile>>;
	markDirty: (tabKey: string) => void;
};

/**
 * 检测成功且实际走通 /v1（或 /v1beta）时，把表单里的 baseUrl 自动改成带版本路径。
 * 原因：检测侧会兼容补路径，但 pi 会话会原样读 models.json；不改写则「测试正常、会话 404」。
 * 仅改内存表单，需用户点保存后才写入磁盘。
 * 后端仅在确实需要改写时返回 suggestedBaseUrl，前端直接应用即可。
 * 声明在 loadConfig 之前：后台自动发现分支要在闭包里引用它（TDZ）。
 */
export function useModelBaseUrlAutofix({ setModelsData, markDirty }: ConfigBaseUrlAutofixDeps) {
	return useCallback(
		(providerName: string, suggestedBaseUrl?: string) => {
			if (!suggestedBaseUrl) return false;
			const next = suggestedBaseUrl.replace(/\/+$/, "");
			if (!next) return false;
			// 函数式更新，避免 async 返回时闭包拿到旧 modelsData。
			setModelsData((prev) => {
				const provider = prev.providers[providerName];
				if (!provider) return prev;
				const current = (provider.baseUrl ?? "").replace(/\/+$/, "");
				if (current === next) return prev;
				return {
					...prev,
					providers: {
						...prev.providers,
						[providerName]: { ...provider, baseUrl: next },
					},
				};
			});
			// 检测/测试自动改写 baseUrl 同样属于表单修改，标记未保存
			markDirty("config:models");
			return true;
		},
		[markDirty, setModelsData],
	);
}
