/**
 * 引用 chip 图标：4 类引用（file / skill / session / quote）的 SVG path 数据。
 *
 * 为什么不用 lucide-react 组件：
 * - TipTap 的 renderHTML 是纯 HTML 模板（非 React 渲染），无法直接放组件；
 * - 输入框（mentionChip）与消息气泡（SurfaceComponents）必须视觉一致。
 * 所以这里抽一份 lucide 同款 path 数据，输入框侧拼 ProseMirror DOM 规范，
 * 气泡侧可直接用 lucide-react 同名组件——两侧同 path 同 stroke 参数，逐像素一致。
 *
 * path 数据取自 node_modules/lucide-react/dist/esm/icons/{quote,sparkles,file-text,message-square}.mjs
 * （lucide-react v1.17.0，stroke 线性图标，viewBox 0 0 24 24）。升级 lucide 后若图标
 * 变更，需同步更新这里的 path。
 */

import type { ComposerChip } from "./chips";
import type { DOMOutputSpec } from "prosemirror-model";

/** lucide 图标 path 的 d 数据（FileText / Sparkles / MessageSquare / Quote / Folder）。
 * folder 是目录引用专用（对齐 Proma 的 `.directory-mention-chip`）。 */
export const CHIP_ICON_PATHS: Record<ComposerChip["kind"] | "folder", string[]> = {
	// lucide FileText
	file: ["M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z", "M14 2v5a1 1 0 0 0 1 1h5", "M10 9H8", "M16 13H8", "M16 17H8"],
	// lucide Sparkles
	skill: ["M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z", "M20 2v4", "M22 4h-4"],
	// lucide MessageSquare
	session: ["M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"],
	// lucide Quote
	quote: ["M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z", "M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"],
	// lucide Folder
	folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
};

/**
 * 拼出 ProseMirror renderHTML 的 DOM 规范：行内 svg 图标（含全部 path 子元素）。
 * 尺寸固定 12px（Proma 规格），颜色继承文字色（currentColor）。
 * options.isDirectory：文件引用指向目录时换成文件夹图标。
 *
 * tagName 必须写成 `"<命名空间 URI> svg"`：ProseMirror 的 renderSpec 只在 tag 含空格时
 * 才走 createElementNS（见 prosemirror-model renderSpec），否则 `createElement("svg")`
 * 会建出 HTML 命名空间的伪 svg，内部 path 同样不是 SVG 元素 → 图标完全不渲染。
 * 输入框 chip 曾因此一直丢失图标（旧版靠 @ / & ❝ 文字前缀掩盖了这个问题）。
 */
export function chipIconDomSpec(kind: ComposerChip["kind"], options?: { isDirectory?: boolean }): DOMOutputSpec {
	const iconKey = options?.isDirectory && kind === "file" ? "folder" : kind;
	return [
		"http://www.w3.org/2000/svg svg",
		{
			class: "input-chip__icon",
			viewBox: "0 0 24 24",
			width: "12px",
			height: "12px",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"aria-hidden": "true",
		},
		...CHIP_ICON_PATHS[iconKey].map((d) => ["path", { d }] as const),
	];
}
