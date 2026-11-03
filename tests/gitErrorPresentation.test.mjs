import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { localGitOperationErrorText, remoteGitErrorMessage } = loadTsCommonJs("src/renderer/src/utils/gitErrorPresentation.ts");
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
