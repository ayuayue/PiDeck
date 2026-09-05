import { Button } from "../components/ui-shadcn/button";
import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { X, Plus, Check } from "lucide-react";
import type { AuthFile, SettingsFile, ModelsFile } from "./configTypes";
import { collectProviderOptions } from "./providerOptions";
import { ConfigComboboxInput, ConfigSelect } from "./ConfigShared";
import { t } from "../i18n";
import { Input } from "../components/ui-shadcn/input";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Label } from "../components/ui-shadcn/label";
import { SectionHeading } from "../components/ui-shadcn/section-heading";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui-shadcn/popover";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "../components/ui-shadcn/command";

// ── 可用模型列表聚合（含供应商信息，供 enabledModels 多选用） ──

interface ModelRecord {
	id: string;
	provider: string;
	name?: string;
	/** 唯一 key：provider/id 格式，避免同名模型不同供应商互相冲突 */
	fullKey: string;
}

function collectModels(
	modelsData?: ModelsFile,
	discoveredModels?: Record<string, Array<{ id: string; name?: string }>>,
): ModelRecord[] {
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

/** 项目信任兜底策略（pi 文档：ask/always/never，仅全局设置生效；RPC 模式不弹信任询问，靠此值决定是否加载项目 .pi 资源）。 */
const PROJECT_TRUST_OPTIONS = ["ask", "always", "never"].map((v) => ({ value: v, label: v }));

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
	 * 设置页只暴露外层重试次数和基础延迟。
	 * provider 级 timeout/maxRetries 的单位和 SDK 语义容易误解，写入后可能导致立即超时或长时间重试卡住。
	 */
	const retryConfig = {
		maxRetries: (data as any).retry?.maxRetries ?? 10,
		baseDelayMs: (data as any).retry?.baseDelayMs ?? 5000,
	};

	/**
	 * pi 会话压缩配置（~/.pi/agent/settings.json 的 compaction）。
	 * 与 pi 文档默认值对齐：自动压缩开启、预留 16k 回复空间、保留最近 20k tokens。
	 * 只规范化这 3 个字段，避免把未知扩展字段写丢。
	 */
	const rawCompaction =
		data.compaction && typeof data.compaction === "object" && !Array.isArray(data.compaction)
			? (data.compaction as Record<string, unknown>)
			: {};
	const compactionConfig = {
		enabled: typeof rawCompaction.enabled === "boolean" ? rawCompaction.enabled : true,
		reserveTokens:
			typeof rawCompaction.reserveTokens === "number" && Number.isFinite(rawCompaction.reserveTokens)
				? Math.max(0, Math.floor(rawCompaction.reserveTokens))
				: 16384,
		keepRecentTokens:
			typeof rawCompaction.keepRecentTokens === "number" &&
			Number.isFinite(rawCompaction.keepRecentTokens)
				? Math.max(0, Math.floor(rawCompaction.keepRecentTokens))
				: 20000,
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
			...(existing && typeof existing === "object" && !Array.isArray(existing)
				? (existing as Record<string, unknown>)
				: {}),
			...compactionConfig,
		};
		const needsNormalize =
			!existing ||
			typeof existing !== "object" ||
			Array.isArray(existing) ||
			typeof (existing as Record<string, unknown>).enabled !== "boolean" ||
			typeof (existing as Record<string, unknown>).reserveTokens !== "number" ||
			typeof (existing as Record<string, unknown>).keepRecentTokens !== "number";
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
		const existing =
			data.compaction && typeof data.compaction === "object" && !Array.isArray(data.compaction)
				? (data.compaction as Record<string, unknown>)
				: {};
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
	 * 配置键名 → 显示标签。
	 * 已登记 i18n 的键走多语言；未登记回退原始 key，避免未知字段空白。
	 */
	const configLabel = (key: string): string => {
		switch (key) {
			case "enabledModels": return t("config.label.enabledModels");
			case "defaultProvider": return t("config.label.defaultProvider");
			case "defaultModel": return t("config.label.defaultModel");
			case "lastChangelogVersion": return t("config.label.lastChangelogVersion");
			case "customPrompt": return t("config.label.customPrompt");
			case "promptGuidelines": return t("config.label.promptGuidelines");
			case "appendSystemPrompt": return t("config.label.appendSystemPrompt");
			case "proxy": return t("config.label.proxy");
			case "proxyUrl": return t("config.label.proxyUrl");
			case "proxyBypass": return t("config.label.proxyBypass");
			case "theme": return t("config.label.theme");
			case "language": return t("config.label.language");
			case "disabledSkills": return t("config.label.disabledSkills");
			case "disabledExtensions": return t("config.label.disabledExtensions");
			case "noProjectDiscovery": return t("config.label.noProjectDiscovery");
			case "defaultProjectTrust": return t("config.label.defaultProjectTrust");
			case "allowProjectChanges": return t("config.label.allowProjectChanges");
			case "enableSkillCommands": return t("config.label.enableSkillCommands");
			case "temperature": return t("config.label.temperature");
			case "systemPrompt": return t("config.label.systemPrompt");
			case "hideThinkingBlock": return t("config.label.hideThinkingBlock");
			case "packages": return t("config.label.packages");
			case "defaultThinkingLevel": return t("config.label.defaultThinkingLevel");
			case "quietStartup": return t("config.label.quietStartup");
			case "collapseChangelog": return t("config.label.collapseChangelog");
			case "compaction": return t("config.label.compaction");
			case "sessionDir": return t("config.label.sessionDir");
			case "steeringMode": return t("config.label.steeringMode");
			case "followUpMode": return t("config.label.followUpMode");
			case "transport": return t("config.label.transport");
			case "httpProxy": return t("config.label.httpProxy");
			case "shellPath": return t("config.label.shellPath");
			case "shellCommandPrefix": return t("config.label.shellCommandPrefix");
			case "npmCommand": return t("config.label.npmCommand");
			case "thinkingBudgets": return t("config.label.thinkingBudgets");
			case "branchSummary": return t("config.label.branchSummary");
			case "doubleEscapeAction": return t("config.label.doubleEscapeAction");
			case "treeFilterMode": return t("config.label.treeFilterMode");
			default: return key;
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
				<span className="font-mono text-xs tabular-nums text-text-tertiary">
					{t("config.count.configItems", { count: entries.length })}
				</span>
			</div>
			<div className="flex flex-col gap-2">
				{/* enabledModels 始终显示在最前面 */}
				<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
					<span className="min-w-[180px] text-control font-medium text-text-primary">{configLabel("enabledModels")}</span>
					<EnabledModelsInput
						value={
							Array.isArray(data.enabledModels) ? data.enabledModels : undefined
						}
						models={collectModels(props.modelsData, props.discoveredModels)}
						onChange={(v) => props.onChange({ ...data, enabledModels: v })}
					/>
				</div>

				{/* ── 默认供应商 / 默认模型：始终显示，不依赖 settings.json 中是否已存在这两个 key ── */}
				<div className="config-retry-group">
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong flex flex-col items-start gap-0.5 rounded-none border-none px-4 pb-1 pt-2.5 hover:border-transparent">
						<SectionHeading
							className="config-settings-section-heading"
							title={t("config.defaults.title")}
							description={t("config.defaults.hint")}
						/>
					</div>
					{/* defaultProvider / defaultModel 未配置时 value 为 undefined，SettingsValueInput 按空串处理
					    （combobox 空态 + 隐藏清除按钮）；选中后写入 key 本身；清空则保留 key 值为 ""，消费方按默认行为兜底 */}
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary">{configLabel("defaultProvider")}</span>
						<SettingsValueInput
							value={data.defaultProvider}
							fieldKey="defaultProvider"
							modelsData={props.modelsData}
							authData={props.authData}
							discoveredModels={props.discoveredModels}
							allSettings={data}
							onChange={(v) => props.onChange({ ...data, defaultProvider: typeof v === "string" ? v : "" })}
						/>
					</div>
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary">{configLabel("defaultModel")}</span>
						<SettingsValueInput
							value={data.defaultModel}
							fieldKey="defaultModel"
							modelsData={props.modelsData}
							authData={props.authData}
							discoveredModels={props.discoveredModels}
							allSettings={data}
							onChange={(v) => props.onChange({ ...data, defaultModel: typeof v === "string" ? v : "" })}
						/>
					</div>
				</div>

				{/* ── 通用行为：高频 pi 配置常驻显示，未写入时也可见可编辑 ── */}
				<div className="config-retry-group">
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong flex flex-col items-start gap-0.5 rounded-none border-none px-4 pb-1 pt-2.5 hover:border-transparent">
						<SectionHeading
							className="config-settings-section-heading"
							title={t("config.general.title")}
							description={t("config.general.hint")}
						/>
					</div>

					{/* 默认思考档位：枚举下拉，空值表示不设置（pi 按模型/上下文自行决定） */}
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary" title={t("config.general.thinkingLevelHint")}>{configLabel("defaultThinkingLevel")}</span>
						<ClearableSettingsInput
							empty={typeof data.defaultThinkingLevel !== "string" || !data.defaultThinkingLevel}
							onClear={() => props.onChange({ ...data, defaultThinkingLevel: "" })}
						>
							<ConfigSelect
								value={typeof data.defaultThinkingLevel === "string" ? data.defaultThinkingLevel : ""}
								options={THINKING_LEVELS}
								onChange={(v) => props.onChange({ ...data, defaultThinkingLevel: v })}
								placeholder={t("config.general.thinkingLevelPlaceholder")}
								clearSpace
							/>
						</ClearableSettingsInput>
					</div>

					{/* 布尔开关行：hideThinkingBlock / quietStartup，直接写 true/false */}
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary" title={t("config.general.hideThinkingBlockHint")}>{configLabel("hideThinkingBlock")}</span>
						<Label className="config-checkbox-label">
							<Checkbox
								checked={data.hideThinkingBlock === true}
								onCheckedChange={(checked) => props.onChange({ ...data, hideThinkingBlock: checked === true })}
							/>
							<span>{data.hideThinkingBlock === true ? t("common.true") : t("common.false")}</span>
						</Label>
					</div>
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary" title={t("config.general.quietStartupHint")}>{configLabel("quietStartup")}</span>
						<Label className="config-checkbox-label">
							<Checkbox
								checked={data.quietStartup === true}
								onCheckedChange={(checked) => props.onChange({ ...data, quietStartup: checked === true })}
							/>
							<span>{data.quietStartup === true ? t("common.true") : t("common.false")}</span>
						</Label>
					</div>

					{/* steeringMode / followUpMode：steering 与 follow-up 消息的发送模式，
					    all 一次全部发送，one-at-a-time 逐条（pi 默认），RPC 场景下影响 API 调用方式 */}
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary" title={t("config.general.steeringModeHint")}>{configLabel("steeringMode")}</span>
						<ClearableSettingsInput
							empty={typeof data.steeringMode !== "string" || !data.steeringMode}
							onClear={() => props.onChange({ ...data, steeringMode: "" })}
						>
							<ConfigSelect
								value={typeof data.steeringMode === "string" ? data.steeringMode : ""}
								options={SEND_MODE_OPTIONS}
								onChange={(v) => props.onChange({ ...data, steeringMode: v })}
								placeholder={t("config.general.steeringModePlaceholder")}
								clearSpace
							/>
						</ClearableSettingsInput>
					</div>
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary" title={t("config.general.followUpModeHint")}>{configLabel("followUpMode")}</span>
						<ClearableSettingsInput
							empty={typeof data.followUpMode !== "string" || !data.followUpMode}
							onClear={() => props.onChange({ ...data, followUpMode: "" })}
						>
							<ConfigSelect
								value={typeof data.followUpMode === "string" ? data.followUpMode : ""}
								options={SEND_MODE_OPTIONS}
								onChange={(v) => props.onChange({ ...data, followUpMode: v })}
								placeholder={t("config.general.followUpModePlaceholder")}
								clearSpace
							/>
						</ClearableSettingsInput>
					</div>

					{/* defaultProjectTrust：RPC 模式不弹信任询问，靠它在加载项目的 .pi/settings.json 等资源时兜底 */}
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary" title={t("config.general.projectTrustHint")}>{configLabel("defaultProjectTrust")}</span>
						<ClearableSettingsInput
							empty={typeof data.defaultProjectTrust !== "string" || !data.defaultProjectTrust}
							onClear={() => props.onChange({ ...data, defaultProjectTrust: "" })}
						>
							<ConfigSelect
								value={typeof data.defaultProjectTrust === "string" ? data.defaultProjectTrust : ""}
								options={PROJECT_TRUST_OPTIONS}
								onChange={(v) => props.onChange({ ...data, defaultProjectTrust: v })}
								placeholder={t("config.general.projectTrustPlaceholder")}
								clearSpace
							/>
						</ClearableSettingsInput>
					</div>

					{/* 传输协议：多协议供应商选 sse/websocket/websocket-cached，默认 auto 自动选择 */}
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary" title={t("config.general.transportHint")}>{configLabel("transport")}</span>
						<ClearableSettingsInput
							empty={typeof data.transport !== "string" || !data.transport}
							onClear={() => props.onChange({ ...data, transport: "" })}
						>
							<ConfigSelect
								value={typeof data.transport === "string" ? data.transport : ""}
								options={TRANSPORT_OPTIONS}
								onChange={(v) => props.onChange({ ...data, transport: v })}
								placeholder={t("config.general.transportPlaceholder")}
								clearSpace
							/>
						</ClearableSettingsInput>
					</div>
				</div>

				{/* ── 全局会话目录（仅编辑 ~/.pi/agent/settings.json 的 sessionDir） ── */}
				<div className="config-retry-group">
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong flex flex-col items-start gap-0.5 rounded-none border-none px-4 pb-1 pt-2.5 hover:border-transparent">
						<SectionHeading
						className="config-settings-section-heading"
						title={t("config.sessionDir.title")}
						description={t("config.sessionDir.hint")}
					/>
					</div>
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary">{t("config.label.sessionDir")}</span>
						<Input
							className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
							type="text"
							value={sessionDirValue}
							placeholder={t("config.sessionDir.placeholder")}
							onChange={(e) => updateSessionDir(e.target.value)}
						/>
					</div>
				</div>

				{/* ── 重试配置 ── */}
				<div className="config-retry-group">
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong flex flex-col items-start gap-0.5 rounded-none border-none px-4 pb-1 pt-2.5 hover:border-transparent">
					<SectionHeading
						className="config-settings-section-heading"
						title={t("config.retry.title")}
						description={t("config.retry.hint")}
					/>
				</div>
				<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
					<span className="min-w-[180px] text-control font-medium text-text-primary">{t("config.retry.maxRetries")}</span>
					<Input className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]" type="number" min={0} max={50} value={retryConfig.maxRetries} onChange={(e) => updateRetry({ maxRetries: Number(e.target.value) })} />
				</div>
				<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
					<span className="min-w-[180px] text-control font-medium text-text-primary">{t("config.retry.baseDelayMs")}</span>
					<Input className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]" type="number" min={100} step={100} value={retryConfig.baseDelayMs} onChange={(e) => updateRetry({ baseDelayMs: Number(e.target.value) })} />
				</div>
				</div>

				{/* ── 会话压缩：拆成开关 + 两个 token 数，避免用户直接改 JSON 对象 ── */}
				<div className="config-retry-group">
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong flex flex-col items-start gap-0.5 rounded-none border-none px-4 pb-1 pt-2.5 hover:border-transparent">
						<SectionHeading
						className="config-settings-section-heading"
						title={t("config.compaction.title")}
						description={t("config.compaction.hint")}
					/>
					</div>
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary">{t("config.compaction.enabled")}</span>
						<Label className="config-checkbox-label">
							<Checkbox
								checked={compactionConfig.enabled}
								onCheckedChange={(checked) => updateCompaction({ enabled: checked === true })}
							/>
							<span>
								{compactionConfig.enabled
									? t("config.compaction.enabledOn")
									: t("config.compaction.enabledOff")}
							</span>
						</Label>
					</div>
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary" title={t("config.compaction.reserveTokensHint")}>
							{t("config.compaction.reserveTokens")}
						</span>
						<Input
							className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
							type="number"
							min={0}
							step={1024}
							value={compactionConfig.reserveTokens}
							onChange={(e) =>
								updateCompaction({
									reserveTokens: Math.max(0, Math.floor(Number(e.target.value) || 0)),
								})
							}
						/>
					</div>
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary" title={t("config.compaction.keepRecentTokensHint")}>
							{t("config.compaction.keepRecentTokens")}
						</span>
						<Input
							className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
							type="number"
							min={0}
							step={1024}
							value={compactionConfig.keepRecentTokens}
							onChange={(e) =>
								updateCompaction({
									keepRecentTokens: Math.max(0, Math.floor(Number(e.target.value) || 0)),
								})
							}
						/>
					</div>
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong flex flex-col items-start gap-0.5 rounded-none border-none px-4 pb-1 pt-2.5 hover:border-transparent">
						<span className="config-settings-section-hint">{t("config.compaction.manualHint")}</span>
					</div>
				</div>

				{entries
					// sessionDir / retry / enabledModels / defaultProvider / defaultModel 及通用行为区块已占用，避免列表里重复一行
					.filter(([key]) => key !== "enabledModels" && key !== "retry" && key !== "sessionDir" && key !== "defaultProvider" && key !== "defaultModel" && key !== "defaultThinkingLevel" && key !== "hideThinkingBlock" && key !== "quietStartup" && key !== "steeringMode" && key !== "followUpMode" && key !== "defaultProjectTrust" && key !== "transport")
					.map(([key, value]) => (
					<div key={key} className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong">
						<span className="min-w-[180px] text-control font-medium text-text-primary">{configLabel(key)}</span>
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
					</div>
				))}
				{!hasEnabledModels && (
					<div className="flex items-center gap-3.5 rounded-sm border border-border-subtle px-4 py-2 transition-colors hover:border-border-strong justify-center border-dashed opacity-70 hover:opacity-100">
						<Button size="sm" variant="outline"
							onClick={() => props.onChange({ ...data, enabledModels: [] })}
						>
							<Plus size={14} />
							{t("config.settings.addEnabledModels")}
						</Button>
					</div>
				)}
				{/* 页面恒有 enabledModels / 默认供应商 / 默认模型常驻区块，不再需要空态提示 */}
			</div>
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
	const filteredModels = normalizedFilter && !isGlob
		? props.models.filter((m) =>
				[m.id, m.name, m.provider, `${m.provider}/${m.id}`]
					.filter(Boolean)
					.some((v) => v!.toLowerCase().includes(normalizedFilter)),
			)
		: props.models;

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
				<div className="flex min-h-[38px] min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-1.5 rounded-sm border border-border-subtle bg-popover px-2.5 py-[5px] transition-colors duration-150 hover:border-border-strong">
					{[...selected].map((fullKey) => (
						<span key={fullKey} className="inline-flex h-6 items-center gap-[3px] rounded-full border border-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-border-subtle))] bg-[color:color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg-panel))] pl-[9px] pr-[5px] font-mono text-xs leading-[18px] whitespace-nowrap text-text-primary">
							<span>{fullKey}</span>
							<Button type="button"
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
					<span className="text-xs leading-[18px] text-text-tertiary">
						{selected.size === 0
							? t("config.settings.enabledModelsPlaceholder")
							: `${selected.size} ${t("config.settings.enabledModelsSelected")}`}
					</span>
				</div>
			</PopoverTrigger>
			<PopoverContent align="start" sideOffset={4} className="w-[var(--radix-popover-trigger-width)] max-w-[min(680px,calc(100vw-48px))] p-0">
				<Command shouldFilter={false}>
					<CommandInput
						value={filter}
						onValueChange={setFilter}
						placeholder={t("config.settings.enabledModelsSearchPlaceholder")}
						autoFocus
					/>
					<CommandList className="max-h-[min(320px,45vh)]">
						{/* glob 模式行：输入含 * 或 ? 时显示，可勾选为自定义模式 */}
						{filter && isGlob && (
							<CommandItem
								key="__glob__"
								value={filter}
								onSelect={() => toggleModel(filter)}
								className={`border border-dashed border-[var(--color-accent)] bg-[color:color-mix(in_srgb,var(--color-accent)_6%,var(--color-bg-popover))] text-control text-text-primary hover:bg-[color:color-mix(in_srgb,var(--color-accent)_12%,transparent)]${selected.has(filter) ? " border-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_6%,var(--color-bg-popover))]" : ""}`}
							>
								<span className="flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border-[1.5px] border-border-strong text-[color:var(--color-accent)]">
									{selected.has(filter) && <Check size={12} />}
								</span>
								<span className="font-mono text-xs">{filter}</span>
								<span className="ml-auto font-mono text-[11px] text-text-tertiary">{t("config.settings.enabledModelsGlobHint")}</span>
							</CommandItem>
						)}
						{hasResults && providerNames.map((provider) => (
							<CommandGroup key={provider} heading={
								<button
									type="button"
									className="flex w-full cursor-pointer items-center gap-2 border-0 bg-bg-hover px-3 py-2 text-left text-control font-medium text-text-primary transition-colors duration-100 before:mr-1 before:text-[9px] before:text-text-tertiary before:transition-transform before:duration-150 before:content-['▾'] hover:bg-bg-active"
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
									<span className="font-mono text-[11px] text-text-tertiary">{grouped[provider].length}</span>
								</button>
							}>
								{!collapsed.has(provider) && grouped[provider].map((m) => (
									<CommandItem
										key={m.fullKey}
										value={m.fullKey}
										onSelect={() => toggleModel(m.fullKey)}
										className={`cursor-pointer gap-2 py-[7px] pr-3 pl-7 text-control text-text-primary ${selected.has(m.fullKey) ? "bg-[color:color-mix(in_srgb,var(--color-accent)_6%,var(--color-bg-panel))]" : ""}`}
									>
										<span className={`flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border-[1.5px] border-border-strong text-[color:var(--color-accent)] transition-[border-color,background-color] duration-100${selected.has(m.fullKey) ? " border-[var(--color-accent)] bg-[var(--color-accent)] text-white" : ""}`}>
											{selected.has(m.fullKey) && <Check size={12} />}
										</span>
										<span className="text-control text-text-primary">{m.name ?? m.id}</span>
										<span className="ml-auto font-mono text-xs text-text-tertiary">{m.provider}/{m.id}</span>
									</CommandItem>
								))}
							</CommandGroup>
						))}
						{!hasResults && (
							<div className="p-4 text-center text-xs text-text-tertiary">{t("app.modelPickerEmpty")}</div>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/** 带清空按钮的输入包装器：值非空时常显清空按钮，点击即清除选中值。
 *  清除只置空值（onChange("")），保留设置项 key，避免设置页整行消失。
 *  按钮定位在右侧下拉触发按钮左侧（right-[38px]），避免与箭头按钮互相遮挡。 */
function ClearableSettingsInput(props: { empty: boolean; onClear: () => void; children: ReactNode }) {
	return (
		<div className="relative min-w-0 flex-1">
			{props.children}
			{!props.empty && (
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					className="absolute top-1/2 -translate-y-1/2 right-[38px] size-6 rounded-sm hover:bg-bg-hover"
					onMouseDown={(e) => {
						// 用 mousedown 而非 click：避免触发 combobox 的 onFocus/onChange 连锁反应
						e.preventDefault();
						e.stopPropagation();
						props.onClear();
					}}
					title={t("common.clear")}
				>
					<X size={12} className="text-text-tertiary" />
				</Button>
			)}
		</div>
	);
}

function SettingsValueInput(props: {
	value: unknown;
	fieldKey: string;
	modelsData?: ModelsFile;
	authData?: AuthFile;
	discoveredModels?: Record<string, Array<{ id: string; name?: string }>>;
	allSettings?: SettingsFile;
	onChange: (v: unknown) => void;
}) {
	const { value, fieldKey, modelsData, authData, discoveredModels, allSettings } = props;

	// defaultProvider: 从 modelsData.providers + authData + discoveredModels 聚合所有可用的供应商
	if (fieldKey === "defaultProvider") {
		const providerOptions = collectProviderOptions(modelsData, authData, discoveredModels);
		const current = typeof value === "string" ? value : "";
		return (
			<ClearableSettingsInput
				empty={!current}
				onClear={() => props.onChange("")}
			>
				<ConfigComboboxInput
					value={current}
					options={providerOptions}
					onChange={(v) => props.onChange(v)}
					placeholder={t("config.settings.selectProvider")}
					clearSpace
				/>
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
			const currentLabel = selectedProviderName
				? `${currentModel} (${selectedProviderName})`
				: currentModel;
			modelOptions.push({ value: currentModel, label: currentLabel });
		}

		if (selectedProviderName) {
			// 优先从模型配置中取该供应商的模型
			const provider = modelsData?.providers[selectedProviderName];
			if (provider) {
				for (const model of provider.models) {
					if (!seen.has(model.id)) {
						seen.add(model.id);
						const label = model.name && model.name !== model.id
							? `${model.name} (${selectedProviderName})`
							: `${model.id} (${selectedProviderName})`;
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
							label: model.name
								? `${model.name} (${selectedProviderName})`
								: `${model.id} (${selectedProviderName})`,
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
							const label = model.name && model.name !== model.id
								? `${model.name} (${pName})`
								: `${model.id} (${pName})`;
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
								label: model.name
									? `${model.name} (${pName})`
									: `${model.id} (${pName})`,
							});
						}
					}
				}
			}
		}

		const currentModelValue = typeof value === "string" ? value : "";
		return (
			<ClearableSettingsInput
				empty={!currentModelValue}
				onClear={() => props.onChange("")}
			>
				<ConfigComboboxInput
					value={currentModelValue}
					options={modelOptions}
					onChange={(v) => props.onChange(v)}
					placeholder={selectedProviderName
						? t("config.settings.selectModelFor", { provider: selectedProviderName })
						: t("config.settings.selectModelFirst")}
					clearSpace
				/>
			</ClearableSettingsInput>
		);
	}

	if (typeof value === "boolean") {
		return (
			<Label className="config-checkbox-label">
				<Checkbox
					checked={value}
					onCheckedChange={(checked) => props.onChange(checked)}
				/>
				<span>{value ? t("common.true") : t("common.false")}</span>
			</Label>
		);
	}
	if (typeof value === "number") {
		return (
			<Input
				type="number"
				value={value}
				onChange={(e) => props.onChange(Number(e.target.value))}
				className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
			/>
		);
	}
	if (typeof value === "string") {
		return (
			<Input
				value={value}
				onChange={(e) => props.onChange(e.target.value)}
				className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
			/>
		);
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
			className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
		/>
	);
}


