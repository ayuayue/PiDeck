import { credentialRefFor } from "../../../shared/dshCredentialRef";
import { getProviderHeaders } from "./providerHeaders";
import type { DshModelLike } from "./dshModels";

export type DshProviderDraft = {
	name: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	models: DshModelLike[];
	catalogProvider: boolean;
	/**
	 * 自定义请求头（DSH llm-pi-ai 的 typed headers dict）。
	 * 留空不写 headers；旧 User-Agent 值保留，但实际请求仍由 DSH attribution 接管。
	 */
	headers?: Record<string, string>;
};

/** DSH settings 与 credentials 分开提交；不能把 Pi 的 apiKey 字段写进 settings.yaml。 */
export function buildDshProviderFromDraft(draft: DshProviderDraft) {
	const name = draft.name.trim();
	const profile: { apiKeyEnv: string; baseURL?: string; api?: string; models?: DshModelLike[]; headers?: Record<string, string> } = {
		apiKeyEnv: credentialRefFor(undefined, name),
	};
	if (draft.baseUrl.trim()) profile.baseURL = draft.baseUrl.trim();
	// 内置提供方的协议属于适配器目录，不能用自定义表单的默认协议覆盖。
	if (!draft.catalogProvider && draft.api.trim()) profile.api = draft.api.trim();
	if (draft.models.length > 0) {
		profile.models = draft.models.map((model) => {
			const next = { ...model, id: typeof model.id === "string" ? model.id.trim() : "" };
			if (typeof next.name === "string" && !next.name.trim()) delete next.name;
			return next;
		});
	}
	// typed headers dict 原样注入（DSH schema 支持），与 pi 侧 models.json 的
	// provider.headers 同构，便于 DSH ↔ pi 迁移（providerMigration 已双向透传）。
	const headers = getProviderHeaders(draft.headers);
	if (headers) profile.headers = headers;
	return { name, profile, apiKey: draft.apiKey.trim() };
}
