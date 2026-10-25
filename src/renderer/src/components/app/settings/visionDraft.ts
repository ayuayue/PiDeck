/**
 * 视觉桥草稿状态 hook（设置弹框持有）与共享常量。
 *
 * 独立成文件的原因：壳组件（SettingsModal）需要 hook（脏标记/保存统一管理），
 * 但 VisionBridgeSettingsTab 组件应能 lazy 加载——若 hook 与组件同文件，
 * 壳的静态 import 会把整个 tab（含 ModelPicker 等重依赖）拖进首开 chunk。
 */
import { useCallback, useEffect, useState } from "react";
import type { VisionBridgeConfig, VisionBridgeState } from "../../../../../shared/types";
import { visionModelMissing } from "../../../utils/visionModelMissing";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";

/** 与扩展 DEFAULT_PROMPT 保持一致（恢复默认按钮用）。 */
export const DEFAULT_PROMPT = "请详细描述这张图片的内容。如果图片中有文字（代码、报错、UI 文案、文档等），请完整准确地转录所有可见文字；如果是图表，请说明类型、坐标轴含义和关键数值；如果涉及界面，请描述布局与元素。输出使用中文。";

/** 超时默认值（ms），与主进程/扩展 DEFAULT_CONFIG 保持一致；UI 以秒为单位展示。 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** 配置文件路径（来自主进程返回的 configDir，与扩展读取路径一致）。 */
export function configFilePath(configDir: string): string {
	return `${configDir}/pi-deck-vision.json`;
}

/** 未配置时的新建草稿（provider/model 留空，保存按钮不可点，引导先选模型）。 */
export function emptyDraft(): VisionBridgeConfig {
	return { enabled: true, provider: "", model: "" };
}

/**
 * 视觉桥草稿状态 hook（设置弹框持有）：与全局设置草稿平行但独立存储
 * （视觉桥写入 pi-deck-vision.json，走独立 IPC，不是 AppSettings 字段），
 * 因此脏标记单独维护，由弹框头部统一保存/取消/关闭确认一并处理。
 */
export function useVisionBridgeDraft() {
	const [state, setState] = useState<VisionBridgeState | null>(null);
	const [draft, setDraft] = useState<VisionBridgeConfig | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	// 保存失败提示（成功走全局 toast，不在此占位）
	const [notice, setNotice] = useState<string | null>(null);

	// 挂载时拉取当前配置（弹框每次打开都重建 state，无需清理外部资源）
	useEffect(() => {
		let mounted = true;
		desktopApi.config
			.visionGetConfig()
			.then((loaded) => {
				if (!mounted) return;
				setState(loaded);
				setDraft(loaded.config ?? emptyDraft());
				setLoading(false);
			})
			.catch(() => {
				if (mounted) setLoading(false);
			});
		return () => {
			mounted = false;
		};
	}, []);

	/** 表单改动：更新草稿并标记未保存（幂等）。 */
	const updateDraft = useCallback((patch: Partial<VisionBridgeConfig>) => {
		setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
		setDirty(true);
		setNotice(null);
	}, []);

	/** 保存草稿到 pi-deck-vision.json；成功清脏标记并弹 toast，失败保留脏标记（头部按钮可重试）。
	 *  开启状态未选模型属无效配置：不发起 IPC，就近提示后拒绝（与主进程白名单校验语义一致，
	 *  但把错误从「保存失败」升级为明确的「需要先选模型」，并避免无意义的写盘尝试）。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!draft) return false;
		if (visionModelMissing(draft)) {
			setNotice(t("settings.vision.modelRequired"));
			return false;
		}
		setSaving(true);
		setNotice(null);
		try {
			const result = await desktopApi.config.visionSaveConfig(draft);
			if (result.ok) {
				setDirty(false);
				showNotice(t("settings.vision.saved"), 3000);
				return true;
			}
			setNotice(`${t("settings.vision.saveFailed")}：${result.error ?? ""}`);
			return false;
		} catch (error) {
			setNotice(`${t("settings.vision.saveFailed")}：${String(error)}`);
			return false;
		} finally {
			setSaving(false);
		}
	}, [draft]);

	/** 放弃修改：回退到打开弹框时的磁盘配置快照。 */
	const reset = useCallback(() => {
		setDraft(state?.config ?? emptyDraft());
		setDirty(false);
		setNotice(null);
	}, [state]);

	// 开启状态未选模型：保存按钮禁用（引导先选模型），save() 亦前置拦截
	const modelMissing = visionModelMissing(draft);
	return { draft, loading, saving, dirty, modelMissing, notice, configDir: state?.configDir ?? "", updateDraft, save, reset };
}
