import { useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";
import { modelThinkingLevelsKey } from "../../../shared/modelThinkingLevels";

/**
 * 配置页模型表用的「Pi 已确认可用思考档位」目录（键 `provider/modelId`）。
 *
 * 与会话模型选择器同源（projects.listModels 的 capability snapshot），只保留 Pi 权威
 * 返回过的 thinkingLevels：
 * - 不在表里的模型 = 能力未知（旧 Pi / probe 未就绪 / 未保存的新行）→ 读侧按「未知」展示，仍允许手动配置；
 * - 空数组是 Pi 的权威空结果，必须原样进表（该模型没有任何可用档位，编辑入口应禁用）。
 * 加载失败静默为空表，不阻塞配置页其余功能。
 */
export function useAvailableThinkingLevels(): ReadonlyMap<string, readonly string[]> {
	const [levels, setLevels] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
	useEffect(() => {
		let cancelled = false;
		void desktopApi.projects
			.listModels(undefined)
			.then((models) => {
				if (cancelled) return;
				const next = new Map<string, readonly string[]>();
				for (const model of models) {
					// 只收 Pi 明确回答过的档位；undefined（未知）不建键，读侧据此区分「未知」与「空」。
					if (model.thinkingLevels === undefined || !model.provider || !model.id) continue;
					next.set(modelThinkingLevelsKey(model.provider, model.id), model.thinkingLevels);
				}
				setLevels(next);
			})
			.catch(() => {
				if (!cancelled) setLevels(new Map());
			});
		return () => {
			cancelled = true;
		};
	}, []);
	return levels;
}
