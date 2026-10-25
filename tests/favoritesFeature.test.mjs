import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 收藏功能装配契约（页面式 Tab + 本地快照）。
 *
 * 边界：收藏是 PiDeck 自己的数据（<userData>/favorites.json），不写会话文件、不改 pi 协议；
 * 入口必须覆盖「整条回复」「划选片段」两条路径，页面固定排在智能体下面。
 */
const read = (path) => readFileSync(path, "utf8");
const ipc = read("src/shared/ipc.ts");
const preload = read("src/preload/index.ts");
const previewApi = read("src/renderer/src/previewApi.ts");
const mainIndex = read("src/main/index.ts");
const store = read("src/main/favorites/FavoritesStore.ts");
const storeInput = read("src/main/favorites/favoriteInput.ts");
const favoritesIpc = read("src/main/ipc/favoritesIpc.ts");
const catalog = read("src/shared/api/domainCatalog.ts");
const pageTabs = read("src/renderer/src/utils/workspacePageTabs.ts");
const app = read("src/renderer/src/App.tsx");
const sidebar = read("src/renderer/src/components/sidebar/SidebarContent.tsx");
const favoritesPage = read("src/renderer/src/components/favorites/FavoritesPage.tsx");
const favoritesWorkspace = read("src/renderer/src/components/favorites/FavoritesWorkspace.tsx");
const favoritesHook = read("src/renderer/src/hooks/useFavorites.ts");
const contextHook = read("src/renderer/src/hooks/useMessageContextMenu.ts");
const contextMenu = read("src/renderer/src/components/session/timeline/MessageContextMenu.tsx");
const selectionToolbar = read("src/renderer/src/components/session/timeline/SelectionToolbar.tsx");
const turnRow = read("src/renderer/src/components/session/turn/TurnRow.tsx");
const timeline = read("src/renderer/src/components/session/SessionMessageTimeline.tsx");
const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");

