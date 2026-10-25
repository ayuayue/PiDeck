/**
 * DSH agent 预设目录（agentPreset.list）的渲染层共享缓存。
 *
 * 目录是 host 侧 live 数据：默认预设既能在 PiDeck 设置页改（保存后 force 刷新），
 * 也能在 dsh-web / 配置文件里改（只能靠 TTL 或打开新会话时重拉）。旧实现只在
 * atom 为 null 时拉一次、成功后再也不刷新 —— 结果是改完默认预设，新会话胶囊仍
 * 显示旧默认，发出去却按新默认组合，显示与实际两端分叉。
 *
 * 放 utils 而不是 atoms：atoms/index.ts 会被 Node 测试整体加载，不能顶层依赖
 * desktopApi（见 dsh-atoms.ts 注释）。
 */
import { getDefaultStore } from "jotai";
import { dshAgentPresetsAtom, type DshAgentPresetIdentity } from "../atoms";
import { desktopApi } from "../desktopApi";

/** 缓存有效期：默认预设可能被外部（dsh-web/配置文件）改动，超过这个窗口就重拉。 */
export const DSH_AGENT_PRESETS_TTL_MS = 15_000;

/** 模块级 promise 合并并发首拉；loadedAt 记录成功写入 atom 的时刻（失败不更新，保留重试）。 */
let loadPromise: Promise<DshAgentPresetIdentity[] | null> | null = null;
let loadedAt = 0;

/**
 * 读取目录。缓存新鲜时直接返回；`force` 忽略 TTL 重拉（设置页保存默认后让已挂载
 * 的会话头胶囊立即同步）。失败返回 null 且不落缓存，调用方保留重试机会。
 */
export function loadDshAgentPresets(options?: { force?: boolean }): Promise<DshAgentPresetIdentity[] | null> {
	const store = getDefaultStore();
	const cached = store.get(dshAgentPresetsAtom);
	const fresh = cached !== null && Date.now() - loadedAt < DSH_AGENT_PRESETS_TTL_MS;
	if (fresh && options?.force !== true) return Promise.resolve(cached);
	if (loadPromise) return loadPromise;
	loadPromise = desktopApi.sessions
		.listDshAgentPresets()
		.then((list) => {
			store.set(dshAgentPresetsAtom, list);
			loadedAt = Date.now();
			return list;
		})
		.catch(() => {
			// host 首次启动可能数秒、或 DSH 环境未就绪：失败不缓存，保留重试机会
			return null;
		})
		.finally(() => {
			loadPromise = null;
		});
	return loadPromise;
}

/** 强制刷新（忽略 TTL）：默认预设改动后调用，让已挂载的会话头胶囊同步显示。 */
export function refreshDshAgentPresets(): Promise<DshAgentPresetIdentity[] | null> {
	return loadDshAgentPresets({ force: true });
}
