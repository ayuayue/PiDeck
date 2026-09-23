import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t } from "../i18n";
import { ApiTypeInput, SecretInput } from "./ConfigShared";

/** Pi / DSH 共用连接字段；凭据存储、模型发现与兼容性仍由各后端处理。 */
export function ProviderEndpointFields(props: {
	baseUrl: string;
	api: string;
	apiKey: string;
	onChangeBaseUrl: (value: string) => void;
	onChangeApi: (value: string) => void;
	onChangeApiKey: (value: string) => void;
	/** DSH 内置目录拥有协议；不把未生效的协议覆盖展示成可编辑值。 */
	catalogProvider?: boolean;
	backend?: "pi" | "dsh";
}) {
	return (
		<>
			<div className="config-provider-field items-center">
				<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.baseUrl")}</Label>
				<div className="config-base-url-field">
					<Input value={props.baseUrl} aria-label={t("config.field.baseUrl")} className="h-8 min-w-0" onChange={(event) => props.onChangeBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
					<span className="mt-1 block text-[11px] leading-relaxed text-text-tertiary">{t(props.backend === "dsh" ? "config.dsh.baseUrlHint" : "config.baseUrlHint")}</span>
				</div>
			</div>
			{!props.catalogProvider && (
				<div className="config-provider-field items-center">
					<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiType")}</Label>
					<ApiTypeInput value={props.api} onChange={props.onChangeApi} />
				</div>
			)}
			<div className="config-provider-field items-center">
				<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiKey")}</Label>
				<SecretInput value={props.apiKey} onChange={props.onChangeApiKey} />
			</div>
		</>
	);
}
