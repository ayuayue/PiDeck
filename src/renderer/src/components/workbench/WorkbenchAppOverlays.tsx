import type { ComponentProps, ReactNode } from "react";
import type { useStore } from "jotai";
import type { AppSettings, ImageContent, Project } from "../../../../shared/types";
import { openSettingsAtom } from "../../atoms";
import { desktopApi as api } from "../../desktopApi";
import type { useDirectoryImport } from "../../hooks/useDirectoryImport";
import type { useImportFlow } from "../../hooks/useImportFlow";
import type { useOverlayActions } from "../../hooks/useOverlayActions";
import type { PiEnvironmentGuide } from "../../hooks/usePiEnvironmentGuide";
import type { PiUpdateController } from "../../hooks/usePiUpdate";
import type { useWorkspacePanels } from "../../hooks/useWorkspacePanels";
import { t } from "../../i18n";
import { DSH_INSTALL_SETTINGS_TARGET } from "../../utils/dshRuntimeHint";
import type { NoticeKind } from "../../utils/notice";
import { EnvironmentDialog, ImagePreviewModal } from "../app/AppParts";
import { AskPanelOverlay } from "../overlays/AskPanelOverlay";
import { EnvironmentOverlay } from "../overlays/EnvironmentOverlay";
import { ImportOverlayHost } from "../overlays/ImportOverlayHost";
import { SessionActionOverlays } from "../overlays/SessionActionOverlays";
import { HostPluginPanelHost } from "../plugins/HostPluginPanelHost";
import { SelectionToolHost } from "../selectionTool/SelectionToolHost";
import { SessionProxyDialog } from "../session/SessionProxyDialog";
import { RemoteProjectEnrollDialog } from "../sidebar/RemoteProjectEnrollDialog";
import { WslProjectPickerDialog } from "../sidebar/WslProjectPickerDialog";
import { NoticeHistoryDialog } from "../ui-shadcn/notice-history-dialog";
import { ExternalEditorOverlay } from "../workspace/ExternalEditorOverlay";

type ImportFlowController = ReturnType<typeof useImportFlow>;
type DirectoryImportController = ReturnType<typeof useDirectoryImport>;
type DrawerWorkspace = ReturnType<typeof useWorkspacePanels>;
type EnvironmentDialogProps = ComponentProps<typeof EnvironmentDialog>;

export interface WorkbenchAppOverlaysProps {
	/** 环境检测弹窗：pi/DSH 的检测快照与两个控制器（安装引导 + 更新/自定义路径校验）。 */
	environment: {
		environmentDialog: boolean;
		setEnvironmentDialog: (open: boolean) => void;
		piStatus: EnvironmentDialogProps["status"];
		piChecking: boolean;
		piGuide: PiEnvironmentGuide;
		piUpdate: PiUpdateController;
		dshRuntimeStatus: Pick<EnvironmentDialogProps["dsh"], "state" | "runtimeVersion">;
		settings: AppSettings;
		store: ReturnType<typeof useStore>;
		setSettings: (next: AppSettings) => void;
	};
	/** 项目登记与外部会话导入：远端/WSL 登记弹窗，以及 11 家外部 CLI 的导入弹窗控制器。 */
	enrollment: {
		refreshProjects: () => Promise<Project[]>;
		selectProjectCommand: (projectId: string) => void;
		requestSidebarRevealProject: (projectId: string) => void;
		syncDshForeignSessionsIfEnabled: () => Promise<void>;
		announceProjectAdded: (project: Project) => void;
		importFlow: ImportFlowController;
		directoryImport: DirectoryImportController;
	};
	/** 会话级浮层：反馈弹窗注入、图片预览、外部路径确认、代理设置、划词、插件面板、通知历史、外部编辑器。 */
	session: {
		overlays: ReturnType<typeof useOverlayActions>;
		handleFeedbackCreateSession: (prompt: string) => Promise<boolean>;
		previewImage: ImageContent | null;
		setPreviewImage: (image: ImageContent | null) => void;
		externalPathOpenDialog: ReactNode;
		proxyDialogSessionId: string | null;
		setProxyDialogSessionId: (sessionId: string | null) => void;
		activeProject?: Project;
		currentSessionId?: string;
		handleAgentSendToSession: ComponentProps<typeof SelectionToolHost>["onSendToSession"];
		editorsOpen: boolean;
		externalEditors: ComponentProps<typeof ExternalEditorOverlay>["editors"];
		editorsAnchor: ComponentProps<typeof ExternalEditorOverlay>["anchor"];
		editorsTargetPath: ComponentProps<typeof ExternalEditorOverlay>["projectPath"];
		workspace: DrawerWorkspace;
	};
	/** 事件入口：本轮浮层共用的提示出口。 */
	events: {
		showToast: (message: string, duration?: number, kind?: NoticeKind) => void;
	};
}

