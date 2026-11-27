import { useCallback, useRef } from "react";
import { reuseStructure, type ItemSame } from "../renderReuse";

/**
 * 渲染复用与惰性计算的通用件。
 *
 * 为什么要有这一层（2026-10）：
 * 流式输出期间（`messageEmitBatcher` 每 50ms flush 一次）整条派生链每帧重跑，
 * 而「派生出来的对象身份」直接决定下游 `memo` 还成不成立。修复时发现同一个样板要在
 * 每个派生点手抄一遍：
 *
 * ```tsx
 * const ref = useRef(undefined);
 * const value = useMemo(() => {
 *   const merged = reuseStructure(ref.current, build(), isSame);
 *   ref.current = merged;
 *   return merged;
 * }, [deps]);
 * ```
 *
 * 手抄的代价是可验证的：`structureReuse.ts` 就因为「文件写好了、没人接线」变成死代码
 * （注释写着「缺任何一层，下游 memo 就失效」，而 `src/` 里 0 引用），一整轮修复等于
 * 没生效。把样板收进 hook，接线变成一行，且 hook 内部保证 ref 一定被更新——这个失误
 * 类型从机制上消失。
 *
 * 三个件的分工：
 * - `useReusedList`：列表派生，逐项复用（长度或内容变了，只有真变的项换新引用）；
 * - `useStableKeyedHandlers`：列表里每个 item 的回调引用保持稳定（源头解决，不用改子组件比较器）；
 * - `useLazyValue`：算起来贵、但只有交互那一刻才需要的结果（例如复制用的纯文本）。
 */

const sameDeps = (previous: readonly unknown[], next: readonly unknown[]): boolean => {
	if (previous === next) return true;
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index += 1) {
		if (!Object.is(previous[index], next[index])) return false;
	}
	return true;
};

/**
 * 列表派生 + 逐项引用复用。
 *
 * `deps` 变化时**总是重新调用 `factory`**（内容可能真的变了），然后把结果逐项与上一轮
 * 比对：内容等价的项换回旧引用，全部等价且长度相同时连数组本身一起复用。
 * 下游 `useMemo` / `memo` 因此能整层跳过。
 *
 * 什么时候用：派生结果是列表、下游有按项 memo 的组件、且源头每次都会新建对象
 * （典型形态：`build*` / `group*` 这类纯函数在 render 期跑）。
 *
 * 什么时候不能用：`isSame` 判不全时**会静默复用内容已变的项**——这比不复用危险得多
 * （表现为内容停在旧值且不报错）。判据必须覆盖每一项的所有展示字段。
 */
export function useReusedList<T>(factory: () => T[], deps: readonly unknown[], isSame: ItemSame<T>): T[] {
	const state = useRef<{ deps: readonly unknown[]; value: T[] } | undefined>(undefined);
	const current = state.current;
	if (current && sameDeps(current.deps, deps)) return current.value;
	const next = factory();
	const value = current ? reuseStructure(current.value, next, isSame) : next;
	state.current = { deps, value };
	return value;
}

/**
 * 惰性求值：返回一个**引用稳定**的取值函数，首次调用时才执行 `factory`。
 *
 * 为什么需要：`stripMarkdown` 这类转换需要处理整轮正文，而它的结果只在
 * 用户点「复制为文本」那一刻才用得上。挂在 `useMemo` 上等于流式期间每 50ms 对整轮正文
 * 跑一遍正则——测不出来（不报错、不掉帧那么明显），但确实是白烧的。
 *
 * 判断标准一句话：**如果这个值在 render 期算出来只为了「也许以后某个事件会用到」，
 * 就该走 useLazyValue 而不是 useMemo。** 反过来，值要参与 render 输出（布局、文本、
 * 条件渲染）时必须用 `useMemo`——惰性求值在那里只会让首帧多算一次。
 *
 * `deps` 变化时缓存失效（下次调用重算），这保证它不会读到陈旧数据。
 * 返回的函数引用稳定，可以安全地传给 memo 子组件的回调 prop。
 */
export function useLazyValue<T>(factory: () => T, deps: readonly unknown[]): () => T {
	type Cache = { deps: readonly unknown[]; computed: boolean; value: T | undefined };
	const cache = useRef<Cache>({ deps, computed: false, value: undefined });
	if (!sameDeps(cache.current.deps, deps)) cache.current = { deps, computed: false, value: undefined };
	// factory 每次渲染都是新的闭包（捕获最新的 props），放进 ref 由取值函数读取：
	// 这样取值函数本身可以保持稳定引用，不会因为 factory 换引用而击穿下游 memo。
	const factoryRef = useRef(factory);
	factoryRef.current = factory;
	return useCallback(() => {
		const entry = cache.current;
		if (!entry.computed) {
			entry.value = factoryRef.current();
			entry.computed = true;
		}
		return entry.value as T;
	}, []);
}

/**
 * 按键缓存稳定回调：`get(key)` 返回同一 key 的**同一个函数引用**。
 *
 * 解决的是「列表里每个 item 一个内联箭头」这个反复出现的失误类型：
 *
 * ```tsx
 * // ✗ 每次渲染都是新闭包 → 子组件 memo 全部失效（59 个组 = 59 次白渲染）
 * <Group onToggle={(open) => onToggleGroup(node.id, open)} />
 * // ✓ 同一 node.id 永远是同一个引用
 * <Group onToggle={getToggle(node.id)} />
 * ```
 *
 * 为什么不是「在子组件的比较器里忽略回调」：那只能救那一个组件，而且一旦回调真的
 * 捕获了变化的值就会被静默跳过（永远读到旧闭包）。这里的做法是让回调**行为跟着最新
 * props 走、引用保持不变**——两个目标同时满足，子组件用默认浅比较就够了。
 *
 * 使用约束（重要）：`factory` 里必须读 ref 或最新 props 来取行为，不能直接闭包捕获
 * 会在后续变化的值。第一次调用 `get(key)` 之后，这个 key 的回调就固定了，它只能通过
 * 你放进去的 ref 看到新状态。
 *
 * 缓存不淘汰：键是行 id，行集合由上游列表决定；列表整体换掉时组件通常随之重挂载。
 * 若同一个组件实例内 id 会无限增长（无界流），需要自行加淘汰。
 */
export function useStableKeyedHandlers<K, F extends (...args: never[]) => void>(factory: (key: K) => F): (key: K) => F {
	type Registry = Map<K, F>;
	const registry = useRef<Registry>(new Map());
	const factoryRef = useRef(factory);
	factoryRef.current = factory;
	return useCallback((key: K) => {
		const existing = registry.current.get(key);
		if (existing !== undefined) return existing;
		const created = factoryRef.current(key);
		registry.current.set(key, created);
		return created;
	}, []);
}
