import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { ChevronDown, Sparkles, X } from "lucide-react";
import { projectInventoryAtom } from "../../atoms/project-atoms";
import { dshRuntimeStatusAtom } from "../../atoms";
import { dshSendBlockReason } from "../../../../shared/types/dshRuntime";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import { Label } from "../ui-shadcn/label";
import { Switch } from "../ui-shadcn/switch";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui-shadcn/select";
import { ModelPicker } from "../session/ComposerComponents";
import { THINKING_LEVELS } from "../session/sessionPickerOptions";
import { useBackendModelCatalog } from "../../hooks/useBackendModelCatalog";
import { CronScheduleBuilder } from "./CronScheduleBuilder";
import type {
	AutomationTask,
	AutomationTaskMode,
	CreateAutomationTaskInput,
	UpdateAutomationTaskInput,
} from "../../../../shared/types";

interface AutomationTaskEditorProps {
	task?: AutomationTask | null;
	onSave: () => void;
	onCancel: () => void;
}

/** Radix Select 禁止 value=""；空档位表示跟随项目/全局，用哨兵值落盘时再清掉。 */
const THINKING_INHERIT = "inherit";

/**
 * 定时任务可选的「工作模式」档位（顺序即展示顺序）。
 * 与输入框「+」菜单里的 composer 模式同义：普通=直接执行，计划=只读分析出计划，
 * 目标=围绕提示词自动连续推进。这里不含生图后端：AutomationTask.backend 已排除它。
 */
const TASK_MODE_OPTIONS: Array<{
	value: AutomationTaskMode;
	/** 直接复用 composer 模式文案，定时任务与输入框「+」菜单的说法保持一致。 */
	labelKey: "app.composerModeNormal" | "app.composerModePlan" | "app.composerModeGoal";
}> = [
	{ value: "normal", labelKey: "app.composerModeNormal" },
	{ value: "plan", labelKey: "app.composerModePlan" },
	{ value: "goal", labelKey: "app.composerModeGoal" },
];

/**
 * 定时任务执行后端：pi（本地 pi 进程）或 dsh（DSH host 进程）。
 * 与 AutomationTask.backend 同型（Exclude<AgentBackend, "imagegen">），
 * 编辑器只关心这两个值，不引全量 AgentBackend。
 */
type TaskBackend = "pi" | "dsh";

/**
 * 定时任务新建与编辑表单。
 * 模型/思考走会话同款选择器，调度走可视化 Cron，避免用户手输 provider/model-id 和五段表达式。
 */
