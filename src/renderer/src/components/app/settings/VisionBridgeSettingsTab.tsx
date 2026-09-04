/**
 * 视觉桥设置页（设置弹框 → 视觉桥 tab）。
 *
 * 数据流：挂载时经 vision:get-config 拉取「当前配置」，模型选择复用会话的
 * ModelPicker（数据源 projects.listModels = models.json + auth.json + 内置目录全量模型，
 * 支持/不支持视觉由用户自行判断，不做能力过滤）；保存时经 vision:save-config
 * 白名单校验后写回 ~/.pi/agent/pi-deck-vision.json（pi-deck-vision 扩展运行时读取同一文件）。
 *
 * 保存逻辑统一归设置弹框头部「保存」按钮（useVisionBridgeDraft 上提草稿/脏标记/保存，
 * hook 见 visionDraft.ts，独立成文件以便本组件 lazy 加载），
 * 本组件只负责表单呈现与模型选择；保存成功提示走全局 toast（底部绿字太隐蔽，用户
 * 要求改 toast），失败提示就近展示（与头部保存按钮对照），底部保留运行日志诊断区。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, RefreshCw, Trash2 } from "lucide-react";
import { t } from "../../../i18n";
import { cn } from "../../../lib/utils";
import { desktopApi } from "../../../desktopApi";
import { showNotice } from "../../../utils/notice";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Textarea } from "../../ui-shadcn/textarea";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../ui-shadcn/select";
import { ModelPicker } from "../../session/ComposerComponents";
import type {
	AvailableModel,
	VisionBridgeConfig,
	VisionLogInfo,
} from "../../../../../shared/types";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow, SettingSwitchRow } from "./SettingRows";
import {
	DEFAULT_PROMPT,
	DEFAULT_TIMEOUT_MS,
	configFilePath,
	emptyDraft,
} from "./visionDraft.ts";

export type { VisionBridgeConfig, VisionBridgeState } from "../../../../../shared/types";
export { useVisionBridgeDraft, DEFAULT_PROMPT, DEFAULT_TIMEOUT_MS, configFilePath, emptyDraft } from "./visionDraft.ts";

export function VisionBridgeSettingsTab(props: {
	draft: VisionBridgeConfig | null;
	saving: boolean;
	/** 配置文件所在目录（来自主进程 vision:get-config 返回，用于展示落盘路径） */
	configDir: string;
	/** 保存失败提示（成功已走全局 toast）；头部保存后在此就近展示错误，便于对照 */
	notice: string | null;
	onChange: (patch: Partial<VisionBridgeConfig>) => void;
}) {
	const { draft, saving, notice, configDir, onChange } = props;
	const [pickerOpen, setPickerOpen] = useState(false);
	// 运行日志（诊断“视觉桥走没走”）：挂载时拉一次，用户可手动刷新
	const [logInfo, setLogInfo] = useState<VisionLogInfo | null>(null);

	const loadLog = useCallback(async () => {
		try {
			setLogInfo(await desktopApi.config.visionGetLog());
		} catch {
			setLogInfo(null);
		}
	}, []);

	// 打开模型选择器时拉取全量模型（复用现有 ModelPicker 的数据源）；
	// 挂载时也拉一次（模型列表有全局缓存，开销小），用于展示当前已选模型的能力。
	// refreshing/reload：手动刷新绕过缓存重新 fork pi --list-models，
	// 模型列表加载不出来时选择器里的刷新按钮可立即重试。
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [modelsRefreshing, setModelsRefreshing] = useState(false);
	const loadModels = useCallback(async (force = false) => {
		if (force) setModelsRefreshing(true);
		try {
			setModels(await desktopApi.projects.listModelsReport(undefined, force).then((r) => r.models));
		} catch {
			setModels([]);
		} finally {
			setModelsRefreshing(false);
		}
	}, []);

	useEffect(() => {
		loadLog();
		loadModels();
	}, [loadLog, loadModels]);

	const updateDraft = (patch: Partial<VisionBridgeConfig>) => {
		onChange(patch);
	};

	const openPicker = async () => {
		await loadModels();
		setPickerOpen(true);
	};

	const onPickModel = (model: AvailableModel) => {
		const patch: Partial<VisionBridgeConfig> = { provider: model.provider, model: model.id };
		// 按模型能力自动填充：maxTokens 建议 min(单次输出上限, 4096)（描述图片一般 4K 足够），
		// 仅当配置里从未有过该字段（undefined，如旧版本文件被手删）时写入，
		// 不覆盖用户显式选择的「不限制(0)」或手动值（>0）
		if (typeof model.maxTokens === "number" && model.maxTokens > 0) {
			const suggested = Math.min(model.maxTokens, 4096);
			if (draft?.maxTokens === undefined) {
				patch.maxTokens = suggested;
			}
		}
		// provider 本身是 URL（自定义网关）时自动作为 baseUrl，用户无需手动填
		if (!draft?.baseUrl && /^https?:\/\/[^\s]+$/i.test(model.provider)) {
			patch.baseUrl = model.provider.replace(/\/+$/, "");
		}
		updateDraft(patch);
		setPickerOpen(false);
	};

	const selectedModelLabel = useMemo(() => {
		if (!draft?.provider || !draft?.model) return "";
		return `${draft.provider}/${draft.model}`;
	}, [draft?.provider, draft?.model]);

	/** 当前配置对应的模型能力（模型列表来自 pi --list-models 全量输出） */
	const selectedModel = useMemo(
		() => models.find((m) => m.provider === draft?.provider && m.id === draft?.model),
		[models, draft?.provider, draft?.model],
	);

	/** token 数转人类可读：1048576→"1M"，67109→"65.5K"，204800→"200K" */
	const formatTokens = (n: number): string => {
		if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)}M`;
		if (n >= 1024) return `${Math.round(n / 1024)}K`;
		return String(n);
	};

	if (!draft) return <div className="settings-panel min-w-0" />;

	return (
		<div className="min-w-0">
			<SettingsSection title={t("settings.vision.section")} description={t("settings.vision.sectionDesc")}>
				{/* 总开关 */}
				<SettingSwitchRow
					title={t("settings.vision.enabled")}
					description={t("settings.vision.enabledDesc")}
					checked={draft?.enabled ?? true}
					onChange={(checked) => updateDraft({ enabled: checked })}
				/>

				{/* 视觉模型选择：复用会话的 ModelPicker（全量模型，含 auth.json），
				    是否支持视觉由用户自行判断，不做能力标注/过滤 */}
				<SettingRow
					title={<span>{t("settings.vision.model")}</span>}
					description={
						selectedModelLabel ? (
							<>
								{selectedModel?.images === false ? (
									<span className="font-semibold text-destructive">{t("settings.vision.noImagesWarning")}</span>
								) : (
									<span className="inline-flex items-center gap-1">
										<Check size={12} aria-hidden />
										{t("settings.vision.modelSelectedHint")}
									</span>
								)}
								{/* 模型能力：来自 pi --list-models 的 context/max-out/thinking/images 列 */}
								<span className="flex flex-wrap gap-x-3 gap-y-1">
									{selectedModel ? (
										<>
											<span>
												{selectedModel.images === true
													? t("settings.vision.supportsImages")
													: selectedModel.images === false
														? t("settings.vision.unsupportedImages")
														: t("settings.vision.capabilityUnknown")}
											</span>
											{selectedModel.contextWindow !== undefined && (
												<span>{t("settings.vision.contextWindow", { size: formatTokens(selectedModel.contextWindow) })}</span>
											)}
											{selectedModel.maxTokens !== undefined && (
												<span>{t("settings.vision.outputCap", { size: formatTokens(selectedModel.maxTokens) })}</span>
											)}
											{selectedModel.reasoning && <span>{t("settings.vision.thinking")}</span>}
										</>
									) : (
										<span>{t("settings.vision.capabilityUnknown")}</span>
									)}
								</span>
							</>
						) : draft?.enabled ? (
							/* 开启状态未选模型：即时提示（保存按钮同步禁用，见 SettingsModal） */
							<span className="font-semibold text-destructive">{t("settings.vision.modelRequired")}</span>
						) : undefined
					}
				>
					<Button
						type="button"
						variant="outline"
						className="w-full justify-between font-mono text-control"
						/* provider/model 是不可断行 token（/ 与 - 都不产生换行机会），
						   长模型名靠 min-w-0 truncate 收在按钮内省略号截断，
						   悬停 title 显示完整引用；未选择时不挂 title，避免空 tooltip。 */
						title={selectedModelLabel || undefined}
						onClick={openPicker}
					>
						<span
							className={cn(
								"min-w-0 truncate",
								!selectedModelLabel && "text-muted-foreground",
							)}
						>
							{selectedModelLabel || t("settings.vision.modelPlaceholder")}
						</span>
						<ChevronsUpDown size={14} className="flex-none opacity-60" aria-hidden />
					</Button>
				</SettingRow>

				{/* API 格式（一般自动推断） */}
				<SettingRow
					title={<span>{t("settings.vision.api")}</span>}
					description={t("settings.vision.apiDesc")}
					alignEnd={false}
				>
					<Select
						value={draft?.api ?? "auto"}
						onValueChange={(api) => updateDraft({ api: api === "auto" ? undefined : (api as VisionBridgeConfig["api"]) })}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="auto">{t("settings.vision.apiAuto")}</SelectItem>
							<SelectItem value="openai-completions">{t("settings.vision.apiOpenai")}</SelectItem>
							<SelectItem value="anthropic-messages">{t("settings.vision.apiAnthropic")}</SelectItem>
							<SelectItem value="google-generative-ai">{t("settings.vision.apiGoogle")}</SelectItem>
						</SelectContent>
					</Select>
				</SettingRow>

				{/* 可选覆盖项 */}
				<SettingRow
					title={<span>{t("settings.vision.baseUrl")}</span>}
					description={t("settings.vision.baseUrlDesc")}
					stacked
				>
					<Input
						value={draft?.baseUrl ?? ""}
						placeholder="https://open.bigmodel.cn/api/paas/v4"
						onChange={(event) => updateDraft({ baseUrl: event.target.value || undefined })}
					/>
				</SettingRow>

				<SettingRow
					title={<span>{t("settings.vision.apiKey")}</span>}
					description={t("settings.vision.apiKeyDesc")}
					stacked
				>
					<Input
						type="password"
						value={draft?.apiKey ?? ""}
						onChange={(event) => updateDraft({ apiKey: event.target.value || undefined })}
					/>
				</SettingRow>

				{/* 描述最大 token：下拉「不限制 / 自定义」；不限制时不传该字段，Anthropic 必填则请求侧兜底 1024 */}
				<SettingRow
					title={<span>{t("settings.vision.maxTokens")}</span>}
					description={t("settings.vision.maxTokensDesc")}
					alignEnd={false}
					stacked
				>
					<div className="flex w-full items-start gap-2">
						{/* 0/undefined 一律视为「不限制」；>0 为手动限制值 */}
						{(() => {
							const maxTokens = draft?.maxTokens ?? 0;
							const custom = maxTokens > 0;
							return (
								<>
									<Select
										value={custom ? "custom" : "unlimited"}
										onValueChange={(value) => {
											if (value === "unlimited") {
												updateDraft({ maxTokens: 0 });
											} else if (!custom) {
												// 从「不限制」切到「自定义」：以 1024 起步（与 Anthropic 兜底值一致）
												updateDraft({ maxTokens: 1024 });
											}
										}}
									>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="unlimited">{t("settings.vision.maxTokensUnlimited")}</SelectItem>
											<SelectItem value="custom">{t("settings.vision.maxTokensCustom")}</SelectItem>
										</SelectContent>
									</Select>
									{custom && (
										<Input
											type="number"
											min={1}
											max={32768}
											className="w-32 shrink-0"
											value={maxTokens}
											onChange={(event) => updateDraft({ maxTokens: Number(event.target.value) || undefined })}
										/>
									)}
								</>
							);
						})()}
					</div>
				</SettingRow>
				<SettingRow
					title={<span>{t("settings.vision.concurrency")}</span>}
					alignEnd={false}
				>
					<Input
						type="number"
						min={1}
						max={16}
						value={draft?.concurrency ?? 2}
						onChange={(event) => updateDraft({ concurrency: Number(event.target.value) || undefined })}
					/>
				</SettingRow>

				{/* 单图转换超时：UI 以秒为单位（用户直觉），落盘转毫秒与配置文件/扩展一致；
				    清空/非法输入回退默认（undefined → 展示层回显默认值）。 */}
				<SettingRow
					title={<span>{t("settings.vision.timeout")}</span>}
					description={t("settings.vision.timeoutDesc")}
					alignEnd={false}
				>
					<Input
						type="number"
						min={1}
						max={300}
						value={Math.round((draft?.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}
						onChange={(event) => {
							const seconds = Number(event.target.value);
							updateDraft({
								timeoutMs:
									Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined,
							});
						}}
					/>
				</SettingRow>

				{/* 提示词模板 + 恢复默认 */}
				<SettingRow
					title={<span>{t("settings.vision.promptTemplate")}</span>}
					description={t("settings.vision.promptTemplateDesc")}
					stacked
				>
					<Textarea
						rows={6}
						value={draft?.promptTemplate ?? DEFAULT_PROMPT}
						onChange={(event) => updateDraft({ promptTemplate: event.target.value })}
					/>
					<div className="pt-2">
						<Button variant="outline" size="sm" onClick={() => updateDraft({ promptTemplate: DEFAULT_PROMPT })}>
							{t("settings.vision.promptDefault")}
						</Button>
					</div>
				</SettingRow>
			</SettingsSection>

			{/* 配置文件位置说明：扩展与 PiDeck 共享 */}
			<SettingsSection
				title={t("settings.vision.configFile")}
				description={
					<code className="break-all text-caption text-muted-foreground">
						{configDir ? configFilePath(configDir) : ""}
					</code>
				}
			/>

			{/* 运行记录诊断区：发一张图 → 回来刷新，即可确认视觉桥是否真的生效 */}
			<SettingsSection title={t("settings.vision.logSection")} description={t("settings.vision.logSectionDesc")}>
				<div className="flex items-center gap-2 px-0.5 pb-2">
					<Button variant="outline" size="sm" onClick={loadLog}>
						<RefreshCw size={12} aria-hidden />
						{t("settings.vision.logRefresh")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={async () => {
							await desktopApi.config.visionClearLog();
							loadLog();
						}}
					>
						<Trash2 size={12} aria-hidden />
						{t("settings.vision.logClear")}
					</Button>
					{logInfo?.exists && logInfo.size > 0 && (
						<small className="text-muted-foreground">
							{t("settings.vision.logSize", { size: Math.max(1, Math.round(logInfo.size / 1024)) })}
							{logInfo.truncated ? ` ${t("settings.vision.logTruncated")}` : ""}
						</small>
					)}
				</div>
				<pre className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg-muted p-3 text-caption leading-relaxed text-text-secondary">
					{logInfo?.exists && logInfo.content ? logInfo.content : t("settings.vision.logEmpty")}
				</pre>
			</SettingsSection>

			{/* 保存失败提示：成功走全局 toast（showNotice），失败就近展示便于与头部保存按钮对照 */}
			{notice && (
				<div className="flex items-center gap-3 px-0.5 pt-4">
					<small style={{ color: "var(--color-danger, #dc2626)" }}>{notice}</small>
				</div>
			)}
			{saving && <div className="px-0.5 pt-2 text-caption text-muted-foreground">{t("common.saving")}</div>}

			{/* 模型选择弹层：与会话模型选择器同一组件，行为一致 */}
			{pickerOpen && (
				<ModelPicker
					models={models}
					refreshing={modelsRefreshing}
					onRefresh={() => void loadModels(true)}
					current={draft?.provider ? { provider: draft.provider, modelId: draft.model } : undefined}
					favoriteModels={[]}
					onToggleFavorite={() => undefined}
					onPick={onPickModel}
					onClose={() => setPickerOpen(false)}
				/>
			)}
		</div>
	);
}
