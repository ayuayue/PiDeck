import { useMemo } from "react";
import { unzipSync } from "fflate";
import { formatBytes } from "../../../../../shared/formatBytes";
import { t } from "../../../i18n";

type ZipEntry = {
	name: string;
	size: number;
	compressedSize: number;
	dir: boolean;
};

type ParsedArchive = {
	entries: ZipEntry[];
	totalSize: number;
	error: string | null;
};

/**
 * ZIP 只读预览：只列条目（名称/原始大小），不解压内容。
 *
 * fflate 的 filter 在 inflate 之前逐条回调，返回 false 即跳过解压——相当于拿
 * 中央目录做列表，几百 MB 的包也不会把全部条目解进内存。
 */
export default function ArchivePreview(props: { bytes: Uint8Array }) {
	const parsed = useMemo<ParsedArchive>(() => {
		try {
			const entries: ZipEntry[] = [];
			unzipSync(props.bytes, {
				filter: (file) => {
					entries.push({
						name: file.name,
						size: file.originalSize ?? file.size,
						compressedSize: file.size,
						dir: file.name.endsWith("/"),
					});
					return false;
				},
			});
			entries.sort((a, b) => {
				if (a.dir !== b.dir) return a.dir ? -1 : 1;
				return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
			});
			const totalSize = entries.reduce((sum, entry) => (entry.dir ? sum : sum + entry.size), 0);
			return { entries, totalSize, error: null };
		} catch (e) {
			return {
				entries: [],
				totalSize: 0,
				error: e instanceof Error ? e.message : String(e),
			};
		}
	}, [props.bytes]);

	if (parsed.error) return <div className="file-diff-error">{t("editor.previewFailed", { error: parsed.error })}</div>;
	if (parsed.entries.length === 0) return <div className="file-diff-error">{t("editor.archiveEmpty")}</div>;

	const fileCount = parsed.entries.reduce((count, entry) => (entry.dir ? count : count + 1), 0);
	return (
		<div className="flex h-full w-full flex-col overflow-hidden">
			<div className="shrink-0 border-b border-border px-3 py-1.5 text-caption text-muted-foreground">
				{t("editor.archiveSummary", {
					count: fileCount,
					size: formatBytes(parsed.totalSize),
				})}
			</div>
			{/* scroll-ok: bounded —— 归档条目来自单个预览文件，条目数受预览大小上限约束，行数不随数据量无限增长。 */}
			<div className="min-h-0 flex-1 overflow-auto py-1">
				<ul>
					{parsed.entries.map((entry, index) => (
						<li key={`${entry.name}:${index}`} className="flex items-center gap-2 px-3 py-0.5 text-caption hover:bg-muted/40">
							<span className={`min-w-0 flex-1 truncate ${entry.dir ? "text-foreground" : "text-text-secondary"}`} title={entry.name}>
								{entry.name}
							</span>
							{!entry.dir && <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(entry.size)}</span>}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}
