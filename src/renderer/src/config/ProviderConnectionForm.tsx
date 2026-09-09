import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t } from "../i18n";
import { ApiTypeInput, ConfigSelect, SecretInput } from "./ConfigShared";
import { CUSTOM_USER_AGENT_VALUE, getUserAgentOptions } from "./providerHeaders";
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
	compat: { supportsDeveloperRole: boolean; supportsReasoningEffort: boolean };
	onChangeCompat: (next: {
		supportsDeveloperRole: boolean;
		supportsReasoningEffort: boolean;
	}) => void;

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
	const userAgentOptions = getUserAgentOptions();
	const userAgentSelectValue = userAgentOptions.some(
		(option) => option.value === props.userAgent,
	)
		? props.userAgent
		: CUSTOM_USER_AGENT_VALUE;

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
					<ConfigSelect
						value={userAgentSelectValue}
						options={[
							...userAgentOptions,
							{ value: CUSTOM_USER_AGENT_VALUE, label: t("config.custom") },
						]}
						onChange={(value) => {
							if (value === CUSTOM_USER_AGENT_VALUE) return;
							props.onChangeUserAgent(value);
						}}
					/>
					<Input
						value={props.userAgent}
						onChange={(e) => props.onChangeUserAgent(e.target.value)}
						placeholder={t("common.notConfigured")}
					/>
					<span>{t("config.headerEmptyHint")}</span>
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
					<div
						className={`config-test-result ${props.testResult.success ? "success" : "fail"}`}
					>
						<div className="config-test-result-header">
							<span>
								{props.testResult.success
									? `✅ ${t("config.connectionOk")}`
									: `❌ ${t("config.connectionFailed")}`}
							</span>
							<Button variant="ghost" size="icon-sm" className="size-7"
								onClick={props.onClearTestResult}
								title={t("config.clearResult")}
							>
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
								{props.testResult.tokens &&
									(props.testResult.tokens.input != null ||
										props.testResult.tokens.output != null) && (
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
										<span className="break-all text-text-primary">
											{props.testResult.latencyMs < 1000
												? `${props.testResult.latencyMs} ms`
												: `${(props.testResult.latencyMs / 1000).toFixed(1)} s`}
										</span>
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
										<span className="break-all text-text-primary">
											{props.testResult.latencyMs < 1000
												? `${props.testResult.latencyMs} ms`
												: `${(props.testResult.latencyMs / 1000).toFixed(1)} s`}
										</span>
									</div>
								)}
							</div>
						)}
					</div>
					{!props.testResult.success && props.testHint && (
						<div className="config-test-hint">💡 {props.testHint}</div>
					)}
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
							<span>{t("config.developerRole")}</span>
						</Label>
						<small className="config-compat-item-desc">{t("config.developerRoleDesc")}</small>
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
							<span>{t("config.reasoningEffort")}</span>
						</Label>
						<small className="config-compat-item-desc">{t("config.reasoningEffortDesc")}</small>
					</div>
				</div>
			</div>

			{props.advancedHint}
		</div>
	);
}