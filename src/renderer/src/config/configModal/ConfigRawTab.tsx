import type { ComponentProps, Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiConfigTarget } from "../../../../shared/piConfig";
import type { ConfigFileDiagnostic } from "../../../../shared/types";
import { t } from "../../i18n";
import { ConfirmDialog } from "../../components/ui-shadcn/ConfirmDialog";
import type { ConfigTab } from "../configTypes";
import { RawTab } from "../RawTab";
import { WslConfigSourceHint } from "../WslConfigSourceHint";
import type { WslConfigTargetHost } from "../piConfigTargetModel";

type ConfigRawEditingDeps = {
	api: PiDesktopApi;
	configTargetOption: { target: PiConfigTarget } | undefined;
	rawContent: string;
	setRawContent: Dispatch<SetStateAction<string>>;
	rawFileName: string;
	setRawFileName: Dispatch<SetStateAction<string>>;
	/** 源文件草稿的基准快照：切换文件后新旧草稿都以新文件为比较基准。 */
	baselineRawRef: RefObject<{ fileName: string; content: string }>;
	/** 当前脏集合：有 config:raw 草稿时切换文件要先确认丢弃。 */
	hasRawDraft: boolean;
	setPendingRawFile: Dispatch<SetStateAction<string | null>>;
	setLoading: Dispatch<SetStateAction<boolean>>;
	setError: Dispatch<SetStateAction<string | null>>;
	setConfigDiagnostic: Dispatch<SetStateAction<ConfigFileDiagnostic | null>>;
	saveAndReload: (saveFn: () => Promise<{ valid: boolean; error?: string }>, successMessage?: string, dirtyKey?: string) => Promise<boolean>;
	reloadConfig: (target: ConfigTab, options?: { force?: boolean; silent?: boolean }) => Promise<void>;
};

/**
 * 源文件页的保存与换文件动作（搬迁自 ConfigModal，行为不变）。
 * 保存后按被编辑的文件重载对应分页；换文件时若有草稿先弹确认，不静默丢弃编辑。
 */
export function useConfigRawEditing(deps: ConfigRawEditingDeps) {
	const { api, configTargetOption, rawContent, setRawContent, rawFileName, setRawFileName, baselineRawRef, hasRawDraft, setPendingRawFile, setLoading, setError, setConfigDiagnostic, saveAndReload, reloadConfig } = deps;

	const handleSaveRaw = async (): Promise<boolean> => {
		const isModelsFile = rawFileName === "models.json";
		const ok = await saveAndReload(() => api.config.saveRaw(rawFileName, rawContent, configTargetOption), isModelsFile ? t("config.modelsSaved") : undefined, "config:raw");
		if (rawFileName === "models.json") await reloadConfig("models", { force: true });
		else if (rawFileName === "auth.json") await reloadConfig("auth", { force: true });
		else if (rawFileName === "trust.json") await reloadConfig("trust", { force: true });
		else if (rawFileName === "mcp.json") await reloadConfig("mcp", { force: true });
		else await reloadConfig("settings", { force: true });
		return ok;
	};

	// 切换源文件：当前文件有未保存草稿时先弹确认（丢弃草稿才能切），避免静默丢失编辑
	const handleRawFileChange = async (fileName: string) => {
		if (fileName === rawFileName) return;
		if (hasRawDraft) {
			setPendingRawFile(fileName);
			return;
		}
		await applyRawFileChange(fileName);
	};

	/** 确认丢弃草稿后（或本就无草稿）真正切换源文件并重新加载内容。 */
	const applyRawFileChange = async (fileName: string) => {
		setLoading(true);
		try {
			const res = await api.config.getRaw(fileName, configTargetOption);
			setRawFileName(fileName);
			setRawContent(res.raw);
			baselineRawRef.current = { fileName, content: res.raw };
			setConfigDiagnostic(res.diagnostic ?? null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	return { handleSaveRaw, handleRawFileChange, applyRawFileChange };
}

export type ConfigRawTabProps = {
	/** WSL 目标的来源提示（本机为 undefined）。 */
	wslTargetHost: WslConfigTargetHost | undefined;
	statusBlock: ReactNode;
	configDiagnosticBlock: ReactNode;
	loading: boolean;
	/** pi 全局配置目录（主进程 config:get-dir 返回）：WSL 目标不标注本机路径。 */
	piConfigDir: string | null;
	onChangeContent: (value: string) => void;
} & ComponentProps<typeof RawTab>;

/** 源文件页内容（`config:raw` TabsContent 整块）。 */
export function ConfigRawTab({ wslTargetHost, statusBlock, configDiagnosticBlock, loading, piConfigDir, ...rawTabProps }: ConfigRawTabProps) {
	return (
		<div className="config-content flex min-h-0 flex-col">
			{wslTargetHost ? <WslConfigSourceHint host={wslTargetHost} file="raw" /> : null}
			{statusBlock}
			{configDiagnosticBlock}
			{!loading && <RawTab {...rawTabProps} configDir={wslTargetHost ? undefined : (piConfigDir ?? undefined)} />}
		</div>
	);
}

/** 源文件切换确认：Raw 编辑器有未保存草稿时，切换下拉会丢弃草稿，必须显式确认。 */
export function ConfigRawSwitchConfirm({ pendingRawFile, onDiscard, onCancel }: { pendingRawFile: string | null; onDiscard: (fileName: string) => void; onCancel: () => void }) {
	if (!pendingRawFile) return null;
	return <ConfirmDialog title={t("config.rawSwitchTitle")} message={t("config.rawSwitchMessage")} confirmLabel={t("config.rawSwitchConfirm")} danger onConfirm={() => onDiscard(pendingRawFile)} onCancel={onCancel} />;
}
