import { useState, type FormEvent } from "react";
import { ChevronDown, Info, X } from "lucide-react";
import {
	AGENT_PROFILE_BACKENDS,
	AGENT_PROFILE_CATEGORIES,
	AGENT_PROFILE_DESCRIPTION_MAX_CHARS,
	AGENT_PROFILE_ICON_MAX_CHARS,
	AGENT_PROFILE_NAME_MAX_CHARS,
	AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS,
	type AgentModelRef,
	type AgentProfile,
	type AgentProfileBackend,
	type AgentProfileCategory,
} from "../../../../../shared/types/agentProfile";
import { useBackendModelCatalog } from "../../../hooks/useBackendModelCatalog";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { ModelPicker } from "../../session/ComposerComponents";
import { Alert, AlertDescription } from "../../ui-shadcn/alert";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Textarea } from "../../ui-shadcn/textarea";
import { AGENT_CATEGORY_LABEL_KEYS } from "./AgentMarketCategoryChips";
import { AGENT_BACKEND_LABEL_KEYS, FOLLOW_DEFAULT_BACKEND_VALUE, isAgentProfileBackend } from "./agentBackendOptions";
import { useAgentMarketActions } from "./useAgentMarketActions";

/**
 * 空模型引用 = 「清空模型」。UpdateAgentProfileInput.model 没有 null 形态，主进程又把
 * 省略键/undefined 当成「未提供、保持原值」，因此与 AutomationTaskEditor 同一约定：
 * 显式传空 provider/modelId，由主进程归一化成「未设置」。
 */
const EMPTY_AGENT_MODEL_REF: AgentModelRef = { provider: "", modelId: "" };

/** Select 的 value 是 string：用类型守卫收窄成分类枚举，不写 as 强转（AGENTS.md 禁止 as 绕类型）。 */
function isAgentProfileCategory(value: string): value is AgentProfileCategory {
	return AGENT_PROFILE_CATEGORIES.some((category) => category === value);
}

/** 已有模型里空 provider/modelId 视同未设置（防御历史数据里的空 ref）。 */
function initialModelOf(agent: AgentProfile | null): AgentModelRef | undefined {
	const model = agent?.model;
	if (!model || !model.provider.trim() || !model.modelId.trim()) return undefined;
	return { provider: model.provider, modelId: model.modelId };
}

interface AgentMarketEditorProps {
	/** null = 新建。 */
	agent: AgentProfile | null;
	onSaved: () => void;
	onCancel: () => void;
}

/**
 * 智能体新建/编辑表单：名称、emoji 图标、简介、分类、可选模型、「使用」新建会话的后端、角色设定。
 * 校验只拦两个必填项（名称 / 角色设定），提交后由 useAgentMarketActions 统一 toast 与刷新快照。
 */
