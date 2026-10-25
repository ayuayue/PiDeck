import { forwardRef, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { ComposerBottomBar, ImagePreviewModal, PromptSuggestions } from "./ComposerParts";
import { TipTapComposer } from "./composer";
import { SessionReferenceModal } from "../app/SessionReferenceModal";
import { ConfirmDialog } from "../app/AppParts";
import { t } from "../../i18n";
import { useSessionComposerController } from "../../hooks/useSessionComposerController";
import { useAcpSessionConfig } from "../../hooks/useAcpSessionConfig";
import { ComposerAttachmentBar, ComposerSendControls, SessionDeliveryNotice } from "./ComposerPanels";
import { ComposerPickerHost } from "./ComposerPickerHost";
import { SecurityControl } from "./SecurityControl";
import { QuickMessageMenu } from "./QuickMessageMenu";
import { modelPendingByIdAtom } from "../../atoms/composer-atoms";
import { sessionRecordsAtom } from "../../atoms";
import { ComposerRuntimeIntegrations } from "./ComposerRuntimeIntegrations";
import { useSessionPaneServices } from "./SessionPaneServices";
import { desktopApi } from "../../desktopApi";
import { COMPOSER_TEXT_MAX_HEIGHT } from "../../rendererUtils";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../../utils/chatSessionBootstrap";
import { chatContentWidthStyle } from "./chatContentWidth";
import { ComposerStatsLine } from "./ComposerStatsLine";
import { ComposerWidgetLayoutProvider, type ComposerWidgetCollapsedByKey, useComposerWidgetLayoutValue } from "./ComposerWidgetLayout";
import { SessionAgentPromptBar } from "./SessionAgentPromptBar";
import type { ChatMessage, GitBranchInfo } from "../../../../shared/types";
import type { ReplyActionRule } from "../../../../shared/types/replyActions";
import type { EnqueuePromptSnapshot } from "../../hooks/useSessionSend";
import { VoiceTranscriptionControls } from "./VoiceTranscriptionControls";
import { SessionReplyActions } from "./SessionReplyActions";
import { SessionContextMeter } from "./SessionContextMeter";
import { isComposerFeatureHidden, type HideableComposerFeatureId } from "../../../../shared/composerFeatures";

/** 无规则时的稳定空数组（避免每渲染新引用让下游 memo 失效）。 */
const EMPTY_REPLY_RULES: readonly ReplyActionRule[] = [];

export type ComposerAreaProps = {
	sessionId: string;
	gitInfo?: GitBranchInfo;
	/** 底栏分支下拉的切换回调（owner 为 App 级 switchBranch，保持 Git 面板同步） */
	onSwitchBranch?: (branch: string) => void;
	/** 输入框上方独立卡（todo / goal）；放在 widgets 槽位。 */
	widgets?: ReactNode;
	/** 回复尾部动作仍复用本栏发送 owner；只把 UI 投到时间线内的落点。 */
	replyActionMessages?: readonly ChatMessage[];
	/** 声明式规则（userData/reply-actions.json 快照），由 SessionView 注入以保持单点加载。 */
	replyActionRules?: readonly ReplyActionRule[];
	replyActionsTarget?: HTMLDivElement | null;
	replyActionsBlocked?: boolean;
	/** 排队消息独立卡（与 todo/goal 同列同宽，不贴输入框、不右浮）。 */
	queuePanel?: ReactNode;
	enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
	ensureSessionId?: (sessionId: string) => Promise<string>;
	/** 当前会话中用户发起的轮次，用于 pi 统计栏；DSH 自带 sessionStats 时不重复显示。 */
	turnCount?: number;
	/** 引导页虚拟会话没有 SessionRecord，用它兑底确定文件树/模型目录所属项目。 */
	bootstrapProjectId?: string;
};

/** footer 同时带标准 CSS 与自定义封顶变量；交叉类型避免 `as` 强转。 */
function composerFooterStyle(): CSSProperties & {
	"--composer-text-max-height": string;
} {
	return {
		...chatContentWidthStyle,
		"--composer-text-max-height": `${COMPOSER_TEXT_MAX_HEIGHT}px`,
	};
}

type ComposerExtrasProps = {
	widgets: ReactNode;
	queuePanel?: ReactNode;
	deliveryNotice: ReactNode;
	attachmentBar: ReactNode;
	/** 绑定智能体的会话：输入框上方的角色设定提示条（可展开查看提示词）。 */
	agentBar: ReactNode;
	composerBox: ReactNode;
	/** 输入卡正下方 StatsLine；与输入卡同一列，不吃剩余高度。 */
	statsLine?: ReactNode;
};

/**
 * 输入栏固有高度：独立卡按内容撑开，列被 max-height 卡住时才内部滚动。
 * 折叠状态放在这里，是为了一次重渲染就让 footer 跟着内容变高/变矮。
 */
function ComposerMeasuredExtras(props: ComposerExtrasProps) {
	const [collapsedByWidgetKey, setCollapsedByWidgetKey] = useState<ComposerWidgetCollapsedByKey>({});
	const widgetLayoutValue = useComposerWidgetLayoutValue(collapsedByWidgetKey, setCollapsedByWidgetKey);
	const hasAttachmentBar = props.attachmentBar != null;

	return (
		<ComposerWidgetLayoutProvider value={widgetLayoutValue}>
			<>
				{/* 卡片列不预留 scrollbar 槽位：这层是「窗口不够高时兜底滚动」的容器，
				    卡片宽度必须与下方输入框/消息列同宽（100% 同源，见 chatContentWidth）。
				    曾加过 [scrollbar-gutter:stable] 试图治待办条滚动条闪烁，但真正闪的是
				    待办条自己的 ul（旋转图标 AABB 撑高 scrollHeight，见 SessionTodoStrip
				    ProgressGlyph 注释），gutter 治不了，还会把卡片压窄 10px。
				    滚轮责任唯一在本层（overscroll-contain 只放这里）：条内限高列表即使内容
				    不足其 max-height 也仍是滚动容器，若它自己带 overscroll-contain，滚轮会被
				    它吞掉、本层一像素不动 —— 观感就是「展开后只看到前几条且滚不动」
				    （2026-10 子代理条事故，契约见 tests/composerStripWheelChain.test.mjs）。 */}
				<div className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain pb-px empty:hidden">
					{props.widgets}
					{props.queuePanel}
					{props.deliveryNotice}
				</div>
				{hasAttachmentBar ? <div className="shrink-0">{props.attachmentBar}</div> : null}
				<div className="flex w-full min-w-0 shrink-0 flex-col">
					{props.agentBar}
					{props.composerBox}
					{props.statsLine}
				</div>
			</>
		</ComposerWidgetLayoutProvider>
	);
}

export const ComposerArea = forwardRef<HTMLElement, ComposerAreaProps>(function ComposerArea(props, footerRef) {
	const paneServices = useSessionPaneServices();
	const composer = useSessionComposerController({
		sessionId: props.sessionId,
		enqueue: props.enqueue,
		ensureSessionId: props.ensureSessionId,
		// 引导页虚拟会话（GUIDE_BOOTSTRAP_SESSION_ID）无 record：用选中项目加载
		// @ 引用文件树；真实会话忽略该字段（record.projectId 优先）。
		bootstrapProjectId: props.bootstrapProjectId,
		// 预览 Tab 里发消息 → 自动晋升常驻（由 App 装配的 SessionPaneServices 提供）
		onPromoteSession: paneServices.promoteSessionToPermanent,
		onCreateSession: paneServices.runCreateSessionDraft,
		// 输入框 `/login`：桌面接管后打开登录供应商弹框（pi 的登录只在它的 CLI 层）
		onProviderLogin: paneServices.openProviderLogin,
		// `/reload`：桌面拦截后热重载 pi 资源，不写用户气泡
		onReloadResources: (target) => paneServices.runSessionControl(target.sessionId, "reloadResources"),
		// 「停止响应」后暂停排队消息自动投递（App 注入 queue.suppressSessionQueueAutoDrain）
		suppressQueuedDrain: paneServices.queueSuppressAutoDrain,
	});
	// ACP 会话配置(configOptions):枚举由 agent 回传,选择经 session/set_config_option 下发。
	// agentId 未就绪/后端不符时 hook 内部自挂空,无额外成本。
	const acpConfig = useAcpSessionConfig(composer.runtime?.agentId, composer.backend);

	const modelPendingMap = useAtomValue(modelPendingByIdAtom);
	const sessionRecords = useAtomValue(sessionRecordsAtom);
	// 输入框功能显示开关（外观设置）：只隐藏底栏入口，不停功能与快捷键（shared/composerFeatures.ts）
	const hiddenComposerFeatures = paneServices.hiddenComposerFeatures;
	const composerFeatureVisible = (feature: HideableComposerFeatureId): boolean => !isComposerFeatureHidden(hiddenComposerFeatures, feature);

	const prewarmStartedForSessionRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!props.sessionId || !window.piDesktop) return;
		// 引导页虚拟会话（GUIDE_BOOTSTRAP_SESSION_ID）没有 catalog 记录，activateRuntime
		// 必然报「会话不存在」：预热只能跳过——真正的 standby 预热由首次发送时的
		// createDraft IPC 触发（sessionIpc createDraft → ensureStandbyAgent）。
		if (props.sessionId === GUIDE_BOOTSTRAP_SESSION_ID) return;
		// ACP 没有 standby 池：模型/模式等 configOptions 枚举要 runtime 握手
		// （session/new/load 响应）才有。选中会话（含应用启动时恢复焦点的会话）
		// 即后台激活，让用户在首条消息发送前就能看到/修改模型与模式，首发直接
		// 命中热 runtime。键含工具 id：换工具（changeBackend 链会停旧 runtime）
		// 与「切走再切回」都能重新预热。load 失败回退 session/new 的抹屏风险由
		// 主进程快照播种兑住（AcpAgentManager handshake 回退分支）。
		if (composer.backend === "acp") {
			const acpPrewarmToolId = composer.acpTool?.toolId;
			if (!acpPrewarmToolId) return;
			const acpPrewarmKey = `acp:${props.sessionId}:${acpPrewarmToolId}`;
			if (prewarmStartedForSessionRef.current === acpPrewarmKey) return;
			prewarmStartedForSessionRef.current = acpPrewarmKey;
			void desktopApi.sessions.activateRuntime(props.sessionId).catch(() => undefined);
			return;
		}
		if (prewarmStartedForSessionRef.current?.startsWith("acp:")) {
			// 切离 acp 后清掉 ACP 预热键：changeBackend 已把 runtime 停掉，
			// 切回来（即使同一工具）要能重新预热，否则 configControls 到首发前都是空的。
			// 到达这里时 backend 必非 acp（ACP 分支已全部早退），startsWith 判定即充分。
			prewarmStartedForSessionRef.current = undefined;
		}
		// 空白草稿（status=draft，从未发送）不做激活预热：standby 池进程已由 createDraft
		// 预热握手完毕，输入时 activateRuntime 只会把池进程认领给一个可能永不发送的草稿、
		// 并立刻补一个替补进程——悬浮窗「反复新建→输入→放弃」会堆积一串空闲进程
		// （2026-10-06 事故）。首条消息发送时 coordinator.activate 的懒认领路径同样
		// 从池里拿热进程（毫秒级），无感启动不受损；激活预热只保留给恢复历史会话等
		// --session 慢路径。
		if (sessionRecords[props.sessionId]?.status === "draft") return;
		if (!composer.draft.trim() && composer.attachments.length === 0 && composer.pasteFiles.files.length === 0) return;
		if (prewarmStartedForSessionRef.current === props.sessionId) return;
		prewarmStartedForSessionRef.current = props.sessionId;

		// 输入是比“打开会话”更可靠的发送意图信号；只在首次输入后预热一次，
		// 避免用户仅浏览历史时创建进程，也避免每个按键重复触发 IPC。
		void desktopApi.sessions.activateRuntime(props.sessionId).catch(() => undefined);
	}, [composer.acpTool?.toolId, composer.attachments.length, composer.backend, composer.draft, composer.pasteFiles.files.length, props.sessionId, sessionRecords]);

	return (
		<ComposerPickerHost
			sessionId={props.sessionId}
			picker={composer.picker}
			templates={composer.templates}
			onClose={composer.pickers.close}
			onOpenThinking={() => composer.pickers.open("thinking")}
			thinkingDisabled={composer.isStarting}
			onInsertTemplate={composer.pickers.insertTemplate}
			onInsertTemplateContent={composer.pickers.insertTemplateContent}
			onInsertSkill={composer.pickers.insertSkillInvocation}
			onInsertSkillContent={composer.pickers.insertSkillContent}
			defaultModel={composer.dshDefaultModel ?? composer.bootstrapDefaultModel}
			defaultThinkingLevel={composer.dshDefaultThinkingLevel ?? composer.bootstrapDefaultThinkingLevel}
			modelThinkingLevels={composer.bootstrapModelThinkingLevels}
		>
			{(thinkingControl) => (
				<ComposerRuntimeIntegrations sessionId={props.sessionId}>
					{({ feishuIndicator }) => (
						<>
							{props.replyActionMessages && (
								<SessionReplyActions
									sessionId={props.sessionId}
									messages={props.replyActionMessages}
									rules={props.replyActionRules ?? EMPTY_REPLY_RULES}
									target={props.replyActionsTarget ?? null}
									hidden={Boolean(props.replyActionsBlocked || composer.isBusy || composer.isStarting || composer.sendState.status === "sending" || composer.sendState.status === "unknown" || composer.mode === "imagegen" || composer.backend === "imagegen")}
									sendDisabled={!composer.delivery.canSendQuickMessage}
									onSend={composer.delivery.sendQuickMessage}
								/>
							)}
							{/* 固有高度：内容撑开 footer；父列 max-height 卡住时独立卡内部滚动，
              输入卡 shrink-0 始终完整可见。 */}
							<footer ref={footerRef} className="composer flex max-h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden bg-transparent px-0 pb-2" style={composerFooterStyle()} data-session-id={props.sessionId}>
								<ComposerMeasuredExtras
									widgets={props.widgets ?? null}
									queuePanel={props.queuePanel}
									agentBar={<SessionAgentPromptBar sessionId={props.sessionId} />}
									deliveryNotice={<SessionDeliveryNotice status={composer.sendState.status} message={composer.sendState.unknownSnapshot?.message} images={composer.sendState.unknownSnapshot?.images} error={composer.sendState.error} onAcknowledge={composer.delivery.acknowledgeUnknown} />}
									attachmentBar={
										composer.attachments.length > 0 || composer.pasteFiles.files.length > 0 ? (
											<ComposerAttachmentBar images={composer.attachments} onPreview={composer.images.preview} onRemove={composer.images.remove} onClear={composer.images.clear} pasteFiles={composer.pasteFiles.files} onRemovePasteFile={composer.pasteFiles.remove} onClearPasteFiles={composer.pasteFiles.clear} />
										) : null
									}
									statsLine={
										<ComposerStatsLine
											state={composer.runtime?.state}
											turnCount={props.turnCount}
											contextMeter={
												composer.mode === "imagegen" ? null : (
													<SessionContextMeter
														state={composer.runtime?.state}
														// ACP 无 compaction/溢出恢复（主进程直接抛不支持），不注入回调 → 入口隐藏；
														// 圆环仍由 usage_update 的 contextPercent 驱动。
														onCompact={composer.backend === "acp" ? undefined : composer.delivery.compact}
														overflowRecoveryTarget={composer.backend === "acp" ? undefined : composer.delivery.overflowRecoveryTarget}
														onOverflowRecovery={composer.backend === "acp" ? undefined : composer.delivery.onOverflowRecovery}
														backend={composer.backend === "dsh" ? "dsh" : "pi"}
														// ACP 用量来自 agent 侧 usage_update，与 pi 供应商配额无关：不传
														// fallbackProvider，点击圆环只展示本地计算百分比，不误导查询 pi 配额。
														fallbackProvider={composer.backend === "acp" ? undefined : (composer.dshDefaultModel?.provider ?? composer.bootstrapDefaultModel?.provider)}
													/>
												)
											}
										/>
									}
									composerBox={
										<div
											// overflow-visible：保留命令面板/建议浮层；面板 minSize 已保证底栏不被裁切
											// 外壳视觉（border/bg/shadow）由 legacy .composer-box 统一持有（含 mode/focus 状态），
											// 这里只留布局/圆角/过渡，避免 utilities 层压死状态样式
											className={[
												"composer-box relative flex w-full min-w-0 shrink-0 flex-col overflow-visible rounded-[20px] text-card-foreground transition-[border-color,box-shadow,background-color]",
												composer.bangMode === "bang-bang" ? "shell-silent-mode" : composer.bangMode === "bang" ? "shell-mode" : composer.mode === "plan" ? "plan-mode" : composer.mode === "goal" ? "goal-mode" : "",
											]
												.filter(Boolean)
												.join(" ")}
										>
											{/* 扩展 widget（Todo/Plan）由统一会话组件卡展示。 */}
											<TipTapComposer
												ref={composer.editor.ref}
												value={composer.draft}
												className={composer.bangMode === "bang-bang" ? "bang-bang" : composer.bangMode === "bang" ? "bang" : ""}
												disabled={composer.isStarting}
												validCommandNames={composer.editor.validCommandNames}
												validFilePaths={composer.editor.validFilePaths}
												validSessionRefs={composer.editor.validSessionRefs}
												validQuotes={composer.editor.validQuotes}
												caretRef={composer.editor.caretRef}
												placeholder={
													composer.suggestion?.visible
														? ""
														: composer.isStarting
															? t("app.agentStartingPlaceholder")
															: composer.bangMode === "bang-bang"
																? t("app.composerSilentPlaceholder")
																: composer.bangMode === "bang"
																	? t("app.composerShellPlaceholder")
																	: composer.mode === "plan"
																		? t("app.composerPlanPlaceholder")
																		: composer.mode === "goal"
																			? t("app.composerGoalPlaceholder")
																			: composer.acpToolName
																				? t("app.composerAcpPlaceholder", { tool: composer.acpToolName })
																				: t("app.composerEnterPlaceholder")
												}
												onFocus={composer.editor.onFocus}
												onChange={composer.editor.onChange}
												onCursorChange={composer.editor.onCursorChange}
												onKeyDown={composer.editor.onKeyDown}
												onPaste={composer.editor.onPaste}
												onPasteClipboard={composer.editor.onPasteClipboard}
												onDrop={composer.editor.onDrop}
												onDragOver={composer.editor.onDragOver}
												onBlur={composer.editor.onBlur}
												onChipClick={composer.editor.onChipClick}
												// 输入预测：ghost 文案只做视觉层，不进入草稿/撤销；Tab / → 采纳。
												suggestion={composer.suggestion?.visible ? composer.suggestion?.text : undefined}
											/>
											{composer.suggestions.open && !composer.isStarting ? (
												<PromptSuggestions
													prompt={composer.draft}
													items={composer.suggestions.items}
													selectedIndex={composer.suggestions.selectedIndex}
													anchorStyle={composer.suggestions.anchorStyle}
													onSelectedIndexChange={composer.suggestions.setSelectedIndex}
													onClose={composer.suggestions.close}
													onPick={composer.suggestions.pick}
												/>
											) : null}
											{/* 运行中只锁「会话启动瞬间」（isStarting）：「+」菜单（附件/技能/提示词/模式）
									    与模式退出×都是改草稿或下一轮生效的配置，busy 时开放；
									    分支切换会动工作区文件，用 branchDisabled 单独保留 busy 锁。 */}
											<ComposerBottomBar
												sessionId={props.sessionId}
												state={composer.runtime?.state}
												disabled={composer.isStarting}
												branchDisabled={composer.isBusy || composer.isStarting}
												thinkingControl={thinkingControl}
												modelDisabled={composer.isStarting}
												modelPending={modelPendingMap[props.sessionId]}
												composerAgentMode={composer.mode}
												gitInfo={composerFeatureVisible("gitBranch") ? props.gitInfo : undefined}
												onSwitchBranch={props.onSwitchBranch}
												record={composer.record}
												defaultModel={composer.dshDefaultModel ?? composer.bootstrapDefaultModel}
												backend={composer.backend}
												enhance={composerFeatureVisible("enhance") ? composer.enhance : undefined}
												onChangeBackend={composer.changeBackend}
												acpTool={composer.acpTool}
												acpConfig={composer.backend === "acp" && acpConfig.options ? { options: acpConfig.options, onSet: (optionId, value) => void acpConfig.setOption(optionId, value) } : undefined}
												feishuIndicator={feishuIndicator}
												securityControl={
													/* C20：后端安全控制位统一入口（pi 安全等级 / DSH 权限预设） */
													composerFeatureVisible("security") ? <SecurityControl sessionId={props.sessionId} backend={composer.backend} disabled={composer.isStarting} /> : undefined
												}
												quickMessagesControl={
													/* 快捷消息：点条目插入草稿，条目右侧按钮直发（正文不进草稿，见 useSessionSend 的 overrideText 契约）；
											   sessionId 供全局快捷键（Ctrl/Cmd+Shift+M）按聚焦栏去重时使用。 */
													composerFeatureVisible("quickMessages") ? <QuickMessageMenu sessionId={props.sessionId} disabled={composer.isStarting} sendDisabled={!composer.delivery.canSendQuickMessage} onInsert={composer.pickers.insertQuickMessage} onSend={composer.delivery.sendQuickMessage} /> : undefined
												}
												onPickModel={() => composer.pickers.open("model")}
												onPickPromptTemplate={() => composer.pickers.open("template")}
												onPickSkill={() => composer.pickers.open("skill")}
												onCompact={composer.delivery.compact}
												overflowRecoveryTarget={composer.delivery.overflowRecoveryTarget}
												onOverflowRecovery={composer.delivery.onOverflowRecovery}
												onChangeMode={composer.pickers.setMode}
												imageGenLocked={composer.delivery.imageGenModeLocked}
												onCancelPlan={() => composer.pickers.setMode("normal")}
												onAttachFile={composer.editor.attachFile}
												imageGenOptions={
													composer.mode === "imagegen"
														? {
																config: composer.delivery.imageGenConfig,
																providerId: composer.delivery.imageGenProviderId,
																modelId: composer.delivery.imageGenModelId,
																size: composer.delivery.imageGenSize,
																outputFormat: composer.delivery.imageGenOutputFormat,
																watermark: composer.delivery.imageGenWatermark,
																onSelectionChange: composer.delivery.setImageGenSelection,
																onSizeChange: composer.delivery.setImageGenSize,
																onOutputFormatChange: composer.delivery.setImageGenOutputFormat,
																onWatermarkChange: composer.delivery.setImageGenWatermark,
															}
														: undefined
												}
												videoGenOptions={
													composer.mode === "videogen"
														? {
																config: composer.delivery.videoGenConfig,
																providerId: composer.delivery.videoGenConfig.activeProviderId,
																modelId: composer.delivery.videoGenConfig.activeModel,
																resolution: composer.delivery.videoGenConfig.activeParams?.resolution,
																duration: composer.delivery.videoGenConfig.activeParams?.duration,
																ratio: composer.delivery.videoGenConfig.activeParams?.ratio,
																onSelectionChange: composer.delivery.setVideoGenSelection,
																onParamChange: composer.delivery.setVideoGenParam,
															}
														: undefined
												}
												voiceControls={
													// 总开关开启即显示录音入口；引擎未就绪时点击才提示去设置补全（见 useVoiceTranscription.start）；外观设置可隐藏入口
													composerFeatureVisible("voice") && composer.voice.configured ? (
														<VoiceTranscriptionControls state={composer.voice.state} busy={composer.voice.transcribingBusy} readLevel={composer.voice.readLevel} disabled={composer.isStarting} onStart={() => void composer.voice.start()} onStop={composer.voice.stop} onCancel={composer.voice.cancel} />
													) : undefined
												}
												sendControls={
													<ComposerSendControls
														isAgentBusy={composer.isBusy}
														isAgentStarting={composer.isStarting}
														hasContent={composer.hasContent}
														canSend={composer.delivery.canSend}
														isGeneratingImage={composer.delivery.generatingImage}
														onSend={composer.delivery.send}
														onStop={composer.delivery.abort}
														onSendSteer={composer.delivery.sendSteer}
														onSendFollowUp={composer.delivery.sendFollowUp}
														onSendParallel={composer.delivery.sendParallel}
														canSendParallel={composer.delivery.canSendParallel}
													/>
												}
											/>
										</div>
									}
								/>
							</footer>
							{composer.previewImage ? <ImagePreviewModal image={composer.previewImage} onClose={composer.modals.closePreview} /> : null}
							{composer.delivery.videoConfirmPending ? (
								<ConfirmDialog title={t("videogen.confirm.title")} message={t("videogen.confirm.body", { model: composer.delivery.videoGenConfig.activeModel })} confirmLabel={t("videogen.confirm.ok")} onConfirm={() => composer.delivery.confirmVideoGen()} onCancel={() => composer.delivery.cancelVideoGen()} />
							) : null}
							{composer.sessionReference ? (
								<SessionReferenceModal
									session={composer.sessionReference}
									initialSelected={composer.sessionReferenceSelection ? new Set(composer.sessionReferenceSelection.selectedIndices) : undefined}
									onClose={composer.modals.closeSessionReference}
									onConfirm={(result, selectedIndices) => {
										composer.modals.confirmSessionReference(result.sessionName, result.messages, selectedIndices);
									}}
									loadMessages={(sessionId) => desktopApi.sessions.readReferenceMessages(sessionId)}
								/>
							) : null}
						</>
					)}
				</ComposerRuntimeIntegrations>
			)}
		</ComposerPickerHost>
	);
});
