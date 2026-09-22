import type { ReactNode } from "react";
import { HelpCircle, X } from "lucide-react";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t, type TranslationKey } from "../i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui-shadcn/tooltip";
import { ApiTypeInput, ConfigComboboxInput, ConfigSelect, SecretInput } from "./ConfigShared";
import { getUserAgentOptions, isUserAgentOverriddenByApiType, isValidUserAgent } from "./userAgentPresets";
import type { ConfigProxyMode } from "../../../shared/types/fetchedModel";

export type ProviderTestResult = {
	success: boolean;
	model?: string;
	snippet?: string;
	tokens?: { input?: number; output?: number };
	latencyMs?: number;
	error?: string;
};

/**
 * 兼容性字段标签旁的「?」提示图标：悬停显示完整说明。
 *
 * 背景：兼容性说明小字（`config-compat-item-desc`）常驻在每项下方，导致四个
 * 兼容项高低不齐、视觉噪音大；说明本质是「出问题时的排障知识」而不是高频信息，
 * 收进 hover tooltip 后行高回归紧凑，文案本身不变（i18n key 复用）。
 * TooltipProvider 已在 main.tsx 全局挂载，无需本地包 Provider。
 */
function CompatLabelHint(props: { tipKey: TranslationKey }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					role="button"
					tabIndex={0}
					aria-label={t(props.tipKey)}
					className="inline-grid size-4 cursor-help place-items-center rounded-sm text-text-tertiary transition-colors outline-none hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
					onClick={(event) => event.preventDefault()}
					onKeyDown={(event) => {
						// 键盘触发（Enter/Space）会激活 asChild button 的 click 默认行为；
						// 触发器是 span 时需自己阻断，避免冒泡到外层 Label 切换复选框。
						if (event.key === "Enter" || event.key === " ") event.preventDefault();
					}}
				>
					<HelpCircle size={12} strokeWidth={1.8} aria-hidden="true" />
				</span>
			</TooltipTrigger>
			{/* 长说明需要限宽换行（默认 w-fit 会被文案撑到一行超长）；text-left 覆盖 text-balance 的居中倾向 */}
			<TooltipContent className="max-w-75 text-left leading-relaxed">{t(props.tipKey)}</TooltipContent>
		</Tooltip>
	);
}

/**
 * 供应商连接表单（已保存 provider 的展开卡片 / 新增·编辑供应商页共用）：
 * baseUrl / API 类型 / apiKey / User-Agent / 兼容性勾选 + 快速测试连接（模型 ID、
 * 代理选择、结果卡片）。
 *
 * 全部 value 驱动：调用方决定值写到哪里（ModelsTab 直接写 modelsData；
 * AddProviderDialog 写页内草稿），本组件不持有任何状态。
 * 刻意不渲染：用量明细（两端统一移除）、代理选项右侧的代理说明小字（界面更干净）。
 */
