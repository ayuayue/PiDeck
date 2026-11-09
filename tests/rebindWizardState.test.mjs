import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { INITIAL_REBIND_WIZARD, reduceRebindWizard } = loadTsCommonJs("src/renderer/src/utils/rebindWizardState.ts");

/** Rebind 向导状态机：5 步只允许单向推进，换 host 作废旧摘要。 */
const summary = {
	sourceHostId: "src",
	targetHostId: "dst",
	records: { projects: 1, sessions: 0 },
	referenceScan: { complete: true, count: 1 },
	warnings: [],
	tx: "idle",
};

test("合法链路：select → preview → confirm → running → result", () => {
	let state = INITIAL_REBIND_WIZARD;
	state = reduceRebindWizard(state, { type: "select-source", hostId: "src" });
	state = reduceRebindWizard(state, { type: "select-target", hostId: "dst" });
	state = reduceRebindWizard(state, { type: "previewed", summary, requestId: "req-1" });
	assert.equal(state.step, "preview");
	state = reduceRebindWizard(state, { type: "continue" });
	assert.equal(state.step, "confirm");
	state = reduceRebindWizard(state, { type: "approved" });
	assert.equal(state.step, "running");
	state = reduceRebindWizard(state, { type: "answered", outcome: { code: "REMOTE_HOST_REBIND_COMMITTED", stage: "committed", migratedProjects: 1, migratedSessions: 0, sourceRetired: true, warnings: [] } });
	assert.equal(state.step, "result");
	assert.equal(state.outcome.code, "REMOTE_HOST_REBIND_COMMITTED");
});

test("换任何一端都作废旧摘要与 requestId（否则会拿旧摘要确认新状态）", () => {
	const preview = reduceRebindWizard(reduceRebindWizard(INITIAL_REBIND_WIZARD, { type: "select-source", hostId: "src" }), { type: "previewed", summary, requestId: "req-1" });
	const changedTarget = reduceRebindWizard(preview, { type: "select-target", hostId: "dst" });
	assert.equal(changedTarget.step, "select");
	assert.equal(changedTarget.summary, null);
	assert.equal(changedTarget.requestId, null);
});

test("非法跃迁是 no-op：没有摘要不能进确认页，没在确认页不能开始执行", () => {
	assert.equal(reduceRebindWizard(INITIAL_REBIND_WIZARD, { type: "continue" }).step, "select");
	assert.equal(reduceRebindWizard(INITIAL_REBIND_WIZARD, { type: "approved" }).step, "select");
	const preview = reduceRebindWizard(INITIAL_REBIND_WIZARD, { type: "previewed", summary, requestId: "req-1" });
	assert.equal(reduceRebindWizard(preview, { type: "approved" }).step, "preview");
});

test("失败停在原步并只记稳定码", () => {
	const preview = reduceRebindWizard(INITIAL_REBIND_WIZARD, { type: "previewed", summary, requestId: "req-1" });
	const failed = reduceRebindWizard(preview, { type: "failed", code: "CONFIRMATION_CHANGED" });
	assert.equal(failed.step, "preview");
	assert.equal(failed.errorCode, "CONFIRMATION_CHANGED");
});

test("reset 回到初始态", () => {
	const result = reduceRebindWizard(INITIAL_REBIND_WIZARD, { type: "previewed", summary, requestId: "req-1" });
	assert.deepEqual(JSON.parse(JSON.stringify(reduceRebindWizard(result, { type: "reset" }))), JSON.parse(JSON.stringify(INITIAL_REBIND_WIZARD)));
});
