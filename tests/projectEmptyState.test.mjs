import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const emptyState = readFileSync("src/renderer/src/components/session/ProjectEmptyState.tsx", "utf8");
const startSurface = readFileSync("src/renderer/src/components/session/SessionStartSurface.tsx", "utf8");
const workspaceChrome = readFileSync("src/renderer/src/hooks/useSessionWorkspaceChrome.ts", "utf8");
const composerAtoms = readFileSync("src/renderer/src/atoms/composer-atoms.ts", "utf8");
const chatBootstrap = readFileSync("src/renderer/src/utils/chatSessionBootstrap.ts", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("empty state renders the new-session surface bound to a renderer-only virtual session", () => {
	// 无会话空态（启动 / 清空全部 Tab）与「新建 Agent」页面同源：直接挂
	// SessionStartSurface，绑定虚拟会话 ID——不创建 Catalog 记录、不拉起 pi。
	assert.match(emptyState, /SessionStartSurface/);
	assert.match(emptyState, /GUIDE_BOOTSTRAP_SESSION_ID/);
	assert.match(emptyState, /<SessionStartSurface\n\s+sessionId=\{GUIDE_BOOTSTRAP_SESSION_ID\}/);
	assert.match(chatBootstrap, /GUIDE_BOOTSTRAP_SESSION_ID = "renderer:guide-bootstrap"/);
});

test("empty state no longer auto-creates sessions (startup / closing all tabs)", () => {
	// 回归：曾有的「关闭全部 Tab 自动建匿名会话并激活」循环已移除——引导页挂载
	// 只显示空白输入框，首次发送才创建真实会话。闸门状态 allTabsClosedByUser
	// 随之删除。
	assert.doesNotMatch(emptyState, /autoCreateOnMount/);
	assert.doesNotMatch(emptyState, /autoCreatedRef|useEffect\(/);
	assert.doesNotMatch(app, /autoCreateOnMount/);
	assert.doesNotMatch(app, /startupDraftProjectId/);
	assert.doesNotMatch(workspaceChrome, /allTabsClosedByUser/);
	assert.doesNotMatch(workspaceChrome, /setAllTabsClosedByUser/);
});

test("virtual session is promoted to a real catalog session on first send", () => {
	// App.ensureSessionForSend：虚拟会话发送时统一创建项目 draft 会话（Chat 项目
	// 也走普通可保存会话，不再匿名——匿名仅保留给侧栏「新建临时对话」入口），
	// composer 状态整体提升（promoteSessionComposerStateAtom），选中并登记 Tab；
	// 并发发送复用同一个提升 promise。
	assert.match(app, /sessionId !== GUIDE_BOOTSTRAP_SESSION_ID/);
	assert.match(app, /guideBootstrapPromotionRef/);
	assert.match(app, /api\.sessions\.createDraft/);
	assert.doesNotMatch(app, /guideBootstrapPromotionRef[\s\S]{0,400}api\.sessions\.createAnonymous/);
	assert.match(app, /promoteSessionComposerState/);
	// 乐观气泡必须「搬」到真实会话：虚拟会话 ID 是常量，直接拷贝会让残留消息
	// 在下一次引导页发送时被当作 previousMessages 追加（新会话漏出旧消息）。
	assert.match(app, /promoteSessionMessagesCache\(\{\s*fromSessionId:\s*GUIDE_BOOTSTRAP_SESSION_ID/);
	assert.doesNotMatch(app, /sessionMessagesCacheAtom\)\[GUIDE_BOOTSTRAP_SESSION_ID\]/);
	assert.match(app, /registerOpenSession\(session\.id, "permanent"\)/);
	assert.match(composerAtoms, /promoteSessionComposerStateAtom/);
	assert.match(composerAtoms, /sessionDraftByIdAtom/);
	assert.match(composerAtoms, /sessionAttachmentsByIdAtom/);
	assert.match(composerAtoms, /sessionComposerModeByIdAtom/);
	assert.match(composerAtoms, /sessionSendStateByIdAtom/);
});

test("empty state offers a project switcher listing joined projects", () => {
	// 引导页 Logo 下方的项目名升级为下拉：列出已加入的全部项目（含内置 Chat），
	// 切换只走 selectProject 语义（换 activeProjectId，不创建会话）；发送时按
	// 选中项目创建。
	assert.match(emptyState, /projects: Project\[\]/);
	assert.match(emptyState, /onSelectProject: \(projectId: string\) => void/);
	assert.match(emptyState, /projectSwitcher=\{/);
	assert.match(emptyState, /props\.projects\.map/);
	assert.match(emptyState, /isChatProject\(project\) \? t\("app\.chatProject"\) : project\.name/);
	assert.match(emptyState, /value=\{props\.activeProject\.id\}/);
	assert.match(emptyState, /onValueChange=\{props\.onSelectProject\}/);
	// SessionStartSurface 接收的是 ReactNode 槽位（projectSwitcher），不再是纯文本 projectLabel
	assert.match(startSurface, /projectSwitcher\?: ReactNode/);
	// App 装配：传入项目列表与 selectProject 命令
	assert.match(app, /projects=\{projects\}/);
	assert.match(app, /onSelectProject=\{selectProjectCommand\}/);
});

test("empty state keeps the add-project entry only when no project exists", () => {
	assert.match(emptyState, /!props\.activeProject/);
	assert.match(emptyState, /t\("app\.addProject"\)/);
	assert.match(app, /onAddProject=\{\(\) => void addProject\(\)\}/);
});

test("empty-state copy is bilingual and JSX carries no hardcoded text", () => {
	for (const key of ["app.addProject", "app.guideBootstrapUnavailable", "app.guideProjectPicker", "app.chatProject"]) {
		assert.ok(zh.includes(`"${key}"`), `${key} zh-CN copy must exist`);
		assert.ok(en.includes(`"${key}"`), `${key} en-US copy must exist`);
	}
	assert.doesNotMatch(emptyState, />[^<]*(在|开始工作|Start working|尚未)</);
});
