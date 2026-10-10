import assert from "node:assert/strict";
import test from "node:test";
import { deferred, dockHarness, tab } from "./helpers/terminalDockHarness.mjs";

/** 真实 xterm 输入回调与 IPC 替身：拒绝必须就地反馈，不重试输入或影响标签。 */
test("terminal input rejection is reported once without retrying or losing the tab", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	h.setInput(async () => {
		throw new Error("write failed");
	});
	h.typeInput("x");
	h.typeInput("y");
	await h.settle();
	assert.deepEqual(h.inputs, [
		["A", "x"],
		["A", "y"],
	]);
	assert.deepEqual(h.ids, ["A"]);
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0][0], /terminal\.inputFailed.*write failed/);
	assert.equal(h.notices[0][2], "error");
	h.unmount();
});

test("successful terminal input resets failure feedback for a later incident", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const fail = async () => {
		throw new Error("write failed");
	};
	h.setInput(fail);
	h.typeInput("x");
	await h.settle();
	h.setInput(async () => {});
	h.typeInput("y");
	await h.settle();
	h.setInput(fail);
	h.typeInput("z");
	await h.settle();
	assert.equal(h.notices.length, 2);
	assert.deepEqual(h.inputs, [
		["A", "x"],
		["A", "y"],
		["A", "z"],
	]);
	h.unmount();
});

test("initial terminal resize rejections are handled without flooding error feedback", async () => {
	const h = dockHarness([tab("A")]);
	h.setResize(async () => {
		throw new Error("resize failed");
	});
	await h.ready();
	await h.settle();
	assert.ok(h.resizes.length > 0);
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0][0], /terminal\.resizeFailed.*resize failed/);
	assert.equal(h.notices[0][2], "error");
	assert.deepEqual(h.ids, ["A"]);
	h.unmount();
});

for (const [trigger, resize] of [
	[
		"container resize",
		(h) => {
			h.resizeContainer();
			h.flushFrames();
		},
	],
	["font update", (h) => h.setSettings({ fontSize: 18 })],
	["dock height update", (h) => h.render({ height: 320 })],
]) {
	test(`${trigger} handles terminal resize rejection locally`, async () => {
		const h = dockHarness([tab("A")]);
		await h.ready();
		h.flushFrames();
		await h.settle();
		const before = h.resizes.length;
		h.setResize(async () => {
			throw new Error("resize failed");
		});
		resize(h);
		await h.settle();
		assert.ok(h.resizes.length > before);
		assert.equal(h.notices.length, 1);
		assert.match(h.notices[0][0], /terminal\.resizeFailed.*resize failed/);
		assert.equal(h.notices[0][2], "error");
		h.unmount();
	});
}

test("input and resize failures keep independent feedback and resize recovery resets it", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	h.setResize(async () => {
		throw new Error("resize failed");
	});
	h.setInput(async () => {
		throw new Error("write failed");
	});
	h.render({ height: 320 });
	h.typeInput("x");
	await h.settle();
	assert.equal(h.notices.length, 2);
	h.setResize(async () => {});
	h.render({ height: 340 });
	await h.settle();
	h.setResize(async () => {
		throw new Error("resize failed again");
	});
	h.render({ height: 360 });
	await h.settle();
	assert.equal(h.notices.length, 3);
	assert.match(h.notices[2][0], /resize failed again/);
	h.unmount();
});

for (const operation of ["input", "resize"]) {
	for (const departure of ["close", "owner switch", "unmount"]) {
		test(`late ${operation} rejection after ${departure} cannot notify the current dock`, async () => {
			const h = dockHarness([tab("A")]);
			await h.ready();
			const pending = deferred();
			if (operation === "input") {
				h.setInput(() => pending.promise);
				h.typeInput("x");
			} else {
				h.setResize(() => pending.promise);
				h.render({ height: 320 });
			}
			if (departure === "close") {
				h.closeTab("A");
				await h.settle();
			} else if (departure === "owner switch") {
				// 同 ID 在另一归属重新恢复也不应接收旧操作的迟到失败。
				h.setInput(async () => {});
				h.setResize(async () => {});
				h.render({ target: { kind: "project", projectId: "other", cwd: "/other" } });
				await h.settle();
			} else {
				h.unmount();
			}
			pending.reject(new Error("late failure"));
			if (departure !== "unmount") await h.settle();
			else for (let i = 0; i < 8; i++) await Promise.resolve();
			assert.deepEqual(h.notices, []);
			if (departure !== "unmount") h.unmount();
		});
	}
}

test("successful input and resize still use the active tab and never emit an error", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	h.typeInput("hello\r");
	h.render({ height: 320 });
	await h.settle();
	assert.deepEqual(h.inputs, [["A", "hello\r"]]);
	assert.deepEqual(h.resizes.at(-1), ["A", 80, 24]);
	assert.deepEqual(h.notices, []);
	h.unmount();
});
