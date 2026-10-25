import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ExternalEditor, FileManagerInfo } from "../../../../shared/types";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";

const EDITOR_LOGO_URLS: Record<string, string> = {
	vscode: new URL("../../assets/editors/vscode.png", import.meta.url).href,
	cursor: new URL("../../assets/editors/cursor.png", import.meta.url).href,
	zed: new URL("../../assets/editors/zed.png", import.meta.url).href,
	idea: new URL("../../assets/editors/idea.svg", import.meta.url).href,
	webstorm: new URL("../../assets/editors/webstorm.svg", import.meta.url).href,
	phpstorm: new URL("../../assets/editors/phpstorm.svg", import.meta.url).href,
	pycharm: new URL("../../assets/editors/pycharm.svg", import.meta.url).href,
};

export type ExternalEditorOverlayProps = {
	open: boolean;
	editors: ExternalEditor[];
	anchor: { x: number; y: number } | null;
	projectPath: string | null;
	onClose: () => void;
	onOpenProject: (editor: ExternalEditor, projectPath: string) => void | Promise<void>;
	onError?: (error: unknown) => void;
};

/**
 * Windows 资源管理器风格 logo（内联 SVG，避免新增图片资源）：
 * 蓝色窗口 + 四窗格，对应系统资源管理器图标观感。
 */
/**
 * Windows 文件资源管理器 fallback logo（内联 SVG）：Windows 11 风格黄色文件夹，
 * 主路径优先使用系统 explorer.exe 的真实图标（见 FileManagerLogo）。
 */
function WindowsExplorerLogo() {
	return (
		<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
			{/* 后层折叠盖（深黄） */}
			<path d="M4 7a2 2 0 0 1 2-2h3.6l1.6 1.8H18a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z" fill="#d4a017" />
			{/* 前层文件夹主体（亮黄） */}
			<path d="M4 9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9z" fill="#fbc02d" />
			{/* 高光 */}
			<path d="M5 9.2h14v1H5z" fill="#ffe082" opacity="0.9" />
		</svg>
	);
}

/** Linux 文件管理器风格 logo：经典文件夹造型 */
function LinuxFileManagerLogo() {
	return (
		<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
			<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="#f5b301" />
			<path d="M3 9.5V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v.5H3z" fill="#fcd34d" opacity="0.9" />
		</svg>
	);
}

/**
 * 文件管理器 logo：Windows 优先用系统 explorer.exe 的真实图标（iconDataUrl），
 * 获取失败时回退内联黄色文件夹；其它平台用文件夹造型。
 */
function FileManagerLogo({ info }: { info: FileManagerInfo }) {
	if (info.iconDataUrl) {
		return <img src={info.iconDataUrl} alt="" className="size-[14px] object-contain" />;
	}
	return info.id === "windows-explorer" ? <WindowsExplorerLogo /> : <LinuxFileManagerLogo />;
}

/**
 * 编辑器选择气泡：锚点坐标来自触发元素（视口坐标，故用 fixed 定位）。
 * 触发点可能贴窗口边缘（Tab 栏 / 菜单项），弹出后按实测尺寸自钳制：
 * 横向收进右缘、纵向优先锚点下方，放不下时翻到锚点上方。
 * 品牌 logo 的色调锚点沿用 foundation.css 的 .editor-logo.<id>。
 * 底部附「文件管理器」补充入口：检测系统文件管理器并在其中打开项目目录。
 */
