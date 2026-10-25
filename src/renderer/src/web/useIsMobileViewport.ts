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
