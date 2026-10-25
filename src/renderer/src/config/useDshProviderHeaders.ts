import { useCallback, useMemo, useState } from "react";
import type { desktopApi } from "../desktopApi";
import { getProviderHeaders } from "./providerHeaders";

type HeaderDrafts = Record<string, Record<string, string> | undefined>;
type SettingsMutations = Parameters<typeof desktopApi.sessions.mutateDshSettings>[1];

/** 管理已有供应商的整表请求头草稿；不能用 settings.update 的深合并表达改名或删除。 */
export function useDshProviderHeaders() {
	const [drafts, setDrafts] = useState<HeaderDrafts>({});
	const updateHeaders = useCallback((provider: string, headers: Record<string, string> | undefined) => {
		// 自有键 + undefined = 用户清空；没有自有键才是未修改，必须回退已保存值。
		setDrafts((previous) => ({ ...previous, [provider]: headers }));
	}, []);
	const readHeaders = useCallback((provider: string, saved: unknown) => (Object.hasOwn(drafts, provider) ? drafts[provider] : getProviderHeaders(saved)), [drafts]);
	const removeHeaderDraft = useCallback((provider: string) => {
		setDrafts((previous) => {
			const next = { ...previous };
			delete next[provider];
			return next;
		});
	}, []);
	const clearHeaderDrafts = useCallback(() => setDrafts({}), []);
	const headerMutations = useMemo<SettingsMutations>(
		() =>
			Object.entries(drafts).map(([provider, headers]) => {
				const path = ["providers", provider, "headers"];
				// path set 替换整个 dict，unset 恢复运行时默认；头的空字符串值仍是有效覆盖。
				return headers && Object.keys(headers).length > 0 ? { op: "set", path, value: headers } : { op: "unset", path };
			}),
		[drafts],
	);
	return { headersDirty: headerMutations.length > 0, readHeaders, updateHeaders, removeHeaderDraft, clearHeaderDrafts, headerMutations };
}