test("IPC 三处同步：通道常量、main handler、preload 白名单", () => {
	assert.match(ipc, /favoritesList:\s*"favorites:list"/);
	assert.match(ipc, /favoritesAdd:\s*"favorites:add"/);
	assert.match(ipc, /favoritesRemove:\s*"favorites:remove"/);
	assert.match(favoritesIpc, /ipcMain\.handle\(ipcChannels\.favoritesList/);
	assert.match(favoritesIpc, /ipcMain\.handle\(ipcChannels\.favoritesAdd/);
	assert.match(favoritesIpc, /ipcMain\.handle\(ipcChannels\.favoritesRemove/);
	assert.match(preload, /favorites:\s*\{/);
	assert.match(preload, /list:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.favoritesList\)/);
	assert.match(preload, /add:\s*\(input: AddFavoriteInput\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.favoritesAdd, input\)/);
	assert.match(preload, /remove:\s*\(favoriteId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.favoritesRemove, favoriteId\)/);
	// 预览/Web 端必须保持 PiDesktopApi 形状：列表空、写操作不伪造成功
	assert.match(previewApi, /favorites:\s*\{/);
	assert.match(previewApi, /add: async \(\) => \{[\s\S]{0,80}?throw new Error\("preview stub"\)/);
});

test("主进程装配：userData/favorites.json + 注册收藏 IPC + 域清单认领", () => {
	assert.match(mainIndex, /new FavoritesStore\(join\(app\.getPath\("userData"\), "favorites\.json"\)\)/);
	assert.match(mainIndex, /registerFavoritesIpc\(\{ store: favoritesStore, appLogger \}\)/);
	assert.match(store, /FAVORITE_ENTRY_LIMIT/);
	assert.match(store, /FAVORITE_TEXT_MAX_CHARS/);
	assert.match(store, /rename\(tmpPath, this\.filePath\)/, "写盘必须是 tmp + rename（半截文件有读盘兜底）");
	assert.match(storeInput, /parseAddFavoriteInput/);
	assert.match(catalog, /id: "favorites"[\s\S]{0,200}?preloadNamespaces: \["favorites"\][\s\S]{0,120}?channelPrefix: \["favorites"\]/);
});

test("页面式 Tab：收藏排在智能体下面，标题走 i18n，失活隐藏、关闭卸载、Esc 仅当前页响应", () => {
	assert.match(pageTabs, /export type WorkspacePageId = "automation" \| "agents" \| "favorites"/);
	assert.match(pageTabs, /WORKSPACE_PAGE_ORDER[\s\S]{0,120}?\["automation", "agents", "favorites"\]/);
	assert.match(pageTabs, /export function sortWorkspacePageIds/);
	assert.match(app, /sortWorkspacePageIds\(openWorkspacePageIds\)\.map/);
	assert.match(app, /"favorites\.title"/, "页面标题必须走 favorites.title");
	assert.match(app, /<FavoritesPage active=\{activeWorkspacePage === "favorites"\}/);
	// 侧栏入口必须排在智能体下面（同一动作区，顺序即视觉顺序）
	const agentIndex = sidebar.indexOf("<AgentMarketDockButton />");
	const favoritesIndex = sidebar.indexOf("<FavoritesDockButton />");
	assert.ok(agentIndex > 0 && favoritesIndex > agentIndex, "收藏入口必须在智能体入口之后");

	assert.match(favoritesPage, /if \(!open\) return null;/);
	assert.match(favoritesPage, /!props\.active && "hidden"/);
	assert.match(favoritesPage, /if \(!open \|\| !props\.active\) return;/);
	assert.match(favoritesPage, /event\.key !== "Escape"/);
});

test("收藏页展示收藏时间、筛选与删除确认，复用统一视觉原语", () => {
	assert.match(favoritesWorkspace, /formatFullDateTime\(entry\.createdAt\)/, "收藏时间必须精确展示");
	assert.match(favoritesWorkspace, /formatRelativeTime\(entry\.createdAt\)/);
	assert.match(favoritesWorkspace, /filterFavorites\(entries \?\? \[\], query, filter\)/);
	assert.match(favoritesWorkspace, /<ConfirmDialog/);
	assert.match(favoritesWorkspace, /writeClipboard\(entry\.text\)/);
	assert.match(favoritesWorkspace, /favorites\.emptyTitle/);
	// 页面排版与智能体页一致：同一边距/分隔线/标题字号
	assert.match(favoritesWorkspace, /border-b border-border\/40 px-5 py-3/);
	assert.match(favoritesWorkspace, /<h1 className="truncate text-base font-semibold text-foreground">/);
});

test("两条收藏入口：消息右键菜单 + 划选浮层 + 回合动作条，均写同一条快照链路", () => {
	assert.match(contextHook, /useFavorites\(\)/);
	assert.match(contextHook, /favorite: \(kind: "message" \| "selection"\) => void/);
	assert.match(contextHook, /addFavorite\(\{ kind: "selection", text: current\.selectionText/);
	assert.match(contextHook, /const text = current\.messageText \? cleanMessageCopyText\(current\.messageText\)/);
	assert.match(contextMenu, /props\.onFavorite\("selection"\)/);
	assert.match(contextMenu, /props\.onFavorite\("message"\)/);
	assert.match(contextMenu, /favorites\.saveSelection/);
	assert.match(contextMenu, /favorites\.saveMessage/);
	assert.match(selectionToolbar, /data-quote-action="favorite"/);
	assert.match(selectionToolbar, /useFavorites\(\)/);
	assert.match(turnRow, /onFavoriteReply\?: \(text: string, messageId: string \| null\) => void/);
	assert.match(turnRow, /props\.onFavoriteReply\?\.\(mergedText, replyMessageId\)/);
	assert.match(timeline, /onFavoriteReply=\{handleFavoriteReply\}/);
	assert.match(timeline, /favoriteContext/);
});

test("已收藏态与详情：星标/右键菜单识别已收藏并可取消，卡片可展开完整详情", () => {
	const identity = read("src/renderer/src/components/favorites/favoriteIdentity.ts");
	assert.match(identity, /export function favoriteMessageKey/, "消息收藏身份必须是会话 + 消息 id");
	assert.match(identity, /export function collectFavoritedMessageKeys/);
	assert.match(identity, /export function findMessageFavorite/);

	assert.match(favoritesHook, /favoritedMessageKeys: ReadonlySet<string>/);
	assert.match(favoritesHook, /toggleMessageFavorite/);
	assert.match(favoritesHook, /findMessageFavorite\(entriesRef\.current/);

	// 右键菜单：命中消息时提供「取消收藏」而不是再加一条
	assert.match(contextHook, /favoritedMessageKeys\?: ReadonlySet<string>/);
	assert.match(contextHook, /messageFavorited: boolean/);
	assert.match(contextHook, /void toggleMessageFavorite\(input\)/);
	assert.match(contextMenu, /state\.messageFavorited \? t\("favorites\.unsaveMessage"\)/);

	// 回合星标：实心星 + aria-pressed 表示已收藏，再点取消
	assert.match(turnRow, /aria-pressed=\{replyFavorited\}/);
	assert.match(turnRow, /fill-current/);
	assert.match(timeline, /favoritedMessageKeys=\{favoritedMessageKeys\}/);

	// 详情：点卡片弹出右侧抽屉（与公告中心同一套 beui Drawer）展示完整正文与元信息
	assert.match(favoritesWorkspace, /function FavoriteDetailDrawer/);
	assert.match(favoritesWorkspace, /createPortal\([\s\S]{0,4000}document\.body,/, "抽屉必须 portal 到 body，不能被页面 overlay 裁剪");
	assert.match(favoritesWorkspace, /<Drawer[\s\S]{0,600}side="right"/);
	assert.match(favoritesWorkspace, /z-\[var\(--z-drawer\)\]/, "抽屉层级用 --z-drawer（980），高于弹窗 950");
	assert.match(favoritesWorkspace, /favorites\.detailTitle/);
	assert.match(favoritesWorkspace, /favorites\.detailSession/);
	assert.match(favoritesWorkspace, /favorites\.detailTime/);
	assert.match(favoritesWorkspace, /role="button"/);
	// 详情正文按 Markdown 渲染（唯一引擎 MarkdownStream，与时间线同一插件管线）；列表摘要剥离 Markdown 并压到两行
	assert.match(favoritesWorkspace, /<MarkdownStream text=\{entry\.text\} isStreaming=\{false\}/);
	assert.match(favoritesWorkspace, /stripMarkdown\(entry\.text\)/);
	assert.match(favoritesWorkspace, /line-clamp-2/);
	// 批量删除：进入选择态 → 选中卡片 → 确认框 → 一次 IPC 落盘
	assert.match(favoritesWorkspace, /removeFavorites/);
	assert.match(favoritesWorkspace, /BulkSelectionBar/);
	assert.match(favoritesWorkspace, /favorites\.batchDeleteTitle/);
	assert.match(favoritesWorkspace, /favorites\.batchDeleteBody/);
	assert.match(favoritesHook, /removeFavorites/);
	assert.match(favoritesHook, /desktopApi\.favorites\.removeMany\(ids\)/);
	assert.match(zh, /"favorites\.detailTitle"/);
	assert.match(en, /"favorites\.detailTitle"/);
	// 关联会话找不到时的兜底文案：显示「无关联会话」，不是「未知会话」
	assert.match(zh, /"favorites\.sourceUnknown": "无关联会话"/);
	assert.match(en, /"favorites\.sourceUnknown": "No linked session"/);
});

test("数据链路：收藏写入本机 JSON，页面与入口共用同一 atom 与 IPC", () => {
	assert.match(favoritesHook, /desktopApi\.favorites\.list\(\)/);
	assert.match(favoritesHook, /desktopApi\.favorites\.add\(input\)/);
	assert.match(favoritesHook, /desktopApi\.favorites\.remove\(favoriteId\)/);
	assert.match(favoritesHook, /setEntries\(\(current\) => \[entry, \.\.\.\(current \?\? \[\]\)\]\)/);
	assert.match(zh, /"favorites\.title": "收藏"/);
	assert.match(zh, /"favorites\.saved"/);
	assert.match(en, /"favorites\.title": "Favorites"/);
	assert.match(en, /"favorites\.deleteTitle"/);
});

test("模块可隐藏：外观设置「功能模块」可收起收藏入口，命令面板仍保留直达路径", () => {
	const hiddenModules = read("src/shared/hiddenModules.ts");
	const uiAtoms = read("src/renderer/src/atoms/app-ui-atoms.ts");
	const dock = read("src/renderer/src/components/sidebar/FavoritesDockButton.tsx");
	const section = read("src/renderer/src/components/app/settings/ModuleVisibilitySection.tsx");
	const palette = read("src/renderer/src/hooks/app/useCommandPalette.ts");

	assert.match(hiddenModules, /"automation", "agents", "favorites"/, "收藏必须进入可隐藏模块清单");
	assert.match(uiAtoms, /favoritesModuleHiddenAtom = atom\(\(get\) => isModuleHidden\(get\(hiddenModulesAtom\), "favorites"\)\)/);
	assert.match(dock, /useAtomValue\(favoritesModuleHiddenAtom\)/);
	assert.match(dock, /if \(hidden\) return null;/, "隐藏只摘入口，不卸载页面/数据");

	// 设置行：标题复用页面名，描述说明「只摘入口、收藏仍在」，并归入无活动徽标分支
	assert.match(section, /favorites: "favorites\.title"/);
	assert.match(section, /favorites: "settings\.modules\.favoritesDesc"/);
	assert.match(section, /case "favorites":/);

	// 隐藏不等于不可达：命令面板保留打开收藏页的命令并标注「已隐藏」
	assert.match(palette, /id: "action:open-favorites"/);
	assert.match(palette, /isModuleHidden\(hiddenModules, "favorites"\) \? t\("command\.openHiddenPageHint"\)/);
	assert.match(palette, /actions\.openFavoritesPage\(\)/);
	assert.match(zh, /"settings\.modules\.favoritesDesc"/);
	assert.match(en, /"settings\.modules\.favoritesDesc"/);
});

test("收藏拖拽排序：顺序即文件顺序，重排经 favorites:reorder 落盘", () => {
	assert.match(ipc, /favoritesReorder:\s*"favorites:reorder"/);
	assert.match(favoritesIpc, /ipcMain\.handle\(ipcChannels\.favoritesReorder/);
	assert.match(preload, /reorder:\s*\(favoriteIds: string\[\]\) => ipcRenderer\.invoke\(ipcChannels\.favoritesReorder/, "preload 必须暴露 favorites.reorder");
	// 数组顺序就是权威顺序：读盘不能再按 createdAt 重排，否则重启会抹掉用户拖出来的顺序。
	assert.ok(!/entries\.sort\(/.test(store), "FavoritesStore 读盘不得按时间重排");
	assert.match(store, /async reorder\(ids: readonly string\[\]\)/, "store 必须提供 reorder");
	assert.match(favoritesWorkspace, /useListReorder\(/, "收藏列表必须启用通用列表重排");
	assert.match(favoritesWorkspace, /reorder\.gripProps/, "收藏卡片必须有拖拽手柄");
	assert.match(favoritesHook, /reorderFavorites/, "hook 必须暴露 reorderFavorites（乐观更新 + 失败回滚）");
});
