import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

type AppErrorBoundaryProps = {
	children: ReactNode;
	/** 可选：局部边界标题，默认使用全局应用异常文案 */
	title?: string;
	/** 局部边界时提供重置回调，避免只能刷新整页 */
	onReset?: () => void;
};

type AppErrorBoundaryState = {
	error: Error | null;
};

/**
 * 全局/局部 React 错误边界。
 * 捕获子树渲染异常，避免整页白屏；同时通过 notice toast 提示用户。
 */
export class AppErrorBoundary extends Component<
	AppErrorBoundaryProps,
	AppErrorBoundaryState
> {
	override state: AppErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		// 渲染异常时 toast 提示；即使主界面损坏，也尽量让用户看到反馈。
		showNotice(
			`${t("app.renderErrorToast")}: ${error.message}`,
			6000,
			"error",
		);
		void window.piDesktop?.app
			.rendererLog("error", "renderer", "React render error boundary caught", {
				message: error.message,
				stack: error.stack,
				componentStack: info.componentStack,
			})
			.catch(() => undefined);
	}

	private handleReset = () => {
		this.setState({ error: null });
		this.props.onReset?.();
	};

	private handleReload = () => {
		window.location.reload();
	};

	override render() {
		if (!this.state.error) return this.props.children;

		const title = this.props.title ?? t("app.renderErrorTitle");
		const message = this.state.error.message || t("app.renderErrorUnknown");

		return (
			<div className="app-error-boundary" role="alert">
				<div className="app-error-boundary-card">
					<strong className="app-error-boundary-title">{title}</strong>
					<p className="app-error-boundary-message">{message}</p>
					<small className="app-error-boundary-help">
						{t("app.renderErrorHelp")}
					</small>
					<pre className="app-error-boundary-stack">
						{this.state.error.stack ?? this.state.error.message}
					</pre>
					<div className="app-error-boundary-actions">
						<button
							type="button"
							className="config-btn"
							onClick={this.handleReset}
						>
							{t("app.renderErrorRetry")}
						</button>
						<button
							type="button"
							className="config-btn primary"
							onClick={this.handleReload}
						>
							{t("app.renderErrorReload")}
						</button>
					</div>
				</div>
			</div>
		);
	}
}
