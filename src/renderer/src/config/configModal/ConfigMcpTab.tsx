import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { t } from "../../i18n";
import { McpTab, type McpTabHandle } from "../McpTab";
import { RawTab } from "../RawTab";
import { RemoteConfigPanel } from "../RemoteConfigPanel";
import { WslConfigSourceHint } from "../WslConfigSourceHint";
import type { WslConfigTargetHost } from "../piConfigTargetModel";

export type ConfigMcpTabProps = {
	/** ssh 目标的主机 id：非空时整页换成远端 patch 面板。 */
	remoteTargetHostId: string | null;
	remoteHostLabel: string | undefined;
	onRemoteDirtyChange: (dirty: boolean) => void;
	/** WSL 目标：按文件编辑该发行版的 mcp.json（探测/登录/模板仍只在本机执行）。 */
	wslTargetHost: WslConfigTargetHost | undefined;
	statusBlock: ReactNode;
	configDiagnosticBlock: ReactNode;
	loading: boolean;
	saving: boolean;
	/** WSL 目标的 mcp.json 文本草稿（本机目标由 McpTab 自己维护）。 */
	wslMcpRaw: string;
	setWslMcpRaw: Dispatch<SetStateAction<string>>;
	markDirty: (tabKey: string) => void;
	onSaveWslMcp: () => Promise<boolean>;
	/** 全局 MCP 页：导入扫描的项目来源 + 句柄（顶部统一保存经 saveByKey 转发）。 */
	projectId: string | undefined;
	mcpTabRef: RefObject<McpTabHandle | null>;
	onGoToExtensions: () => void;
	onDirtyChange: (dirty: boolean) => void;
};

/**
 * MCP 页内容（`config:mcp` TabsContent 整块）：ssh 远端面板 / WSL 文本编辑 / 本机 McpTab 三选一。
 * forceMount 由调用方的 TabsContent 负责（面板自管草稿，切走再回来不能丢未保存编辑）。
 */
export function ConfigMcpTab({ remoteTargetHostId, remoteHostLabel, onRemoteDirtyChange, wslTargetHost, statusBlock, configDiagnosticBlock, loading, saving, wslMcpRaw, setWslMcpRaw, markDirty, onSaveWslMcp, projectId, mcpTabRef, onGoToExtensions, onDirtyChange }: ConfigMcpTabProps) {
	return (
		<div className="config-content flex min-h-0 flex-col">
			{remoteTargetHostId ? (
				<RemoteConfigPanel key={"remote-mcp-" + remoteTargetHostId} file="mcp" hostId={remoteTargetHostId} hostLabel={remoteHostLabel} onDirtyChange={onRemoteDirtyChange} />
			) : wslTargetHost ? (
				<>
					{/* WSL：探测/登录/模板仍只在本机执行，这里按文件编辑该发行版的 mcp.json */}
					<WslConfigSourceHint host={wslTargetHost} file="mcp" />
					<div className="mb-2 flex flex-col gap-0.5">
						<span className="text-control font-medium">{t("config.env.mcpFileTitle")}</span>
						<span className="text-micro leading-relaxed text-muted-foreground">{t("config.env.mcpFileHint")}</span>
					</div>
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && (
						<RawTab
							fileName="mcp.json"
							content={wslMcpRaw}
							saving={saving}
							showFileSelector={false}
							onChangeFileName={() => undefined}
							onChangeContent={(value) => {
								setWslMcpRaw(value);
								markDirty("config:mcp");
							}}
							onSave={onSaveWslMcp}
						/>
					)}
				</>
			) : (
				<>
					{/* 全局作用域：activeProjectId 只作导入扫描的项目来源，配置仍写全局 mcp.json。 */}
					<McpTab ref={mcpTabRef} activeProjectId={projectId} onGoToExtensions={onGoToExtensions} onDirtyChange={onDirtyChange} />
				</>
			)}
		</div>
	);
}
