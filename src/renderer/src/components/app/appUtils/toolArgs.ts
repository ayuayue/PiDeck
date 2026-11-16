/**
 * 从 AppUtils 拆出的「工具参数解析」域：文件路径、写入内容、edit/patch 差异与改动行数。
 * 纯函数，无依赖；被 TimelineFormat / ToolCallComponents / session-outline-atoms 复用。
 */

/* ── 工具参数 ── */

export function getToolFilePath(args: unknown): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try {
			args = JSON.parse(args);
		} catch {
			return undefined;
		}
	}
	if (typeof args !== "object") return undefined;
	const a = args as Record<string, unknown>;
	return typeof a.filePath === "string" && a.filePath
		? a.filePath
		: typeof a.file_path === "string" && a.file_path
			? a.file_path
			: typeof a.path === "string" && a.path
				? a.path
				: typeof a.targetPath === "string" && a.targetPath
					? a.targetPath
					: typeof a.target_path === "string" && a.target_path
						? a.target_path
						: typeof a.outputPath === "string" && a.outputPath
							? a.outputPath
							: typeof a.output_path === "string" && a.output_path
								? a.output_path
								: typeof a.file === "string" && a.file
									? a.file
									: typeof a.fileName === "string" && a.fileName
										? a.fileName
										: typeof a.filename === "string" && a.filename
											? a.filename
											: undefined;
}

export function countTextLines(value: string): number {
	return value ? value.split(/\r\n|\r|\n/).length : 0;
}

export function getToolEditDiff(args: Record<string, unknown>): { oldText: string; newText: string } | undefined {
	const edits = Array.isArray(args.edits) ? args.edits : undefined;
	if (edits) {
		const parts = edits
			.map((edit: unknown) => {
				if (!edit || typeof edit !== "object") return null;
				const e = edit as Record<string, unknown>;
				const oldText = String(e.oldText ?? e.old_text ?? e.old_string ?? "");
				const newText = String(e.newText ?? e.new_text ?? e.new_string ?? "");
				return { oldText, newText };
			})
			.filter((p): p is { oldText: string; newText: string } => p !== null);
		if (parts.length === 0) return undefined;
		return {
			oldText: parts.map((p) => p.oldText).join("\n"),
			newText: parts.map((p) => p.newText).join("\n"),
		};
	}
	const oldText = typeof args.oldText === "string" ? args.oldText : typeof args.old_text === "string" ? args.old_text : typeof args.old_string === "string" ? args.old_string : undefined;
	const newText = typeof args.newText === "string" ? args.newText : typeof args.new_text === "string" ? args.new_text : typeof args.new_string === "string" ? args.new_string : undefined;
	if (oldText === undefined || newText === undefined) return undefined;
	return { oldText, newText };
}

export function getToolNewContent(toolName: string, args: string | Record<string, unknown>): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try {
			// JSON.parse 返回 any；这里立刻收窄为参数对象，后续按字段 typeof 判定
			args = JSON.parse(args) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}
	if (!toolName) return undefined;
	if (typeof args !== "object") return undefined;
	if (/write|create/i.test(toolName)) {
		const a = args as Record<string, unknown>;
		return typeof a.content === "string" ? a.content : typeof a.text === "string" ? a.text : typeof a.data === "string" ? a.data : typeof a.body === "string" ? a.body : undefined;
	}
	if (/edit|patch/i.test(toolName)) {
		const diff = getToolEditDiff(args);
		return diff?.newText;
	}
	return undefined;
}

export function getToolChangedLineCount(toolName: string, args: string | Record<string, unknown>): number {
	if (typeof args === "string" && args.trim()) {
		try {
			args = JSON.parse(args) as Record<string, unknown>;
		} catch {
			return 0;
		}
	}
	if (!toolName) return 0;
	if (typeof args !== "object") return 0; // 空串入参：无内容可数，与原 String(undefined ?? "") 等价
	if (/edit|patch/i.test(toolName)) {
		const edits = Array.isArray(args?.edits) ? (args.edits as Array<Record<string, unknown>>) : undefined;
		if (edits) {
			return edits.reduce((total: number, edit) => {
				const oldLines = countTextLines(String(edit?.oldText ?? edit?.old_text ?? ""));
				const newLines = countTextLines(String(edit?.newText ?? edit?.new_text ?? ""));
				return total + Math.max(oldLines, newLines);
			}, 0);
		}
		return Math.max(countTextLines(String(args?.oldText ?? args?.old_text ?? "")), countTextLines(String(args?.newText ?? args?.new_text ?? "")));
	}
	if (/write|create/i.test(toolName)) {
		return countTextLines(String(args?.content ?? args?.text ?? args?.data ?? args?.body ?? ""));
	}
	return 0;
}
