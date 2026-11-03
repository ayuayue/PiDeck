import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const localProject = { id: "project", name: "local", path: "/local" };
const remoteProject = { id: "project", name: "remote", locator: { kind: "ssh", hostId: "host", remotePath: "/remote" } };

const hostProps = {
	projectId: "project",
	gitApi: {},
	fallbackGitInfo: { current: "main", branches: ["main"] },
	fallbackSwitchBranch: () => {},
	fallbackCreateBranch: () => {},
	onOpenCommitFileDiff: () => {},
	onOpenWorkspaceFileDiff: () => {},
};

function mount(project, services = undefined) {
	const mounts = [];
	const { ProjectGitDrawer } = loadTsCommonJs("src/renderer/src/components/workspace/ProjectGitDrawer.tsx", {
		stubs: {
			"../../hooks/useProjectServices": {
				useProjectServices: (value) => {
					mounts.push(["services", value?.id]);
					return services;
				},
			},
			"./GitDrawerHost": {
				GitDrawerHost: (props) => {
					mounts.push(["local", props.gitCapabilities?.write]);
					return React.createElement("div", null, "local");
				},
			},
			"./RemoteGitPanel": {
				RemoteGitPanel: ({ project: value }) => {
					mounts.push(["remote", value.locator.hostId, value.locator.remotePath]);
					return React.createElement("div", null, "remote");
				},
			},
		},
	});
	const html = renderToStaticMarkup(React.createElement(ProjectGitDrawer, { ...hostProps, project }));
	return { html, mounts };
}

test("remote projects mount only RemoteGitPanel and do not acquire local project services", () => {
	const { html, mounts } = mount(remoteProject, { capabilities: { git: { write: true } } });
	assert.match(html, />remote</);
	assert.deepEqual(mounts, [["remote", "host", "/remote"]]);
});

test("a project identity mismatch keeps the historical local fallback", () => {
	const staleRemote = { ...remoteProject, id: "other" };
	const { html, mounts } = mount(staleRemote, { capabilities: { git: { write: false } } });
	assert.match(html, />local</);
	assert.deepEqual(mounts, [
		["services", "other"],
		["local", false],
	]);
});

test("local projects mount GitDrawerHost with the shared service capabilities", () => {
	const { html, mounts } = mount(localProject, { capabilities: { git: { write: true } } });
	assert.match(html, />local</);
	assert.deepEqual(mounts, [
		["services", "project"],
		["local", true],
	]);
});

test("a missing active project keeps the local fallback behavior", () => {
	const { html, mounts } = mount(undefined);
	assert.match(html, />local</);
	assert.deepEqual(mounts, [
		["services", undefined],
		["local", undefined],
	]);
});