export function AutomationTaskEditor({
	task,
	onSave,
	onCancel,
}: AutomationTaskEditorProps) {
	const projects = useAtomValue(projectInventoryAtom);

	const [name, setName] = useState(task?.name ?? "");
	const [projectId, setProjectId] = useState(
		task?.projectId ?? (projects[0]?.id || ""),
	);
	const [cronExpression, setCronExpression] = useState(
		task?.schedule.type === "cron" ? task.schedule.expression : "0 9 * * 1-5",
	);
	const [prompt, setPrompt] = useState(task?.prompt ?? "");
	const [selectedModel, setSelectedModel] = useState<
		{ provider: string; modelId: string } | undefined
	>(task?.model);
	// 执行后端：旧任务无 backend 字段时缺省 pi。切换 dsh 后 mode/thinking 会被
	// 锁定回继承/普通（DSH 无 plan/goal 扩展与独立思考档位，见下方 UI 约束）。
	const [backend, setBackend] = useState<TaskBackend>(task?.backend ?? "pi");
	const [thinkingLevel, setThinkingLevel] = useState(task?.thinkingLevel ?? "");
	// 缺省（含旧任务）不在下拉里显示普通模式，而显示「跟随项目/全局」——
	// 普通模式本就是默认行为，说「跟随」比说「普通」更贴近实际语义。
	const [mode, setMode] = useState<AutomationTaskMode | "">(task?.mode ?? "");
	const [enabled, setEnabled] = useState(task?.enabled ?? true);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
	const [recentProviders, setRecentProviders] = useState<string[]>([]);
	const [hiddenProviders, setHiddenProviders] = useState<string[]>([]);

	const initialTimeoutMinutes =
		task?.budget?.timeoutMs != null
			? String(Math.round(task.budget.timeoutMs / 60000))
			: "";
	const [timeoutMinutes, setTimeoutMinutes] = useState<string>(
		initialTimeoutMinutes,
	);
	const [maxTokens, setMaxTokens] = useState<string>(
		task?.budget?.maxTokens ? String(task.budget.maxTokens) : "",
	);
	const [maxCostUsd, setMaxCostUsd] = useState<string>(
		task?.budget?.maxCostUsd ? String(task.budget.maxCostUsd) : "",
	);
	const [maxSteps, setMaxSteps] = useState<string>(
		task?.budget?.maxSteps ? String(task.budget.maxSteps) : "",
	);

	const [cronPreviews, setCronPreviews] = useState<number[]>([]);
	const [cronError, setCronError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	// DSH runtime 安装态：未安装/损坏/过旧时拦截发送，编辑器据此提示「先去设置安装」
	// （同一拦截函数与 App 发送链路共用，保证口径一致）。
	const dshRuntimeStatus = useAtomValue(dshRuntimeStatusAtom);
	const dshBlockReason = dshSendBlockReason(dshRuntimeStatus.state);

	// DSH 无 plan/goal 模式与独立思考档位（都是 pi 侧内置扩展），
	// 提交时强制退回缺省；UI 上 Select 置灰 + 锁定显示值，避免用户配了不生效。
	const isDsh = backend === "dsh";
	const effectiveMode: AutomationTaskMode | typeof THINKING_INHERIT = isDsh
		? "normal"
		: (mode || THINKING_INHERIT);
	const effectiveThinking = isDsh ? THINKING_INHERIT : (thinkingLevel || THINKING_INHERIT);

	useEffect(() => {
		void desktopApi.settings
			.get()
			.then((settings) => {
				setFavoriteModels(settings.favoriteModels ?? []);
				setRecentProviders(settings.recentProviders ?? []);
				setHiddenProviders(settings.hiddenProviders ?? []);
			})
			.catch(() => undefined);
	}, []);

	// 选择器打开才拉模型目录，避免弹层常驻轮询；sessionId 仅满足 hook 签名（目录按 projectId 加载）。
	const { models, report, loading: catalogLoading, refreshing, reload } = useBackendModelCatalog({
		sessionId: "automation-editor",
		projectId: projectId || undefined,
		// DSH 任务选 DSH host 的模型目录（listDshModels），pi 任务用默认目录；
		// 切换 backend 后目录随动，避免把 pi 模型填进 DSH 任务的 model 字段。
		backend: isDsh ? "dsh" : undefined,
		enabled: modelPickerOpen,
	});

	useEffect(() => {
		let isCancelled = false;
		const trimmed = cronExpression.trim();
		if (!trimmed) {
			setCronPreviews([]);
			setCronError(null);
			return;
		}

		desktopApi.automation
			.previewCron(trimmed, 3)
			.then((res) => {
				if (isCancelled) return;
				if (res.valid) {
					setCronPreviews(res.nextRuns);
					setCronError(null);
				} else {
					setCronPreviews([]);
					setCronError(res.error || t("automation.cronInvalid"));
				}
			})
			.catch(() => {
				if (isCancelled) return;
				setCronPreviews([]);
				setCronError(t("automation.cronInvalid"));
			});

		return () => {
			isCancelled = true;
		};
	}, [cronExpression]);

	const currentModel = models.find(
		(model) =>
			model.provider === selectedModel?.provider && model.id === selectedModel?.modelId,
	);
	const modelLabel = selectedModel
		? (currentModel?.name ?? `${selectedModel.provider}/${selectedModel.modelId}`)
		: t("automation.modelUnset");

	const toggleFavorite = async (provider: string, modelId: string) => {
		const key = `${provider}/${modelId}`;
		const next = favoriteModels.includes(key)
			? favoriteModels.filter((item) => item !== key)
			: [...favoriteModels, key];
		setFavoriteModels(next);
		try {
			await desktopApi.settings.update({ favoriteModels: next });
		} catch (error) {
			setFavoriteModels(favoriteModels);
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) {
			showNotice(t("automation.namePlaceholder"), 2000);
			return;
		}
		if (!projectId) {
			showNotice(t("automation.projectSelect"), 2000);
			return;
		}
		if (!prompt.trim()) {
			showNotice(t("automation.promptPlaceholder"), 2000);
			return;
		}
		if (cronError || cronPreviews.length === 0) {
			showNotice(t("automation.cronInvalid"), 2000);
			return;
		}

		setIsSubmitting(true);
		try {
			const timeoutMinNum = timeoutMinutes.trim() ? Number(timeoutMinutes) : undefined;
			const budget = {
				timeoutMs: timeoutMinNum ? timeoutMinNum * 60000 : 30 * 60000,
				maxTokens: maxTokens.trim() ? Number(maxTokens) : undefined,
				maxCostUsd: maxCostUsd.trim() ? Number(maxCostUsd) : undefined,
				maxSteps: maxSteps.trim() ? Number(maxSteps) : undefined,
			};

			// IPC/JSON 会丢掉 undefined 键。更新时用空对象/空串表示「恢复默认」，
			// 避免主进程把缺省字段当成「保持原值」。
			if (task) {
				const patch: UpdateAutomationTaskInput = {
					name: name.trim(),
					projectId,
					schedule: {
						type: "cron",
						expression: cronExpression.trim(),
					},
					prompt: prompt.trim(),
					model: selectedModel ?? { provider: "", modelId: "" },
					// DSH 无独立档位：thinking/mode 强制回缺省（清空即「跟随/普通」）。
					thinkingLevel: isDsh ? "" : thinkingLevel.trim(),
					// 与 model/thinkingLevel 同理：用空串表示「恢复默认（普通模式）」,
					// 而不是省略键——省略会被主进程当成「保持原值」。
					mode: isDsh ? "normal" : ((mode || "normal") as AutomationTaskMode),
					// 显式覆盖后端：旧任务没有该字段时也写死当前选择，防止「保持原值」歧义。
					backend,
					enabled,
					budget,
				};
				await desktopApi.automation.updateTask(task.id, patch);
			} else {
				const input: CreateAutomationTaskInput = {
					name: name.trim(),
					projectId,
					schedule: {
						type: "cron",
						expression: cronExpression.trim(),
					},
					prompt: prompt.trim(),
					enabled,
					budget,
					backend,
					...(selectedModel ? { model: selectedModel } : {}),
					// DSH 无独立档位，thinking/mode 一律不写（store 缺省即继承/普通）。
					...(!isDsh && thinkingLevel.trim()
						? { thinkingLevel: thinkingLevel.trim() }
						: {}),
					// 普通模式是缺省，不必写进创建入参；store 侧也只持久化非 normal。
					...(!isDsh && mode && mode !== "normal" ? { mode } : {}),
				};
				await desktopApi.automation.createTask(input);
			}

			showNotice(t("automation.taskSaved"), 2000);
			onSave();
		} catch (error) {
			showNotice(
				error instanceof Error ? error.message : String(error),
				3500,
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4 py-1">
			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="task-name" className="text-xs font-medium">
						{t("automation.name")} <span className="text-destructive">*</span>
					</Label>
					<Input
						id="task-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={t("automation.namePlaceholder")}
						className="h-8 text-xs"
						required
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="task-project" className="text-xs font-medium">
						{t("automation.project")} <span className="text-destructive">*</span>
					</Label>
					<Select value={projectId} onValueChange={setProjectId}>
						<SelectTrigger id="task-project" className="h-8 text-xs">
							<SelectValue placeholder={t("automation.projectSelect")} />
						</SelectTrigger>
						<SelectContent>
							{projects.map((p) => (
								<SelectItem key={p.id} value={p.id} className="text-xs">
									{p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			<CronScheduleBuilder
				value={cronExpression}
				onChange={setCronExpression}
				previews={cronPreviews}
				error={cronError}
			/>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="task-backend" className="text-xs font-medium">
					{t("automation.backend")}
				</Label>
				<Select
					value={backend}
					onValueChange={(value) => setBackend(value as TaskBackend)}
				>
					<SelectTrigger id="task-backend" className="h-8 text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="pi" className="text-xs">
							{t("automation.backendPi")}
						</SelectItem>
						<SelectItem value="dsh" className="text-xs">
							{t("automation.backendDsh")}
						</SelectItem>
					</SelectContent>
				</Select>
				{isDsh && dshBlockReason ? (
					// DSH runtime 缺失/损坏/过旧：触发时 host 无法 fork，发送会被拦截。
					// 只提示不动手（安装入口在设置），与 App 发送链路的拦截口径一致。
					<p className="text-[11px] leading-snug text-destructive">
						{t("automation.backendDshUnavailable")}
					</p>
				) : (
					<p className="text-[11px] leading-snug text-muted-foreground">
						{t("automation.backendHint")}
					</p>
				)}
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor="task-mode" className="text-xs font-medium">
					{t("automation.mode")}
				</Label>
				<Select
					value={effectiveMode}
					disabled={isDsh}
					onValueChange={(value) => {
						setMode(value === THINKING_INHERIT ? "" : (value as AutomationTaskMode));
					}}
				>
					<SelectTrigger id="task-mode" className="h-8 text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={THINKING_INHERIT} className="text-xs">
							{t("automation.modeInherit")}
						</SelectItem>
						{TASK_MODE_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value} className="text-xs">
								{t(option.labelKey)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-[11px] leading-snug text-muted-foreground">
					{isDsh ? t("automation.dshModeHint") : t("automation.modeHint")}
				</p>
			</div>
		</div>

		<div className="flex flex-col gap-1.5">
			<Label htmlFor="task-prompt" className="text-xs font-medium">
				{t("automation.prompt")} <span className="text-destructive">*</span>
			</Label>
			<Textarea
				id="task-prompt"
				value={prompt}
				onChange={(e) => setPrompt(e.target.value)}
				placeholder={t("automation.promptPlaceholder")}
				rows={4}
				className="text-xs font-mono"
				required
			/>
		</div>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs font-medium">{t("automation.model")}</Label>
					<div className="flex items-center gap-1">
						<Button
							type="button"
							variant="outline"
							className="h-8 min-w-0 flex-1 justify-between px-2 font-mono text-xs"
							title={modelLabel}
							onClick={() => setModelPickerOpen(true)}
						>
							<span className="min-w-0 truncate">{modelLabel}</span>
							<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
						</Button>
						{selectedModel && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-8 w-8 px-0"
								title={t("automation.modelUnset")}
								onClick={() => setSelectedModel(undefined)}
							>
								<X className="size-3.5" />
							</Button>
						)}
					</div>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="task-thinking" className="text-xs font-medium">
						{t("automation.thinkingLevel")}
					</Label>
					<Select
						value={effectiveThinking}
						disabled={isDsh}
						onValueChange={(value) => {
							setThinkingLevel(value === THINKING_INHERIT ? "" : value);
						}}
					>
						<SelectTrigger id="task-thinking" className="h-8 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={THINKING_INHERIT} className="text-xs">
								{t("automation.thinkingInherit")}
							</SelectItem>
							{THINKING_LEVELS.map((level) => (
								<SelectItem key={level.value} value={level.value} className="text-xs">
									{t(level.labelKey)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			<div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-bg-panel/40 p-3">
				<Label className="flex items-center gap-1.5 text-xs font-medium">
					<Sparkles className="size-3.5 text-amber-500" />
					{t("automation.budgets")}
				</Label>
				<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
					<div className="flex flex-col gap-1">
						<span className="text-[11px] text-muted-foreground">{t("automation.timeoutMinutes")}</span>
						<Input
							type="number"
							min="1"
							value={timeoutMinutes}
							onChange={(e) => setTimeoutMinutes(e.target.value)}
							placeholder="30"
							className="h-7 font-mono text-xs"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-[11px] text-muted-foreground">{t("automation.maxTokens")}</span>
						<Input
							type="number"
							min="1000"
							value={maxTokens}
							onChange={(e) => setMaxTokens(e.target.value)}
							placeholder="e.g. 500000"
							className="h-7 font-mono text-xs"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-[11px] text-muted-foreground">{t("automation.maxCostUsd")}</span>
						<Input
							type="number"
							step="0.01"
							min="0.01"
							value={maxCostUsd}
							onChange={(e) => setMaxCostUsd(e.target.value)}
							placeholder="e.g. 1.00"
							className="h-7 font-mono text-xs"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-[11px] text-muted-foreground">{t("automation.maxSteps")}</span>
						<Input
							type="number"
							min="1"
							value={maxSteps}
							onChange={(e) => setMaxSteps(e.target.value)}
							placeholder="e.g. 50"
							className="h-7 font-mono text-xs"
						/>
					</div>
				</div>
			</div>

			<div className="flex items-center justify-between border-t border-border/40 pt-2">
				<div className="flex items-center gap-2">
					<Switch
						id="task-enabled"
						checked={enabled}
						onCheckedChange={setEnabled}
					/>
					<Label htmlFor="task-enabled" className="cursor-pointer text-xs">
						{enabled ? t("automation.enabled") : t("automation.disabled")}
					</Label>
				</div>

				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-8 text-xs"
						onClick={onCancel}
						disabled={isSubmitting}
					>
						{t("automation.cancel")}
					</Button>
					<Button
						type="submit"
						size="sm"
						className="h-8 text-xs"
						disabled={isSubmitting || !!cronError}
					>
						{t("automation.saveTask")}
					</Button>
				</div>
			</div>

			{modelPickerOpen && (
				<ModelPicker
					models={models}
					report={report}
					loading={catalogLoading}
					refreshing={refreshing}
					onRefresh={() => reload(true)}
					current={selectedModel}
					favoriteModels={favoriteModels}
					recentProviders={recentProviders}
					hiddenProviders={hiddenProviders}
					onClose={() => setModelPickerOpen(false)}
					onPick={(model) => {
						setSelectedModel({ provider: model.provider, modelId: model.id });
						setModelPickerOpen(false);
					}}
					onToggleFavorite={(provider, modelId) => void toggleFavorite(provider, modelId)}
				/>
			)}
		</form>
	);
}
