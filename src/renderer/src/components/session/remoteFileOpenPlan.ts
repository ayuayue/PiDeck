/**
 * 远端文件「点开」时选哪个宿主（纯判据 + 一次调用封装，node 单测直接加载）。
 *
 * 本地文件点开走 `useFileEditor` 的中间栏阅读面：单击预览 / 双击常驻，布局由
 * workspaceContentOpenMode 决定。远端此前无论点什么都塞进抽屉文件栏底部 40% 的内嵌编辑器——
 * 同一个动作两套位置，而且完全不看设置。
 *
 * 现在两边同一条主路径：**文件进中间栏**。不再按文本/二进制分流——二进制读通道
 * （`files:read-base64` 的远端分支）已经支持 ssh 项目，图片/PDF/Office/压缩包在中间栏里
 * 和本机文件一样渲染。只有「宿主根本没注入中间栏入口」时才退回面板内预览，绝不吞掉点击。
 */
/** 项目作用域的相对文件身份（远端没有本机绝对路径）。 */
export type RemoteFileTarget = { projectId: string; relativePath: string };
/** 与 useFileEditor 同语义：单击预览（可被下一次单击替换）/ 双击常驻。 */
export type RemoteFileOpenMode = "preview" | "permanent";
export type RemoteFileOpenHandler = (target: RemoteFileTarget, openMode?: RemoteFileOpenMode) => void;

/** workbench = 中间栏阅读面（与本地文件同一条主路径）；inline = 宿主没给入口时的兜底。 */
export type RemoteFileOpenHost = "workbench" | "inline";

export function remoteFileOpenHost(input: { hasWorkbench: boolean }): RemoteFileOpenHost {
	return input.hasWorkbench ? "workbench" : "inline";
}

/**
 * 落成一次调用。换到中间栏时必须同时收掉面板内预览（`setInline(null)`），否则上一次的
 * 兜底预览还挂着，看起来就是「点开没反应」。
 */
export function openRemoteFile(input: { target: RemoteFileTarget; openMode?: RemoteFileOpenMode; onViewFile?: RemoteFileOpenHandler; setInline: (relativePath: string | null) => void }): void {
	const { target, openMode = "preview", onViewFile, setInline } = input;
	if (remoteFileOpenHost({ hasWorkbench: onViewFile !== undefined }) === "inline") {
		setInline(target.relativePath);
		return;
	}
	setInline(null);
	onViewFile?.(target, openMode);
}
