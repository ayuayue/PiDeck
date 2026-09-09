import { memo, useEffect, useRef, useState } from "react";
import type {
	AppSettings,
	AvailableModel,
	GitExecutableInfo,
	ModelListReport,
} from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { ModelPicker } from "../../session/ComposerComponents";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingRow, SettingSwitchRow, SettingTextarea } from "./SettingRows";

type GitTabProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	isDirty: (field: keyof AppSettings) => boolean;
	gitModels: AvailableModel[];
	gitModelsReport: ModelListReport | null;
	gitModelsRefreshing: boolean;
	onRefreshGitModels: () => void;
	gitModelPickerOpen: boolean;
	onOpenGitModelPicker: () => void;
	onCloseGitModelPicker: () => void;
	onPickGitModel: (model: AvailableModel) => void;
	onToggleGitModelFavorite: (provider: string, modelId: string) => void;
};

/** 探测来源 → 展示文案 */
function sourceLabel(source: GitExecutableInfo["source"]): string {
	switch (source) {
		case "configured":
			return t("settings.gitExecutableSourceConfigured");
		case "known-location":
			return t("settings.gitExecutableSourceKnown");
		case "path":
			return t("settings.gitExecutableSourcePath");
		default:
			return t("settings.gitExecutableNotDetected");
	}
}

/** 探测结果是否是可直接展示的绝对路径（PATH 回退时可能是裸的 "git" 字面量，不适合当占位符）。 */
function looksLikePath(p: string): boolean {
	return p.includes("/") || p.includes("\\");
}

/**
 * 设置弹框「Git」tab（原为常用设置内区块，单独成 tab 便于高频访问）。
 * 区块 id 保留 settings-section-git：Git 面板「去设置」深链先切到本 tab，
 * 再滚动到摘要模型（见 useSettingsFocus）。
 *
 * Git 可执行文件配置行：读写走 draft（随全局保存生效）。异步探测只用于
 * 「当前路径能不能用 + 版本展示」，不写 draft —— 真正生效靠保存 settings:update
 * 把 gitExecutablePath 灌进主进程解析器（见 SettingsStore / systemIpc）。
 */
