/**
 * 同一项目同一时刻只允许一条在途草稿创建（issue #481）。
 *
 * 引导页首发（App.ensureSessionForSend）与 Tab 栏「+」/ 侧栏「新建会话」
 * （App.createSessionDraftWithTab）是两条独立入口，都会为项目建 draft：
 * 「+」的创建要等一次 IPC 往返，这段窗口里引导页输入框仍然可发送，
 * 于是同一项目被建出两条会话——用户只写过其中一条，另一条就成了
 * Tab 栏里没内容、也点不出东西的空标签。
 *
 * 后到者复用先到者的结果（而不是返回 undefined 让用户以为点击没生效）：
 * 两条链路拿到同一条会话，选择与 Tab 登记都是幂等的。
 *
 * 只按 key 去重，不缓存已完成的结果：创建失败/成功后立刻放行，下一次
 * 新建仍是真的新建。
 */
export function createSessionOnce<T>(registry: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
	const pending = registry.get(key);
	if (pending) return pending;
	// Promise.resolve().then：create 同步抛错也收敛成 rejected promise，
	// 调用方 await 的契约不变（否则异常会从注册表写入前逃逸）。
	const promise = Promise.resolve()
		.then(create)
		.finally(() => {
			// 只删自己：先到者失败时后来者可能已覆盖同 key（重入路径），不能误删。
			if (registry.get(key) === promise) registry.delete(key);
		});
	registry.set(key, promise);
	return promise;
}
