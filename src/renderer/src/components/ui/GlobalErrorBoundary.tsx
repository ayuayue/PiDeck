import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../../i18n";

interface Props {
	children: ReactNode;
}

interface State {
	error: Error | null;
}

/**
 * 全局渲染错误边界。
 *
 * 背景:会话进行中,某条异常消息内容(超大文本、意外结构等)可能让 React 渲染抛错。
 * 之前整棵 App 没有错误边界,任意渲染异常都会卸载整棵树导致白屏,既无提示也无法恢复。
 * 这里在最外层捕获渲染异常,显示错误信息和「重载界面」按钮,避免纯白屏。
 *
 * 注意:错误边界只能捕获子组件渲染/生命周期中的异常,无法捕获事件回调或异步错误,
 * 因此它和白屏根因(全量 IPC 传输导致的 OOM)是互补关系——根因修复降低崩溃几率,
 * 边界保证万一崩溃时用户可见、可恢复。
 */
export class GlobalErrorBoundary extends Component<Props, State> {
	override state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		// 输出到控制台,便于用户反馈和排查触发崩溃的消息内容。
		console.error("[PiDeck] 全局渲染崩溃:", error, info.componentStack);
	}

	private handleReload = () => {
		this.setState({ error: null });
		// 重置 React 状态后重载,清掉导致崩溃的内存中的异常消息引用。
		window.location.reload();
	};

	private handleCopyError = () => {
		const { error } = this.state;
		if (!error) return;
		void navigator.clipboard.writeText(
			`${error.name}: ${error.message}\n\n${error.stack ?? ""}`,
		);
	};

	override render() {
		const { error } = this.state;
		if (!error) return this.props.children;
		return (
			<div className="global-error-boundary">
				<div className="global-error-card">
					<h1>{t("app.globalRenderCrashed")}</h1>
					<p>{t("app.globalRenderCrashedHelp")}</p>
					<pre className="global-error-detail">
						{error.stack ?? error.message}
					</pre>
					<div className="global-error-actions">
						<button
							type="button"
							className="global-error-primary"
							onClick={this.handleReload}
						>
							{t("app.globalRenderReload")}
						</button>
						<button type="button" onClick={this.handleCopyError}>
							{t("app.globalRenderCopyError")}
						</button>
					</div>
				</div>
			</div>
		);
	}
}
