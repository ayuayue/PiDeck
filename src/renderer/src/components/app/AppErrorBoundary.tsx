import { Button } from "../ui-shadcn/button";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { LogoMark } from "../app/AppParts";
import { t } from "../../i18n";
import { isLanWeb } from "../../desktopApi";
import { showNotice } from "../../utils/notice";
import { StackTrace } from "../ui-shadcn/stack-trace";
import { CRASH_AUTO_RELOAD_KEY, computeCrashReloadPlan } from "../../utils/autoReloadPolicy";
import { AutoReloadTimer } from "../../utils/crashAutoReloadTimer";

type AppErrorBoundaryProps = {
	children: ReactNode;
	/** 可选：局部边界标题，默认使用全局应用异常文案 */
	title?: string;
	/** 局部边界时提供重置回调，避免只能刷新整页 */
	onReset?: () => void;
};

type AppErrorBoundaryState = {
	error: Error | null;
	/** 自动刷新倒计时（秒）；null = 未在自动刷新 */
	autoReloadSeconds: number | null;
	/** 自动刷新已连续失败达到上限，停止自动刷新（仅提示，需用户手动操作） */
	autoReloadExhausted: boolean;
};

/** 自动刷新倒计时秒数：给用户留出看错误信息/手动操作的缓冲，太短来不及反应。 */
const AUTO_RELOAD_SECONDS = 5;

