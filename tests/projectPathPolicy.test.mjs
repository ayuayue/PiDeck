import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { projectPathKey, isEphemeralProjectPath, isDismissedProjectPath, shouldAutoRegisterForeignCwd } = loadTsCommonJs("src/main/projects/projectPathPolicy.ts");

test("projectPathKey ignores trailing separators and Windows case", () => {
	assert.equal(projectPathKey("C:\\Users\\14012\\AppData\\Local\\Temp\\pideck-mockpi-3auU0p\\profile\\chat-workspace\\"), projectPathKey("c:/Users/14012/AppData/Local/Temp/pideck-mockpi-3auU0p/profile/chat-workspace"));
});

test("e2e mockpi chat-workspace is ephemeral and must not auto-register", () => {
	const cwd = "C:\\Users\\14012\\AppData\\Local\\Temp\\pideck-mockpi-3auU0p\\profile\\chat-workspace";
	assert.equal(isEphemeralProjectPath(cwd), true);
	assert.equal(shouldAutoRegisterForeignCwd(cwd), false);
});

test("user-dismissed path is not auto-registered even if the folder still exists", () => {
	const cwd = "D:\\work\\alpha";
	assert.equal(isDismissedProjectPath(cwd, ["D:/work/alpha/"]), true);
	assert.equal(
		shouldAutoRegisterForeignCwd(cwd, {
			dismissedPaths: ["D:\\work\\alpha"],
			pathExists: true,
		}),
		false,
	);
});

test("missing directory is not auto-registered", () => {
	assert.equal(shouldAutoRegisterForeignCwd("D:\\work\\gone", { pathExists: false }), false);
});

test("ordinary existing workspace still auto-registers", () => {
	assert.equal(shouldAutoRegisterForeignCwd("D:\\work\\alpha", { pathExists: true }), true);
});
