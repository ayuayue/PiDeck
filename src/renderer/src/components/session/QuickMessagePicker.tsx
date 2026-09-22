import { useEffect, useMemo, useState } from "react";
import { FileJson, Search, SendHorizontal, Settings2 } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Pagination } from "../ui-shadcn/pagination";
import { Table, TableBody, TableCell, TableRow } from "../ui-shadcn/table";
import { filterQuickMessages, paginateQuickMessages } from "./quickMessagePickerModel";

/**
 * 「快捷消息」弹框内容（底栏入口按钮的浮层主体）。
 *
 * 形状是一张紧凑表：搜索 + 分页 + 行内两个动作，而不是一长条菜单。
 * 理由很直接——条目上限 30 条，整列铺开会比窗口还高（旧版 16 条就顶穿屏幕顶部），
 * 而且列表越长越难找；固定行高（28px）+ 每页 8 条把弹框压在 ~320px，一屏可扫。
 *
 * 行内两个动作沿用弹框一直以来的约定：
 * - 点条目文字 = 插入草稿（可继续补参数再回车）；
 * - 行尾按钮 = 直接发送（「继续」「提交推送」这类不需要改写的口令）。
 *
 * 纯展示组件：数据与动作都由 QuickMessageMenu 传入（读文件、写文件在 hook/主进程）。
 */
export function QuickMessagePicker(props: {
	items: readonly string[];
	loading: boolean;
	error: string | null;
	/** 直发不可用（DSH 模型不可路由 / 生图进行中）：仍可插入草稿，只是不给直发。 */
	sendDisabled?: boolean;
	onInsert: (text: string) => void;
	onSend: (text: string) => void;
	onOpenFile: () => void;
	onManage: () => void;
}) {
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(1);
	const filtered = useMemo(() => filterQuickMessages(props.items, query), [props.items, query]);
	const paged = useMemo(() => paginateQuickMessages(filtered, page), [filtered, page]);

	// 页码夹紧后回写：搜索把结果截短、或用户在设置里删条目时，state 里可能留着越界页码，
	// 不回写就会「点下一页没反应」（夹紧发生在渲染期，翻页却从旧页码再算一次）。
	useEffect(() => {
		if (paged.page !== page) setPage(paged.page);
	}, [paged.page, page]);

	// 回车 = 用当前页第一条：搜索本身就是「找到就用」的路径，再点一次鼠标是多余的。
	// 中文输入法组字期间的回车是选字，必须放过（isComposing），否则打「提交」按回车会被吞掉。
	const insertFirst = () => {
		const first = paged.items[0];
		if (first !== undefined) props.onInsert(first);
	};

	return (
		<div className="flex min-h-0 w-full flex-col">
			{/* 搜索行：搜索框占满，两个出口（配置文件 / 管理）收成图标按钮放同行，省下一整行高度 */}
			<div className="flex flex-none items-center gap-1 border-b border-border/60 p-2">
				<div className="relative min-w-0 flex-1">
					<Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground/70" aria-hidden="true" />
					<Input
						type="text"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							// 换搜索词回到第一页：否则搜到第 3 页再改词，会停在一个与结果无关的页码上
							setPage(1);
						}}
						onKeyDown={(event) => {
							if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
							event.preventDefault();
							insertFirst();
						}}
						placeholder={t("app.quickMessagesSearch")}
						className="h-8 pl-8 text-control"
						autoFocus
					/>
				</div>
				<Button variant="ghost" size="icon-sm" className="flex-none text-muted-foreground hover:text-foreground" title={t("settings.quickMessagesOpenFile")} aria-label={t("settings.quickMessagesOpenFile")} onClick={props.onOpenFile}>
					<FileJson size={14} strokeWidth={2} aria-hidden="true" />
				</Button>
				<Button variant="ghost" size="icon-sm" className="flex-none text-muted-foreground hover:text-foreground" title={t("app.quickMessagesManage")} aria-label={t("app.quickMessagesManage")} onClick={props.onManage}>
					<Settings2 size={14} strokeWidth={2} aria-hidden="true" />
				</Button>
			</div>

			{props.loading ? (
				// 读文件很快但要区分「还没读完」与「真的没有」：否则每次打开弹框都会闪一下空态。
				<p className="px-3 py-4 text-caption leading-relaxed text-muted-foreground">{t("app.quickMessagesLoading")}</p>
			) : props.error ? (
				<p className="px-3 py-4 text-caption leading-relaxed text-destructive">{props.error}</p>
			) : props.items.length === 0 ? (
				<p className="px-3 py-4 text-caption leading-relaxed text-muted-foreground">{t("app.quickMessagesEmpty")}</p>
			) : (
				<>
					{/* 动作分工只讲一次：行首那条说明比给每行加 tooltip 更省空间 */}
					<p className="flex-none px-3 pt-1.5 pb-0.5 text-micro text-muted-foreground">{t("app.quickMessagesHint")}</p>
					<div className="min-h-0 flex-1 overflow-y-auto p-1">
						{filtered.length === 0 ? (
							<p className="px-2 py-3 text-caption text-muted-foreground">{t("app.quickMessagesNoMatch")}</p>
						) : (
							// table-fixed：长条目按剩余宽度截断，而不是把弹框撑宽（否则长句会顶破 24rem）
							<Table className="table-fixed">
								<TableBody>
									{paged.items.map((text, index) => (
										<TableRow key={`${paged.page}:${index}:${text}`} className="border-b-0 hover:bg-transparent">
											<TableCell className="p-0">
												{/* 行主体做成真按钮（而不是给 tr 挂 onClick）：键盘 Tab 也能选中条目 */}
												<Button type="button" variant="ghost" className="h-7 w-full justify-start rounded-sm px-2 text-control font-normal" title={text} onClick={() => props.onInsert(text)}>
													<span className="truncate">{text}</span>
												</Button>
											</TableCell>
											<TableCell className="w-8 p-0 pr-1 text-right">
												{/* 直发是独立按钮：不冒泡、不经过插入路径（旧版依赖菜单取消冒泡，这里结构上就不会误触） */}
												<Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" title={t("app.quickMessagesSend")} aria-label={t("app.quickMessagesSend")} disabled={props.sendDisabled} onClick={() => props.onSend(text)}>
													<SendHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
												</Button>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</div>
					{/* 页脚：左边条数（搜索后是命中数），右边分页；只有一页时不渲染分页控件 */}
					<div className="flex flex-none items-center justify-between gap-2 border-t border-border/60 px-2 py-1">
						<span className="shrink-0 text-micro text-muted-foreground tabular-nums">{t("app.quickMessagesCount", { count: String(filtered.length) })}</span>
						{paged.totalPages > 1 ? <Pagination page={paged.page} totalPages={paged.totalPages} onPageChange={setPage} className="justify-end gap-1 py-0" /> : null}
					</div>
				</>
			)}
		</div>
	);
}
