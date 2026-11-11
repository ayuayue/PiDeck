import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// jotai 必须一并 stub：不 stub 就会 require 到真实的 jotai/react，
// 而 node:test 里没有 React dispatcher，一调 useStore 就
// "Cannot read properties of null (reading 'useContext')"（dev 上这两条红的主因）。
// 这里关心的是删除后的 reconcile 行为，不需要真正的 atom 存储。
const jotaiStub = { useSetAtom: () => () => undefined, useAtomValue: () => undefined, useStore: () => ({ get: () => undefined, set: () => undefined }), atom: (init) => ({ init }) };
const { useSessionActions } = createTsSandbox({ stubs: { "../i18n": { t: (key) => key }, jotai: jotaiStub } })("src/renderer/src/hooks/useSessionActions.ts");

function setup(deleteRecord = async () => true) {
	const events = [];
	const session = { id: "session-a", projectId: "p", environment: "native", name: "会话-A" };
	const actions = useSessionActions({
		activeProjectId: "p",
		getProjectSessionRecords: () => [session],
		closeTabs: (ids) => events.push(["close", ...ids]),
		removeSessionState: (id) => events.push(["remove", id]),
		removeSessionComposerState: (id) => events.push(["composer", id]),
		api: { sessions: { deleteRecord } },
		showToast: (message) => events.push(["toast", message]),
		refreshProjectSessions: async (projectId, silent = false) => {
			events.push(["refresh", projectId, silent]);
			return [];
		},
	});
	return { actions, events, session };
}

test("successful session deletion reconciles without loading the whole project again", async () => {
	const { actions, events, session } = setup();
	await actions.deleteHistorySession(session);
	assert.deepEqual(
		events.find(([kind]) => kind === "refresh"),
		["refresh", "p", true],
	);
	assert.deepEqual(events.slice(0, 3), [
		["close", "session-a"],
		["remove", "session-a"],
		["composer", "session-a"],
	]);
});

test("failed session deletion preserves its row and does not trigger list refresh", async () => {
	const { actions, events, session } = setup(async () => {
		throw new Error("Recycle bin unavailable");
	});
	await actions.deleteHistorySession(session);
	assert.deepEqual(events, [["toast", "Recycle bin unavailable"]]);
});
