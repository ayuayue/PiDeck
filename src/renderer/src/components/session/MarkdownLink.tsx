import { useState } from "react";
import type React from "react";
import { isLocalPathRef, remarkLinkifyPaths } from "./MarkdownLinkCore";
import { useFileLinkContext, useFilePathExists } from "./FileLinkBase";
import { extractFileLinkLocation, relativeFilePathWithinRoot, resolveFileLinkPath } from "../../utils/filePathLinks";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
// 剪贴板工具必须取 utils 而非 notice-toast：notice-toast 经 MarkdownStream 依赖本文件，
// 从它那里取导出会形成循环 import
import { writeClipboard } from "../../utils/clipboard";
import { desktopApi } from "../../desktopApi";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { detectRendererPlatform } from "../../lib/detectRendererPlatform";
export {
	isLocalPathRef,
	markdownUrlTransform,
	remarkLinkifyPaths,
} from "./MarkdownLinkCore";

/**
 * 左键修饰键标签：macOS 用 ⌘、其余用 Ctrl，与 shared/shortcuts 的 CmdOrCtrl 语义一致。
 * 平台在进程生命周期内不会变，模块级取一次即可（渲染层同步判定，不必等 appInfo IPC）。
 */
const FILE_LINK_MODIFIER = detectRendererPlatform() === "darwin" ? "⌘" : "Ctrl";

/**
 * 链接渲染：file:// 前缀为 remarkLinkifyPaths 生成的文件路径链接，其余为普通外链。
 * 无协议 href（[text](path) 形式）识别为本地路径引用，点击走 onOpenFile。
 */