export function ExternalEditorOverlay(props: ExternalEditorOverlayProps) {
	const overlayRef = useRef<HTMLDivElement>(null);
	const [openingId, setOpeningId] = useState<string | null>(null);
	const [fileManager, setFileManager] = useState<FileManagerInfo | null>(null);
	const [fileManagerOpening, setFileManagerOpening] = useState(false);
	// 首帧用原始锚点渲染，layout effect 里实测尺寸后立即钳制（paint 前完成，无跳动）
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

	// 打开气泡时检测系统文件管理器（Windows 固定资源管理器；Linux 按 PATH 探测）。
	// 检测失败不阻断气泡：只隐藏文件管理器入口。
	useEffect(() => {
		if (!props.open) {
			setFileManager(null);
			return;
		}
		let cancelled = false;
		void desktopApi.files
			.detectFileManager()
			.then((info) => {
				if (!cancelled) setFileManager(info);
			})
			.catch(() => {
				if (!cancelled) setFileManager(null);
			});
		return () => {
			cancelled = true;
		};
	}, [props.open]);

	useEffect(() => {
		if (!props.open) return;
		const onMouseDown = (event: MouseEvent) => {
			if (!overlayRef.current?.contains(event.target as Node)) props.onClose();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") props.onClose();
		};
		document.addEventListener("mousedown", onMouseDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [props.onClose, props.open]);

	useLayoutEffect(() => {
		if (!props.open || !props.anchor) {
			setPos(null);
			return;
		}
		const el = overlayRef.current;
		if (!el) return;
		const { width, height } = el.getBoundingClientRect();
		const margin = 8;
		let left = props.anchor.x;
		let top = props.anchor.y + 4;
		if (left + width > window.innerWidth - margin) {
			left = Math.max(margin, window.innerWidth - width - margin);
		}
		if (top + height > window.innerHeight - margin) {
			top = Math.max(margin, props.anchor.y - height - 4);
		}
		setPos({ left, top });
	}, [props.anchor, props.open]);

	if (!props.open || !props.anchor) return null;
	const logoFor = (editor: ExternalEditor) => EDITOR_LOGO_URLS[editor.id];
	// 无目标目录时所有入口无从打开：禁用而不是静默 return（否则表现为「点击没反应」）
	const canOpen = Boolean(props.projectPath);
	const choose = (editor: ExternalEditor) => {
		if (!canOpen || openingId) return;
		setOpeningId(editor.id);
		Promise.resolve(props.onOpenProject(editor, props.projectPath ?? ""))
			.catch((error) => props.onError?.(error))
			.finally(() => setOpeningId(null));
	};
	const chooseFileManager = () => {
		// 文件管理器不依赖项目目录：空路径由主进程回退用户主目录（常驻快捷入口）
		if (!fileManager || fileManagerOpening) return;
		setFileManagerOpening(true);
		desktopApi.files
			.openFileManager(props.projectPath ?? "")
			.catch((error) => props.onError?.(error))
			.finally(() => setFileManagerOpening(false));
	};

	const pathName = props.projectPath ? props.projectPath.split(/[\\/]/).pop() : null;

	return (
		<div ref={overlayRef} className="fixed z-[100] flex w-60 flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-md" style={{ left: pos?.left ?? props.anchor.x, top: pos?.top ?? props.anchor.y }} role="menu" aria-label={t("app.openWithEditor")} onClick={(event) => event.stopPropagation()}>
			<div className="border-b border-border/60 px-3 pb-2 pt-2">
				<p className="text-xs font-medium text-foreground">{t("app.openWithEditor")}</p>
				{pathName ? (
					<p className="mt-0.5 truncate text-micro leading-4 text-muted-foreground" title={props.projectPath ?? undefined}>
						{pathName}
					</p>
				) : (
					// 未绑定项目目录：编辑器打开不可用；文件管理器回退主目录仍可用
					<p className="mt-0.5 text-micro leading-4 text-muted-foreground">{t("app.openWithEditorNoProject")}</p>
				)}
			</div>
			<div className="max-h-60 overflow-y-auto p-1">
				{props.editors.length === 0 ? (
					<div className="px-2 py-2 text-xs text-muted-foreground">{t("app.noExternalEditors")}</div>
				) : (
					props.editors.map((editor) => {
						const logo = logoFor(editor);
						return (
							<button
								type="button"
								key={editor.id}
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground/90 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								disabled={!canOpen || Boolean(openingId)}
								onClick={() => choose(editor)}
								role="menuitem"
								title={t("app.openProjectInEditor")}
							>
								<span className={`editor-logo ${editor.id}`}>{logo ? <img src={logo} alt="" /> : editor.id.slice(0, 2).toUpperCase()}</span>
								<span className="truncate">{editor.name}</span>
							</button>
						);
					})
				)}
				{fileManager && (
					<>
						{/* 编辑器与文件管理器之间的分隔线：文件管理器是补充入口，不属于编辑器列表 */}
						<div className="mx-1 my-1 h-px bg-border/60" aria-hidden="true" />
						<button
							type="button"
							className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground/90 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
							disabled={fileManagerOpening}
							onClick={chooseFileManager}
							role="menuitem"
							title={t("app.openInFileManager")}
						>
							<span className="editor-logo file-manager">
								<FileManagerLogo info={fileManager} />
							</span>
							<span className="truncate">{fileManager.id === "windows-explorer" ? t("app.fileManager.windowsExplorer") : fileManager.name}</span>
						</button>
					</>
				)}
			</div>
		</div>
	);
}

export { EDITOR_LOGO_URLS };
