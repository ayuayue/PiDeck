import { extractFileLinkLocation, matchPlainFilePaths } from "../../utils/filePathLinks.ts";

/**
 * 本地复刻 react-markdown 的 defaultUrlTransform（迁移 streamdown 后不再依赖 react-markdown 包）：
 * 无协议/相对链接原样返回；非白名单协议清空（javascript:/data: 等危险协议被拦截）。
 * 白名单与 react-markdown 一致：http/https/irc/ircs/mailto/xmpp。
 */
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;
export function defaultUrlTransform(value: string): string {
	// Windows 盘符路径（F:/... 或 F:\\...）是本地文件链接，不是协议：必须先放行，
	// 否则 "F:" 会被当作未知协议清空 href → 显式本地链接点了无反应。
	// 与 isLocalPathRef 的盘符判定同一口径。
	if (/^[a-zA-Z]:[\\/]/.test(value)) return value;
	const colon = value.indexOf(":");
	const questionMark = value.indexOf("?");
	const numberSign = value.indexOf("#");
	const slash = value.indexOf("/");

	if (
		// 无协议：相对链接
		colon === -1 ||
		// 首个冒号在 ?/#// 之后：不是协议（如 ./a:b.ts、path?x=1:2）
		(slash !== -1 && colon > slash) ||
		(questionMark !== -1 && colon > questionMark) ||
		(numberSign !== -1 && colon > numberSign) ||
		// 是协议且在安全白名单内
		SAFE_PROTOCOL.test(value.slice(0, colon))
	) {
		return value;
	}
	return "";
}

/**
 * Markdown 内的链接默认会在 Electron 窗口内导航,这里拦截点击统一用系统浏览器打开。
 * 支持文件路径链接（file:// 协议）点击打开文件。
 */
export function markdownUrlTransform(url: string): string {
	// react-markdown 默认会清空 file:// 协议；这里只放行本地文件链接，普通外链仍使用默认安全过滤。
	return url.startsWith("file://") ? url : defaultUrlTransform(url);
}

/**
 * mdast 插件：把裸文件路径和完整的 inline-code 文件引用转成 file:// 链接。
 * 普通文本只处理叶子节点，天然跳过 code / link 内的文本；inlineCode 仅在完整内容
 * 符合文件路径时转换，因此模型遵循 `path:line` 规则后，行内代码也能直接点击。
 * 匹配规则与存在性校验共用 utils/filePathLinks 的 matchPlainFilePaths（含 URL 尾巴排除），
 * 保证「渲染出的链接」与「后续 stat 校验的对象」永远同一份字符串。
 */
function encodeFileLinkTarget(path: string): string {
	return `file://${encodeURIComponent(path).replace(/%2F/g, "/").replace(/%3A/g, ":")}`;
}

/**
 * 判断 inline code 是否是一个完整的文件引用，而不是任意代码片段。
 * 带目录的路径复用裸文本识别规则；只有 inline code 才额外允许 `package.json`
 * 这类单段文件名。这样不会把普通句子里的 `main.ts` 误判成链接，但模型按规则
 * 输出的 `` `package.json:1` `` 仍然可以点击打开。
 */
export function isStandaloneFileReference(value: string): boolean {
	const raw = value.trim();
	if (!raw || raw !== value) return false;
	const location = extractFileLinkLocation(raw);
	if (!isLocalPathRef(location.path)) return false;
	const matches = matchPlainFilePaths(location.path);
	if (matches.length === 1 && matches[0]?.path === location.path) return true;
	return /^[^\\/\s<>"'`|?*\[\](){}，。；：！？、（）【】《》「」『』“”‘’·…—～￥×÷→←↑↓⇒／]+\.[\p{L}\p{N}]+$/u.test(location.path);
}

/** remark mdast 节点的最小内部形状：remark 插件边界类型包未随包引入，字段按实际访问点声明；
 * __segs/__fileLink 是本插件在 text/inlineCode 节点上挂载的私有载荷（父节点消费后整体替换并删除）。 */
type MdNode = {
	type: string;
	value?: string;
	url?: string;
	children?: MdNode[];
	__segs?: MdNode[];
	__fileLink?: MdNode;
	[key: string]: unknown;
};

export const remarkLinkifyPaths = () => {
	return (tree: MdNode) => {
		const visit = (node: MdNode) => {
			if (!node || typeof node !== "object") return;
			const type: string = node.type;
			if (type === "code" || type === "link") return;
			if (type === "inlineCode") {
				if (typeof node.value === "string" && isStandaloneFileReference(node.value)) {
					node.__fileLink = {
						type: "link",
						url: encodeFileLinkTarget(node.value),
						children: [{ type: "inlineCode", value: node.value }],
					};
				}
				return;
			}
			if (type === "text" && typeof node.value === "string") {
				const text: string = node.value;
				const matches = matchPlainFilePaths(text);
				if (matches.length === 0) return;
				const segs: MdNode[] = [];
				let last = 0;
				for (const match of matches) {
					if (match.start > last) segs.push({ type: "text", value: text.slice(last, match.start) });
					segs.push({
						type: "link",
						url: encodeFileLinkTarget(match.path),
						children: [{ type: "text", value: match.path }],
					});
					last = match.end;
				}
				// 最后一个命中之后仍有正文时必须原样补回：父节点会用 __segs **整体替换**本
				// 文本节点，少了这一段，路径之后的全部文字（含换行后的后续行）会从回复里
				// 整段消失——用户看到的现象就是「/ 后面的文本不显示」。
				// 回归来历：fb6b5667 把 while 循环重写成 for-of 时漏掉这段尾部回填，
				// 2026-09-23 经会话 jsonl 实测暴露（91 条回复 47 条丢文本）。
				// 链接文本本身等于原文路径，因此补回尾段不会改变链接已产出的部分。
				if (last < text.length) {
					segs.push({ type: "text", value: text.slice(last) });
				}
				node.__segs = segs;
				return;
			}
			const children: MdNode[] | undefined = node.children;
			if (Array.isArray(children)) {
				const next: MdNode[] = [];
				for (const child of children) {
					visit(child);
					if (child && child.__segs) {
						const segs = child.__segs;
						delete child.__segs;
						next.push(...segs);
					} else if (child && child.__fileLink) {
						const fileLink = child.__fileLink;
						delete child.__fileLink;
						next.push(fileLink);
					} else {
						next.push(child);
					}
				}
				node.children = next;
			}
		};
		visit(tree);
	};
};

/**
 * 判断是否为本地文件路径引用（无协议的相对/绝对路径）：
 * markdown 链接 [text](docs/guide.md) 的 href 无协议，此前被当作外链交给系统浏览器
 * 打开（打开方式错误/无法打开）——这里识别为本地路径，点击走 onOpenFile。
 */
export function isLocalPathRef(url: string): boolean {
	if (!url) return false;
	// Windows 盘符路径（D:\x 或 D:/x）→ 本地路径（先于协议判断，避免 D: 被当协议）
	if (/^[a-zA-Z]:[\\/]/.test(url)) return true;
	// 有协议（http/https/ftp/mailto/file/data/javascript 等）→ 外链
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
	// 锚点 / 协议相对 URL → 不拦截（保持默认行为）
	if (url.startsWith("#") || url.startsWith("//")) return false;
	return true;
}