/**
 * 全局/局部 React 错误边界。
 * 捕获子树渲染异常，避免整页白屏；同时通过 notice toast 提示用户。
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
	override state: AppErrorBoundaryState = {
		error: null,
		autoReloadSeconds: null,
		autoReloadExhausted: false,
	};

	/**
	 * 自动刷新倒计时 timer。
	 * 注意：不能在 componentDidCatch 里创建后就不再管——React 19 StrictMode（dev）
	 * 下 error fallback 会 double-mount（mount→unmount→remount），伪卸载时
	 * componentWillUnmount 会 stop 掉它，而 componentDidCatch 只在错误提交时调用
	 * 一次不会重建，表现为文案停在 5 秒不递减。componentDidMount 里的 ensure()
	 * 负责在 remount 后按 state 兜底重建（正常挂载/用户取消后不会误启动）。
	 */
	private readonly autoReloadTimer = new AutoReloadTimer({
		onTick: (remaining) => this.setState({ autoReloadSeconds: remaining }),
		onDone: () => {
			this.setState({ autoReloadSeconds: null });
			// 刷新后若仍崩溃会再次进入边界并累计计数，达到上限即停止。
			window.location.reload();
		},
	});

	override componentDidMount() {
		// StrictMode remount 兜底：见 autoReloadTimer 字段注释。
		// 初次挂载（无 error）或局部边界（scheduleAutoReload 已直接返回、
		// autoReloadSeconds 仍为 null）时 ensure 不会启动 timer。
		if (this.state.error) {
			this.autoReloadTimer.ensure(this.state.autoReloadSeconds ?? AUTO_RELOAD_SECONDS);
		}
	}

	override componentWillUnmount() {
		this.autoReloadTimer.stop();
	}

	static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
		// 返回完整 state：倒计时/已耗尽标志由 componentDidCatch 里的 scheduleAutoReload
		// 在提交后设置（getDerivedStateFromError 阶段不读 sessionStorage）。
		return { error, autoReloadSeconds: null, autoReloadExhausted: false };
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		// 渲染异常时 toast 提示；即使主界面损坏，也尽量让用户看到反馈。
		showNotice(`${t("app.renderErrorToast")}: ${error.message}`, 6000, "error");
		void window.piDesktop?.app
			.rendererLog("error", "renderer", "React render error boundary caught", {
				message: error.message,
				stack: error.stack,
				componentStack: info.componentStack,
			})
			.catch(() => undefined);
		// 崩溃后自动尝试刷新页面；连续失败（短时间窗口内累计）则停止，避免死循环。
		this.scheduleAutoReload();
	}

	/**
	 * 崩溃自动刷新：读 sessionStorage 计数（刷新后仍保留，同一窗口内共享），
	 * 时间窗口内累计崩溃次数，≤3 次时倒计时后自动刷新；超过上限停止自动刷新
	 * （已证明刷新不可行，改由用户手动操作）。局部边界（有 onReset）不自动
	 * 整页刷新——宿主负责局部恢复，整页重载会打断用户正在进行的编辑。
	 */
	private scheduleAutoReload = () => {
		if (this.props.onReset) return;

		let stored: { count: number; at: number } | null = null;
		try {
			const raw = window.sessionStorage.getItem(CRASH_AUTO_RELOAD_KEY);
			if (raw) {
				const parsed = JSON.parse(raw) as { count?: unknown; at?: unknown };
				if (typeof parsed.count === "number" && typeof parsed.at === "number") {
					stored = { count: parsed.count, at: parsed.at };
				}
			}
		} catch {
			// sessionStorage 不可用（隐私模式等）：按首次崩溃处理，仍允许自动刷新。
			stored = null;
		}

		const plan = computeCrashReloadPlan({ stored, now: Date.now() });
		try {
			window.sessionStorage.setItem(CRASH_AUTO_RELOAD_KEY, JSON.stringify({ count: plan.count, at: Date.now() }));
		} catch {
			// 写入失败不影响本次展示；下次崩溃重新计数（最多再多自动刷新一轮）。
		}

		if (!plan.shouldAutoReload) {
			// 已连续自动刷新 3 次仍崩溃：停止倒计时，提示用户手动刷新/退出。
			this.setState({ autoReloadExhausted: true });
			return;
		}

		this.setState({ autoReloadSeconds: AUTO_RELOAD_SECONDS });
		// 崩溃次数登记（上面 sessionStorage 写入）只在此处执行一次；timer 的
		// 生命周期交给 autoReloadTimer（start 内部先 stop 再重启），StrictMode
		// remount 后的重建由 componentDidMount 的 ensure 兜底。
		this.autoReloadTimer.start(AUTO_RELOAD_SECONDS);
	};

	/** 用户取消自动刷新：停止倒计时，保留崩溃页供手动操作。 */
	private handleCancelAutoReload = () => {
		this.autoReloadTimer.stop();
		this.setState({ autoReloadSeconds: null });
	};

	private handleReset = () => {
		// 重置边界时同步停止自动刷新：若重试即恢复，不能再被旧定时器整页刷新。
		this.autoReloadTimer.stop();
		this.setState({ error: null, autoReloadSeconds: null, autoReloadExhausted: false });
		this.props.onReset?.();
	};

	private handleReload = () => {
		window.location.reload();
	};

	private handleQuit = () => {
		// 全局边界会整页替换 App，自定义标题栏随之卸载；无框窗口若只留「重试/刷新」，
		// 用户无法退出。必须走 app.quit 而不是 closeWindow：开启 closeToTray 时关窗只会隐藏，
		// 崩溃页再藏起来就退不掉。preload 缺失时静默跳过，避免再抛一层。
		void window.piDesktop?.app.quit().catch(() => undefined);
	};

	override render() {
		if (!this.state.error) return this.props.children;

		const title = this.props.title ?? t("app.renderErrorTitle");
		const message = this.state.error.message || t("app.renderErrorUnknown");
		// LAN Web / 无 preload：浏览器自己有标签栏，desktopApi.quit 也不是真进程退出。
		const canQuitApp = Boolean(window.piDesktop) && !isLanWeb;

		return (
			<div className="app-error-boundary" role="alert">
				<div className="app-error-boundary-card">
					<div className="app-error-boundary-brand">
						<LogoMark />
					</div>
					<div className="app-error-boundary-badge">
						<span className="app-error-boundary-dot" aria-hidden="true" />
						{t("app.renderErrorToast")}
					</div>
					<h1 className="app-error-boundary-title">{title}</h1>
					<p className="app-error-boundary-message">{message}</p>
					<div className="app-error-boundary-stack">
						<div className="mb-1 text-caption font-medium text-text-secondary">{t("app.renderErrorStack")}</div>
						<StackTrace trace={this.state.error.stack ?? this.state.error.message} defaultOpen />
					</div>
					<div className="app-error-boundary-actions">
						<Button type="button" variant="outline" onClick={this.handleReset}>
							{t("app.renderErrorRetry")}
						</Button>
						<Button type="button" variant="default" onClick={this.handleReload}>
							{t("app.renderErrorReload")}
						</Button>
						{canQuitApp ? (
							<Button type="button" variant="outline" onClick={this.handleQuit}>
								{t("app.quit")}
							</Button>
						) : null}
					</div>
					{/* 自动刷新状态提示：倒计时中 / 已多次失败停止（用户可见文案走 i18n） */}
					{this.state.autoReloadSeconds != null && (
						<div className="app-error-boundary-autoreload">
							<span>
								{t("app.renderErrorAutoReload", {
									seconds: this.state.autoReloadSeconds,
								})}
							</span>
							<Button type="button" variant="ghost" size="sm" className="app-error-boundary-autoreload-cancel" onClick={this.handleCancelAutoReload}>
								{t("app.renderErrorAutoReloadCancel")}
							</Button>
						</div>
					)}
					{this.state.autoReloadExhausted && (
						<div className="app-error-boundary-autoreload">
							<span>{t("app.renderErrorAutoReloadExhausted")}</span>
						</div>
					)}
					<small className="app-error-boundary-help">{t("app.renderErrorHelp")}</small>
				</div>
			</div>
		);
	}
}
