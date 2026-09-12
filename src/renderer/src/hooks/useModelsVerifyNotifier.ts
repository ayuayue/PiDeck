/**
 * 模型保存后台验证结果通知 hook（全局唯一挂载点：App.tsx）。
 *
 * 背景：models 保存路径已改为即时反馈（解析刚写入的 models.json，不 fork pi），
 * fork 真实 pi 的完整验证（本机实测 ~17-21s）在主进程后台跑完，经
 * config:models-verify-result 推送结果。本 hook 是该事件的全局订阅点：
 * - 仅失败时提示（warning toast，带可复制详情）；成功静默，避免每次保存都弹。
 * - 挂在 App 而非 ConfigModal：验证完成时用户可能已关掉配置弹窗，
 *   全局订阅保证 toast 不丢。
 * - 稳定 notice id：连续保存产生的多条失败结果相互顶掉，不堆一排 toast。
 */
import { useEffect } from "react";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

const MODELS_VERIFY_NOTICE_ID = "models-verify-result";

export function useModelsVerifyNotifier(): void {
	useEffect(() => {
		// 预览/浏览器模式可能没有该订阅（previewApi 提供空实现，browserApi 可能缺省），
		// 可选链保证缺省时静默跳过，不阻塞 App 装配。
		const unsubscribe = desktopApi.config?.onModelsVerifyResult?.((payload) => {
			// 成功静默：即时反馈已覆盖「保存成功」，后台 pi 验证通过无需再打扰。
			if (payload.ok) return;
			showNotice(
				t("config.modelsVerifyFailed", { detail: payload.detail || payload.reason || "" }),
				8000,
				"warning",
				t("config.modelsVerifyFailedTitle"),
				undefined,
				MODELS_VERIFY_NOTICE_ID,
			);
		});
		return () => unsubscribe?.();
	}, []);
}
