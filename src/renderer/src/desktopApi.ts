import type { PiDesktopApi } from "../../preload";
import { t } from "./i18n";
import { createBrowserApi } from "./browserApi";
import { createPreviewApi } from "./previewApi";

export const isLanWeb = !window.piDesktop && window.location.protocol.startsWith("http");
export const isElectronRuntime = navigator.userAgent.includes("Electron/");
export const missingElectronPreload = isElectronRuntime && !window.piDesktop;

function createUnavailableDesktopApi(): PiDesktopApi {
	const fail = () => {
		throw new Error(t("app.preloadMissing"));
	};
	return new Proxy(
		{},
		{
			get: fail,
			set: fail,
		},
	) as PiDesktopApi;
}

export const desktopApi: PiDesktopApi = window.piDesktop ?? (missingElectronPreload ? createUnavailableDesktopApi() : isLanWeb ? createBrowserApi() : createPreviewApi());
