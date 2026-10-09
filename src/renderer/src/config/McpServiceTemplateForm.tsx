import { useState } from "react";
import { BadgeCheck, ExternalLink } from "lucide-react";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t } from "../i18n";
import { openDocsInSystemBrowser, SecretInput } from "./ConfigShared";
import { isMcpServerName, uniqueServerName } from "./mcpForm";
import { buildCatalogDefinition, catalogNeedsCredential, type McpCatalogCategory, type McpCatalogCredential, type McpServiceCatalogEntry } from "./mcpServiceCatalog";
import { MCP_BRAND_ICONS, McpBrandIconSvg } from "./mcpServiceBrandIcons";
import type { SmartAddEntry } from "./McpSmartAdd";

const NAME_ERROR_KEYS = {
	required: "config.mcp.template.name.required",
	invalid: "config.mcp.template.name.invalid",
	duplicate: "config.mcp.template.name.duplicate",
} as const;

/** 单个凭据字段的落点说明：让用户看到值最终写到哪个字段（Bearer 头 / 环境变量 / URL 参数 / 命令行参数）。 */
function credentialTargetText(credential: McpCatalogCredential): string {
	if (credential.kind === "env") return t("config.mcp.catalog.credentialEnv", { key: credential.envKey });
	if (credential.kind === "url-query") return t("config.mcp.catalog.credentialUrlQuery", { param: credential.param });
	if (credential.kind === "args") return t("config.mcp.catalog.credentialArgs", { flag: credential.flag });
	return t("config.mcp.catalog.credentialHeader");
}

/** 目录服务表单：字段由条目的凭据声明驱动——none/oauth 只需名称，其余按 credentials 渲染多个密钥框。 */
export function McpServiceTemplateForm(props: { entry: McpServiceCatalogEntry; existingNames: ReadonlySet<string>; disabled: boolean; saving: boolean; onConnect: (entry: SmartAddEntry) => Promise<boolean>; onCustom: () => void }) {
	const credentialFields = props.entry.credentials ?? [];
	const [name, setName] = useState(() => uniqueServerName(props.entry.defaultName, props.existingNames));
	const [credentialValues, setCredentialValues] = useState<string[]>(() => credentialFields.map(() => ""));
	const [nameError, setNameError] = useState<keyof typeof NAME_ERROR_KEYS | null>(null);
	const [credentialErrors, setCredentialErrors] = useState<boolean[]>(() => credentialFields.map(() => false));
	const needsCredential = catalogNeedsCredential(props.entry);
	const hasCredentialInput = credentialFields.length > 0;

	const connect = async () => {
		const trimmedName = name.trim();
		if (!trimmedName) {
			setNameError("required");
			return;
		}
		if (!isMcpServerName(trimmedName)) {
			setNameError("invalid");
			return;
		}
		if (props.existingNames.has(trimmedName)) {
			setNameError("duplicate");
			return;
		}
		if (needsCredential && credentialFields.some((field, index) => !(credentialValues[index] ?? "").trim())) {
			setCredentialErrors(credentialFields.map((field, index) => !(credentialValues[index] ?? "").trim()));
			return;
		}
		const saved = await props.onConnect({ name: trimmedName, definition: buildCatalogDefinition(props.entry, credentialValues) });
		if (saved) setCredentialValues(credentialFields.map(() => ""));
	};

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				void connect();
			}}
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						{MCP_BRAND_ICONS[props.entry.id] ? <McpBrandIconSvg icon={MCP_BRAND_ICONS[props.entry.id]} size={16} /> : null}
						<h2 className="text-control font-medium">{t(props.entry.titleKey)}</h2>
					</div>
					<p className="mt-1 text-micro text-muted-foreground">{t(props.entry.hintKey)}</p>
					<code className="mt-1 block break-all font-mono text-micro text-muted-foreground">{props.entry.endpointDisplay}</code>
				</div>
				<a href={props.entry.docsUrl} className="inline-flex shrink-0 items-center gap-1 text-micro text-primary hover:underline" onClick={openDocsInSystemBrowser(props.entry.docsUrl)}>
					{t("config.mcp.template.officialDocs")}
					<ExternalLink size={12} aria-hidden="true" />
				</a>
			</div>

			<div className="grid gap-1.5">
				<Label htmlFor="mcp-template-name">{t("config.mcp.template.serverName")}</Label>
				<Input
					id="mcp-template-name"
					value={name}
					onChange={(event) => {
						setName(event.target.value);
						setNameError(null);
					}}
					disabled={props.disabled}
					className="h-8 font-mono"
				/>
				{nameError ? <p className="text-micro text-danger">{t(NAME_ERROR_KEYS[nameError])}</p> : null}
			</div>

			{hasCredentialInput
				? credentialFields.map((field, index) => (
						<div key={field.labelKey} className="grid gap-1.5">
							<Label>{t(field.labelKey)}</Label>
							<SecretInput
								value={credentialValues[index] ?? ""}
								ariaLabel={t(field.labelKey)}
								disabled={props.disabled}
								onChange={(value) => {
									setCredentialValues((current) => current.map((entry, i) => (i === index ? value : entry)));
									setCredentialErrors((current) => current.map((entry, i) => (i === index ? false : entry)));
								}}
								placeholder={t("config.mcp.template.secretPlaceholder")}
							/>
							{credentialErrors[index] ? <p className="text-micro text-danger">{t("config.mcp.template.keyRequired")}</p> : null}
							<p className="text-micro text-muted-foreground">{field.optional ? t("config.mcp.catalog.credentialOptionalHint", { target: credentialTargetText(field.credential) }) : credentialTargetText(field.credential)}</p>
						</div>
					))
				: null}

			{hasCredentialInput ? <p className="text-micro text-muted-foreground">{t("config.mcp.template.plaintextNotice")}</p> : null}

			{props.entry.auth === "oauth" ? <p className="text-micro text-muted-foreground">{t("config.mcp.catalog.oauthHint")}</p> : null}
			{props.entry.auth === "none" ? <p className="text-micro text-muted-foreground">{t("config.mcp.catalog.noAuthHint")}</p> : null}

			<div className="flex flex-wrap items-center gap-1.5">
				<Button type="submit" size="sm" disabled={props.disabled}>
					{t(props.saving ? "config.mcp.template.saving" : "config.mcp.template.connect")}
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={props.onCustom} disabled={props.disabled}>
					{t("config.mcp.template.custom")}
				</Button>
			</div>
		</form>
	);
}

/** 目录分组小标题（左栏）：按类别聚合同类服务，减一屏噪音。 */
export function McpCatalogGroupTitle(props: { category: McpCatalogCategory }) {
	const key = `config.mcp.catalog.category.${props.category}` as const;
	return <div className="px-1 pb-0.5 text-micro text-muted-foreground">{t(key)}</div>;
}

/** 已配置标记：目录条目在左栏命中同名服务时打勾，避免「已连过又出现在推荐区」的困惑。 */
export function McpCatalogConfiguredMark() {
	return <BadgeCheck size={13} className="shrink-0 text-[var(--color-success)]" aria-label={t("config.mcp.catalog.configured")} />;
}
