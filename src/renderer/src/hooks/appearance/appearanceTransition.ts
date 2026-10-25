/**
 * View Transition 的最小宿主契约，便于把过渡策略与 React 生命周期拆开测试。
 */
interface AppearanceTransitionHost {
	readonly visibilityState: DocumentVisibilityState;
	startViewTransition?: (update: () => void) => Pick<ViewTransition, "ready">;
}

interface ApplyAppearanceWithTransitionOptions {
	host: AppearanceTransitionHost;
	apply: () => void;
	settingsLoaded: boolean;
	hasAppliedAuthoritativeAppearance: boolean;
	prefersReducedMotion: boolean;
}

/**
 * 应用外观，并仅在启动初始化完成、文档可见且用户允许动画时使用 View Transition。
 *
 * Chromium 在文档未激活、窗口尚未展示或另一过渡抢占时，会让 `ready` 以
 * "Transition was skipped" 拒绝；DOM 更新本身通常已经完成。这是动画降级而非业务
 * 错误，因此必须在调用边界消费该 rejection，不能泄漏到全局 unhandledrejection。
 */
export function applyAppearanceWithTransition(options: ApplyAppearanceWithTransitionOptions): void {
	const startViewTransition = options.host.startViewTransition;
	const shouldApplyDirectly = !options.settingsLoaded || !options.hasAppliedAuthoritativeAppearance || options.host.visibilityState !== "visible" || options.prefersReducedMotion || typeof startViewTransition !== "function";
	if (shouldApplyDirectly) {
		options.apply();
		return;
	}

	try {
		const transition = startViewTransition.call(options.host, options.apply);
		// `ready` 只描述动画能否开始；主题 DOM 更新由回调负责。跳过动画时静默降级，
		// 防止 Chromium 的预期拒绝触发全局「未处理异常」toast。
		void transition.ready.catch(() => undefined);
	} catch {
		// 极少数 Chromium 状态会同步拒绝启动过渡；此时回调尚未执行，直接应用主题。
		options.apply();
	}
}
