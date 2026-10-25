import { Button } from "../components/ui-shadcn/button";
import { useState, useRef, useCallback, useEffect } from "react";
import { X, Plus, Check } from "lucide-react";
import type { AuthFile, SettingsFile, ModelsFile } from "./configTypes";
import { collectProviderOptions } from "./providerOptions";
import { ConfigComboboxInput, ConfigSelect } from "./ConfigShared";
import { t } from "../i18n";
import { Input } from "../components/ui-shadcn/input";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Label } from "../components/ui-shadcn/label";
import { SettingBox, SettingRow, SettingSwitchRow, ClearableSettingsInput } from "../components/app/settings/SettingRows";
import { SettingsSection } from "../components/app/settings/SettingsStorageTab";
import { DefaultToolsInput } from "./DefaultToolsInput";
import { defaultToolsDisablesAll, mergeCodemodeSetting, normalizeCodemodeInlineBudget, normalizeCodemodeMode } from "../../../shared/defaultTools";
import { COMPACT_REFERENCE_WINDOW_TOKENS, COMPACTION_SLIDER_MAX_PERCENT, COMPACTION_SLIDER_MIN_PERCENT, compactionPercentToTokens, compactionTokensToPercent } from "../../../shared/compactionSlider";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui-shadcn/popover";
import { Slider } from "../components/ui-shadcn/slider";
import { desktopApi } from "../desktopApi";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "../components/ui-shadcn/command";

// ── 可用模型列表聚合（含供应商信息，供 enabledModels 多选用） ──

interface ModelRecord {
	id: string;
	provider: string;
	name?: string;
	/** 唯一 key：provider/id 格式，避免同名模型不同供应商互相冲突 */
	fullKey: string;
}

function collectModels(modelsData?: ModelsFile, discoveredModels?: Record<string, Array<{ id: string; name?: string }>>): ModelRecord[] {
	const map = new Map<string, ModelRecord>();
	if (modelsData) {
		for (const [provider, cfg] of Object.entries(modelsData.providers)) {
			for (const m of cfg.models) {
				const key = `${provider}/${m.id}`;
				if (!map.has(key)) {
					map.set(key, { id: m.id, provider, name: m.name, fullKey: key });
				}
			}
		}
	}
	if (discoveredModels) {
		for (const [provider, models] of Object.entries(discoveredModels)) {
			for (const m of models) {
				const key = `${provider}/${m.id}`;
				if (!map.has(key)) {
					map.set(key, { id: m.id, provider, name: m.name, fullKey: key });
				}
			}
		}
	}
	return [...map.values()];
}

// ── Settings Tab ────────────────────────────────────────

/**
 * pi 支持的默认思考档位枚举（与 pi 文档 settings.md 的 defaultThinkingLevel 取值一致，
 * 直接用原值作 label，避免翻译后大小写/拼写与 pi 内部枚举对不上）。
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({ value: v, label: v }));

/** pi 支持的传输协议枚举（transport 设置项，websocket-cached 为新协议，auto 为默认自动选择）。 */
const TRANSPORT_OPTIONS = ["sse", "websocket", "websocket-cached", "auto"].map((v) => ({ value: v, label: v }));

/** steering / follow-up 消息发送模式（pi 文档："all" 一次全部发送，"one-at-a-time" 逐条，默认 one-at-a-time）。 */
const SEND_MODE_OPTIONS = ["all", "one-at-a-time"].map((v) => ({ value: v, label: v }));

/** pi 1.0 起 quietStartup 是 boolean | "header" 三态（"header" 保留版本横幅、隐藏其余启动输出）。 */
const QUIET_STARTUP_OPTIONS: Array<{ value: string; labelKey: "config.general.quietStartup.off" | "config.general.quietStartup.true" | "config.general.quietStartup.header" }> = [
	{ value: "false", labelKey: "config.general.quietStartup.off" },
	{ value: "true", labelKey: "config.general.quietStartup.true" },
	{ value: "header", labelKey: "config.general.quietStartup.header" },
];

/** 项目信任兜底策略（pi 文档：ask/always/never，仅全局设置生效；RPC 模式不弹信任询问，靠此值决定是否加载项目 .pi 资源）。 */
const PROJECT_TRUST_OPTIONS = ["ask", "always", "never"].map((v) => ({ value: v, label: v }));

/** codemode.mode 枚举（pi settings.md#tools：on 默认声明并存、only 模型只能经脚本调工具）。 */
const CODEMODE_MODE_OPTIONS = [
	{ value: "on", label: "on" },
	{ value: "only", label: "only" },
];

/**
 * 写回 codemode 子设置：只 patch 用户改动的键，保留未知嵌套字段；
 * 合并后对象为空则移除整个键（避免落盘 codemode:{} 脏数据）。
 */
function withCodemode(data: SettingsFile, existing: unknown, patch: { mode?: string | undefined; inlineBudget?: number | undefined }): SettingsFile {
	const next = mergeCodemodeSetting(existing, patch);
	if (next === undefined) {
		const { codemode: _removed, ...rest } = data;
		return rest;
	}
	return { ...data, codemode: next };
}

