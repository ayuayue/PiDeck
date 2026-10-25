/**
 * Composer mention 原子节点：@file / /skill|/cmd / &session。
 * 渲染为与旧 RichInput 一致的 .input-chip 外观；不可编辑内部。
 */

import { mergeAttributes, Node } from "@tiptap/core";
import type { ComposerChip } from "../chips";
import { formatChipDisplayLabel, isDirectoryFileChip, stripChipDisplayPrefix } from "../chips";
import { chipIconDomSpec } from "../chipIcons";

export type MentionChipAttrs = {
	kind: ComposerChip["kind"];
	raw: string;
	label: string;
};

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		mentionChip: {
			insertMentionChip: (attrs: MentionChipAttrs) => ReturnType;
		};
	}
}

export const MentionChip = Node.create({
	name: "mentionChip",
	group: "inline",
	inline: true,
	atom: true,
	selectable: true,
	draggable: false,

	addAttributes() {
		return {
			kind: { default: "file" as ComposerChip["kind"] },
			raw: { default: "" },
			label: { default: "" },
		};
	},

	parseHTML() {
		return [
			{
				// 兼容两种形态：旧 chip（span.input-chip[data-raw]）与新普通文本引用
				// （span[data-raw][data-type]）——历史记录 load 回编辑器时都能重建原子节点。
				tag: "span[data-raw][data-type]",
				getAttrs: (el) => {
					if (!(el instanceof HTMLElement)) return false;
					const kind = el.getAttribute("data-type");
					const raw = el.getAttribute("data-raw");
					if (!raw || (kind !== "file" && kind !== "skill" && kind !== "session" && kind !== "quote")) {
						return false;
					}
					return {
						kind,
						raw,
						// 只按类型剥前缀（file 的 @、skill 的 /skill:）；统一剥 [@/&❝]
						// 会把引用内容自身的 / & ❝ 吃掉。
						label: stripChipDisplayPrefix(kind, el.textContent?.trim() ?? "") || raw.slice(1),
					};
				},
			},
		];
	},

	renderHTML({ node, HTMLAttributes }) {
		// 收窄 kind 到合法枚举：attrs 来自编辑器插入/历史解析，防御性回退 file
		const rawKind = node.attrs.kind;
		const kind: ComposerChip["kind"] = rawKind === "skill" || rawKind === "session" || rawKind === "quote" ? rawKind : "file";
		const raw = String(node.attrs.raw ?? "");
		const label = String(node.attrs.label ?? raw);
		// 目录引用用文件夹图标（Proma `.directory-mention-chip` 同款区分）。
		const isDirectoryRef = isDirectoryFileChip(raw);
		// chip 外观（2026-09 对齐 Proma）：类型色浅底 + 同色文字 + 12px currentColor 图标，
		// 无边框。保留 data-raw/data-type 与 contenteditable=false——点击定位
		// （closest [data-raw]）与内容再解析都依赖它们。
		// 单行截断由 timeline.css 的共用骨架统一管理，不在节点上写内联样式，
		// 否则输入框与气泡两边会逐渐不一致。
		return [
			"span",
			mergeAttributes(HTMLAttributes, {
				class: `input-chip input-chip--${kind}`,
				"data-type": kind,
				"data-raw": raw,
				contenteditable: "false",
				title: raw,
			}),
			chipIconDomSpec(kind, { isDirectory: isDirectoryRef }),
			// 展示文本与气泡侧同源（formatChipDisplayLabel）：只 file 保留 @，
			// 其余交给图标表达；attrs.label 保持纯文本，重建后统一推导展示文本。
			["span", { class: "input-chip__label" }, formatChipDisplayLabel(kind, label)],
		];
	},

	addCommands() {
		return {
			insertMentionChip:
				(attrs) =>
				({ commands }) =>
					commands.insertContent({
						type: this.name,
						attrs,
					}),
		};
	},
});