export function ProviderConnectionForm(props: {
	/** ── 连接字段（调用方持有值并决定落点） ── */
	baseUrl: string;
	api: string;
	apiKey: string;
	userAgent: string;
	onChangeBaseUrl: (value: string) => void;
	onChangeApi: (value: string) => void;
	onChangeApiKey: (value: string) => void;
	onChangeUserAgent: (value: string) => void;

	/** ── 兼容性勾选（两端共用：卡片的已保存 provider 与草稿页同构） ── */
	compat: {
		supportsDeveloperRole: boolean;
		supportsReasoningEffort: boolean;
		/** 未赋值 = 未表态（保存时按 DeepSeek 特征自动判定）；true/false = 用户显式表态。 */
		requiresReasoningContentOnAssistantMessages?: boolean;
		/** 未赋值 = 跟随 pi 协议默认（不写该键）；true/false = 用户显式表态。 */
		supportsStrictMode?: boolean;
	};
	onChangeCompat: (next: { supportsDeveloperRole: boolean; supportsReasoningEffort: boolean; requiresReasoningContentOnAssistantMessages?: boolean; supportsStrictMode?: boolean }) => void;

	/** ── 快速测试连接 ── */
	testModelId: string;
	onChangeTestModelId: (value: string) => void;
	testing: boolean;
	/** 首个模型的 ID（未输入时占位提示；不传则显示通用占位文案）。 */
	firstModelId?: string;
	onTest: () => void;
	onClearTestResult: () => void;
	testProxyMode: ConfigProxyMode;
	onChangeTestProxyMode: (mode: ConfigProxyMode) => void;
	/** 当前 provider 的测试结果（null = 尚无结果）。 */
	testResult: ProviderTestResult | null;
	/** 失败时的排查引导（调用方按「是否已获取到模型」选文案）；null 不渲染。 */
	testHint: string | null;

	/** 高级字段保留提示（可选 slot；草稿页无未知字段时不传）。 */
	advancedHint?: ReactNode;
}) {
	// User-Agent 是「单个可输入下拉」：内置预设在下拉里挑，也能直接手写任意值。
	// 不再拆成「下拉选预设 + 另一个输入框」——两套控件会互相打架
	// （选完预设后输入框里还是旧值、手写值又不在下拉选项里），用户报告过这个体验问题。
	const userAgentOptions = getUserAgentOptions();
	// 用户填了含控制字符（换行等）的 UA：请求头注入风险且会被静默忽略，
	// 表现为「配了却不生效」，所以在表单里显式提示而不是静默丢弃。
	const userAgentInvalid = Boolean(props.userAgent.trim()) && !isValidUserAgent(props.userAgent);
	// api 类型为 openai-codex-responses 时 pi 会用自己的 UA 覆盖此处配置，
	// 此时任何 UA 都不会生效，必须提示用户而不是让他反复试不同的 UA。
	const userAgentOverridden = isUserAgentOverriddenByApiType(props.api);

	return (
		<div className="config-provider-form grid gap-2.5">
			<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
				<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.baseUrl")}</Label>
				<div className="config-base-url-field">
					<Input
						value={props.baseUrl}
						className="h-8 min-w-0 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
						onChange={(e) => props.onChangeBaseUrl(e.target.value)}
						placeholder="https://api.openai.com/v1"
					/>
					<span className="mt-1 block text-[11px] leading-relaxed text-text-tertiary">{t("config.baseUrlHint")}</span>
				</div>
			</div>
			<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
				<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiType")}</Label>
				<ApiTypeInput value={props.api} onChange={props.onChangeApi} />
			</div>
			<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
				<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiKey")}</Label>
				<SecretInput value={props.apiKey} onChange={props.onChangeApiKey} />
			</div>
			<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
				<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.userAgent")}</Label>
				<div className="config-header-field">
					<ConfigComboboxInput value={props.userAgent} options={userAgentOptions} onChange={props.onChangeUserAgent} placeholder={t("config.userAgentRuntimeDefault")} />
					{/* pi 会用自身 UA 覆盖本项时优先展示这条：此时「配了 UA 却不生效」的困惑
					    比留空提示更关键，两条同时出现会让真正的原因被埋掉。 */}
					{userAgentOverridden ? (
						<span className="text-warning">{t("config.userAgentOverriddenByApiType")}</span>
					) : (
						<>
							<span>{t("config.headerEmptyHint")}</span>
							{userAgentInvalid && <span className="text-danger">{t("config.userAgentInvalid")}</span>}
						</>
					)}
				</div>
			</div>

			{/* 快速测试连接 */}
			<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
				<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.testModel")}</Label>
				<div className="config-test-controls">
					<Input
						value={props.testModelId}
						className="h-8 min-w-0 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
						onChange={(e) => props.onChangeTestModelId(e.target.value)}
						placeholder={props.firstModelId ?? t("config.testModelPlaceholder")}
					/>
					<Button size="sm" variant="default" onClick={props.onTest} disabled={props.testing}>
						{props.testing ? t("config.testingConnection") : t("config.testConnection")}
					</Button>
				</div>
			</div>

			{/* 测试/拉取模型的代理选择：需要代理才能访问的供应商（海外网关等）不用改全局代理开关。
			    刻意不渲染右侧代理说明小字：选项文案已自解释，保持界面干净。 */}
			<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
				<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.testProxy")}</Label>
				<ConfigSelect
					value={props.testProxyMode}
					onChange={(value) => props.onChangeTestProxyMode((value || "follow") as ConfigProxyMode)}
					options={[
						{ value: "follow", label: t("config.proxyFollow") },
						{ value: "pi", label: t("config.proxyPi") },
						{ value: "desktop", label: t("config.proxyDesktop") },
						{ value: "off", label: t("config.proxyOff") },
					]}
				/>
			</div>

			{/* 测试结果 */}
			{props.testResult && (
				<>
					<div className={`config-test-result ${props.testResult.success ? "success" : "fail"}`}>
						<div className="config-test-result-header">
							<span>{props.testResult.success ? `✅ ${t("config.connectionOk")}` : `❌ ${t("config.connectionFailed")}`}</span>
							<Button variant="ghost" size="icon-sm" className="size-7" onClick={props.onClearTestResult} title={t("config.clearResult")}>
								<X size={14} />
							</Button>
						</div>
						{props.testResult.success ? (
							<div className="config-test-result-body">
								<div className="flex items-baseline gap-4 text-control">
									<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.model")}</span>
									<strong className="break-all text-text-primary">{props.testResult.model}</strong>
								</div>
								<div className="flex items-baseline gap-4 text-control">
									<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.response")}</span>
									<span className="break-all text-text-primary">{props.testResult.snippet}</span>
								</div>
								{props.testResult.tokens && (props.testResult.tokens.input != null || props.testResult.tokens.output != null) && (
									<div className="flex items-baseline gap-4 text-control">
										<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.tokens")}</span>
										<span className="break-all text-text-primary">
											{t("config.testInputTokens", {
												count: props.testResult.tokens.input ?? "-",
											})}
											，
											{t("config.testOutputTokens", {
												count: props.testResult.tokens.output ?? "-",
											})}
										</span>
									</div>
								)}
								{props.testResult.latencyMs != null && (
									<div className="flex items-baseline gap-4 text-control">
										<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.testLatency")}</span>
										<span className="break-all text-text-primary">{props.testResult.latencyMs < 1000 ? `${props.testResult.latencyMs} ms` : `${(props.testResult.latencyMs / 1000).toFixed(1)} s`}</span>
									</div>
								)}
							</div>
						) : (
							<div className="config-test-result-body">
								{/* 失败原因放在详情第一行，保证用户立刻看到核心错误，
								   不会只看到请求/Body 等排障信息而误判测试结果。 */}
								<div className="flex items-start gap-4 text-control">
									<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.reason")}</span>
									<strong className="break-all leading-relaxed text-danger">{props.testResult.error}</strong>
								</div>
								{props.testResult.latencyMs != null && (
									<div className="flex items-baseline gap-4 text-control">
										<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.testElapsed")}</span>
										<span className="break-all text-text-primary">{props.testResult.latencyMs < 1000 ? `${props.testResult.latencyMs} ms` : `${(props.testResult.latencyMs / 1000).toFixed(1)} s`}</span>
									</div>
								)}
							</div>
						)}
					</div>
					{!props.testResult.success && props.testHint && <div className="config-test-hint">💡 {props.testHint}</div>}
				</>
			)}

			{/* 兼容性勾选 */}
			<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
				<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.compatibility")}</Label>
				<div className="config-compat-group">
					<div className="config-compat-item">
						<Label className="config-checkbox-label">
							<Checkbox
								checked={props.compat.supportsDeveloperRole}
								onCheckedChange={(checked) =>
									props.onChangeCompat({
										...props.compat,
										// 确保两个兼容性字段都显式写入，避免序列化后 JSON 为空导致 pi 后端无法正确判断
										supportsDeveloperRole: checked === true,
										supportsReasoningEffort: props.compat.supportsReasoningEffort || false,
									})
								}
							/>
							<span>
								{t("config.developerRole")}
								<CompatLabelHint tipKey="config.developerRoleDesc" />
							</span>
						</Label>
					</div>
					<div className="config-compat-item">
						<Label className="config-checkbox-label">
							<Checkbox
								checked={props.compat.supportsReasoningEffort}
								onCheckedChange={(checked) =>
									props.onChangeCompat({
										...props.compat,
										supportsDeveloperRole: props.compat.supportsDeveloperRole || false,
										supportsReasoningEffort: checked === true,
									})
								}
							/>
							<span>
								{t("config.reasoningEffort")}
								<CompatLabelHint tipKey="config.reasoningEffortDesc" />
							</span>
						</Label>
					</div>
					<div className="config-compat-item">
						<Label className="config-checkbox-label">
							<Checkbox
								checked={props.compat.requiresReasoningContentOnAssistantMessages === true}
								onCheckedChange={(checked) =>
									props.onChangeCompat({
										// 展开保留未知 compat 子键（如手写的 openRouterRouting），只覆盖面板拥有的三项
										...props.compat,
										supportsDeveloperRole: props.compat.supportsDeveloperRole || false,
										supportsReasoningEffort: props.compat.supportsReasoningEffort || false,
										// 取消勾选也要显式写 false：它是「否决自动判定」的表态，
										// 省略会被保存时的 DeepSeek 特征判定重新打开。
										requiresReasoningContentOnAssistantMessages: checked === true,
									})
								}
							/>
							<span>
								{t("config.reasoningContentReplay")}
								<CompatLabelHint tipKey="config.reasoningContentReplayDesc" />
							</span>
						</Label>
					</div>
					{/* 严格工具采样是「三态下拉」不是复选框，与上面三项并排时必须靠 .config-compat-item
					    的横向排列（见 surfaces.css），否则标签独占一行、下拉落第二行，整组被撑成两行。
					    这里刻意不再用 config-checkbox-label：它带 cursor:pointer 且是 <label>，
					    但本项内没有可切换的控件，点文字没任何反应会误导。 */}
					<div className="config-compat-item">
						<span className="text-control text-text-primary">
							{t("config.strictToolSampling")}
							<CompatLabelHint tipKey="config.strictToolSamplingDesc" />
						</span>
						{/* 三态下拉而不是复选框：pi 的 strict 默认值随协议不同（openai-completions 默认开、
						    responses 系默认关），用「勾/不勾」表达不出「跟随 pi 默认」这一档，
						    还会让界面显示的开关状态与实际线上行为不一致。选「跟随 pi 默认」时不写该键。 */}
						<ConfigSelect
							triggerClassName="w-auto min-w-28"
							value={props.compat.supportsStrictMode === undefined ? "follow" : props.compat.supportsStrictMode ? "on" : "off"}
							options={[
								{ value: "follow", label: t("config.strictToolSamplingFollow") },
								{ value: "on", label: t("config.strictToolSamplingOn") },
								{ value: "off", label: t("config.strictToolSamplingOff") },
							]}
							onChange={(value) =>
								props.onChangeCompat({
									// 展开保留未知 compat 子键（如手写的 openRouterRouting），只覆盖面板拥有的项
									...props.compat,
									supportsDeveloperRole: props.compat.supportsDeveloperRole || false,
									supportsReasoningEffort: props.compat.supportsReasoningEffort || false,
									supportsStrictMode: value === "follow" ? undefined : value === "on",
								})
							}
						/>
					</div>
				</div>
			</div>

			{props.advancedHint}
		</div>
	);
}
