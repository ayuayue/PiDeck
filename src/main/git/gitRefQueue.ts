/**
 * 同一仓库「会写远程跟踪引用」的 git 操作（fetch / pull / push）串行化。
 *
 * 现场（#603）：Git 面板的自动 fetch（面板挂载后非静默刷新、每 5 分钟定时）与用户点「拉取」
 * 可以同时跑。两个进程都要更新 `refs/remotes/origin/<branch>`，后加锁的那个直接失败：
 * `error: cannot lock ref 'refs/remotes/origin/dev': is at … but expected …`，`git pull`
 * 在合并之前就退出，HEAD 不动——表现为「时好时坏，再点一次就好」。
 *
 * 进程内按 cwd 排队即可消掉面板自己制造的那一半竞态；外部 git（IDE / 终端）仍可能撞上，
 * 所以 pull 另有 `isRefLockError` 判定的一次重试：输家重跑时引用已被赢家更新到位。
 */

const queues = new Map<string, Promise<unknown>>();

/**
 * 串行执行同一 key（仓库 cwd）下的任务。
 *
 * 只排队，不传播前一笔的结果：前一个 fetch 失败不能连坐后面排队的 pull。
 * 队列排空后删除 key，避免「打开过的仓库」永久占内存。
 */
export function withRepoRefLock<T>(key: string, task: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	// 成功与失败都继续往下排（onRejected 位置传 task，等价于 finally 后接着跑）。
	const run = previous.then(task, task);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	queues.set(key, settled);
	void settled.then(() => {
		if (queues.get(key) === settled) queues.delete(key);
	});
	return run;
}

/** `cannot lock ref`：并发的另一个 fetch 先一步更新了同一引用；重跑一次即可成功。 */
export function isRefLockError(message: string): boolean {
	return /cannot lock ref/i.test(message);
}

/**
 * 外部 git（IDE / 终端）不受本进程串行化约束，仍可能抢先更新引用；
 * 命中 `cannot lock ref` 时重跑一次即可（此时引用已被对方更新到位）。其它错误直接上抛。
 */
export async function withRefLockRetry<T>(task: () => Promise<T>): Promise<T> {
	try {
		return await task();
	} catch (error) {
		if (!isRefLockError(error instanceof Error ? error.message : String(error))) throw error;
		return await task();
	}
}
