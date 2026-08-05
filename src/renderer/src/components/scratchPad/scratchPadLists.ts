export type ListNewline = { next: string; cursor: number };

const orderedListItem = /^(\s*)(\d+)(\.)(\s+)(.*)$/;

export function normalizeOrderedLists(value: string): string {
	const lines = value.split("\n");
	const nextByIndent = new Map<string, number>();

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const match = line.match(orderedListItem);
		if (match) {
			const [, indent, number, marker, spacing, content] = match;
			for (const key of nextByIndent.keys()) {
				if (key.length > indent.length) nextByIndent.delete(key);
			}
			const next = nextByIndent.get(indent) ?? Number(number);
			lines[index] = `${indent}${next}${marker}${spacing}${content}`;
			nextByIndent.set(indent, next + 1);
			continue;
		}

		/* 空行中断重编号链：空白之后的列表视为新列表，保留用户写的起始编号 */
		if (!line.trim()) {
			nextByIndent.clear();
			continue;
		}
		const indent = line.match(/^\s*/)?.[0] ?? "";
		for (const key of nextByIndent.keys()) {
			if (indent.length <= key.length) nextByIndent.delete(key);
		}
	}

	return lines.join("\n");
}

export function continueListOnNewline(value: string, selectionStart: number): ListNewline | null {
	const before = value.slice(0, selectionStart);
	const after = value.slice(selectionStart);
	const currentLine = before.slice(before.lastIndexOf("\n") + 1);

	const taskMatch = currentLine.match(/^(\s*[-*+]\s+\[[ xX]\])(?:\s+(.*))?$/);
	if (taskMatch) {
		const [, marker, content = ""] = taskMatch;
		if (!content.trim()) {
			const next = `${before.slice(0, before.length - currentLine.length).replace(/\n$/, "")}\n${after}`;
			return { next, cursor: next.length - after.length };
		}
		const prefix = `${marker} `;
		return { next: `${before}\n${prefix}${after}`, cursor: before.length + 1 + prefix.length };
	}

	const unorderedMatch = currentLine.match(/^(\s*)([-*+]) (.*)$/);
	if (unorderedMatch) {
		const [, indent, marker, content] = unorderedMatch;
		if (!content.trim()) {
			const next = `${before.slice(0, before.length - currentLine.length).replace(/\n$/, "")}\n${after}`;
			return { next, cursor: next.length - after.length };
		}
		const prefix = `${indent}${marker} `;
		return { next: `${before}\n${prefix}${after}`, cursor: before.length + 1 + prefix.length };
	}

	const orderedMatch = currentLine.match(orderedListItem);
	if (!orderedMatch) return null;
	const [, indent, number, marker, spacing, content] = orderedMatch;
	if (!content.trim()) {
		const next = normalizeOrderedLists(`${before.slice(0, before.length - currentLine.length).replace(/\n$/, "")}\n${after}`);
		return { next, cursor: next.length - after.length };
	}
	const prefix = `${indent}${Number(number) + 1}${marker}${spacing}`;
	const next = normalizeOrderedLists(`${before}\n${prefix}${after}`);
	return { next, cursor: before.length + 1 + prefix.length };
}

/* 预览专用：micromark 要求任务标记后必须有内容，纯标记行（如 `- [x]`）
   会被渲染成字面 `[x]`；补一个空格+零宽字符让它解析为空任务项，行数不变。 */
export function prepareTaskListPreview(value: string): string {
	return value.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\])\s*$/gm, "$1 \u200B");
}

export function toggleTaskCheckbox(value: string, lineIndex: number): string {
	const lines = value.split("\n");
	if (lineIndex < 0 || lineIndex >= lines.length) return value;
	const line = lines[lineIndex];
	if (!/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line)) return value;
	lines[lineIndex] = line.replace(/\[([ xX])\]/, (_, mark: string) => mark.trim() ? "[ ]" : "[x]");
	return lines.join("\n");
}
