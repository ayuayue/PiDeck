import { Globe } from "lucide-react";
import { t } from "../../../i18n";
import { openBrowserHtml } from "../../../utils/openBrowserHtml";
import { Button } from "../../ui-shadcn/button";

/** 打开当前文件内容的快照，包括尚未保存的编辑。 */
export function OpenHtmlInBrowserButton({ content, fileName, onOpen }: { content: string; fileName: string; onOpen: (url: string) => void }) {
	const label = t("browser.openLinkInBrowser");
	return (
		<Button type="button" variant="ghost" size="icon-sm" title={label} aria-label={label} disabled={!content} onClick={() => void openBrowserHtml(fileName, content, onOpen)}>
			<Globe size={15} aria-hidden="true" />
		</Button>
	);
}
