import type { PiExtensionListResult, PiExtensionSummary } from "../../../shared/types";

export function ExtensionsTab(props: {
	data: PiExtensionListResult;
	loading: boolean;
	uninstallingSource: string | null;
	onRefresh: () => void;
	onUninstall: (extension: PiExtensionSummary) => void;
}) {
	return (
		<div className="extensions-tab">
			<div className="config-toolbar">
				<div>
					<span className="config-count">{props.data.extensions.length} 个扩展</span>
					<small className="skills-restart-hint">
						卸载后需要新建或重启 agent 才会生效
					</small>
				</div>
				<div className="skills-toolbar-actions">
					<button className="config-btn" onClick={props.onRefresh} disabled={props.loading}>
						刷新
					</button>
				</div>
			</div>

			<div className="skills-list">
				{props.data.extensions.length === 0 ? (
					<div className="config-empty">暂无已安装扩展。</div>
				) : (
					props.data.extensions.map((extension) => (
						<ExtensionCard
							key={extension.id}
							extension={extension}
							uninstalling={props.uninstallingSource === extension.source}
							onUninstall={props.onUninstall}
						/>
					))
				)}
			</div>
		</div>
	);
}

function ExtensionCard(props: {
	extension: PiExtensionSummary;
	uninstalling: boolean;
	onUninstall: (extension: PiExtensionSummary) => void;
}) {
	const { extension } = props;
	const name = extension.source.replace(/^(?:npm|file|github|git):/i, "");
	return (
		<article className="session-card skill-card extension-card">
			<div className="session-card-display">
				<div className="session-card-inner skill-card-main">
					<div className="session-card-title skill-title-row">
						<strong>{name}</strong>
						<div className="skill-badges">
							<span className="skill-state enabled">{extension.scope === "project" ? "项目" : "全局"}</span>
						</div>
					</div>
					<small>{extension.source}</small>
					{extension.path && <small>{extension.path}</small>}
				</div>
				<div className="session-card-actions skill-card-actions">
					<button
						className="session-rename-button danger"
						disabled={props.uninstalling}
						onClick={() => props.onUninstall(extension)}
					>
						{props.uninstalling ? "卸载中..." : "卸载"}
					</button>
				</div>
			</div>
		</article>
	);
}
