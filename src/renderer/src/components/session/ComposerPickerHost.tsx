import type { ReactNode } from "react";
import type { PromptTemplateInfo } from "../../composerBehavior";
import { ModelPicker, PromptTemplatePicker } from "./ComposerParts";
import { ThinkingLevelDropdown } from "./ModelThinkingChip";
import { ComposerSkillPicker } from "./ComposerSkillPicker";
import { t } from "../../i18n";
import { ConfirmDialog } from "../app/AppParts";
import type { ComposerPickerKind } from "../../hooks/useSessionComposerController";
import { useSessionPreferenceController } from "../../hooks/useSessionPreferenceController";

export type ComposerPickerHostProps = {
	sessionId: string;
	picker: ComposerPickerKind | null;
	templates: PromptTemplateInfo[];
	onClose: () => void;
	onOpenThinking: () => void;
	thinkingDisabled?: boolean;
	/** 思考下拉注入底栏；偏好 controller 仍只有本宿主这一份，避免重复快捷键/RPC 订阅。 */
	children: (thinkingControl: ReactNode) => ReactNode;
	onInsertTemplate: (template: PromptTemplateInfo) => void;
	/** 一键插入模板全文（controller insertTemplateContent）：直接塞正文，不走斜线命令。 */
	onInsertTemplateContent: (template: PromptTemplateInfo) => void;
	/** 技能选择：把技能调用命令插入输入框（由 controller 的 insertSkillInvocation 提供）。
	 *  插入的斜线形态由后端决定：pi 用 /skill:名称，DSH 用 /名称——保证与各自的
	 *  技能命令解析一致，避免「从列表选了却调不动」（bare 斜杠在 pi 会被过滤）。 */
	onInsertSkill: (name: string) => void;
	/** 一键插入技能全文（controller insertSkillContent）：正文由选择器先读 SKILL.md。 */
	onInsertSkillContent: (content: string) => void;
	/** DSH 部署默认模型/思考档位（settings.yaml agent-default-model）：草稿期高亮与过滤用。 */
	defaultModel?: { provider?: string; modelId?: string; modelName?: string };
	defaultThinkingLevel?: string;
	/** pi settings.modelThinkingLevels 快照（引导页预选默认的一部分）：按当前模型反查每模型默认档位。 */
	modelThinkingLevels?: Record<string, string>;
};

/**
 * 选择器宿主（渲染壳）：只负责把「模型 / 思考 / 模板 / 技能」四个选择器与
 * 「需重启 Agent 才生效」的确认框渲出来，状态与应用命令全部来自
 * useSessionPreferenceController（同一份链路也被 Ctrl+M / Ctrl+T 快捷键复用）。
 */
export function ComposerPickerHost(props: ComposerPickerHostProps) {
	const preference = useSessionPreferenceController({
		sessionId: props.sessionId,
		pickerOpen: props.picker === "model" || props.picker === "thinking",
		thinkingPickerOpen: props.picker === "thinking",
		defaultModel: props.defaultModel,
		defaultThinkingLevel: props.defaultThinkingLevel,
		modelThinkingLevels: props.modelThinkingLevels,
		// 选择器点选后关闭：快捷键循环走的也是这条路径，此时 picker 本来就是 null，幂等。
		onApplied: props.onClose,
	});

	const thinkingControl = (
		<ThinkingLevelDropdown current={preference.currentThinkingLevel} levels={preference.thinkingLevels} open={props.picker === "thinking"} onOpenChange={(open) => (open ? props.onOpenThinking() : props.onClose())} disabled={props.thinkingDisabled} onPick={(level) => void preference.applyThinking(level)} />
	);

	return (
		<>
			{props.children(thinkingControl)}
			{renderDialog()}
		</>
	);

	/** 思考不再占用对话框；其余复杂选择器与重启确认保持原链路。 */
	function renderDialog() {
		if (props.picker === "template") {
			return <PromptTemplatePicker templates={props.templates} onClose={props.onClose} onPick={props.onInsertTemplate} onInsertContent={props.onInsertTemplateContent} />;
		}
		if (props.picker === "skill") {
			return <ComposerSkillPicker backend={preference.isDshSession ? "dsh" : "pi"} projectId={preference.projectId} agentId={preference.agentId} onClose={props.onClose} onPick={props.onInsertSkill} onInsertContent={props.onInsertSkillContent} />;
		}
		if (props.picker === "model") {
			// DSH 会话的模型归属 host（agent-default-model），不读 pi 的欢迎页偏好：
			// 否则 localStorage 里的 pi 模型会被当成「当前模型」高亮，误导用户以为已选中。
			// 草稿期用部署默认模型（settings.yaml agent-default-model）作当前值。
			// 目录/收藏/隐藏状态由 controller 统一持有（快捷键循环共用同一份）。
			return (
				<ModelPicker
					models={preference.models}
					report={preference.report}
					loading={preference.catalogLoading}
					refreshing={preference.refreshing}
					onRefresh={() => preference.reloadCatalog(true)}
					current={preference.currentModel}
					onClose={props.onClose}
					onPick={(model) => void preference.applyModel(model)}
					onClear={preference.canClearModel ? () => void preference.clearModel() : undefined}
					favoriteModels={preference.favoriteModels}
					onToggleFavorite={(provider, modelId) => void preference.toggleFavorite(provider, modelId)}
					recentProviders={preference.recentProviders}
					// 自定义顺序随会话后端：DSH 目录分组是 route 名，用 dshProviderOrder
					providerOrder={preference.isDshSession ? preference.dshProviderOrder : preference.providerOrder}
					hiddenProviders={preference.hiddenProviders}
					hiddenModels={preference.hiddenModels}
					onToggleHideModel={(provider, modelId) => void preference.toggleHideModel(provider, modelId)}
					// 用量查询链路随会话后端：DSH 目录的 provider 是 route 名，配置/凭据走 dsh 链路
					backend={preference.isDshSession ? "dsh" : "pi"}
				/>
			);
		}
		return (
			<>
				{preference.restartTarget && (
					<ConfirmDialog
						title={t("app.modelRestartTitle")}
						message={t("app.modelRestartBody", { model: preference.restartTarget.model })}
						confirmLabel={t("common.confirm")}
						onConfirm={() => {
							void preference.confirmRestart();
						}}
						onCancel={() => {
							// 只关框：点确定也会先走 onOpenChange(false)→onCancel。
							// 不能在这里清「确认意图」，否则确认路径读到空、重启不会发生（见 controller）。
							preference.cancelRestart();
						}}
					/>
				)}
			</>
		);
	}
}