export function MarkdownLink(
	props: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
		onOpenExternal: (url: string, forceSystem?: boolean) => void;
		onOpenFile?: (path: string, line?: number) => void;
	},
) {
	const { onOpenExternal, onOpenFile, children, className, title, ...anchorProps } = props;
	const [menu, setMenu] = useState<{ x: number; y: number } | undefined>(undefined);
	// remarkLinkifyPaths 生成的文件路径链接走 file:// 协议，与普通外链区分展示；
	// 无协议 href（[text](path) 形式）也是本地路径引用，同样走 onOpenFile
	const isFileLink = props.href?.startsWith("file://") ?? false;
	const isLocalRef = !isFileLink && isLocalPathRef(props.href ?? "");
	// 显式 Markdown 链接可能写成 /C:/path/file.ts:42：先还原 Windows 盘符，
	// 再把行号从路径里拆出来。校验用纯路径，点击带上行号（打开后滚动定位）。
	const fileLinkRawPath = isFileLink ? props.href!.slice(7) : isLocalRef ? props.href : undefined;
	const fileLinkLocation = fileLinkRawPath === undefined ? undefined : extractFileLinkLocation(fileLinkRawPath);
	const fileLinkPath = fileLinkLocation?.path;
	const fileLinkLine = fileLinkLocation?.line;
	const pathExists = useFilePathExists(fileLinkPath);
	// 右键菜单用：与存在性校验/点击打开同一份基准解析，保证三个入口拿到同一绝对路径
	const { baseDir, projectRoot, scope } = useFileLinkContext();
	const resolvedPath = fileLinkPath === undefined ? null : resolveFileLinkPath(fileLinkPath, baseDir, projectRoot);
	const relativePath = resolvedPath && projectRoot ? relativeFilePathWithinRoot(resolvedPath, projectRoot) : null;
	const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		if (!props.href) return;

		// 处理文件路径链接（file:// 协议 + 无协议的本地路径引用）
		if (isFileLink || isLocalRef) {
			// Ctrl/⌘ + 左键 = 用系统默认应用打开（issue #229 方案 C）。与普通外链已有的
			// 「Ctrl/⌘ + 点击强制系统浏览器」共用同一个修饰键，用户不必学第二套手势；
			// 不加修饰键时行为完全不变（文本进内置编辑器，保留行号定位与只读 diff）。
			// openWithDefaultApp 定义在下方：点击发生在渲染之后，闭包取值时已初始化。
			// 解析不出路径（空 href / 项目外）时退回默认左键行为，避免「点了没反应」。
			if ((e.ctrlKey || e.metaKey) && resolvedPath) {
				openWithDefaultApp();
				return;
			}
			if (onOpenFile && fileLinkPath) {
				void onOpenFile(fileLinkPath, fileLinkLine);
			}
		} else {
			// 普通 URL 链接：修饰键点击（Ctrl/Cmd）强制走系统浏览器。
			// 全局设置「内置浏览器」时，用户可临时用默认浏览器打开，无需改设置；
			// external 模式下 forceSystem 与默认行为一致，结果不变。
			void onOpenExternal(props.href, e.ctrlKey || e.metaKey || undefined);
		}
	};
	const handleContextMenu = (e: React.MouseEvent<HTMLAnchorElement>) => {
		if (!resolvedPath) return;
		e.preventDefault();
		setMenu({ x: e.clientX, y: e.clientY });
	};
	// 「在资源管理器打开」：stat 分流——目录直接打开该目录（shell.openPath），
	// 文件定位到父目录并选中（showInFolder）；不存在时与左键点击同一份提示。
	const openInExplorer = () => {
		if (!resolvedPath) return;
		void desktopApi.files
			.stat(resolvedPath, scope)
			.then((stat) => {
				if (!stat.exists) {
					showNotice(t("app.fileLinkNotFound", { path: resolvedPath }), undefined, "error");
					return undefined;
				}
				return stat.isDirectory ? desktopApi.files.open(resolvedPath, scope) : desktopApi.files.showInFolder(resolvedPath, scope);
			})
			.catch((error) =>
				showNotice(
					t("app.openFileFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
					undefined,
					"error",
				),
			);
	};
	// 「默认方式打开」：交给系统按文件关联启动（.md 走用户自己的 Typora / .pdf 走阅读器 / 目录走资源管理器）。
	// 与左键点击互补：左键把文本后缀交给内置编辑器预览，替代不了用户的本地工具链。
	// 不做 stat 预检——主进程 shell.openPath 对不存在的路径会返回错误，统一在这里提示，
	// 少一次 IPC 往返；左键路由之所以 stat，是因为它需要区分目录/图片/文本三种去向。
	const openWithDefaultApp = () => {
		if (!resolvedPath) return;
		void desktopApi.files.open(resolvedPath, scope).catch((error) =>
			showNotice(
				t("app.openFileFailed", {
					error: error instanceof Error ? error.message : String(error),
				}),
				undefined,
				"error",
			),
		);
	};
	const copyAbsolutePath = () => {
		if (!resolvedPath) return;
		void writeClipboard(resolvedPath).then((ok) => {
			if (ok) showNotice(t("app.pathCopied"));
		});
	};
	const copyRelativePath = () => {
		if (!relativePath) return;
		void writeClipboard(relativePath).then((ok) => {
			if (ok) showNotice(t("app.pathCopied"));
		});
	};
	// false=已确认不存在：渲染纯文本；undefined=未知或校验中：维持普通文本链接，
	// 等存在性结果回来后只改变是否可点击，不引入胶囊式视觉跳变。
	if (isFileLink || isLocalRef) {
		if (pathExists === false) {
			return <span className="text-text-tertiary">{children}</span>;
		}
	}
	const linkClass = [className, isFileLink || isLocalRef ? "cursor-pointer font-mono text-[var(--color-accent)] underline decoration-[var(--color-accent)]/50 underline-offset-2 hover:decoration-[var(--color-accent)]" : undefined].filter(Boolean).join(" ") || undefined;
	return (
		<>
			<a
				{...anchorProps}
				className={linkClass}
				onClick={handleClick}
				onContextMenu={isFileLink || isLocalRef ? handleContextMenu : undefined}
				// 文件链接 hover 展示解码后的完整路径 + 修饰键提示（右键菜单之外的快路径）；
				// 普通链接不传 title，保留 markdown 自带 title 语法的原行为
				title={isFileLink ? `${fileLinkPath}\n${t("fileLink.modifierOpenHint", { modifier: FILE_LINK_MODIFIER })}` : title}
			>
				{children}
			</a>
			{menu && resolvedPath && (
				<DropdownMenu
					open
					onOpenChange={(open) => {
						if (!open) setMenu(undefined);
					}}
				>
					{/* 不可见 Trigger 钉在右键坐标上（同 FileContextMenu 的坐标菜单模式）：
					    Radix 负责视口碰撞翻转/焦点圈定/ESC 关闭。 */}
					<DropdownMenuTrigger
						aria-hidden
						tabIndex={-1}
						style={{
							position: "fixed",
							left: menu.x,
							top: menu.y,
							width: 0,
							height: 0,
							padding: 0,
							border: 0,
							background: "transparent",
							pointerEvents: "none",
						}}
					/>
					<DropdownMenuContent align="start" side="bottom" className="min-w-40" onCloseAutoFocus={(e) => e.preventDefault()}>
						{/* 顺序与文件抽屉右键菜单同序：默认打开 → 定位 → 复制，主操作在首位 */}
						<DropdownMenuItem onSelect={openWithDefaultApp}>
							{t("menu.defaultOpen")}
							{/* 与左键修饰键同一常量，避免两处平台文案漂移 */}
							<DropdownMenuShortcut>{t("fileLink.modifierClickShortcut", { modifier: FILE_LINK_MODIFIER })}</DropdownMenuShortcut>
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={openInExplorer}>{t("fileLink.openInExplorer")}</DropdownMenuItem>
						<DropdownMenuItem onSelect={copyRelativePath} disabled={!relativePath}>
							{t("fileLink.copyRelativePath")}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={copyAbsolutePath}>{t("fileLink.copyAbsolutePath")}</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</>
	);
}
