import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 远端项目空态与本地同构：先给输入页，文件浏览是同一页的次级视图。
// 同时锁定后端门控：远端项目只能跑主机上的 pi，不能把本地 dsh/acp runtime 绑上去。

const emptyState = readFileSync("src/renderer/src/components/session/ProjectEmptyState.tsx", "utf8");
const startSurface = readFileSync("src/renderer/src/components/session/SessionStartSurface.tsx", "utf8");
const panel = readFileSync("src/renderer/src/components/session/RemoteProjectPanel.tsx", "utf8");
const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");

test("remote empty state is the composer first, files second", () => {
	assert.match(emptyState, /const \[remoteFilesOpen, setRemoteFilesOpen\] = useState\(false\)/);
	assert.match(emptyState, /if \(isRemoteProject\(remoteProject\)\) \{/);
	// 默认分支是输入页（同一个 SessionStartSurface），不再直接落到文件管理器。
	assert.match(emptyState, /if \(remoteFilesOpen\) \{[\s\S]*?<RemoteProjectPanel[\s\S]*?onBack=\{\(\) => setRemoteFilesOpen\(false\)\}/);
	assert.match(emptyState, /<SessionStartSurface[\s\S]*?bootstrapProjectId=\{remoteProject\.id\}[\s\S]*?secondaryAction=\{/);
	assert.match(emptyState, /data-testid="remote-project-browse-files"/);
	// 本地项目仍走同一输入页；远端切换不改本机行为。
	assert.match(emptyState, /return <SessionStartSurface sessionId=\{GUIDE_BOOTSTRAP_SESSION_ID\} bootstrapProjectId=\{props\.activeProject\.id\} projectSwitcher=\{projectSwitcher\} \/>;/);
});

test("start surface and file panel expose the two-way switch", () => {
	assert.match(startSurface, /secondaryAction\?: ReactNode/);
	assert.match(startSurface, /props\.projectSwitcher/);
	// 回归：SessionStartSurface 曾漏把 secondaryAction 转发给 SessionStartBody，
	// 导致真实主机空态的「浏览远端文件」入口整个消失（e2e remoteHostAcceptance:223 抓到）。
	assert.match(startSurface, /<SessionStartBody[\s\S]{0,400}secondaryAction=\{props\.secondaryAction\}/);
	assert.match(startSurface, /props\.secondaryAction !== undefined[\s\S]{0,120}props\.secondaryAction\}/);
	assert.match(panel, /onBack\?: \(\) => void/);
	assert.match(panel, /data-testid="remote-project-back"/);
});

test("remote projects are locked to pi on both the composer and first send", () => {
	// 输入页：强制 pi、隐藏后端切换器（changeBackend undefined）。
	assert.match(controller, /const isRemoteProjectSession = composerProject !== undefined && isRemoteProject\(composerProject\)/);
	assert.match(controller, /guidePageBackend: AgentBackend = isRemoteProjectSession \? "pi"/);
	assert.match(controller, /if \(isRemoteProjectSession\) return;\n\t\t\tif \(backendLocked\) return;/);
	assert.match(controller, /backend: isRemoteProjectSession \? "pi"/);
	assert.match(controller, /changeBackend: backendLocked \|\| isRemoteProjectSession \? undefined : changeBackend/);
	// 首次发送：欢迎页残留的 dsh/acp 偏好不能在远端项目上生效。
	assert.match(app, /const draftBackend = isRemoteProject\(project\) \? "pi" : \(target\?\.backend \?\? effectiveAgentBackend\)/);
});
