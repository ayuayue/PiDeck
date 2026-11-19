import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { localGitOperationErrorText, remoteGitErrorMessage, remoteGitErrorText } = loadTsCommonJs("src/renderer/src/utils/gitErrorPresentation.ts");
const { GitInlineErrorNotice } = loadTsCommonJs("src/renderer/src/components/app/git/GitInlineErrorNotice.tsx", { stubs: { react: React } });
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");

test("local Git errors remove only Electron/execFile wrappers and preserve stderr", () => {
	const wrapped = new Error("Error invoking remote method 'git:push': Error: Command failed: git push\nfatal: no upstream branch");
	assert.equal(localGitOperationErrorText(wrapped), "fatal: no upstream branch");
	assert.equal(localGitOperationErrorText(new Error("fatal: local detail")), "fatal: local detail");
	assert.equal(localGitOperationErrorText("plain failure"), "plain failure");
	assert.equal(localGitOperationErrorText(""), "");
});

test("remote Git errors map the closed vocabulary and never expose unknown diagnostics", () => {
	assert.equal(remoteGitErrorMessage("GIT_NOT_TEXT"), zhCN["remoteGit.notText"]);
	assert.equal(remoteGitErrorMessage("GIT_WRITE_RESULT_UNCONFIRMED"), zhCN["remoteGit.writeUnknown"]);
	assert.equal(remoteGitErrorMessage("SSH_HOST_DISCONNECTED"), zhCN["remoteGit.connection"]);
	assert.equal(remoteGitErrorMessage("REQUEST_TIMEOUT"), zhCN["remoteGit.timeout"]);
	const unknown = remoteGitErrorMessage("fatal: cannot open /srv/private/repo");
	assert.equal(unknown, zhCN["remoteGit.failed"]);
	assert.doesNotMatch(unknown, /srv|fatal/i);
});

test("remote Git user text: helper 原文优先，内部说明与稳定码都不上屏", () => {
	// 稳定码即 Error.message 的失败（ProjectServiceError）不能把码当文案。
	assert.equal(remoteGitErrorText(Object.assign(new Error("GIT_NOT_REPOSITORY"), { code: "GIT_NOT_REPOSITORY", internal: "remote git refs refused" })), zhCN["remoteGit.notRepository"]);
	assert.equal(remoteGitErrorText(Object.assign(new Error("whatever"), { code: "SSH_HOST_NOT_READY", detail: "fatal: repository not found" })), "fatal: repository not found", "helper 原文优先");
	assert.equal(remoteGitErrorText({ code: "SOME_NEW_CODE" }), zhCN["remoteGit.failed"], "未收录的码摺回通用文案");
	// 没有稳定码 = 不是远端失败信封（编程错误）：保留原文便于定位。
	assert.equal(remoteGitErrorText(new Error("boom")), "boom");
});

test("compact and changes variants retain alert semantics and the local truncation contract", () => {
	const compact = renderToStaticMarkup(React.createElement(GitInlineErrorNotice, { message: "visible failure", className: "p-3 text-danger" }));
	assert.match(compact, /^<p role="alert" class="p-3 text-danger">visible failure<\/p>$/);

	const changes = renderToStaticMarkup(
		React.createElement(GitInlineErrorNotice, {
			variant: "changes",
			message: "long local stderr",
			className: "error-row",
			testId: "local-git-error",
			icon: React.createElement("svg", { "data-icon": "alert" }),
		}),
	);
	assert.match(changes, /role="alert"/);
	assert.match(changes, /data-testid="local-git-error"/);
	assert.match(changes, /data-icon="alert"/);
	assert.match(changes, /class="min-w-0 flex-1 truncate" title="long local stderr"/);
});
