import { credentialRefFor } from "../../../shared/dshCredentialRef";
import type { DshModelLike } from "./dshModels";

export type DshProviderDraft = {
	name: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	models: DshModelLike[];
	catalogProvider: boolean;
};

/** DSH settings 与 credentials 分开提交；不能把 Pi 的 apiKey 字段写进 settings.yaml。 */
export function buildDshProviderFromDraft(draft: DshProviderDraft) {
	const name = draft.name.trim();
	const profile: { apiKeyEnv: string; baseURL?: string; api?: string; models?: DshModelLike[] } = {
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
	return { name, profile, apiKey: draft.apiKey.trim() };
}
