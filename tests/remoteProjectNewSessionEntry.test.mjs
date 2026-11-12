import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rendererAppSource } from "./helpers/rendererAppSources.mjs";

// 远端项目没有会话时，空态原本只给文件管理：用户要先回侧栏找 hover 的「+」才能开始对话。
// 这里锁定空态上的「新建会话」主入口，并确保它走与项目行「+」同一条 createDraft 链路，
// 不复制第二套会话创建逻辑、也不把远端项目伪装成本机项目。

const panel = readFileSync("src/renderer/src/components/session/RemoteProjectPanel.tsx", "utf8");
const emptyState = readFileSync("src/renderer/src/components/session/ProjectEmptyState.tsx", "utf8");
const app = rendererAppSource;

test("remote project panel offers a real new-session entry", () => {
	assert.match(panel, /onCreateSession\?: \(\) => void/);
	assert.match(panel, /data-testid="remote-project-new-session"/);
	assert.match(panel, /onClick=\{props\.onCreateSession\}/);
	assert.match(panel, /project\.remote\.newSession/);
	// 文件浏览与终端仍在同一页，不起第二个空态实现。
	assert.match(panel, /remote-file-toolbar/);
});

test("empty state passes the app-level createDraft to remote projects only", () => {
	assert.match(emptyState, /onCreateSession\?: \(projectId: string\) => void/);
	assert.match(emptyState, /const remoteProject = props\.activeProject;/);
	assert.match(emptyState, /onCreateSession=\{props\.onCreateSession === undefined \? undefined : \(\) => props\.onCreateSession\?\.\(remoteProject\.id\)\}/);
	// 本机项目仍走 SessionStartSurface（虚拟会话 + 首次发送晋升），不被改道。
	assert.match(emptyState, /<SessionStartSurface[\s\S]*?sessionId=\{GUIDE_BOOTSTRAP_SESSION_ID\}/);
});

test("App wires the same createSessionDraftWithTab used by the sidebar +", () => {
	assert.match(app, /onCreateSession=\{createSessionDraftWithTab\}/);
	assert.match(app, /createDraft: async \(projectId\) => \{\s*await createSessionDraftWithTab\(projectId\);/);
});
