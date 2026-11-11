/**
 * Web 端项目命名与「智能体建到哪个项目」的取值规则。
 *
 * 抽出来的原因是两处共用：侧栏项目树与「智能体」面板的目标项目。这里守两条：
 * - 展示名：chat 项目用文案名，其余取路径末段（用户自定义别名优先）；
 * - 目标项目：优先当前上下文，失效退回对话项目 → 第一个项目 → undefined（不瞎建）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { displayProjectName, resolveTargetProjectId } = loadTsCommonJs("src/renderer/src/web/webProjectLabel.ts");
const { t } = loadTsCommonJs("src/renderer/src/i18n.ts");

const chat = { id: "chat", name: "对话", path: "/home/u/.pideck/chat", kind: "chat" };
const workspace = { id: "w1", name: "pi-desktop", path: "D:\\project\\github\\pi-desktop" };
const renamed = { id: "w2", name: "我的项目", path: "D:/work/repo" };

test("chat project renders the shared copy, not its directory name", () => {
	assert.equal(displayProjectName(chat), t("app.chatProject"));
});

test("workspace project falls back to the directory tail", () => {
	assert.equal(displayProjectName(workspace), "pi-desktop");
});

test("custom alias wins over the directory tail", () => {
	assert.equal(displayProjectName(renamed), "我的项目");
});

test("resolveTargetProjectId keeps a still-valid context project", () => {
	assert.equal(resolveTargetProjectId([chat, workspace], "w1"), "w1");
});

test("resolveTargetProjectId falls back to the chat project when the context is gone", () => {
	assert.equal(resolveTargetProjectId([workspace, chat], "deleted-project"), "chat");
});

test("resolveTargetProjectId falls back to the first project without a chat project", () => {
	assert.equal(resolveTargetProjectId([workspace, renamed], undefined), "w1");
});

test("resolveTargetProjectId returns undefined when there is nowhere to create", () => {
	assert.equal(resolveTargetProjectId([], "w1"), undefined);
});
