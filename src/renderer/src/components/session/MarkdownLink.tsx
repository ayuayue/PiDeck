import { useState } from "react";
import type React from "react";
import { isLocalPathRef, remarkLinkifyPaths } from "./MarkdownLinkCore";
import { useFileLinkContext, useFilePathExists } from "./FileLinkBase";
import { extractFileLinkLocation, relativeFilePathWithinRoot, resolveFileLinkPath } from "../../utils/filePathLinks";
import { isExecutableLikePath } from "../../utils/externalPathAccessPolicy";
import { useExternalPathOpenGate } from "../../hooks/useExternalPathOpenGate";
import type { ProjectFileAccessScope } from "../../../../shared/types";
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
 * 项目外路径的打开由 App 侧的安全等级门处理（直开 / 二次确认 / 拒绝），本组件只负责渲染与菜单。
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
	const { baseDir, projectRoot, scope, sessionId } = useFileLinkContext();
	// 项目外路径的系统动作（默认应用 / 文件管理器）也要过安全等级门：门实例挂在链接自身上
	//（右键菜单本来就是本组件的局部 UI 状态），与 App 侧左键那份共用同一套判定函数，
	// 同时只可能有一个处于 pending，因此不会出现两扇确认窗。
	const { requestExternalPathOpen, dialog: externalPathOpenDialog } = useExternalPathOpenGate();
	const resolvedPath = fileLinkPath === undefined ? null : resolveFileLinkPath(fileLinkPath, baseDir, projectRoot);
	// 项目外引用：按本档项目边界解析失败（resolvedPath 为 null），但词法上仍是一个绝对路径。
	// 解析得出来就必须可用：左键由 App 侧的门放行/确认，菜单里的系统动作由下面两个 handler 送进同一道门。
	const externalPath = resolvedPath === null && fileLinkPath !== undefined ? resolveFileLinkPath(fileLinkPath, baseDir) : null;
	const menuPath = resolvedPath ?? externalPath;
	// 「用系统默认方式打开」= shell.openPath：项目内是用户自己的工程文件，直接给；
	// 项目外要对可执行/脚本后缀收回入口（对这些后缀等于执行代码），其余后缀仍可经等级门打开。
	const canOpenWithDefaultApp = resolvedPath !== null || (externalPath !== null && !isExecutableLikePath(externalPath));
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
		if (!menuPath) return;
		e.preventDefault();
		setMenu({ x: e.clientX, y: e.clientY });
	};
	const showOpenFailure = (error: unknown) =>
		showNotice(
			t("app.openFileFailed", {
				error: error instanceof Error ? error.message : String(error),
			}),
			undefined,
			"error",
		);
	// 「在资源管理器打开」：stat 分流——目录直接打开该目录（shell.openPath），
	// 文件定位到父目录并选中（showInFolder）；不存在时与左键点击同一份提示。
	// targetScope 有形（项目内）时用项目边界，无（项目外）时走主进程的通用入口。
	const revealInExplorer = (targetPath: string, targetScope?: ProjectFileAccessScope) => {
		void desktopApi.files
			.stat(targetPath, targetScope)
			.then((stat) => {
				if (!stat.exists) {
					showNotice(t("app.fileLinkNotFound", { path: targetPath }), undefined, "error");
					return undefined;
				}
				return stat.isDirectory ? desktopApi.files.open(targetPath, targetScope) : desktopApi.files.showInFolder(targetPath, targetScope);
			})
			.catch(showOpenFailure);
	};
	const openInExplorer = () => {
		if (resolvedPath) {
			revealInExplorer(resolvedPath, scope);
			return;
		}
		if (!externalPath) return;
		// kind=reveal：只唤起系统文件管理器，不读内容、不执行——档位因此不会为它弹确认框
		void requestExternalPathOpen({
			kind: "reveal",
			path: externalPath,
			sessionId,
			cwd: baseDir,
			projectRoot,
			proceed: () => revealInExplorer(externalPath),
		});
	};
	// 「默认方式打开」：交给系统按文件关联启动（.md 走用户自己的 Typora / .pdf 走阅读器 / 目录走资源管理器）。
	// 与左键点击互补：左键把文本后缀交给内置编辑器预览，替代不了用户的本地工具链。
	// 不做 stat 预检——主进程 shell.openPath 对不存在的路径会返回错误，统一在这里提示，
	// 少一次 IPC 往返；左键路由之所以 stat，是因为它需要区分目录/图片/文本三种去向。
	const openWithDefaultApp = () => {
		if (resolvedPath) {
			void desktopApi.files.open(resolvedPath, scope).catch(showOpenFailure);
			return;
		}
		if (!externalPath) return;
		void requestExternalPathOpen({
			kind: "default-app",
			path: externalPath,
			sessionId,
			cwd: baseDir,
			projectRoot,
			proceed: () => void desktopApi.files.open(externalPath).catch(showOpenFailure),
		});
	};
	const copyAbsolutePath = () => {
		if (!menuPath) return;
		void writeClipboard(menuPath).then((ok) => {
			if (ok) showNotice(t("app.pathCopied"));
		});
	};
	const copyRelativePath = () => {
		if (!relativePath) return;
		void writeClipboard(relativePath).then((ok) => {
			if (ok) showNotice(t("app.pathCopied"));
		});
	};
	// false=已确认不存在：
	// - 显式 Markdown 链接（[text](path)）是作者声明过的链接，失效时降级灰字提示；
	// - remarkLinkifyPaths 自动识别的裸路径（file://）作者从未声明成链接，误识别/幻觉路径
	//   一律按普通正文渲染（继承上下文样式）。否则中文散文里被误识别的词（`降分辨率/抽帧`）
	//   会在正文中间突然变灰，看起来像高亮/阴影（线上回归）。
	if (isFileLink || isLocalRef) {
		if (pathExists === false) {
			return isFileLink ? <>{children}</> : <span className="text-text-tertiary">{children}</span>;
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
			{menu && menuPath && (
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
						{/* 顺序与文件抽屉右键菜单同序：默认打开 → 定位 → 复制，主操作在首位。
						    项目外路径的系统动作同样提供，但都经 requestExternalPathOpen 过一遍安全等级门；
						    可执行/脚本后缀对项目外不提供「默认方式打开」（shell.openPath 等于执行代码）。 */}
						{canOpenWithDefaultApp && (
							<DropdownMenuItem onSelect={openWithDefaultApp}>
								{t("menu.defaultOpen")}
								{/* 与左键修饰键同一常量，避免两处平台文案漂移 */}
								<DropdownMenuShortcut>{t("fileLink.modifierClickShortcut", { modifier: FILE_LINK_MODIFIER })}</DropdownMenuShortcut>
							</DropdownMenuItem>
						)}
						<DropdownMenuItem onSelect={openInExplorer}>{t("fileLink.openInExplorer")}</DropdownMenuItem>
						<DropdownMenuItem onSelect={copyRelativePath} disabled={!relativePath}>
							{t("fileLink.copyRelativePath")}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={copyAbsolutePath}>{t("fileLink.copyAbsolutePath")}</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
			{/* 项目外路径经安全等级门确认时弹框（与左键路由同一份文案体系） */}
			{externalPathOpenDialog}
		</>
	);
}
