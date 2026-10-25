import { CodeMirrorEditor } from "../components/app/CodeMirrorEditor";
import { t } from "../i18n";
import { ConfigSelect } from "./ConfigShared";

// ── Raw Tab ─────────────────────────────────────────────

const RAW_FILE_OPTIONS = [
	{ value: "models.json", label: "models.json" },
	{ value: "auth.json", label: "auth.json" },
	{ value: "settings.json", label: "settings.json" },
	{ value: "trust.json", label: "trust.json" },
	{ value: "mcp.json", label: "mcp.json" },
];

export function RawTab(props: {
	fileName: string;
	content: string;
	saving: boolean;
	/** pi 全局配置目录（主进程 config:get-dir 返回），用于标注实际编辑位置；缺省时不显示路径行。 */
	configDir?: string;
	onChangeFileName: (name: string) => void;
	onChangeContent: (content: string) => void;
	onSave: () => void;
}) {
	// 与 DSH joinConfigPath 一致：去尾斜杠后拼接文件名（平台路径，避免 /\ 混用）。
	const rawFilePath = props.configDir ? `${props.configDir.replace(/[\\/]+$/, "")}/${props.fileName}` : "";
	return (
		<div className="config-raw-tab flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex shrink-0 items-center justify-between gap-3">
				<ConfigSelect value={props.fileName} options={RAW_FILE_OPTIONS} onChange={props.onChangeFileName} />
			</div>
			{/* 源文件都是 JSON：CodeMirror 提供语法高亮/折叠/括号匹配，JSON 语法错误即时提示（lint）。 */}
			<CodeMirrorEditor value={props.content} language="json" height="100%" onChange={props.onChangeContent} />
			{/* 编辑位置说明：标注当前文件在 pi 配置目录里的实际路径（随下拉切换），保存后由 pi 读取 */}
			<div className="flex shrink-0 flex-col gap-1 rounded-md border border-border-subtle bg-bg-panel px-3 py-2">
				{rawFilePath && (
					<div className="flex items-baseline gap-1.5 text-micro text-muted-foreground">
						<span className="shrink-0">{t("config.rawEditingAt")}</span>
						<span className="min-w-0 truncate font-mono text-foreground/80" title={rawFilePath}>
							{rawFilePath}
						</span>
					</div>
				)}
				<span className="text-micro text-muted-foreground">{t("config.rawHostReads")}</span>
			</div>
		</div>
	);
}
