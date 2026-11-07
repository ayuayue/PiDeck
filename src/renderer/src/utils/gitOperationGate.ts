/**
 * Git 面板状态机的四条公共规则（W5 / 第三批 C 片）。
 *
 * 本地 `GitPanel` 与远端 `remoteGitViewState` / `remoteGitStatusPolling` 各自带着一套等价但各写一遍的
 * 簿记：请求序号、单飞标记、unknown 写后的持续告警。重复实现的问题是它们会**分叉**——一边加了「取消后
 * 不发布」，另一边忘了；一边的 unknown 能被一次失败读清掉，另一边不能。这里只抽这四条规则：
 *
 * 1. **取消**：`retire()` 换一代并清在途读；在途结果拿旧令牌一律作废（卸载/断开/换仓库/收起）。
 * 2. **互斥**：同一时刻只允许一个写（`beginWrite`，写者在途由消费者自己的标志回答，闸门不另存一份）；
 *    读可选「不重叠」（`beginRead({ exclusive: true })`，静默轮询用，避免与前一个 status 请求重叠）。
 * 3. **unknown**：写结果未知时记下稳定码，绝不重放；只有**一次成功的事实读**（`resolveUnknown`）
 *    才能解除，失败读/断开都不算。
 * 4. **迟到读**：读者用 `isCurrent(token)` 判断自己是否仍代表现状；代数在每次读/写/退休时前进。
 *
 * 这里刻意不包含任何 Git 语义（不认仓库、不认能力、不装载）：它只回答“这次结果还算不算数”。
 * 历史/比较/信任/初始化/同步等区块的授权语义不同，继续各管各的，不塞进这个闸门。
 */

export type GitReadToken = number;
export type GitWriteToken = number;

export type GitOperationGateOptions = {
	/**
	 * 写者在途判定：**由消费者回答**（本地面板是 mutation ref，远端是它的 `mutating` 状态）。
	 * 闸门不缓存这份状态，因此没有“忘了 endWrite 就永久锁死”的失败模式。
	 */
	isWriting?: () => boolean;
};

export type GitOperationGate = {
	/** 当前代数：每次读/写/退休都会前进。 */
	current(): number;
	/**
	 * 开一次读：返回令牌用于 `isCurrent`。
	 * `exclusive` 时若已有读在途则返回 undefined（静默轮询的「不重叠」）。
	 */
	beginRead(options?: { exclusive?: boolean }): GitReadToken | undefined;
	/** 一次读结束（成功/失败都算）。只影响「在途读」计数，不会让令牌失效。 */
	endRead(): void;
	/** 取消所有在途读并换一代：旧令牌之后的发布全部作废。 */
	retire(): number;
	/** 迟到读判定：令牌仍是当前代才允许发布。 */
	isCurrent(token: GitReadToken): boolean;
	/** 开一次写：已有写在途时返回 undefined（互斥）。写开始即让在途读结果作废。 */
	beginWrite(): GitWriteToken | undefined;
	/** 是否有写在途（消费者标志或闸门自己的判定）。 */
	writing(): boolean;
	/** 写结果未知：记下稳定码；只有成功的事实读能解除。 */
	markUnknown(code: string): void;
	/** 一次成功的事实读解除了不确定状态。 */
	resolveUnknown(): void;
	/** 当前的不确定写稳定码（undefined = 没有待确认的写）。 */
	unknownCode(): string | undefined;
};

export function createGitOperationGate(options: GitOperationGateOptions = {}): GitOperationGate {
	let generation = 0;
	let readsInFlight = 0;
	let unknown: string | undefined;
	return {
		current: () => generation,
		beginRead(beginOptions) {
			// exclusive = 「不重叠」：已在途就这拍不读，等下一次触发（静默轮询）。
			if (beginOptions?.exclusive === true && readsInFlight > 0) return undefined;
			generation += 1;
			readsInFlight += 1;
			return generation;
		},
		endRead() {
			readsInFlight = Math.max(0, readsInFlight - 1);
		},
		retire() {
			generation += 1;
			readsInFlight = 0;
			return generation;
		},
		isCurrent: (token) => token === generation,
		beginWrite() {
			if (options.isWriting?.() === true) return undefined;
			// 写会改变事实：在途读的结果不再代表现状。
			generation += 1;
			return generation;
		},
		writing: () => options.isWriting?.() === true,
		markUnknown(code) {
			unknown = code;
		},
		resolveUnknown() {
			unknown = undefined;
		},
		unknownCode: () => unknown,
	};
}