export const GitTab = memo(function GitTab(props: GitTabProps) {
	const { draft, updateDraft, isDirty } = props;

	const [detecting, setDetecting] = useState(false);
	const [info, setInfo] = useState<GitExecutableInfo | null>(null);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// 当前草稿里的配置路径（空白 = 自动解析）
	const draftPath = (draft.gitExecutablePath ?? "").trim();

	const runDetect = async (configuredPath: string) => {
		setDetecting(true);
		try {
			const next = await desktopApi.git.detectExecutable(configuredPath);
			if (mountedRef.current) setInfo(next);
		} catch {
			// 探测异常（预览/受限环境）保持现状，不打断编辑。
		} finally {
			if (mountedRef.current) setDetecting(false);
		}
	};

	// 挂载后自动探测一次，把「已识别到的 git 路径」作为默认展示。
	const initialRan = useRef(false);
	useEffect(() => {
		if (initialRan.current) return;
		initialRan.current = true;
		void runDetect("");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const chooseFile = async () => {
		try {
			const selected = await desktopApi.git.chooseExecutable();
			if (!selected) return;
			updateDraft({ gitExecutablePath: selected });
			void runDetect(selected);
		} catch {
			// 对话框取消 / 失败：静默。
		}
	};

	const status = info;
	const effectiveVersion =
		status?.source === "not-found" ? "" : status?.version ?? "";
	const resolvedDisplay =
		draftPath || status?.resolvedPath || status?.system?.resolvedPath || "";
	// 系统自动探测到的路径（不含用户配置），用作输入框占位符直观展示。
	const detectedPath = status?.system?.resolvedPath ?? status?.resolvedPath ?? "";

	return (
		/* Git：id 供「去设置」深链滚动到摘要模型 */
		<SettingsSection id="settings-section-git" title={t("settings.git")}>
			<SettingSwitchRow
				title={t("settings.gitManagement")}
				description={t("settings.gitManagementDesc")}
				checked={draft.enableGitManagement}
				onChange={(checked) => updateDraft({ enableGitManagement: checked })}
			/>
			{draft.enableGitManagement && (
				<>
					<SettingRow
						title={
							<>
								<span>{t("settings.gitExecutable")}</span>
								<DirtyMarker dirty={isDirty("gitExecutablePath")} label={t("settings.gitExecutable")} />
							</>
						}
						description={t("settings.gitExecutableDesc")}
					>
						<div className="w-full space-y-1.5">
							<div className="flex flex-wrap items-center gap-2">
								<Input
									className="w-56 min-w-0 flex-1 font-mono text-xs"
									value={draftPath}
									placeholder={
										draftPath
											? ""
											: looksLikePath(detectedPath)
												? detectedPath
												: t("settings.gitExecutablePlaceholder")
									}
									title={draftPath || (looksLikePath(detectedPath) ? detectedPath : "")}
									onChange={(e) => updateDraft({ gitExecutablePath: e.target.value })}
								/>
								<Button
									variant="outline"
									size="sm"
									disabled={detecting}
									onClick={() => void runDetect(draftPath)}
								>
									{detecting ? t("settings.gitExecutableDetecting") : t("settings.gitExecutableDetect")}
								</Button>
								<Button variant="outline" size="sm" onClick={() => void chooseFile()}>
									{t("settings.gitExecutableBrowse")}
								</Button>
								{draftPath && (
									<Button
										variant="ghost"
										size="sm"
										onClick={() => updateDraft({ gitExecutablePath: "" })}
									>
										{t("settings.gitExecutableClear")}
									</Button>
								)}
							</div>
							{!status?.error && resolvedDisplay && (
								<small
									className="block truncate font-mono text-caption text-muted-foreground"
									// 悬停看全路径：窄面板下路径必然被 truncate，title 是唯一兜底。
									title={`${sourceLabel(status?.source ?? "path")}${effectiveVersion ? ` · ${t("settings.gitExecutableVersion", { version: effectiveVersion })}` : ""} · ${resolvedDisplay}`}
								>
									{/* 版本号放在路径前：截断只伤路径尾部，来源与版本永远可见 */}
									{sourceLabel(status?.source ?? "path")}
									{effectiveVersion
										? ` · ${t("settings.gitExecutableVersion", { version: effectiveVersion })}`
										: ""}
									{" · "}
									{resolvedDisplay}
								</small>
							)}
							{status?.error && (
								<div className="space-y-1">
									<small className="block text-caption text-danger">{status.error}</small>
									{status.system && (
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												const p = status.system?.resolvedPath ?? "";
												updateDraft({ gitExecutablePath: p });
												void runDetect(p);
											}}
										>
											{t("settings.gitExecutableUseSystem")} · {status.system.resolvedPath}
										</Button>
									)}
								</div>
							)}
						</div>
					</SettingRow>

					<SettingRow
						title={
							<>
								<span>{t("settings.gitCommitMessageModel")}</span>
								<DirtyMarker dirty={isDirty("gitCommitMessageProvider") || isDirty("gitCommitMessageModel")} label={t("settings.gitCommitMessageModel")} />
							</>
						}
						description={t("settings.gitCommitMessageModelDesc")}
					>
						<Button
							variant="outline"
							className="w-full justify-start font-mono text-xs"
							onClick={props.onOpenGitModelPicker}
							// title 兜底完整值：长供应商/模型在按钮内被 truncate 省略时，悬停仍可读全。
							title={
								draft.gitCommitMessageProvider && draft.gitCommitMessageModel
									? `${draft.gitCommitMessageProvider}/${draft.gitCommitMessageModel}`
									: t("settings.gitCommitMessageModelUnset")
							}
						>
							<span className="min-w-0 truncate">
								{draft.gitCommitMessageProvider && draft.gitCommitMessageModel
									? `${draft.gitCommitMessageProvider}/${draft.gitCommitMessageModel}`
									: t("settings.gitCommitMessageModelUnset")}
							</span>
						</Button>
					</SettingRow>
					<SettingTextarea
						title={t("settings.gitCommitMessagePrompt")}
						description={t("settings.gitCommitMessagePromptDesc")}
						value={draft.gitCommitMessagePrompt}
						onChange={(value) => updateDraft({ gitCommitMessagePrompt: value })}
					/>
					{props.gitModelPickerOpen && (
						<ModelPicker
							models={props.gitModels}
							report={props.gitModelsReport}
							refreshing={props.gitModelsRefreshing}
							onRefresh={props.onRefreshGitModels}
							current={{
								provider: draft.gitCommitMessageProvider,
								modelId: draft.gitCommitMessageModel,
							}}
							favoriteModels={draft.favoriteModels ?? []}
							onClose={props.onCloseGitModelPicker}
							onPick={props.onPickGitModel}
							onToggleFavorite={props.onToggleGitModelFavorite}
						/>
					)}
				</>
			)}
		</SettingsSection>
	);
});
