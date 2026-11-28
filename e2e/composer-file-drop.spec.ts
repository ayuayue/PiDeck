import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect } from "./mock-pi-fixture";
import { settleStartupOverlays } from "./startupOverlays";

test("OS file drops preserve each reference and leave subsequent text editable", async ({ window }, testInfo) => {
	const paths = ["one.txt", "two notes.md", "three.txt"].map((name) => testInfo.outputPath(name));
	mkdirSync(dirname(paths[0]), { recursive: true });
	for (const path of paths) writeFileSync(path, "file-drop fixture");

	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await settleStartupOverlays(window);
	await composer.focus();

	// CDP supplies disk-backed File objects. An in-page DataTransfer with new File()
	// would have no path and would never reach Electron's getPathForFile branch.
	const cdp = await window.context().newCDPSession(window);
	const drop = async (files: string[]) => {
		const rect = await composer.boundingBox();
		if (!rect) throw new Error("Composer has no bounds");
		const data = { items: [], files, dragOperationsMask: 1 };
		for (const type of ["dragEnter", "dragOver", "drop"] as const) {
			await cdp.send("Input.dispatchDragEvent", { type, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, data });
		}
	};

	const chips = composer.locator('[data-type="file"]');
	await drop(paths.slice(0, 2));
	await expect(chips).toHaveText(["@one.txt", "@two notes.md"]);
	await expect(composer).toBeFocused();
	await window.keyboard.insertText("docs/summary.md");
	await expect(composer).toHaveText("@one.txt @two notes.md docs/summary.md");

	await drop(paths.slice(2));
	await expect(chips).toHaveText(["@one.txt", "@two notes.md", "@three.txt"]);
	await window.keyboard.insertText("请比较这三个文件");
	const expected = "@one.txt @two notes.md docs/summary.md @three.txt 请比较这三个文件";
	await expect(composer).toHaveText(expected);

	await window.keyboard.press("Enter");
	const sent = window.locator(".message-timeline .user-turn-text");
	await expect(sent).toHaveText(expected, { timeout: 15_000 });
});
