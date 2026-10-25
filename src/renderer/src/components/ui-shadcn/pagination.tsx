import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";
import { Input } from "./input";
import { cn } from "../../lib/utils";
import { t } from "../../i18n";
import { paginationWindow } from "../../utils/pagination";

/**
 * 共享分页控件：上一页 / 页码窗口（带省略号）/ 下一页 / 跳页输入框。
 * 页码窗口策略见 utils/pagination.ts（纯函数，配单测）：
 * 当前页前后各 2 页常驻、首尾页常驻，缺口用省略号折叠；
 * 跳页输入框回车直接跳转，非法输入（越界/非数字）静默忽略。
 */
export function Pagination(props: { page: number; totalPages: number; onPageChange: (page: number) => void; className?: string }) {
	const { page, totalPages, onPageChange } = props;
	const [jumpInput, setJumpInput] = useState("");
	const prevDisabled = page <= 1;
	const nextDisabled = page >= totalPages;
	const items = paginationWindow(page, totalPages);

	// 回车跳页：输入须为 1..totalPages 内的整数，否则忽略并清空输入
	const jump = () => {
		const target = Number(jumpInput);
		if (Number.isInteger(target) && target >= 1 && target <= totalPages && target !== page) {
			onPageChange(target);
		}
		setJumpInput("");
	};

	return (
		<nav className={cn("flex flex-wrap items-center justify-center gap-1.5 py-4", props.className)} aria-label={t("pagination.label")}>
			<Button variant="outline" size="sm" disabled={prevDisabled} aria-label={t("pagination.previous")} title={t("pagination.previous")} onClick={() => onPageChange(Math.max(1, page - 1))}>
				<ChevronLeft size={14} />
			</Button>
			{items.map((item, index) =>
				typeof item === "number" ? (
					<Button key={item} variant={item === page ? "default" : "outline"} size="sm" className="min-w-8 px-2 tabular-nums" aria-label={t("pagination.page", { page: String(item) })} aria-current={item === page ? "page" : undefined} onClick={() => onPageChange(item)}>
						{item}
					</Button>
				) : (
					// 省略号占位：不可点击，保持窗口总宽稳定
					<span key={`${item}-${index}`} className="px-0.5 text-caption text-text-tertiary select-none">
						…
					</span>
				),
			)}
			<Button variant="outline" size="sm" disabled={nextDisabled} aria-label={t("pagination.next")} title={t("pagination.next")} onClick={() => onPageChange(Math.min(totalPages, page + 1))}>
				<ChevronRight size={14} />
			</Button>
			{/* 跳页输入框：键入页码后回车跳转；与上一页/下一页解耦，便于大页数快速定位 */}
			<Input
				type="number"
				min={1}
				max={totalPages}
				value={jumpInput}
				onChange={(event) => setJumpInput(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") jump();
				}}
				onBlur={() => setJumpInput("")}
				className="h-8 w-14 text-center text-caption tabular-nums"
				aria-label={t("pagination.jumpTo")}
				title={t("pagination.jumpTo")}
			/>
		</nav>
	);
}
