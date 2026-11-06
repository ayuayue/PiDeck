import { atom } from "jotai";
import type { PiAuthMethod } from "../../../shared/types/piAuth";

/**
 * 「登录供应商」弹框的打开请求。
 *
 * 归属：弹框是全局 chrome（一次只能开一个），但触发点分散（输入框 `/login`、
 * 配置管理里的 OAuth 页入口），因此打开状态放在 atom 里由弹框自己订阅，
 * 不沿着 ComposerArea → Controller → Send 一路透传 props。
 *
 * `providerId` 来自 `/login <id>` 的参数或 OAuth 页点选的供应商；未带参数时由用户手选。
 * `method` 只由 OAuth 页传入：直接指定登录方式（浏览器授权 / API Key）后可自动开始，
 * 省掉「点弹框里的同款按钮」这一步。
 */
export type ProviderLoginOpenRequest = { providerId?: string; method?: PiAuthMethod };

export const providerLoginRequestAtom = atom<{ open: boolean; providerId?: string; method?: PiAuthMethod }>({ open: false });

/**
 * 打开登录弹框。`string` 形式保留给既有 `/login <id>` 调用（只预选供应商，不自动开始）；
 * OAuth 页传对象以同时指定登录方式。
 */
export const openProviderLoginAtom = atom(null, (_get, set, request?: string | ProviderLoginOpenRequest) => {
	const { providerId, method } = typeof request === "string" ? { providerId: request } : (request ?? {});
	set(providerLoginRequestAtom, { open: true, providerId, method });
});

export const closeProviderLoginAtom = atom(null, (_get, set) => {
	set(providerLoginRequestAtom, { open: false });
});
