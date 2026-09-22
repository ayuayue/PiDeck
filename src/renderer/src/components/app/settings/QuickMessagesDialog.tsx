import { ArrowDown, ArrowUp, FileJson, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { MAX_QUICK_MESSAGES, MAX_QUICK_MESSAGE_LENGTH } from "../../../../../shared/quickMessages";
import { useQuickMessageEditor } from "../../../hooks/useQuickMessageEditor";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";

/**
 * 「管理快捷消息」弹框：条目清单的增删/排序/恢复默认/重新读取/打开配置文件。
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

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="max-w-[600px] gap-3">
				<DialogHeader>
					<DialogTitle>{t("settings.quickMessages")}</DialogTitle>
					<DialogDescription>{t("settings.quickMessagesDesc", { max: MAX_QUICK_MESSAGES })}</DialogDescription>
				</DialogHeader>

				{editor.loading ? (
					<p className="py-6 text-center text-caption text-muted-foreground">{t("settings.quickMessagesLoading")}</p>
				) : (
					<div className="flex min-h-0 flex-col gap-2">
						{/* 列表自己滚：条数再多也只占弹框高度，设置页与弹框都不跟着长高 */}
						<div className="flex max-h-[min(52vh,420px)] min-h-0 flex-col gap-1.5 overflow-y-auto pr-1">
							{rows.length === 0 ? <p className="py-3 text-caption text-muted-foreground">{t("settings.quickMessagesEmpty")}</p> : null}
							{rows.map((text, index) => (
								<div key={index} className="flex min-w-0 items-center gap-1">
									<Input value={text} maxLength={MAX_QUICK_MESSAGE_LENGTH} placeholder={t("settings.quickMessagesPlaceholder")} onChange={(event) => editor.setItem(index, event.target.value)} onBlur={editor.flushPending} className="min-w-0 flex-1" />
									<Button type="button" variant="ghost" size="icon-sm" title={t("settings.quickMessagesMoveUp")} aria-label={t("settings.quickMessagesMoveUp")} disabled={index === 0} onClick={() => editor.moveItem(index, -1)}>
										<ArrowUp size={14} strokeWidth={1.8} aria-hidden="true" />
									</Button>
									<Button type="button" variant="ghost" size="icon-sm" title={t("settings.quickMessagesMoveDown")} aria-label={t("settings.quickMessagesMoveDown")} disabled={index === rows.length - 1} onClick={() => editor.moveItem(index, 1)}>
										<ArrowDown size={14} strokeWidth={1.8} aria-hidden="true" />
									</Button>
									{/* 列表用「上移/下移」而不是拖拽排序：条目通常不到 20 条，顺序只在弹框里体现一次，
									    拖拽需要引入新的交互栈且键盘不可用，上下移按钮对两种操作方式都成立。 */}
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
							{editor.atLimit ? <span className="text-caption text-muted-foreground">{t("settings.quickMessagesLimit", { max: MAX_QUICK_MESSAGES })}</span> : null}
						</div>
					</div>
				)}

				{/* 配置文件出口：手工编辑同样生效，这里的三个按钮是「配置化」的可见入口 */}
				<DialogFooter className="sm:justify-between">
					<div className="flex flex-wrap items-center gap-1">
						<Button type="button" variant="ghost" size="sm" disabled={!editor.defaultsAvailable} title={editor.defaultsAvailable ? undefined : t("settings.quickMessagesDefaultsUnavailable")} onClick={editor.resetDefaults}>
							<RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.quickMessagesReset")}
						</Button>
						<Button type="button" variant="ghost" size="sm" title={t("settings.quickMessagesReloadHint")} onClick={() => void editor.reload()}>
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