export function AgentMarketEditor({ agent, onSaved, onCancel }: AgentMarketEditorProps) {
	const actions = useAgentMarketActions();
	const [name, setName] = useState(agent?.name ?? "");
	const [icon, setIcon] = useState(agent?.icon ?? "");
	const [description, setDescription] = useState(agent?.description ?? "");
	const [category, setCategory] = useState<AgentProfileCategory>(agent?.category ?? "general");
	const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
	const [selectedModel, setSelectedModel] = useState<AgentModelRef | undefined>(() => initialModelOf(agent));
	const [backend, setBackend] = useState<AgentProfileBackend | undefined>(agent?.backend);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [saving, setSaving] = useState(false);

	// 选择器打开才拉模型目录，避免页面常驻轮询；sessionId 只满足 hook 签名（目录按项目加载，这里不绑项目）。
	const { models, report, loading, refreshing, reload } = useBackendModelCatalog({ sessionId: "agent-market-editor", enabled: modelPickerOpen });
	const currentModel = models.find((model) => model.provider === selectedModel?.provider && model.id === selectedModel?.modelId);
	const modelLabel = selectedModel ? (currentModel?.name ?? `${selectedModel.provider} / ${selectedModel.modelId}`) : t("agentMarket.modelUnset");

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) {
			showNotice(t("agentMarket.nameRequired"), 2500, "warning");
			return;
		}
		if (!systemPrompt.trim()) {
			showNotice(t("agentMarket.promptRequired"), 2500, "warning");
			return;
		}
		setSaving(true);
		try {
			const base = {
				name: name.trim(),
				description: description.trim(),
				icon: icon.trim(),
				category,
				systemPrompt: systemPrompt.trim(),
			};
			// update 始终带上 backend 键（值为 undefined = 跟随默认）：IPC 结构化克隆保留自有键，
			// 主进程据此删除字段；create 省略 backend 等价于未指定。
			const saved = agent ? await actions.updateAgent(agent.id, { ...base, model: selectedModel ?? EMPTY_AGENT_MODEL_REF, backend }) : await actions.createAgent({ ...base, ...(selectedModel ? { model: selectedModel } : {}), ...(backend ? { backend } : {}) });
			// 失败时 actions 已 toast 并返回 null：保留表单内容，用户改完可直接重试。
			if (saved) onSaved();
		} finally {
			setSaving(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<div className="mx-auto flex max-w-[640px] flex-col gap-4">
					{agent?.builtin && (
						<Alert className="border-warning/30 bg-warning/10 py-2">
							<Info className="size-4 text-warning" aria-hidden="true" />
							<AlertDescription className="text-xs leading-snug text-foreground/80">{t("agentMarket.builtinEditHint")}</AlertDescription>
						</Alert>
					)}

					<div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-market-name" className="text-xs font-medium">
								{t("agentMarket.fieldName")} <span className="text-destructive">*</span>
							</Label>
							<Input id="agent-market-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("agentMarket.fieldNamePlaceholder")} maxLength={AGENT_PROFILE_NAME_MAX_CHARS} autoFocus />
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-market-icon" className="text-xs font-medium">
								{t("agentMarket.fieldIcon")}
							</Label>
							<Input id="agent-market-icon" value={icon} onChange={(event) => setIcon(event.target.value)} placeholder="🤖" maxLength={AGENT_PROFILE_ICON_MAX_CHARS} className="text-center" />
						</div>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="agent-market-description" className="text-xs font-medium">
							{t("agentMarket.fieldDescription")}
						</Label>
						<Textarea id="agent-market-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("agentMarket.fieldDescriptionPlaceholder")} maxLength={AGENT_PROFILE_DESCRIPTION_MAX_CHARS} rows={2} className="resize-none text-xs" />
					</div>

					<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-market-category" className="text-xs font-medium">
								{t("agentMarket.fieldCategory")}
							</Label>
							<Select
								value={category}
								onValueChange={(value) => {
									if (isAgentProfileCategory(value)) setCategory(value);
								}}
							>
								<SelectTrigger id="agent-market-category" size="sm" className="w-full text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{AGENT_PROFILE_CATEGORIES.map((item) => (
										<SelectItem key={item} value={item} className="text-xs">
											{t(AGENT_CATEGORY_LABEL_KEYS[item])}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label className="text-xs font-medium">{t("agentMarket.fieldModel")}</Label>
							<div className="flex items-center gap-1">
								<Button type="button" variant="outline" className="h-8 min-w-0 flex-1 justify-between px-2 font-mono text-xs" title={modelLabel} onClick={() => setModelPickerOpen(true)}>
									<span className="min-w-0 truncate">{modelLabel}</span>
									<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
								</Button>
								{selectedModel && (
									<Button type="button" variant="ghost" size="sm" className="h-8 w-8 px-0" title={t("agentMarket.modelUnset")} aria-label={t("agentMarket.modelUnset")} onClick={() => setSelectedModel(undefined)}>
										<X className="size-3.5" aria-hidden="true" />
									</Button>
								)}
							</div>
							<p className="text-micro leading-snug text-muted-foreground">{t("agentMarket.fieldModelHint")}</p>
						</div>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="agent-market-backend" className="text-xs font-medium">
							{t("agentMarket.backend")}
						</Label>
						<Select
							value={backend ?? FOLLOW_DEFAULT_BACKEND_VALUE}
							onValueChange={(value) => {
								if (value === FOLLOW_DEFAULT_BACKEND_VALUE) {
									setBackend(undefined);
									return;
								}
								if (isAgentProfileBackend(value)) setBackend(value);
							}}
						>
							<SelectTrigger id="agent-market-backend" size="sm" className="w-full text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={FOLLOW_DEFAULT_BACKEND_VALUE} className="text-xs">
									{t("agentMarket.backendFollow")}
								</SelectItem>
								{AGENT_PROFILE_BACKENDS.map((item) => (
									<SelectItem key={item} value={item} className="text-xs">
										{t(AGENT_BACKEND_LABEL_KEYS[item])}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-micro leading-snug text-muted-foreground">{t("agentMarket.backendHint")}</p>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="agent-market-prompt" className="text-xs font-medium">
							{t("agentMarket.fieldSystemPrompt")} <span className="text-destructive">*</span>
						</Label>
						<Textarea id="agent-market-prompt" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder={t("agentMarket.fieldSystemPromptPlaceholder")} maxLength={AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS} rows={12} className="min-h-[220px] resize-y font-mono text-xs leading-relaxed" />
						<p className="text-micro leading-snug text-muted-foreground">{t("agentMarket.fieldSystemPromptHint")}</p>
					</div>
				</div>
			</div>

			<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/40 px-5 py-3">
				<Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={onCancel} disabled={saving}>
					{t("common.cancel")}
				</Button>
				<Button type="submit" size="sm" className="h-8 text-xs" loading={saving}>
					{t("common.save")}
				</Button>
			</footer>

			{modelPickerOpen && (
				<ModelPicker
					models={models}
					report={report}
					loading={loading}
					refreshing={refreshing}
					onRefresh={() => reload(true)}
					current={selectedModel}
					onClose={() => setModelPickerOpen(false)}
					onPick={(model) => {
						setSelectedModel({ provider: model.provider, modelId: model.id });
						setModelPickerOpen(false);
					}}
				/>
			)}
		</form>
	);
}
