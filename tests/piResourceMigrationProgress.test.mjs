import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { completedMigrationInputs, pendingMigrationLegacy, markResolvedMigrationInputs } = loadTsCommonJs("src/main/config/piResourceMigrationProgress.ts");

function legacy() {
	return {
		global: { disabledExtensions: [], disabledSkills: [], disabledPrompts: [], disableExtensionWhitelist: false },
		project: { disabledExtensions: [], disabledSkills: [], disabledPrompts: [], inheritedExtensions: [], inheritedSkills: [], inheritedPrompts: [] },
	};
}

test("completed global extension does not consume a later entry with different legacy scope", () => {
	const before = legacy();
	before.global.disabledExtensions = [{ scope: "user", source: "same" }];
	const completed = new Set();
	markResolvedMigrationInputs(before, { unresolved: [] }, completed);
	const after = legacy();
	after.global.disabledExtensions = [{ scope: "project", source: "same" }];
	assert.equal(pendingMigrationLegacy(after, completed).global.disabledExtensions.length, 1);
});

test("project names and inherited paths have distinct identities and preserve path case", () => {
	const before = legacy();
	before.project.disabledSkills = ["same"];
	before.project.inheritedSkills = ["/Skills/A"];
	const completed = new Set();
	markResolvedMigrationInputs(before, { unresolved: [] }, completed);
	const after = legacy();
	after.project.inheritedSkills = ["same", "/Skills/A", "/Skills/a"];
	assert.deepEqual([...pendingMigrationLegacy(after, completed).project.inheritedSkills], ["same", "/Skills/a"]);
});

test("old completion record leaves unsupported extension scopes pending", () => {
	const before = legacy();
	before.global.disabledExtensions = [
		{ scope: "project", source: "same" },
		{ scope: "unknown", source: "unknown" },
	];
	assert.equal(completedMigrationInputs(before, { unresolved: [] }).size, 0);
});
