import { useEffect, useState } from "react";
import { WEB_MOBILE_MAX_WIDTH, isMobileViewport, readViewportWidth } from "./webViewport";

export function useIsMobileViewport(): boolean {
	const [mobile, setMobile] = useState(() => isMobileViewport(readViewportWidth()));
	useEffect(() => {
		const media = window.matchMedia(`(max-width: ${WEB_MOBILE_MAX_WIDTH}px)`);
		const sync = () => setMobile(media.matches);
		sync();
		media.addEventListener("change", sync);
		return () => media.removeEventListener("change", sync);
	}, []);
	return mobile;
}

/**
 * 触屏主指针，与全站 `pointer-coarse` CSS 变体同一判定（窄窗口桌面键盘不误伤）。
 * 虚拟键盘没有 Shift/修饰键，Enter 键行为、输入提示文案等触屏专属分支用它门控，
 * 而不是移动宽度断点——两者语义不同（触屏手机 vs 窄窗口）。
 */
export function useCoarsePointer(): boolean {
	const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches);
	useEffect(() => {
		const media = window.matchMedia("(pointer: coarse)");
		const sync = () => setCoarse(media.matches);
		sync();
		media.addEventListener("change", sync);
		return () => media.removeEventListener("change", sync);
	}, []);
	return coarse;
}
