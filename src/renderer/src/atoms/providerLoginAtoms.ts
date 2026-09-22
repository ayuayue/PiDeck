import { atom } from "jotai";

/**
 * 「登录供应商」弹框的打开请求。
 *
 * 归属：弹框是全局 chrome（一次只能开一个），但触发点分散（输入框 `/login`、
 * 后续可能加的设置页入口），因此打开状态放在 atom 里由弹框自己订阅，
 * 不沿着 ComposerArea → Controller → Send 一路透传 props。
 *
 * `providerId` 来自 `/login <id>` 的参数，仅用于在列表里预选；未带参数时由用户手选。
 */
export const providerLoginRequestAtom = atom<{ open: boolean; providerId?: string }>({ open: false });

/** 打开发送 `/login` 时的预选提示（列表加载后若命中则自动选中）。 */
export const openProviderLoginAtom = atom(null, (_get, set, providerId?: string) => {
	set(providerLoginRequestAtom, { open: true, providerId });
});

export const closeProviderLoginAtom = atom(null, (_get, set) => {
	set(providerLoginRequestAtom, { open: false });
});
