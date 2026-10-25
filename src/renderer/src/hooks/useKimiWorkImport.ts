import { useCallback, useMemo, useState } from "react";
import type { KimiWorkImportReport, KimiWorkSessionSummary, KimiWorkShareRootInfo, Project } from "../../../shared/types";
import { useImportSource, type ImportController } from "./useImportSource";

export type { ImportController };

/**
 * Kimi Work 导入源的输入：除通用导入流程外，多一组「数据目录探测 + 手动指定」。
 * Kimi Work 的 daimon-share 位置不固定（默认安装位 / daimon-storage.json 自定义位置），
 * 探测链在主进程 kimiWorkSource；这里只负责探测结果的展示状态与手动指定的写入。
 */
export interface UseKimiWorkImportInput {
	setProjectMenu: (menu: null) => void;
	refreshProjectSessions: (projectId: string) => Promise<unknown>;
	showToast: (message: string, duration?: number) => void;
	/** API: 探测 Kimi Work 数据目录（settings 手动指定 > daimon-storage.json > 默认位置） */
	describeShareRoot: () => Promise<KimiWorkShareRootInfo>;
	/** API: scan Kimi Work sessions */
	scanKimiWorkSessions: (projectId: string) => Promise<KimiWorkSessionSummary[]>;
	/** API: import Kimi Work sessions */
	importKimiWorkSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<KimiWorkImportReport>;
	/** API: 读写设置（kimiWorkShareRoot 手动指定值，undefined = 走探测链） */
	getSettings: () => Promise<{ kimiWorkShareRoot?: string }>;
	updateSettings: (patch: { kimiWorkShareRoot?: string }) => Promise<unknown>;
	/** Translation function */
	t: Parameters<typeof useImportSource<KimiWorkSessionSummary, KimiWorkImportReport>>[0]["t"];
}

export type KimiWorkImportController = ImportController<KimiWorkSessionSummary, KimiWorkImportReport> & {
	/** 数据目录探测结果（弹窗头部展示；scan 期间实时刷新）。 */
	shareRoot: KimiWorkShareRootInfo | null;
	/** settings 里手动指定的目录（空串 = 未指定，走探测链）。 */
	customRoot: string;
	/** 手动指定输入框的受控值（尚未保存的草稿）。 */
	customRootDraft: string;
	setCustomRootDraft: (value: string) => void;
	/** 保存手动指定目录并重新探测 + 重新扫描（空串 = 清除，恢复探测链）。 */
	applyCustomRoot: () => Promise<void>;
	/** 清除手动指定目录，恢复自动探测并重新扫描。 */
	clearCustomRoot: () => Promise<void>;
};

/**
 * Kimi Work（kimi-desktop 桌面版）会话导入流程。
 *
 * 复用 useImportSource 的通用状态机（scan/toggle/import/report），叠加 Kimi Work 特有的
 * 数据目录状态：describe 结果展示 + settings.kimiWorkShareRoot 手动指定（探测失败兜底）。
 * 弹窗打开时先 describe 再 scan（位置没找到时 scan 直接返回空列表，弹窗引导手动指定）。
 */
export function useKimiWorkImport(input: UseKimiWorkImportInput): {
	project: Project | null;
	setProject: React.Dispatch<React.SetStateAction<Project | null>>;
	controller: KimiWorkImportController;
	open: (project: Project) => Promise<void>;
} {
	const [shareRoot, setShareRoot] = useState<KimiWorkShareRootInfo | null>(null);
	const [customRoot, setCustomRoot] = useState("");
	const [customRootDraft, setCustomRootDraft] = useState("");

	const describe = useCallback(async () => {
		const [info, settings] = await Promise.all([input.describeShareRoot(), input.getSettings()]);
		setShareRoot(info);
		setCustomRoot(settings.kimiWorkShareRoot ?? "");
		setCustomRootDraft(settings.kimiWorkShareRoot ?? "");
		return info;
	}, [input]);

	const source = useImportSource<KimiWorkSessionSummary, KimiWorkImportReport>({
		setProjectMenu: input.setProjectMenu,
		refreshProjectSessions: input.refreshProjectSessions,
		showToast: input.showToast,
		t: input.t,
		copyPrefix: "kimiwork",
		scan: input.scanKimiWorkSessions,
		importSessions: input.importKimiWorkSessionsApi,
	});

	const open = useCallback(
		async (project: Project) => {
			await describe();
			await source.open(project);
		},
		[describe, source],
	);

	/** 弹窗「刷新」：describe + scan 都要重跑（用户可能改了 Kimi Work 的数据位置）。 */
	const refresh = useCallback(async () => {
		await describe();
		await source.controller.refresh();
	}, [describe, source]);

	/** 保存手动指定目录（空串 = 清除恢复自动探测），随后重新探测 + 重新扫描。 */
	const applyCustomRoot = useCallback(async () => {
		const next = customRootDraft.trim();
		await input.updateSettings(next ? { kimiWorkShareRoot: next } : { kimiWorkShareRoot: "" });
		setCustomRoot(next);
		await refresh();
	}, [customRootDraft, input, refresh]);

	const clearCustomRoot = useCallback(async () => {
		setCustomRootDraft("");
		await input.updateSettings({ kimiWorkShareRoot: "" });
		setCustomRoot("");
		await refresh();
	}, [input, refresh]);

	const controller = useMemo<KimiWorkImportController>(
		() => ({
			...source.controller,
			refresh,
			shareRoot,
			customRoot,
			customRootDraft,
			setCustomRootDraft,
			applyCustomRoot,
			clearCustomRoot,
		}),
		[source.controller, refresh, shareRoot, customRoot, customRootDraft, applyCustomRoot, clearCustomRoot],
	);

	return { project: source.project, setProject: source.setProject, controller, open };
}