export function SettingsTab(props: {
	data: SettingsFile;
	saving: boolean;
	/** 已配置的模型/服务商数据，用于 defaultProvider / defaultModel 下拉选项 */
	modelsData?: ModelsFile;
	/** 已配置的认证数据，配合 modelsData 一起为 defaultProvider 聚合所有可用的供应商 */
	authData?: AuthFile;
	/** 通过已知端点自动发现的模型（auth-only 供应商） */
	discoveredModels?: Record<string, Array<{ id: string; name?: string }>>;
	onChange: (data: SettingsFile) => void;
	onSave: () => void;
}) {
	const { data, saving } = props;
	const entries = Object.entries(data);
	// enabledModels 已配置时合并到 entries 前端展示，未配置时通过「添加」按钮单独显示
	const hasEnabledModels = "enabledModels" in data;

	/**
	 * 未在常驻区块占用的配置项（原始 key 名展示），作为最后一个「其他设置项」分区。
	 * （sessionDir / retry / enabledModels / defaultProvider / defaultModel 及通用行为区块已占用，避免列表里重复一行）
	 */
	const filteredEntries = entries.filter(
		([key]) =>
			key !== "enabledModels" &&
			key !== "retry" &&
			key !== "sessionDir" &&
			key !== "defaultProvider" &&
			key !== "defaultModel" &&
			key !== "defaultThinkingLevel" &&
			key !== "hideThinkingBlock" &&
			key !== "quietStartup" &&
			key !== "steeringMode" &&
			key !== "followUpMode" &&
			key !== "defaultProjectTrust" &&
			key !== "transport" &&
			// 「工具与 Codemode」区块占用：不走「其他设置项」的 JSON 兜底
			key !== "defaultTools" &&
			key !== "codemode" &&
			// 「会话压缩」常驻区块占用：开关 + 百分比滑条已在专项区块编辑，
			// 原始 JSON 对象再出现在其他设置里就是同一配置的两处入口（重复）
			key !== "compaction",
	);

	/**
	 * 设置页只暴露外层重试次数和基础延迟。
	 * provider 级 timeout/maxRetries 的单位和 SDK 语义容易误解，写入后可能导致立即超时或长时间重试卡住。
	 */
	const retryRaw = data && typeof data === "object" ? (data as Record<string, unknown>).retry : undefined;
	const retryRecord = retryRaw && typeof retryRaw === "object" ? (retryRaw as Record<string, unknown>) : undefined;
	const retryConfig = {
		maxRetries: typeof retryRecord?.maxRetries === "number" ? retryRecord.maxRetries : 10,
		baseDelayMs: typeof retryRecord?.baseDelayMs === "number" ? retryRecord.baseDelayMs : 5000,
	};

	/**
	 * pi 会话压缩配置（~/.pi/agent/settings.json 的 compaction）。
	 * 与 pi 文档默认值对齐：自动压缩开启、预留 16k 回复空间、保留最近 20k tokens。
	 * 只规范化这 3 个字段，避免把未知扩展字段写丢。
	 */
	const rawCompaction = data.compaction && typeof data.compaction === "object" && !Array.isArray(data.compaction) ? (data.compaction as Record<string, unknown>) : {};
	const compactionConfig = {
		enabled: typeof rawCompaction.enabled === "boolean" ? rawCompaction.enabled : true,
		reserveTokens: typeof rawCompaction.reserveTokens === "number" && Number.isFinite(rawCompaction.reserveTokens) ? Math.max(0, Math.floor(rawCompaction.reserveTokens)) : 16384,
		keepRecentTokens: typeof rawCompaction.keepRecentTokens === "number" && Number.isFinite(rawCompaction.keepRecentTokens) ? Math.max(0, Math.floor(rawCompaction.keepRecentTokens)) : 20000,
	};

	// 首次进入设置页时清理旧版 UI 写入的 provider/enable 等字段，保证后续保存只留下安全的两个参数。
	const retryInitializedRef = useRef(false);
	useEffect(() => {
		if (retryInitializedRef.current) return;
		// 先标记再回调，避免父组件更新 data 后再次触发初始化。
		retryInitializedRef.current = true;
		const existingRetry = data.retry;
		if (!existingRetry || typeof existingRetry !== "object" || Object.keys(existingRetry).some((key) => !(key in retryConfig))) {
			props.onChange({ ...data, retry: retryConfig });
		}
	}, [data, props.onChange, retryConfig.maxRetries, retryConfig.baseDelayMs]);

	// 首次进入时把 compaction 规范化成可编辑结构；保留用户已有的额外字段。
	const compactionInitializedRef = useRef(false);
	useEffect(() => {
		if (compactionInitializedRef.current) return;
		// 先标记再回调，避免规范化配置造成父子组件循环更新。
		compactionInitializedRef.current = true;
		const existing = data.compaction;
		const next = {
			...(existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {}),
			...compactionConfig,
		};
		const needsNormalize = !existing || typeof existing !== "object" || Array.isArray(existing) || typeof (existing as Record<string, unknown>).enabled !== "boolean" || typeof (existing as Record<string, unknown>).reserveTokens !== "number" || typeof (existing as Record<string, unknown>).keepRecentTokens !== "number";
		if (needsNormalize) {
			props.onChange({ ...data, compaction: next });
		}
	}, [data, props.onChange, compactionConfig.enabled, compactionConfig.reserveTokens, compactionConfig.keepRecentTokens]);

	const updateRetry = (patch: Record<string, unknown>) => {
		props.onChange({
			...data,
			retry: { ...retryConfig, ...patch },
		});
	};

	const updateCompaction = (patch: Partial<typeof compactionConfig>) => {
		const existing = data.compaction && typeof data.compaction === "object" && !Array.isArray(data.compaction) ? (data.compaction as Record<string, unknown>) : {};
		props.onChange({
			...data,
			compaction: {
				...existing,
				...compactionConfig,
				...patch,
			},
		});
	};

	/**
	 * 压缩百分比滑条的换算基数：默认模型的上下文窗口。
	 * pi 的触发条件是 contextTokens > contextWindow - reserveTokens，两个 token 值
	 * 的直观语义本来就是「窗口占比」。解析顺序：models.json 显式配置优先（同步、
	 * 用户手填即真相），缺省时异步查 pi-ai 模型目录；都拿不到则回退数值输入。
	 */
	const defaultProvider = typeof data.defaultProvider === "string" ? data.defaultProvider : "";
	const defaultModel = typeof data.defaultModel === "string" ? data.defaultModel : "";
	const explicitContextWindow = defaultProvider && defaultModel ? props.modelsData?.providers[defaultProvider]?.models.find((m) => m.id === defaultModel)?.contextWindow : undefined;
	const [catalogContextWindow, setCatalogContextWindow] = useState<number | undefined>(undefined);
	useEffect(() => {
		if (explicitContextWindow) {
			setCatalogContextWindow(undefined);
			return;
		}
		if (!defaultProvider || !defaultModel) {
			setCatalogContextWindow(undefined);
			return;
		}
		let cancelled = false;
		desktopApi.projects
			.getModelSpec(defaultProvider, defaultModel)
			.then((spec) => {
				if (!cancelled && typeof spec?.contextWindow === "number" && spec.contextWindow > 0) setCatalogContextWindow(spec.contextWindow);
			})
			.catch(() => {
				/* 目录未命中时保持 undefined，UI 回退数值输入 */
			});
		return () => {
			cancelled = true;
		};
	}, [defaultProvider, defaultModel, explicitContextWindow]);
	// 识别不到模型窗口时也始终提供滑条：按参考窗口换算（业界最常见 200k；pi 默认值 16384/20000 恰为 8%/10%）。
	// token 数始终如实展示，百分比只是编辑手感。
	const hasModelWindow = typeof explicitContextWindow === "number" || typeof catalogContextWindow === "number";
	const compactionContextWindow = explicitContextWindow ?? catalogContextWindow ?? COMPACT_REFERENCE_WINDOW_TOKENS;
	const percentToTokens = (percent: number) => compactionPercentToTokens(percent, compactionContextWindow);
	const tokensToPercent = (tokens: number) => compactionTokensToPercent(tokens, compactionContextWindow);

	/**
	 * 配置键名 → 显示标签。
	 * 已登记 i18n 的键走多语言；未登记回退原始 key，避免未知字段空白。
	 */
	const configLabel = (key: string): string => {
		switch (key) {
			case "enabledModels":
				return t("config.label.enabledModels");
			case "defaultProvider":
				return t("config.label.defaultProvider");
			case "defaultModel":
				return t("config.label.defaultModel");
			case "lastChangelogVersion":
				return t("config.label.lastChangelogVersion");
			case "customPrompt":
				return t("config.label.customPrompt");
			case "promptGuidelines":
				return t("config.label.promptGuidelines");
			case "appendSystemPrompt":
				return t("config.label.appendSystemPrompt");
			case "proxy":
				return t("config.label.proxy");
			case "proxyUrl":
				return t("config.label.proxyUrl");
			case "proxyBypass":
				return t("config.label.proxyBypass");
			case "theme":
				return t("config.label.theme");
			case "language":
				return t("config.label.language");
			case "disabledSkills":
				return t("config.label.disabledSkills");
			case "disabledExtensions":
				return t("config.label.disabledExtensions");
			case "noProjectDiscovery":
				return t("config.label.noProjectDiscovery");
			case "defaultProjectTrust":
				return t("config.label.defaultProjectTrust");
			case "allowProjectChanges":
				return t("config.label.allowProjectChanges");
			case "enableSkillCommands":
				return t("config.label.enableSkillCommands");
			case "temperature":
				return t("config.label.temperature");
			case "systemPrompt":
				return t("config.label.systemPrompt");
			case "hideThinkingBlock":
				return t("config.label.hideThinkingBlock");
			case "packages":
				return t("config.label.packages");
			case "defaultThinkingLevel":
				return t("config.label.defaultThinkingLevel");
			case "quietStartup":
				return t("config.label.quietStartup");
			case "collapseChangelog":
				return t("config.label.collapseChangelog");
			case "sessionDir":
				return t("config.label.sessionDir");
			case "steeringMode":
				return t("config.label.steeringMode");
			case "followUpMode":
				return t("config.label.followUpMode");
			case "transport":
				return t("config.label.transport");
			case "httpProxy":
				return t("config.label.httpProxy");
			case "shellPath":
				return t("config.label.shellPath");
			case "shellCommandPrefix":
				return t("config.label.shellCommandPrefix");
			case "npmCommand":
				return t("config.label.npmCommand");
			case "thinkingBudgets":
				return t("config.label.thinkingBudgets");
			case "branchSummary":
				return t("config.label.branchSummary");
			case "doubleEscapeAction":
				return t("config.label.doubleEscapeAction");
			case "treeFilterMode":
				return t("config.label.treeFilterMode");
			default:
				return key;
		}
	};

	/** 全局会话目录：空值表示使用 pi 默认 ~/.pi/agent/sessions/<encoded-cwd>/ */
	const sessionDirValue = typeof data.sessionDir === "string" ? data.sessionDir : "";
	const updateSessionDir = (raw: string) => {
		const next = raw.trim();
		if (!next) {
			// 清空时移除字段，避免写入空字符串覆盖默认行为
			const { sessionDir: _removed, ...rest } = data;
			props.onChange(rest);
			return;
		}
		props.onChange({ ...data, sessionDir: raw });
	};

	return (
		<div className="config-settings-tab">
			<div className="mb-3 flex items-center justify-between gap-3">
				<span className="font-mono text-xs tabular-nums text-muted-foreground">{t("config.count.configItems", { count: entries.length })}</span>
			</div>

			{/* pi 的 settingsManager 只在会话启动与 /reload 时重读 settings.json，保存不会推给活进程。
			    不写这句提示，用户改完默认工具/ codemode 会以为保存失败（改完没反应）。 */}
			<div className="mb-3 rounded-md border border-dashed border-border bg-muted/30 px-3.5 py-2.5 text-micro leading-relaxed text-muted-foreground">{t("config.settings.applyNote")}</div>

			{/* ── 模型切换列表（enabledModels）：单行分区，行标题即一级标题（同「常用设置」语言分区） ── */}
			<SettingBox>
				<SettingRow level={1} title={<span>{configLabel("enabledModels")}</span>} description={t("config.settings.enabledModelsHint")} stacked>
					<EnabledModelsInput value={Array.isArray(data.enabledModels) ? data.enabledModels : undefined} models={collectModels(props.modelsData, props.discoveredModels)} onChange={(v) => props.onChange({ ...data, enabledModels: v })} />
				</SettingRow>
				{!hasEnabledModels && (
					<div className="flex justify-start px-1 pb-2">
						<Button size="sm" variant="outline" onClick={() => props.onChange({ ...data, enabledModels: [] })}>
							<Plus size={14} />
							{t("config.settings.addEnabledModels")}
						</Button>
					</div>
				)}
			</SettingBox>

			{/* ── 默认供应商 / 默认模型：始终显示，不依赖 settings.json 中是否已存在这两个 key ── */}
			<SettingsSection title={t("config.defaults.title")} description={t("config.defaults.hint")}>
				{/* defaultProvider / defaultModel 未配置时 value 为 undefined，SettingsValueInput 按空串处理
				    （combobox 空态 + 隐藏清除按钮）；选中后写入 key 本身；清空则保留 key 值为 ""，消费方按默认行为兜底 */}
				<SettingRow title={<span>{configLabel("defaultProvider")}</span>} alignEnd={false}>
					<SettingsValueInput value={data.defaultProvider} fieldKey="defaultProvider" modelsData={props.modelsData} authData={props.authData} discoveredModels={props.discoveredModels} allSettings={data} onChange={(v) => props.onChange({ ...data, defaultProvider: typeof v === "string" ? v : "" })} />
				</SettingRow>
				<SettingRow title={<span>{configLabel("defaultModel")}</span>} alignEnd={false}>
					<SettingsValueInput value={data.defaultModel} fieldKey="defaultModel" modelsData={props.modelsData} authData={props.authData} discoveredModels={props.discoveredModels} allSettings={data} onChange={(v) => props.onChange({ ...data, defaultModel: typeof v === "string" ? v : "" })} />
				</SettingRow>
			</SettingsSection>

			{/* ── 通用行为：高频 pi 配置常驻显示，未写入时也可见可编辑 ── */}
			<SettingsSection title={t("config.general.title")} description={t("config.general.hint")}>
				{/* 默认思考档位：枚举下拉，空值表示不设置（pi 按模型/上下文自行决定） */}
				<SettingRow title={<span>{configLabel("defaultThinkingLevel")}</span>} description={t("config.general.thinkingLevelHint")} alignEnd={false}>
					<ClearableSettingsInput empty={typeof data.defaultThinkingLevel !== "string" || !data.defaultThinkingLevel} onClear={() => props.onChange({ ...data, defaultThinkingLevel: "" })}>
						<ConfigSelect value={typeof data.defaultThinkingLevel === "string" ? data.defaultThinkingLevel : ""} options={THINKING_LEVELS} onChange={(v) => props.onChange({ ...data, defaultThinkingLevel: v })} placeholder={t("config.general.thinkingLevelPlaceholder")} />
					</ClearableSettingsInput>
				</SettingRow>

				{/* 布尔开关行：hideThinkingBlock 直接写 true/false。 */}
				<SettingSwitchRow title={configLabel("hideThinkingBlock")} description={t("config.general.hideThinkingBlockHint")} checked={data.hideThinkingBlock === true} onChange={(checked) => props.onChange({ ...data, hideThinkingBlock: checked })} />
				{/* quietStartup 是三态（pi 1.0 新增 "header"）：布尔开关会把 "header" 覆盖成
				    true/false 造成数据丢失，必须用下拉表达完整枚举。 */}
				<SettingRow title={<span>{configLabel("quietStartup")}</span>} description={t("config.general.quietStartupHint")} alignEnd={false}>
					<ClearableSettingsInput empty={data.quietStartup !== true && data.quietStartup !== "header"} onClear={() => props.onChange({ ...data, quietStartup: false })}>
						<ConfigSelect
							value={data.quietStartup === true ? "true" : data.quietStartup === "header" ? "header" : "false"}
							options={QUIET_STARTUP_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
							onChange={(v) => props.onChange({ ...data, quietStartup: v === "true" ? true : v === "header" ? "header" : false })}
							placeholder="false"
						/>
					</ClearableSettingsInput>
				</SettingRow>

				{/* steeringMode / followUpMode：steering 与 follow-up 消息的发送模式，
				    all 一次全部发送，one-at-a-time 逐条（pi 默认），RPC 场景下影响 API 调用方式 */}
				<SettingRow title={<span>{configLabel("steeringMode")}</span>} description={t("config.general.steeringModeHint")} alignEnd={false}>
					<ClearableSettingsInput empty={typeof data.steeringMode !== "string" || !data.steeringMode} onClear={() => props.onChange({ ...data, steeringMode: "" })}>
						<ConfigSelect value={typeof data.steeringMode === "string" ? data.steeringMode : ""} options={SEND_MODE_OPTIONS} onChange={(v) => props.onChange({ ...data, steeringMode: v })} placeholder={t("config.general.steeringModePlaceholder")} />
					</ClearableSettingsInput>
				</SettingRow>
				<SettingRow title={<span>{configLabel("followUpMode")}</span>} description={t("config.general.followUpModeHint")} alignEnd={false}>
					<ClearableSettingsInput empty={typeof data.followUpMode !== "string" || !data.followUpMode} onClear={() => props.onChange({ ...data, followUpMode: "" })}>
						<ConfigSelect value={typeof data.followUpMode === "string" ? data.followUpMode : ""} options={SEND_MODE_OPTIONS} onChange={(v) => props.onChange({ ...data, followUpMode: v })} placeholder={t("config.general.followUpModePlaceholder")} />
					</ClearableSettingsInput>
				</SettingRow>

				{/* defaultProjectTrust：RPC 模式不弹信任询问，靠它在加载项目的 .pi/settings.json 等资源时兜底 */}
				<SettingRow title={<span>{configLabel("defaultProjectTrust")}</span>} description={t("config.general.projectTrustHint")} alignEnd={false}>
					<ClearableSettingsInput empty={typeof data.defaultProjectTrust !== "string" || !data.defaultProjectTrust} onClear={() => props.onChange({ ...data, defaultProjectTrust: "" })}>
						<ConfigSelect value={typeof data.defaultProjectTrust === "string" ? data.defaultProjectTrust : ""} options={PROJECT_TRUST_OPTIONS} onChange={(v) => props.onChange({ ...data, defaultProjectTrust: v })} placeholder={t("config.general.projectTrustPlaceholder")} />
					</ClearableSettingsInput>
				</SettingRow>

				{/* 传输协议：多协议供应商选 sse/websocket/websocket-cached，默认 auto 自动选择 */}
				<SettingRow title={<span>{configLabel("transport")}</span>} description={t("config.general.transportHint")} alignEnd={false}>
					<ClearableSettingsInput empty={typeof data.transport !== "string" || !data.transport} onClear={() => props.onChange({ ...data, transport: "" })}>
						<ConfigSelect value={typeof data.transport === "string" ? data.transport : ""} options={TRANSPORT_OPTIONS} onChange={(v) => props.onChange({ ...data, transport: v })} placeholder={t("config.general.transportPlaceholder")} />
					</ClearableSettingsInput>
				</SettingRow>
			</SettingsSection>

			{/* ── 工具与 Codemode：defaultTools 单一字段 + codemode 子设置（计划 S 篇）── */}
			<SettingsSection title={t("config.tools.title")} description={t("config.tools.hint")}>
				<SettingRow title={<span>{t("config.tools.defaultTools")}</span>} description={t("config.tools.defaultToolsHint")} stacked>
					<DefaultToolsInput
						value={Array.isArray(data.defaultTools) ? (data.defaultTools as string[]) : undefined}
						onChange={(next) => {
							// undefined = 移除键（回到 pi 默认）；[] = 禁用全部内置工具（pi 语义）
							if (next === undefined) {
								const { defaultTools: _removed, ...rest } = data;
								props.onChange(rest);
								return;
							}
							props.onChange({ ...data, defaultTools: next });
						}}
					/>
					{defaultToolsDisablesAll(data.defaultTools as readonly string[] | undefined) ? <small className="text-caption text-danger">{t("config.tools.allDisabledWarn")}</small> : null}
				</SettingRow>

				{(() => {
					const codemode = data.codemode && typeof data.codemode === "object" && !Array.isArray(data.codemode) ? (data.codemode as { mode?: unknown; inlineBudget?: unknown }) : undefined;
					// 子设置始终允许预配置：codemode 扩展可用且工具被手动/MCP 自动激活后才生效；
					// 不能仅因为当前 defaultTools 里没写 "+codemode" 就禁用输入（裸名列表、继承层、
					// MCP 自动激活都会让 codemode 生效）。仅在扩展层被显式关闭时提示原因，不自动改写工具选择。
					const codemodeDisabledByExtension = (Array.isArray(data.extensions) ? (data.extensions as string[]) : []).some((entry) => entry === "-builtin:codemode");
					const mode = normalizeCodemodeMode(codemode?.mode);
					const budget = normalizeCodemodeInlineBudget(codemode?.inlineBudget);
					return (
						<>
							<SettingRow title={<span>{t("config.tools.codemodeMode")}</span>} description={codemodeDisabledByExtension ? t("config.tools.codemodeBuiltinDisabled") : t("config.tools.codemodeModeHint")} alignEnd={false}>
								<div className={codemodeDisabledByExtension ? "pointer-events-none opacity-50" : ""}>
									<ClearableSettingsInput empty={typeof mode !== "string"} onClear={() => props.onChange(withCodemode(data, codemode, { mode: undefined }))}>
										<ConfigSelect value={mode ?? ""} options={CODEMODE_MODE_OPTIONS} onChange={(v) => props.onChange(withCodemode(data, codemode, { mode: normalizeCodemodeMode(v) }))} placeholder={t("config.tools.codemodeModePlaceholder")} />
									</ClearableSettingsInput>
								</div>
							</SettingRow>
							<SettingRow title={<span>{t("config.tools.codemodeBudget")}</span>} description={codemodeDisabledByExtension ? t("config.tools.codemodeBuiltinDisabled") : t("config.tools.codemodeBudgetHint")} alignEnd>
								<div className={codemodeDisabledByExtension ? "pointer-events-none opacity-50" : ""}>
									<Input
										type="number"
										min={0}
										step={500}
										value={typeof budget === "number" ? budget : ""}
										onChange={(e) => {
											const raw = e.target.value.trim();
											props.onChange(withCodemode(data, codemode, { inlineBudget: raw === "" ? undefined : normalizeCodemodeInlineBudget(Number(raw)) }));
										}}
										className="h-8 w-24 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
										placeholder="3000"
									/>
								</div>
							</SettingRow>
						</>
					);
				})()}
			</SettingsSection>

			{/* ── 全局会话目录（仅编辑 ~/.pi/agent/settings.json 的 sessionDir） ── */}
			<SettingsSection title={t("config.sessionDir.title")} description={t("config.sessionDir.hint")}>
				<SettingRow title={<span>{t("config.label.sessionDir")}</span>} stacked>
					<Input
						className="h-8 w-full rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
						type="text"
						value={sessionDirValue}
						placeholder={t("config.sessionDir.placeholder")}
						onChange={(e) => updateSessionDir(e.target.value)}
					/>
				</SettingRow>
			</SettingsSection>

			{/* ── 重试配置 ── */}
			<SettingsSection title={t("config.retry.title")} description={t("config.retry.hint")}>
				<SettingRow title={<span>{t("config.retry.maxRetries")}</span>}>
					<Input
						className="h-8 w-24 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
						type="number"
						min={0}
						max={50}
						value={retryConfig.maxRetries}
						onChange={(e) => updateRetry({ maxRetries: Number(e.target.value) })}
					/>
				</SettingRow>
				<SettingRow title={<span>{t("config.retry.baseDelayMs")}</span>}>
					<Input
						className="h-8 w-24 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
						type="number"
						min={100}
						step={100}
						value={retryConfig.baseDelayMs}
						onChange={(e) => updateRetry({ baseDelayMs: Number(e.target.value) })}
					/>
				</SettingRow>
			</SettingsSection>

			{/* ── 会话压缩：开关 + 百分比滑条（基数=默认模型窗口，识别不到时按参考窗口 200k，滑条始终可用）── */}
			<SettingsSection title={t("config.compaction.title")} description={t("config.compaction.hint")}>
				<SettingSwitchRow title={t("config.compaction.enabled")} checked={compactionConfig.enabled} onChange={(checked) => updateCompaction({ enabled: checked })} />
				{/* 百分比标签显示真实占比（不限制在滑条范围内）；滑条 value 用约束后的百分比，拖动时再换算回绝对 tokens */}
				<SettingRow title={<span>{t("config.compaction.reserveTokens")}</span>} description={t("config.compaction.reserveTokensHint")} stacked>
					<div className="flex w-full items-center gap-3">
						<Slider
							className="h-4 min-w-0 flex-1"
							min={COMPACTION_SLIDER_MIN_PERCENT}
							max={COMPACTION_SLIDER_MAX_PERCENT}
							step={1}
							value={[tokensToPercent(compactionConfig.reserveTokens)]}
							onValueChange={([pct]) => updateCompaction({ reserveTokens: percentToTokens(pct ?? 0) })}
							aria-label={t("config.compaction.reserveTokens")}
						/>
						<span className="w-32 shrink-0 text-right text-control text-text-secondary">
							{Math.round((compactionConfig.reserveTokens / compactionContextWindow) * 100)}% · ≈{compactionConfig.reserveTokens.toLocaleString()}t
						</span>
					</div>
				</SettingRow>
				<SettingRow title={<span>{t("config.compaction.keepRecentTokens")}</span>} description={t("config.compaction.keepRecentTokensHint")} stacked>
					<div className="flex w-full items-center gap-3">
						<Slider
							className="h-4 min-w-0 flex-1"
							min={COMPACTION_SLIDER_MIN_PERCENT}
							max={COMPACTION_SLIDER_MAX_PERCENT}
							step={1}
							value={[tokensToPercent(compactionConfig.keepRecentTokens)]}
							onValueChange={([pct]) => updateCompaction({ keepRecentTokens: percentToTokens(pct ?? 0) })}
							aria-label={t("config.compaction.keepRecentTokens")}
						/>
						<span className="w-32 shrink-0 text-right text-control text-text-secondary">
							{Math.round((compactionConfig.keepRecentTokens / compactionContextWindow) * 100)}% · ≈{compactionConfig.keepRecentTokens.toLocaleString()}t
						</span>
					</div>
				</SettingRow>
				<div className="px-1 pb-2 pt-1.5">
					<small className="text-caption leading-relaxed text-muted-foreground">{hasModelWindow ? t("config.compaction.windowBaseHint", { window: compactionContextWindow.toLocaleString() }) : t("config.compaction.windowRefHint", { window: COMPACT_REFERENCE_WINDOW_TOKENS.toLocaleString() })}</small>
				</div>
				<div className="px-1 pb-2 pt-1.5">
					<small className="text-caption leading-relaxed text-muted-foreground">{t("config.compaction.manualHint")}</small>
				</div>
			</SettingsSection>

			{/* ── 其他设置项：未在常驻区块占用的原始 key，保留原文展示可编辑 ── */}
			{filteredEntries.length > 0 && (
				<SettingsSection title={t("config.others.title")}>
					{filteredEntries.map(([key, value]) => (
						<SettingRow key={key} title={<span>{configLabel(key)}</span>} alignEnd={typeof value === "boolean"}>
							<SettingsValueInput
								value={value}
								fieldKey={key}
								modelsData={props.modelsData}
								authData={props.authData}
								discoveredModels={props.discoveredModels}
								allSettings={data}
								onChange={(v) => {
									// 防御性兜底：当前清空路径统一走空字符串（保留 key，值为 ""，
									// 消费方按 falsy 回到默认行为），不删除设置项本身
									if (v === undefined) {
										const { [key]: _removed, ...rest } = data;
										props.onChange(rest);
										return;
									}
									props.onChange({ ...data, [key]: v });
								}}
							/>
						</SettingRow>
					))}
				</SettingsSection>
			)}
		</div>
	);
}

/**
 * enabledModels 下拉多选：按供应商分组，搜索过滤可用模型，勾选加入列表。
 * 选中的模型 ID 直接写入 enabledModels 数组，取消勾选即从列表中移除。
 * 输入含 * 或 ? 时可添加 glob 模式。
 */
function EnabledModelsInput(props: {
	value?: string[];
	/** 按模型的 provider/id 分组，每项含 provider 信息 */
	models: ModelRecord[];
	onChange: (value: string[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const selected = new Set(props.value ?? []);

	const toggleModel = (id: string) => {
		const next = new Set(selected);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		props.onChange([...next]);
	};

	const removeSelected = (id: string) => {
		const next = new Set(selected);
		next.delete(id);
		props.onChange([...next]);
	};

	// 过滤 & 按供应商分组
	const normalizedFilter = filter.trim().toLowerCase();
	const isGlob = filter.includes("*") || filter.includes("?");
	const filteredModels = normalizedFilter && !isGlob ? props.models.filter((m) => [m.id, m.name, m.provider, `${m.provider}/${m.id}`].filter(Boolean).some((v) => v!.toLowerCase().includes(normalizedFilter))) : props.models;

	// 按供应商分组
	const grouped = filteredModels.reduce<Record<string, ModelRecord[]>>((acc, m) => {
		if (!acc[m.provider]) acc[m.provider] = [];
		acc[m.provider].push(m);
		return acc;
	}, {});

	const providerNames = Object.keys(grouped).sort((a, b) => {
		const order = ["anthropic", "openai", "google", "deepseek", "other"];
		const ai = order.indexOf(a);
		const bi = order.indexOf(b);
		if (ai !== -1 && bi !== -1) return ai - bi;
		if (ai !== -1) return -1;
		if (bi !== -1) return 1;
		return a.localeCompare(b);
	});

	const hasResults = providerNames.length > 0 || isGlob;

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				// 每次打开都重置过滤词，避免上次搜索残留导致列表为空。
				if (next) setFilter("");
			}}
		>
			<PopoverTrigger asChild>
				<div className="flex min-h-[38px] w-full min-w-0 cursor-pointer flex-wrap items-center gap-1.5 rounded-sm border border-border-subtle bg-popover px-2.5 py-[5px] transition-colors duration-fast hover:border-border-strong">
					{[...selected].map((fullKey) => (
						<span
							key={fullKey}
							className="inline-flex h-6 items-center gap-[3px] rounded-full border border-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-border-subtle))] bg-[color:color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg-panel))] pl-[9px] pr-[5px] font-mono text-xs leading-[18px] whitespace-nowrap text-text-primary"
						>
							<span>{fullKey}</span>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="rounded-full border-0 bg-transparent text-text-tertiary hover:bg-[color:color-mix(in_srgb,var(--color-danger)_16%,transparent)] hover:text-[color:var(--color-danger)]"
								onClick={(e) => {
									e.stopPropagation();
									removeSelected(fullKey);
								}}
							>
								<X size={12} />
							</Button>
						</span>
					))}
					<span className="text-xs leading-[18px] text-text-tertiary">{selected.size === 0 ? t("config.settings.enabledModelsPlaceholder") : `${selected.size} ${t("config.settings.enabledModelsSelected")}`}</span>
				</div>
			</PopoverTrigger>
			<PopoverContent align="start" sideOffset={4} className="w-[var(--radix-popover-trigger-width)] max-w-[min(680px,calc(100vw-48px))] p-0">
				<Command shouldFilter={false}>
					<CommandInput value={filter} onValueChange={setFilter} placeholder={t("config.settings.enabledModelsSearchPlaceholder")} autoFocus />
					<CommandList className="max-h-[min(320px,45vh)]">
						{/* glob 模式行：输入含 * 或 ? 时显示，可勾选为自定义模式 */}
						{filter && isGlob && (
							<CommandItem
								key="__glob__"
								value={filter}
								onSelect={() => toggleModel(filter)}
								className={`border border-dashed border-[var(--color-accent)] bg-[color:color-mix(in_srgb,var(--color-accent)_6%,var(--color-bg-popover))] text-control text-text-primary hover:bg-[color:color-mix(in_srgb,var(--color-accent)_12%,transparent)]${selected.has(filter) ? " border-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_6%,var(--color-bg-popover))]" : ""}`}
							>
								<span className="flex size-[18px] shrink-0 items-center justify-center rounded-xs border-[1.5px] border-border-strong text-[color:var(--color-accent)]">{selected.has(filter) && <Check size={12} />}</span>
								<span className="font-mono text-xs">{filter}</span>
								<span className="ml-auto font-mono text-micro text-text-tertiary">{t("config.settings.enabledModelsGlobHint")}</span>
							</CommandItem>
						)}
						{hasResults &&
							providerNames.map((provider) => (
								<CommandGroup
									key={provider}
									heading={
										<button
											type="button"
											className="flex w-full cursor-pointer items-center gap-2 border-0 bg-bg-hover px-3 py-2 text-left text-control font-medium text-text-primary transition-colors duration-fast before:mr-1 before:text-[9px] before:text-text-tertiary before:transition-transform before:duration-fast before:content-['▾'] hover:bg-bg-active"
											onClick={() => {
												setCollapsed((prev) => {
													const next = new Set(prev);
													if (next.has(provider)) next.delete(provider);
													else next.add(provider);
													return next;
												});
											}}
										>
											<span className="flex-1">{provider}</span>
											<span className="font-mono text-micro text-text-tertiary">{grouped[provider].length}</span>
										</button>
									}
								>
									{!collapsed.has(provider) &&
										grouped[provider].map((m) => (
											<CommandItem key={m.fullKey} value={m.fullKey} onSelect={() => toggleModel(m.fullKey)} className={`cursor-pointer gap-2 py-[7px] pr-3 pl-7 text-control text-text-primary ${selected.has(m.fullKey) ? "bg-[color:color-mix(in_srgb,var(--color-accent)_6%,var(--color-bg-panel))]" : ""}`}>
												<span
													className={`flex size-[18px] shrink-0 items-center justify-center rounded-xs border-[1.5px] border-border-strong text-[color:var(--color-accent)] transition-[border-color,background-color] duration-fast${selected.has(m.fullKey) ? " border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)]" : ""}`}
												>
													{selected.has(m.fullKey) && <Check size={12} />}
												</span>
												<span className="text-control text-text-primary">{m.name ?? m.id}</span>
												<span className="ml-auto font-mono text-xs text-text-tertiary">
													{m.provider}/{m.id}
												</span>
											</CommandItem>
										))}
								</CommandGroup>
							))}
						{!hasResults && <div className="p-4 text-center text-xs text-text-tertiary">{t("app.modelPickerEmpty")}</div>}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function SettingsValueInput(props: { value: unknown; fieldKey: string; modelsData?: ModelsFile; authData?: AuthFile; discoveredModels?: Record<string, Array<{ id: string; name?: string }>>; allSettings?: SettingsFile; onChange: (v: unknown) => void }) {
	const { value, fieldKey, modelsData, authData, discoveredModels, allSettings } = props;

	// defaultProvider: 从 modelsData.providers + authData + discoveredModels 聚合所有可用的供应商
	if (fieldKey === "defaultProvider") {
		const providerOptions = collectProviderOptions(modelsData, authData, discoveredModels);
		const current = typeof value === "string" ? value : "";
		return (
			<ClearableSettingsInput empty={!current} onClear={() => props.onChange("")}>
				<ConfigComboboxInput value={current} options={providerOptions} onChange={(v) => props.onChange(v)} placeholder={t("config.settings.selectProvider")} />
			</ClearableSettingsInput>
		);
	}

	// defaultModel: 根据当前选中的 defaultProvider 联动过滤
	if (fieldKey === "defaultModel") {
		const selectedProvider = allSettings?.["defaultProvider"];
		const selectedProviderName = typeof selectedProvider === "string" ? selectedProvider : "";
		const currentModel = typeof value === "string" ? value : "";
		const modelOptions: Array<{ value: string; label?: string }> = [];
		const seen = new Set<string>();

		// 始终将当前已配置的值作为首选项，确保已生效的配置在列表中可见
		if (currentModel && !seen.has(currentModel)) {
			seen.add(currentModel);
			const currentLabel = selectedProviderName ? `${currentModel} (${selectedProviderName})` : currentModel;
			modelOptions.push({ value: currentModel, label: currentLabel });
		}

		if (selectedProviderName) {
			// 优先从模型配置中取该供应商的模型
			const provider = modelsData?.providers[selectedProviderName];
			if (provider) {
				for (const model of provider.models) {
					if (!seen.has(model.id)) {
						seen.add(model.id);
						const label = model.name && model.name !== model.id ? `${model.name} (${selectedProviderName})` : `${model.id} (${selectedProviderName})`;
						modelOptions.push({ value: model.id, label });
					}
				}
			}
			// 尝试从自动发现的模型中获取（auth-only 供应商通过已知端点获取）
			const discovered = discoveredModels?.[selectedProviderName];
			if (discovered) {
				for (const model of discovered) {
					if (!seen.has(model.id)) {
						seen.add(model.id);
						modelOptions.push({
							value: model.id,
							label: model.name ? `${model.name} (${selectedProviderName})` : `${model.id} (${selectedProviderName})`,
						});
					}
				}
			}
			// 如果该供应商只有 auth 没有模型配置，尝试从 auth 条目的 model 字段获取
			const authEntry = authData?.[selectedProviderName];
			if (authEntry && typeof authEntry.model === "string" && authEntry.model && !seen.has(authEntry.model)) {
				seen.add(authEntry.model);
				modelOptions.push({ value: authEntry.model, label: `${authEntry.model} (${selectedProviderName})` });
			}
		} else {
			// 未选择供应商时，展示全部模型的精简列表供参考
			if (modelsData) {
				for (const [pName, provider] of Object.entries(modelsData.providers)) {
					for (const model of provider.models) {
						if (!seen.has(model.id)) {
							seen.add(model.id);
							const label = model.name && model.name !== model.id ? `${model.name} (${pName})` : `${model.id} (${pName})`;
							modelOptions.push({ value: model.id, label });
						}
					}
				}
			}
			if (authData) {
				for (const [pName, auth] of Object.entries(authData)) {
					if (typeof auth.model === "string" && auth.model && !seen.has(auth.model)) {
						seen.add(auth.model);
						modelOptions.push({ value: auth.model, label: `${auth.model} (${pName})` });
					}
				}
			}
			// 从自动发现的模型中获取
			if (discoveredModels) {
				for (const [pName, models] of Object.entries(discoveredModels)) {
					for (const model of models) {
						if (!seen.has(model.id)) {
							seen.add(model.id);
							modelOptions.push({
								value: model.id,
								label: model.name ? `${model.name} (${pName})` : `${model.id} (${pName})`,
							});
						}
					}
				}
			}
		}

		const currentModelValue = typeof value === "string" ? value : "";
		return (
			<ClearableSettingsInput empty={!currentModelValue} onClear={() => props.onChange("")}>
				<ConfigComboboxInput value={currentModelValue} options={modelOptions} onChange={(v) => props.onChange(v)} placeholder={selectedProviderName ? t("config.settings.selectModelFor", { provider: selectedProviderName }) : t("config.settings.selectModelFirst")} />
			</ClearableSettingsInput>
		);
	}

	if (typeof value === "boolean") {
		return (
			<Label className="config-checkbox-label">
				<Checkbox checked={value} onCheckedChange={(checked) => props.onChange(checked)} />
				<span>{value ? t("common.true") : t("common.false")}</span>
			</Label>
		);
	}
	if (typeof value === "number") {
		return <Input type="number" value={value} onChange={(e) => props.onChange(Number(e.target.value))} className="h-8 w-full rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]" />;
	}
	if (typeof value === "string") {
		return <Input value={value} onChange={(e) => props.onChange(e.target.value)} className="h-8 w-full rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]" />;
	}
	return (
		<Input
			value={JSON.stringify(value)}
			onChange={(e) => {
				try {
					props.onChange(JSON.parse(e.target.value));
				} catch {
					/* 输入过程中 JSON 不合法时暂不更新 */
				}
			}}
			className="h-8 w-full rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
		/>
	);
}
