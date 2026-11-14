/**
 * 从 AppUtils 拆出的「文件树拖拽负载」域：写侧/读侧共用的 MIME 与负载形状。
 * 与 AppParts.tsx 分离的原因见 AppUtils 的 barrel 头注释（Fast Refresh 只支持组件/hook 导出）。
 */

import type { FileTreeNode } from "../../../../../shared/types";
import type { ProjectFileTarget } from "../../../../../shared/types/project";
import { formatFilePathRef } from "../../session/composer/chips";

/* ── 文件树拖拽负载 ── */

/**
 * 文件树行拖拽时写入 dataTransfer 的两个 MIME：
 * - PI_FILE_PATH_DRAG_MIME：纯绝对路径，供「移动到目录」落点使用（历史约定，勿改名）。
 * - PI_FILE_NODE_DRAG_MIME：完整节点 JSON，composer 落点据此生成 @ 引用（区分文件/目录）。
 */
export const PI_FILE_PATH_DRAG_MIME = "text/pi-file-path";
export const PI_FILE_NODE_DRAG_MIME = "application/x-pi-file-node";

export interface FileNodeDragPayload {
	/** 本机绝对路径：**只有真有本机位置的节点才有**（远端节点不该伪造这个字段）。 */
	path?: string;
	relativePath: string;
	type: "file" | "directory";
	/** 项目作用域身份：跨位置通用的打开凭据，远端拖拽只靠它。 */
	target?: ProjectFileTarget;
}

/** 拖拽开始侧：把节点信息写入 dataTransfer（项目作用域 JSON + 仅有本机路径时的纯路径通道） */
export function writeFileNodeDragPayload(dataTransfer: DataTransfer, node: FileTreeNode): void {
	// 纯路径通道只在本机节点写：远端节点没有本机绝对路径，拿 displayPath 充数会让
	// 落点以为是本机文件（拖进终端/上传会把一个不存在的路径发下去）。
	if (node.path !== undefined) dataTransfer.setData(PI_FILE_PATH_DRAG_MIME, node.path);
	const payload: FileNodeDragPayload = {
		...(node.path === undefined ? {} : { path: node.path }),
		relativePath: node.relativePath,
		type: node.type,
		...(node.target === undefined ? {} : { target: node.target }),
	};
	dataTransfer.setData(PI_FILE_NODE_DRAG_MIME, JSON.stringify(payload));
}

/**
 * 落点侧：读取文件树拖拽负载。
 * 优先解析 JSON；只有纯路径时按「文件 + 绝对路径」兜底（兼容未带 JSON 的拖拽源）。
 * 非文件树拖拽（如 OS 文件拖入）返回 null。
 */
export function readFileNodeDragPayload(dataTransfer: DataTransfer): FileNodeDragPayload | null {
	const raw = dataTransfer.getData(PI_FILE_NODE_DRAG_MIME);
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as Partial<FileNodeDragPayload>;
			const relativePath = typeof parsed.relativePath === "string" ? parsed.relativePath : "";
			const path = typeof parsed.path === "string" && parsed.path ? parsed.path : undefined;
			// target 是本机与远端都成立的打开凭据；字段残缺就当没有（不猜）。
			const target = parsed.target !== undefined && typeof parsed.target.projectId === "string" && typeof parsed.target.relativePath === "string" ? { projectId: parsed.target.projectId, relativePath: parsed.target.relativePath } : undefined;
			if (path !== undefined || relativePath !== "" || target !== undefined) {
				return {
					...(path === undefined ? {} : { path }),
					relativePath: target?.relativePath ?? relativePath,
					type: parsed.type === "directory" ? "directory" : "file",
					...(target === undefined ? {} : { target }),
				};
			}
		} catch {
			// JSON 损坏时继续走纯路径兜底
		}
	}
	const plainPath = dataTransfer.getData(PI_FILE_PATH_DRAG_MIME);
	return plainPath ? { path: plainPath, relativePath: "", type: "file" } : null;
}

/**
 * 文件树节点 → composer @ 引用文本。
 * 项目内节点优先 relativePath（与 @ 建议一致，可过 chip 白名单校验）；
 * relativePath 缺失时退回绝对路径（chip 规则对绝对路径直接放行）。
 * 目录由 formatFilePathRef 追加尾斜杠，含空格路径自动加引号。
 */
export function fileNodeDragPayloadToRef(payload: FileNodeDragPayload): string {
	return formatFilePathRef(payload.relativePath || payload.path || "", {
		isDirectory: payload.type === "directory",
	});
}