/**
 * 工作台应用级浮层装配层：环境检测 → 项目登记 → 反馈/预览/代理/导入/划词/插件/通知/外部编辑器。
 *
 * 只搬结构不持状态：开关、检测结果与各导入 controller 全由 App 持有，这里按 environment /
 * enrollment / session / events 四组接 props；条件渲染顺序与被搬走的内联版本逐个一致。
 */
export function WorkbenchAppOverlays({ environment, enrollment, session, events }: WorkbenchAppOverlaysProps) {
	const { environmentDialog, setEnvironmentDialog, piStatus, piChecking, piGuide, piUpdate, dshRuntimeStatus, settings, store, setSettings } = environment;
	const { refreshProjects, selectProjectCommand, requestSidebarRevealProject, syncDshForeignSessionsIfEnabled, announceProjectAdded, importFlow, directoryImport } = enrollment;
	const {
		codexImportProject,
		setCodexImportProject,
		claudeImportProject,
		setClaudeImportProject,
		qoderImportProject,
		setQoderImportProject,
		openCodeImportProject,
		setOpenCodeImportProject,
		zcodeImportProject,
		setZcodeImportProject,
		workbuddyImportProject,
		setWorkbuddyImportProject,
		codebuddyImportProject,
		setCodebuddyImportProject,
		cursorImportProject,
		setCursorImportProject,
		kimiImportProject,
		setKimiImportProject,
		kimiWorkImportProject,
		setKimiWorkImportProject,
		minimaxImportProject,
		setMinimaxImportProject,
		codexImportController,
		claudeImportController,
		qoderImportController,
		openCodeImportController,
		zcodeImportController,
		workbuddyImportController,
		codebuddyImportController,
		cursorImportController,
		kimiImportController,
		kimiWorkImportController,
		minimaxImportController,
	} = importFlow;
	const { project: directoryImportProject, setProject: setDirectoryImportProject, controller: directoryImportController } = directoryImport;
	const { overlays, handleFeedbackCreateSession, previewImage, setPreviewImage, externalPathOpenDialog, proxyDialogSessionId, setProxyDialogSessionId, activeProject, currentSessionId, handleAgentSendToSession, editorsOpen, externalEditors, editorsAnchor, editorsTargetPath, workspace } = session;
	const { showToast } = events;

	return (
		<>
			<EnvironmentOverlay open={environmentDialog}>
				<EnvironmentDialog
					status={piStatus}
					checking={piChecking}
					guide={piGuide}
					setupPreview={piUpdate.environmentSetupPreview}
					dsh={{
						state: dshRuntimeStatus.state,
						runtimeVersion: dshRuntimeStatus.runtimeVersion,
						isDefault: settings.defaultAgentBackend === "dsh",
						onOpenInstall: () => {
							// 安装/修复入口就是配置管理 → DSH 分页（未装时那页即安装引导），关窗避免两层弹层叠压
							setEnvironmentDialog(false);
							store.set(openSettingsAtom, DSH_INSTALL_SETTINGS_TARGET);
						},
						onUseAsDefault: () => {
							void (async () => {
								// 手动选择：置 manual 后自动选择不再改写；同时标记 pi 环境已确认，
								// 否则只装 DSH 的用户每次启动都会被打一次「没有 pi」。
								const next = await api.settings.update({ defaultAgentBackend: "dsh", defaultAgentBackendManual: true, piEnvironmentChecked: true });
								setSettings(next);
								setEnvironmentDialog(false);
								showToast(t("environment.dshSwitched"));
							})();
						},
					}}
					onClose={() => {
						setEnvironmentDialog(false);
						// 预览标记只在本次打开有效：下次（含启动检测）回到真实检测结果
						piUpdate.setEnvironmentSetupPreview(false);
						piUpdate.setCustomPathResult(null);
						// 关闭时重置安装状态
						piUpdate.setInstallResult(null);
						piUpdate.setInstallCompleted(false);
						piUpdate.setNpmAvailable(null);
						// 引导面板的一次性状态同样重置，下次打开重新检测
						piGuide.resetGuide();
					}}
					onRecheck={() => {
						piUpdate.setCustomPathResult(null);
						piUpdate.setNpmAvailable(null);
						piUpdate.setNpmVersion(undefined);
						piUpdate.setInstallResult(null);
						piUpdate.setInstallCompleted(false);
						// 引导面板上的 Node/npm 状态同步刷新（一键安装可能刚补上便携 Node）；WSL 模式下不展示也不探测宿主机环境
						if (settings.wslEnabled !== true) {
							void piGuide.checkNode();
							void piGuide.checkNpmForGuide();
						}
						piUpdate.checkPiInstall("manual");
					}}
					onOpenInstallDocs={() => api.app.openExternal("https://pi.dev/docs/latest/quickstart#install")}
					// WSL 模式下 pi 在发行版里，引导面板要换成 WSL 内的安装指令（宿主机一键安装对它无效）。
					wsl={{ enabled: settings.wslEnabled === true, distro: settings.wslDistro, user: settings.wslUser }}
					installations={piUpdate.piInstallations ?? []}
					applyingInstallationPath={piUpdate.applyingInstallationPath}
					onChooseInstallation={(path) => void piUpdate.choosePiInstallation(path)}
					onShellProbeInstallations={() => void piUpdate.loadPiInstallations({ forceShellProbe: true })}
					shellProbingInstallations={piUpdate.piInstallationsProbing}
					onBrowsePiPath={() => void piUpdate.browsePiPath()}
					browsingPiPath={piUpdate.browsingPiPath}
					customPath={piUpdate.customPiPath}
					customPathValidating={piUpdate.customPathValidating}
					customPathResult={piUpdate.customPathResult}
					onCustomPathChange={(path) => {
						piUpdate.setCustomPiPath(path);
						piUpdate.setCustomPathResult(null);
					}}
					onValidateCustomPath={() => piUpdate.validateCustomPiPath({ closeDialogOnSuccess: true })}
					installCommand={piUpdate.installCommand}
					installExecuting={piUpdate.installExecuting}
					installResult={piUpdate.installResult}
					installCompleted={piUpdate.installCompleted}
					onInstallCommandChange={(cmd) => {
						piUpdate.setInstallCommand(cmd);
						piUpdate.setInstallResult(null);
						piUpdate.setInstallCompleted(false);
					}}
					onExecInstall={piUpdate.execInstallCommand}
					onRestartApp={() => api.app.restart()}
					onClearCheckFlag={async () => {
						await api.settings.update({ piEnvironmentChecked: false });
						showToast(t("environment.checkFlagCleared"));
					}}
				/>
			</EnvironmentOverlay>
			{/* 远端项目登记：全应用唯一挂载点（侧栏「+」/空态只写开关 atom）。成功后先刷新清单再选中新项目，不创建本地会话。 */}
			<RemoteProjectEnrollDialog
				onEnrolled={(projectId) => {
					void refreshProjects()
						.then(() => selectProjectCommand(projectId))
						.then(() => {
							// 弹窗成功页已说过「已添加」，这里只补侧栏揭示，不再叠一条重复 toast。
							requestSidebarRevealProject(projectId);
						})
						.catch(() => undefined);
				}}
			/>
			{/* WSL 目录选择器：同上，唯一挂载点；WSL 侧没有「外部会话按 cwd 归位」的问题，登记后直接选中新项目。 */}
			<WslProjectPickerDialog
				onAdded={(projectId) => {
					void syncDshForeignSessionsIfEnabled()
						.then(() => refreshProjects())
						.then((next) => {
							selectProjectCommand(projectId);
							const added = next.find((project) => project.id === projectId);
							if (added) announceProjectAdded(added);
						})
						.catch(() => undefined);
				}}
			/>
			{/*
			 * 问题反馈弹窗的「新建会话分析」依赖 App 级会话创建能力（createSessionDraftWithTab），
			 * 在装配层组合：useOverlayActions 只持开关状态，会话创建与预填在此处注入。
			 */}
			<SessionActionOverlays
				{...overlays.overlayProps}
				feedback={
					overlays.overlayProps.feedback
						? {
								...overlays.overlayProps.feedback,
								props: {
									...overlays.overlayProps.feedback.props,
									onCreateSessionWithPrompt: handleFeedbackCreateSession,
								},
							}
						: undefined
				}
			/>
			{previewImage && <ImagePreviewModal image={previewImage} onClose={() => setPreviewImage(null)} />}
			{/* 项目外文件链接二次确认（安全等级：敏感文件 / 限定目录 / 配置不可读时才弹） */}
			{externalPathOpenDialog}
			{/* 会话代理设置：侧栏菜单与 Tab 栏 ⋯ 菜单共用的宿主（同一弹框实例） */}
			{proxyDialogSessionId && <SessionProxyDialog sessionId={proxyDialogSessionId} onClose={() => setProxyDialogSessionId(null)} />}
			{codexImportProject && <ImportOverlayHost kind="codex" project={codexImportProject} controller={codexImportController} onClose={() => setCodexImportProject(null)} />}
			{claudeImportProject && <ImportOverlayHost kind="claude" project={claudeImportProject} controller={claudeImportController} onClose={() => setClaudeImportProject(null)} />}
			{qoderImportProject && <ImportOverlayHost kind="qoder" project={qoderImportProject} controller={qoderImportController} onClose={() => setQoderImportProject(null)} />}
			{openCodeImportProject && <ImportOverlayHost kind="opencode" project={openCodeImportProject} controller={openCodeImportController} onClose={() => setOpenCodeImportProject(null)} />}
			{zcodeImportProject && <ImportOverlayHost kind="zcode" project={zcodeImportProject} controller={zcodeImportController} onClose={() => setZcodeImportProject(null)} />}
			{workbuddyImportProject && <ImportOverlayHost kind="workbuddy" project={workbuddyImportProject} controller={workbuddyImportController} onClose={() => setWorkbuddyImportProject(null)} />}
			{codebuddyImportProject && <ImportOverlayHost kind="codebuddy" project={codebuddyImportProject} controller={codebuddyImportController} onClose={() => setCodebuddyImportProject(null)} />}
			{cursorImportProject && <ImportOverlayHost kind="cursor" project={cursorImportProject} controller={cursorImportController} onClose={() => setCursorImportProject(null)} />}
			{kimiImportProject && <ImportOverlayHost kind="kimi" project={kimiImportProject} controller={kimiImportController} onClose={() => setKimiImportProject(null)} />}
			{kimiWorkImportProject && <ImportOverlayHost kind="kimiwork" project={kimiWorkImportProject} controller={kimiWorkImportController} onClose={() => setKimiWorkImportProject(null)} />}
			{minimaxImportProject && <ImportOverlayHost kind="minimax" project={minimaxImportProject} controller={minimaxImportController} onClose={() => setMinimaxImportProject(null)} />}
			{directoryImportProject && <ImportOverlayHost kind="directory" project={directoryImportProject} controller={directoryImportController} onClose={() => setDirectoryImportProject(null)} />}

			{/* 划词工具：全局唯一挂载点（划选浮出按钮 + 原地工具栏） */}
			<SelectionToolHost onSendToSession={handleAgentSendToSession} />

			{/* 并行问询结果弹框（AskPanel）：独立匿名会话的结果展示，根级渲染 */}
			<AskPanelOverlay />
			<HostPluginPanelHost projectId={activeProject?.id} sessionId={currentSessionId} />

			{/* toast 通知历史：全渲染层唯一一份（设置页/详情弹窗两个入口共用，
			    模块级 opener 注册式打开，见 utils/noticeHistory + ui-shadcn/notice-history-dialog） */}
			<NoticeHistoryDialog />

			{/* 外部编辑器选择气泡 */}
			<ExternalEditorOverlay
				open={editorsOpen}
				editors={externalEditors}
				anchor={editorsAnchor}
				projectPath={editorsTargetPath}
				onClose={() => workspace.closeExternalEditorChooser()}
				onOpenProject={(editor, path) => workspace.openProjectInExternalEditor(editor)}
				onError={(error) => showToast(t("app.openEditorFailed", { error: String(error) }), 3000)}
			/>
		</>
	);
}
