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
					<Input value={props.baseUrl} aria-label={t("config.field.baseUrl")} size="sm" className="min-w-0" onChange={(event) => props.onChangeBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
					<span className="mt-1 block text-micro leading-relaxed text-text-tertiary">{t(props.backend === "dsh" ? "config.dsh.baseUrlHint" : "config.baseUrlHint")}</span>
				</div>
			</div>
			{!props.catalogProvider && (
				<div className="config-provider-field items-center">
					<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiType")}</Label>
					<ApiTypeInput value={props.api} onChange={props.onChangeApi} backend={props.backend} />
				</div>
			)}
			<div className="config-provider-field items-center">
				<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiKey")}</Label>
				<div className="flex min-w-0 flex-col gap-1">
					<SecretInput value={props.apiKey} onChange={props.onChangeApiKey} />
					{/* 空 Key 是 issue #356 的现场：PiDeck 允许保存不带 Key 的供应商，而 pi 只列出凭据
					    可解析的供应商，于是「设置页有、会话与代理名单没有」。登录（/login）或环境变量
					    同样算凭据，所以只陈述条件，不断言「一定列不出」；填了 Key 就不再占地方。 */}
					{props.backend !== "dsh" && props.apiKey.trim() === "" && <span className="text-micro leading-relaxed text-text-tertiary">{t("config.field.apiKeyEmptyHint")}</span>}
				</div>
			</div>
		</>
	);
}
