import { FileJson, GripVertical, ListPlus, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { type DragEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { MAX_QUICK_MESSAGES, MAX_QUICK_MESSAGE_LENGTH } from "../../../../../shared/quickMessages";
import { useQuickMessageEditor } from "../../../hooks/useQuickMessageEditor";
import { createDragGhost } from "../../../utils/dragGhost";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";

/**
 * 「管理快捷消息」弹框：条目清单的增删/排序/补充内置/恢复默认/重新读取/打开配置文件。
 *
 * 为什么从设置页搬到弹框里：条目上限 30 条，16 条出厂清单就能把设置页撑成一屏半，
 * 设置页只该留一行「条目预览 + 配置更多」（见 QuickMessagesSetting）。这里用弹框而不是
 * 内联展开，是为了给列表一个自己的滚动区（`max-h`），设置页高度不再随条目数变化。
 *
 * 写盘时序（打字合并 400ms、增删排序立即、关弹框补写）都在 useQuickMessageEditor 里，
 * 本组件只负责排版与事件转发。
 *
 * 列表 key 用下标：条目文本随输入实时变化，且允许存在重复/空行——用文本或 id 都会
 * 在编辑过程中重建节点、丢掉输入焦点。顺序调整本身就是重排，无状态可丢。
 */
export function QuickMessagesDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const editor = useQuickMessageEditor();
	const { rows } = editor;
	const latestRef = useRef({ rows, open: props.open, reorderItems: editor.reorderItems });
	latestRef.current = { rows, open: props.open, reorderItems: editor.reorderItems };
	const dragRef = useRef<{ index: number; rows: string[] } | null>(null);
	// 拖拽影像节点：dragstart 时挂到 body，dragend/关闭/卸载时移除（Chromium 拖动全程引用它截图）。
	const ghostRef = useRef<HTMLDivElement | null>(null);
	const [dropTarget, setDropTarget] = useState<number | null>(null);

	/** ref 是内部拖放的唯一来源；外部载荷即使伪造下标也不能触发排序。 */
	const clearDrag = useCallback(() => {
		dragRef.current = null;
		setDropTarget(null);
		ghostRef.current?.remove();
		ghostRef.current = null;
	}, []);

	useEffect(() => {
		// 下标只对开始拖动时那份列表有意义；增删/编辑/刷新和关闭都取消本次拖动。
		clearDrag();
		return () => {
			dragRef.current = null;
			ghostRef.current?.remove();
			ghostRef.current = null;
		};
	}, [rows, props.open, clearDrag]);

	/** 只允许把柄启动原生 HTML drag；自定义 MIME 仅让浏览器启动拖放，不携带消息正文。 */
	const startDrag = useCallback((event: DragEvent<HTMLButtonElement>, index: number) => {
		const current = latestRef.current;
		if (!current.open || index < 0 || index >= current.rows.length) {
			event.preventDefault();
			return;
		}
		event.stopPropagation();
		dragRef.current = { index, rows: current.rows };
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("application/x-pideck-quick-message", "move");
		// 拖拽影像：克隆整行当影像（默认影像只是十几像素的手柄图标），clearDrag 负责移除。
		// currentTarget 可选链：测试沙箱无 DOM，模拟事件没有 currentTarget 时跳过影像，不影响排序本身。
		const row = event.currentTarget?.closest<HTMLElement>("[data-quick-message-row]");
		if (row) {
			ghostRef.current?.remove();
			const ghost = createDragGhost(row);
			ghostRef.current = ghost.node;
			event.dataTransfer.setDragImage(ghost.node, ghost.x, ghost.y);
		}
	}, []);

	/** 手柄聚焦后的键盘微调：↑/↓ 移动一位（越界由 moveItem 内部忽略），上移/下移按钮的无障碍替代。 */
	const gripKeyDown = useCallback(
		(event: KeyboardEvent<HTMLButtonElement>, index: number) => {
			if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
			event.preventDefault();
			event.stopPropagation();
			editor.moveItem(index, event.key === "ArrowUp" ? -1 : 1);
		},
		[editor.moveItem],
	);

	/** 拖放期间使用最新 ref 校验列表身份，不能让过期事件移动到另一条消息。 */
	const canDrop = useCallback((target: number) => {
		const current = latestRef.current;
		const source = dragRef.current;
		return current.open && source !== null && source.rows === current.rows && source.index >= 0 && source.index < current.rows.length && Number.isInteger(target) && target >= 0 && target < current.rows.length;
	}, []);

	const dragOver = useCallback(
		(event: DragEvent<HTMLDivElement>, target: number) => {
			// 同时拦住输入框默认接收文本/文件的行为，不把外部 drop 交给宿主处理。
			event.preventDefault();
			event.stopPropagation();
			const allowed = canDrop(target);
			event.dataTransfer.dropEffect = allowed ? "move" : "none";
			setDropTarget(allowed ? target : null);
		},
		[canDrop],
	);

	const drop = useCallback(
		(event: DragEvent<HTMLDivElement>, target: number) => {
			event.preventDefault();
			event.stopPropagation();
			const source = dragRef.current;
			const allowed = canDrop(target);
			clearDrag();
			if (allowed && source) latestRef.current.reorderItems(source.index, target);
		},
		[canDrop, clearDrag],
	);

	return (
		<Dialog
			open={props.open}
			onOpenChange={(open) => {
				if (!open) clearDrag();
				props.onOpenChange(open);
			}}
		>
			<DialogContent onOpenAutoFocus={(event) => event.preventDefault()} className="w-[min(960px,calc(100vw-48px))] max-w-none gap-3 sm:max-w-none">
				<DialogHeader>
					<DialogTitle>{t("settings.quickMessages")}</DialogTitle>
					<DialogDescription>{t("settings.quickMessagesDesc", { max: MAX_QUICK_MESSAGES })}</DialogDescription>
					<p className="text-caption text-muted-foreground">{t("settings.quickMessagesConfigHint")}</p>
				</DialogHeader>

				{editor.loading ? (
					<p className="py-6 text-center text-caption text-muted-foreground">{t("settings.quickMessagesLoading")}</p>
				) : (
					<div className="flex min-h-0 flex-col gap-2">
						{/* 列表自己滚：条数再多也只占弹框高度，设置页与弹框都不跟着长高 */}
						{/* scroll-ok: transient —— 一次性弹窗 / 设置面板：内容随交互生命周期结束，不是随数据增长的列表。 */}
						<div className="flex max-h-[min(52vh,420px)] min-h-0 flex-col gap-1.5 overflow-y-auto pr-1">
							{rows.length === 0 ? <p className="py-3 text-caption text-muted-foreground">{t("settings.quickMessagesEmpty")}</p> : null}
							{rows.map((text, index) => (
								<div key={index} data-quick-message-row="" onDragOver={(event) => dragOver(event, index)} onDragLeave={() => setDropTarget(null)} onDrop={(event) => drop(event, index)} className={`flex min-w-0 items-center gap-1 rounded-md ${dropTarget === index ? "bg-accent ring-1 ring-inset ring-primary" : ""}`}>
									{/* 仅把柄可拖动，输入框仍可选字；聚焦手柄后 ↑/↓ 也可微调（上移/下移按钮的无障碍替代）。 */}
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										draggable
										title={t("settings.quickMessagesDragHandle")}
										aria-label={t("settings.quickMessagesDragHandle")}
										onDragStart={(event) => startDrag(event, index)}
										onDragEnd={clearDrag}
										onKeyDown={(event) => gripKeyDown(event, index)}
										className="shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
									>
										<GripVertical size={14} strokeWidth={1.8} aria-hidden="true" />
									</Button>
									<Input autoFocus={index === rows.length - 1 && text === ""} value={text} maxLength={MAX_QUICK_MESSAGE_LENGTH} placeholder={t("settings.quickMessagesPlaceholder")} onChange={(event) => editor.setItem(index, event.target.value)} onBlur={editor.flushPending} className="min-w-0 flex-1" />
									<Button type="button" variant="ghost" size="icon-sm" title={t("settings.quickMessagesRemove")} aria-label={t("settings.quickMessagesRemove")} onClick={() => editor.removeItem(index)}>
										<Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
									</Button>
								</div>
							))}
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button type="button" variant="outline" size="sm" disabled={editor.atLimit} onClick={editor.addItem}>
								<Plus size={14} strokeWidth={2} aria-hidden="true" />
								{t("settings.quickMessagesAdd")}
							</Button>
							<Button type="button" variant="outline" size="sm" disabled={editor.merging || editor.atLimit} title={t("settings.quickMessagesMergeDefaultsHint")} onClick={() => void editor.mergeDefaults()}>
								<ListPlus size={14} strokeWidth={2} aria-hidden="true" />
								{t(editor.merging ? "settings.quickMessagesMerging" : "settings.quickMessagesMergeDefaults")}
							</Button>
							{editor.atLimit ? <span className="text-caption text-muted-foreground">{t("settings.quickMessagesLimit", { max: MAX_QUICK_MESSAGES })}</span> : null}
						</div>
					</div>
				)}

				{/* 个人文件与内置资源互不自动合并；恢复默认是整体替换，补充内置才保留现有顺序。 */}
				<DialogFooter className="sm:justify-between">
					<div className="flex flex-wrap items-center gap-1">
						<Button type="button" variant="ghost" size="sm" disabled={!editor.defaultsAvailable || editor.merging} title={editor.defaultsAvailable ? t("settings.quickMessagesResetHint") : t("settings.quickMessagesDefaultsUnavailable")} onClick={editor.resetDefaults}>
							<RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.quickMessagesReset")}
						</Button>
						<Button type="button" variant="ghost" size="sm" disabled={editor.merging} title={t("settings.quickMessagesReloadHint")} onClick={() => void editor.reload()}>
							<RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.quickMessagesReload")}
						</Button>
						<Button type="button" variant="ghost" size="sm" onClick={() => void editor.openFile()}>
							<FileJson size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.quickMessagesOpenFile")}
						</Button>
					</div>
					{/* 改动即时落盘，所以这里是「完成」而不是「保存」——没有可取消的草案 */}
					<DialogClose asChild>
						<Button type="button" variant="default" size="sm">
							{t("settings.quickMessagesDone")}
						</Button>
					</DialogClose>
				</DialogFooter>

				{editor.filePath ? <p className="break-all text-caption text-muted-foreground">{t("settings.quickMessagesFileHint", { path: editor.filePath })}</p> : null}
				{editor.error ? <p className="text-caption text-destructive">{editor.error}</p> : null}
			</DialogContent>
		</Dialog>
	);
}
