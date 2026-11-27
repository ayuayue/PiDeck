import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "./notice";

/** 打开一份已读取的 HTML 快照。 */
export async function openBrowserHtml(fileName: string, html: string, navigate: (url: string) => void): Promise<void> {
	try {
		const url = await desktopApi.browser.stageHtmlPreview(fileName, html);
		if (url) navigate(url);
		else showNotice(t("editor.browserHtmlTooLarge"), undefined, "warning");
	} catch {
		showNotice(t("browser.loadFailedTitle"), undefined, "error");
	}
}
