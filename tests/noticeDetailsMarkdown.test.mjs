// toast 详情弹窗的 markdown 渲染契约（回归：公告详情曾经是一坨 `**` 原文）。
//
// 背景：toast 卡片对超长正文截断，点「查看详情」进 NoticeDetailsDialog。该弹窗原先用
// `<p whitespace-pre-wrap>` 纯文本渲染，而公告等外部内容本身就是 markdown——用户看到
// 的是满屏 `**加粗**` 与 ``` 围栏原文。契约：
//  1. 正文经 MarkdownStream（light + isStreaming=false）渲染，与会话消息/公告中心/
//     更新日志共用同一条 streamdown sanitize 管线；
//  2. 外层必须挂 `markdown-body`：MarkdownStream 自身不挂，缺了会拿到 streamdown 官方
//     稀疏密度（space-y-4 + text-3xl 标题），长段落还会因缺 min-width:0 横向撑破弹窗；
//  3. 正文滚动有上界（公告正文数千字，不限高会把弹窗顶出屏幕）；
//  4. 标题保持纯文本（单行短文本，markdown 会把 `#`/`-` 开头误判成标题/列表）；
//  5. 禁止循环 import：notice-toast 不得运行时依赖 MarkdownStream ——
//     notice-toast → MarkdownStream → MarkdownLink → utils/notice → notice-toast；
//  6. 外链强制系统浏览器（外部内容不跟随「内置浏览器」设置，与公告中心一致）
//  7. 公告中心详情抽屉（AnnouncementCenter）与 toast 详情弹窗保持同一 `markdown-body`
//     挂载点契约：同一份公告内容在不同入口的排版不允许分叉。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");
const dialog = read("src/renderer/src/components/ui-shadcn/notice-details-dialog.tsx");
const card = read("src/renderer/src/components/ui-shadcn/notice-toast.tsx");
const markdownLink = read("src/renderer/src/components/session/MarkdownLink.tsx");
const notifier = read("src/renderer/src/hooks/useAnnouncementNotifier.ts");
const announcementCenter = read("src/renderer/src/components/sidebar/AnnouncementCenter.tsx");

/** 只留运行时 import（`import type` 编译期擦除，不构成模块环）。 */
const runtimeImports = (source) => (source.match(/^import[^\n]*$/gm) ?? []).filter((line) => !/^import type\b/.test(line));

test("details dialog renders the body through MarkdownStream (light, static)", () => {
	// 空白容忍写法：biome 折行/改缩进不该让契约测试集体变红
	assert.match(dialog, /<MarkdownStream\s+text=\{payload\.description\}\s+isStreaming=\{false\}\s+light\s+onOpenExternal=\{openInSystemBrowser\}\s*\/>/);
	// 纯文本时代的「正文当普通段落渲染」必须已移除
	assert.doesNotMatch(dialog, /<p[^>]*>\{payload\.description\}/);
});

test("markdown wrapper carries the markdown-body class and a scroll bound", () => {
	assert.match(dialog, /className="markdown-body[^"]*"/);
	assert.match(dialog, /max-h-\[52vh\][\s\S]{0,40}?overflow-y-auto/);
});

test("title stays plain text", () => {
	assert.match(dialog, /whitespace-pre-wrap text-text-primary">\{payload\.title\}/);
});

test("announcement-center detail drawer keeps the same markdown-body scope", () => {
	// 公告中心详情抽屉与 toast 详情弹窗是两个入口、同一种内容：挂载点必须一致，
	// 否则公告在抽屉里是补丁后的排版、在 toast 弹窗里是完整排版，两处观感分叉
	assert.match(announcementCenter, /className="markdown-body[^"]*"[\s\S]{0,600}?<MarkdownStream/);
});

test("notice-toast keeps no runtime dependency on the markdown chain (cycle guard)", () => {
	const imports = runtimeImports(card);
	assert.ok(!imports.some((line) => line.includes('"../session/MarkdownStream"')), `notice-toast must not import MarkdownStream at runtime, got: ${imports.join(" | ")}`);
	// utils/notice 只能 type-only 引入：运行时引入就是环的另一半
	assert.ok(!imports.some((line) => line.includes('"../../utils/notice"')), `notice-toast must not import utils/notice at runtime, got: ${imports.join(" | ")}`);
	// 剪贴板写入必须复用 utils/clipboard 的 writeClipboard（Electron 主进程优先），
	// 不允许在 UI 层再写一份 navigator.clipboard 局部实现
	assert.match(card, /import \{ writeClipboard \} from "\.\.\/\.\.\/utils\/clipboard"/);
	assert.doesNotMatch(card, /navigator\.clipboard/);
	assert.match(dialog, /import \{ writeClipboard \} from "\.\.\/\.\.\/utils\/clipboard"/);
	// MarkdownLink 必须从 utils 取（从 notice-toast 取会成环）
	assert.match(markdownLink, /import \{ writeClipboard \} from "\.\.\/\.\.\/utils\/clipboard"/);
	assert.doesNotMatch(markdownLink, /^import[^\n]*ui-shadcn\/notice-toast/m);
});

test("announcement toast comment no longer claims plain-text rendering", () => {
	// 旧注释「正文纯文本展示（与公告中心一致，不做 markdown 渲染，控制攻击面）」已过时，
	// 留着会误导下一个人把详情弹窗改回纯文本
	assert.doesNotMatch(notifier, /不做 markdown 渲染/);
});
