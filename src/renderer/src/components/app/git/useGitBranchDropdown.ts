/**
 * 分支下拉的开关、新建态、视口钳位与「点外关闭」（从 `GitPanel.tsx` 原样搬出）。
 *
 * 定位走 `floatingMenuPosition`：菜单宽度跟触发器走（随抽屉自适应），再钳进视口；
 * z 层级走语义 token（`--z-popover`），不再写死 9999 旁路。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getViewportBoundMenuPlacement } from "./floatingMenuPosition";

export function useGitBranchDropdown() {
	const [branchOpen, setBranchOpen] = useState(false);
	const [branchCreating, setBranchCreating] = useState(false);
	const [newBranchName, setNewBranchName] = useState("");
	const [branchDropdownStyle, setBranchDropdownStyle] = useState<React.CSSProperties>({});
	const branchBarRef = useRef<HTMLDivElement>(null);
	const branchTriggerRef = useRef<HTMLButtonElement>(null);
	const branchDropdownRef = useRef<HTMLDivElement>(null);

	const updateBranchDropdownPosition = useCallback(() => {
		if (!branchTriggerRef.current) return;
		const rect = branchTriggerRef.current.getBoundingClientRect();
		// 菜单宽度跟触发器走（随抽屉自适应），再由 placement 钳进视口；不再写死 240。
		const preferredWidth = Math.max(Math.ceil(rect.width), 160);
		const placement = getViewportBoundMenuPlacement(rect, { width: window.innerWidth, height: window.innerHeight }, { preferredWidth, maxHeight: 300, gap: 2 });
		setBranchDropdownStyle({
			position: "fixed",
			left: placement.left,
			top: placement.top,
			bottom: placement.bottom,
			width: placement.width,
			maxHeight: placement.maxHeight,
			// z 层级走语义 token（foundation.css）：下拉是 popover 语义，不再写死 9999 旁路（Wave 2 §5）。
			zIndex: "var(--z-popover)",
		});
	}, []);

	// 点击外部关闭分支下拉
	useEffect(() => {
		if (!branchOpen) return;
		updateBranchDropdownPosition();
		const handler = (event: MouseEvent) => {
			const target = event.target as Node;
			// Portal 出来的菜单不再是 branchBar 的后代，二者都属于菜单交互区。
			if (branchBarRef.current?.contains(target) || branchDropdownRef.current?.contains(target)) {
				return;
			}
			setBranchOpen(false);
			setBranchCreating(false);
			setNewBranchName("");
		};
		const handleScroll = () => updateBranchDropdownPosition();
		const handleResize = () => updateBranchDropdownPosition();
		document.addEventListener("mousedown", handler);
		window.addEventListener("scroll", handleScroll, true);
		window.addEventListener("resize", handleResize);
		return () => {
			document.removeEventListener("mousedown", handler);
			window.removeEventListener("scroll", handleScroll, true);
			window.removeEventListener("resize", handleResize);
		};
	}, [branchOpen, updateBranchDropdownPosition]);

	return {
		branchOpen,
		setBranchOpen,
		branchCreating,
		setBranchCreating,
		newBranchName,
		setNewBranchName,
		branchDropdownStyle,
		branchBarRef,
		branchTriggerRef,
		branchDropdownRef,
		updateBranchDropdownPosition,
	};
}
