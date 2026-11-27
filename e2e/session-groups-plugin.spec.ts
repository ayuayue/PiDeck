import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { HostPluginEvent, HostPluginSession } from "../src/shared/types/hostPlugin";
import type { SessionGroup } from "../src/shared/types/sessionGroups";

const ROOT = resolve("docs/examples/host-plugins/session-groups");
const ORIGIN = "https://session-groups.test";

type PluginFixture = {
	groups: SessionGroup[];
	sessions: HostPluginSession[];
	aliases: Record<string, string>;
	failures: Record<string, string>;
	getCalls: string[];
	saved: SessionGroup[];
	requestLimit?: number;
};

declare global {
	interface Window {
		sessionGroupsFixture: PluginFixture;
	}
}

/** 同一会话在宿主身份合并后只以存活 ID 出现在分页列表里。 */
function session(id: string): HostPluginSession {
	return { id, projectId: "project", projectName: "项目", directory: "/fixture/project", title: `会话 ${id}`, createdAt: 1, updatedAt: 2, readable: true };
}

function group(id: string, sessionIds: string[]): SessionGroup {
	return { id, name: `分组 ${id}`, color: "purple", createdAt: 1, sessionIds, dirs: ["/fixture/project"] };
}

/** 加载真实 HTML/脚本，只替换 window.pideck 边界；所有资产由本地 route 提供。 */
async function openPlugin(page: Page, input: Partial<PluginFixture>): Promise<void> {
	const fixture: PluginFixture = { groups: [], sessions: [], aliases: {}, failures: {}, getCalls: [], saved: [], ...input };
	await page.route(`${ORIGIN}/**`, (route) => {
		const name = new URL(route.request().url()).pathname.slice(1);
		if (!["app.html", "app.js", "styles.css"].includes(name)) return route.abort();
		return route.fulfill({ path: resolve(ROOT, name) });
	});
	await page.addInitScript((data: PluginFixture) => {
		window.sessionGroupsFixture = data;
		let windowAt = Date.now();
		let used = 0;
		// 与 HostPluginBroker 相同：每个实例每秒最多 20 次请求，超限在执行动作前拒绝。
		const checkBudget = () => {
			if (Date.now() - windowAt > 1000) {
				windowAt = Date.now();
				used = 0;
			}
			if (data.requestLimit && ++used > data.requestLimit) throw new Error("rate-limited");
		};
		Object.defineProperty(window, "pideck", {
			value: {
				context: {
					get: async () => {
						checkBudget();
						return { scope: "workspace", locale: "zh-CN", theme: "light" };
					},
				},
				sessions: {
					list: async (offset = 0) => {
						checkBudget();
						const entries = window.sessionGroupsFixture.sessions;
						return { sessions: structuredClone(entries.slice(offset, offset + 100)), nextOffset: offset + 100 < entries.length ? offset + 100 : null };
					},
					get: async (id: string) => {
						checkBudget();
						const host = window.sessionGroupsFixture;
						host.getCalls.push(id);
						if (host.failures[id]) throw new Error(host.failures[id]);
						const entry = host.sessions.find((item) => item.id === (host.aliases[id] || id));
						if (!entry) throw new Error("session-not-authorized");
						return structuredClone(entry);
					},
				},
				sessionGroups: {
					list: async () => {
						checkBudget();
						return structuredClone(window.sessionGroupsFixture.groups);
					},
					save: async (value: SessionGroup) => {
						checkBudget();
						const host = window.sessionGroupsFixture;
						const entry = structuredClone(value);
						host.saved.push(entry);
						const index = host.groups.findIndex((item) => item.id === entry.id);
						if (index >= 0) host.groups[index] = entry;
						else host.groups.push(entry);
						return structuredClone(host.groups);
					},
					reorder: async () => {
						checkBudget();
						return structuredClone(window.sessionGroupsFixture.groups);
					},
				},
				onEvent: (listener: (event: HostPluginEvent) => void) => {
					const handler = (event: Event) => {
						if (event instanceof CustomEvent) listener(event.detail);
					};
					window.addEventListener("fixture:host-plugin-event", handler);
					return () => window.removeEventListener("fixture:host-plugin-event", handler);
				},
			},
		});
	}, fixture);
	await page.goto(`${ORIGIN}/app.html`);
	await expect(page.locator("#scope-title")).toHaveText("全部项目");
	await expect(page.locator("#scope-stats")).toContainText(`${fixture.sessions.length} 个会话`);
}

async function catalogChanged(page: Page): Promise<void> {
	await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture:host-plugin-event", { detail: { type: "sessions.changed", detail: { catalogChanged: true } } })));
}

test("合并会话 ID 后保留分组并保存存活 ID，再次加载无需重新入组", async ({ page }) => {
	const originalGroup = group("focus", ["old"]);
	await openPlugin(page, { groups: [originalGroup], sessions: [session("current")], aliases: { old: "current" } });
	await expect.poll(() => page.evaluate(() => window.sessionGroupsFixture.saved)).toEqual([{ ...originalGroup, sessionIds: ["current"] }]);
	await expect(page.locator('[data-group-id="focus"] [data-session-id="current"]')).toHaveCount(1);
	await expect(page.locator("#status")).toBeHidden();
	const saved = await page.evaluate(() => window.sessionGroupsFixture.groups);
	const context = page.context();
	await page.close();
	const reopened = await context.newPage();
	await openPlugin(reopened, { groups: saved, sessions: [session("current")] });
	await expect(reopened.locator('[data-group-id="focus"] [data-session-id="current"]')).toHaveCount(1);
	expect(await reopened.evaluate(() => window.sessionGroupsFixture.saved)).toEqual([]);
});

test("已打开插件页时会话被合并，目录事件后仍留在原分组", async ({ page }) => {
	const originalGroup = group("focus", ["old"]);
	await openPlugin(page, { groups: [originalGroup], sessions: [session("old")] });
	await expect(page.locator('[data-group-id="focus"] [data-session-id="old"]')).toHaveCount(1);
	await page.evaluate((current: HostPluginSession) => {
		window.sessionGroupsFixture.sessions = [current];
		window.sessionGroupsFixture.aliases.old = current.id;
	}, session("current"));
	await catalogChanged(page);
	await expect(page.locator('[data-group-id="focus"] [data-session-id="current"]')).toHaveCount(1);
	await expect.poll(() => page.evaluate(() => window.sessionGroupsFixture.groups)).toEqual([{ ...originalGroup, sessionIds: ["current"] }]);
});

test("多个旧 ID 归到同一会话时按原顺序去重，跨组引用均保留", async ({ page }) => {
	const focus = group("focus", ["old", "other", "current", "older"]);
	const shared = group("shared", ["old"]);
	await openPlugin(page, { groups: [focus, shared], sessions: [session("current"), session("other")], aliases: { old: "current", older: "current" } });
	await expect
		.poll(() => page.evaluate(() => window.sessionGroupsFixture.saved))
		.toEqual([
			{ ...focus, sessionIds: ["current", "other"] },
			{ ...shared, sessionIds: ["current"] },
		]);
	expect(await page.evaluate(() => window.sessionGroupsFixture.getCalls)).toEqual(["old", "older"]);
});

test("多个分组批量修正时遵守宿主限流，所有新引用都能保存", async ({ page }) => {
	const current = session("current");
	const groups = Array.from({ length: 24 }, (_, index) => group(`group-${index}`, [`old-${index}`]));
	const aliases = Object.fromEntries(groups.map((item, index) => [`old-${index}`, current.id]));
	await openPlugin(page, { groups, sessions: [current], aliases, requestLimit: 20 });
	await expect.poll(() => page.evaluate(() => window.sessionGroupsFixture.saved.length)).toBe(groups.length);
	expect(await page.evaluate(() => window.sessionGroupsFixture.saved)).toEqual(groups.map((item) => ({ ...item, sessionIds: [current.id] })));
	await expect(page.locator("#status")).toBeHidden();
});

test("目录暂时缺少会话时保留引用，恢复后仍在原分组", async ({ page }) => {
	const originalGroup = group("focus", ["temporarily-missing"]);
	await openPlugin(page, { groups: [originalGroup] });
	await expect(page.locator("#groups")).toContainText("工作区还没有已保存的会话。");
	expect(await page.evaluate(() => window.sessionGroupsFixture.groups)).toEqual([originalGroup]);
	expect(await page.evaluate(() => window.sessionGroupsFixture.saved)).toEqual([]);
	await page.evaluate(() => {
		window.sessionGroupsFixture.sessions = [{ id: "temporarily-missing", projectId: "project", projectName: "项目", directory: "/fixture/project", title: "恢复后的会话", createdAt: 1, updatedAt: 2, readable: true }];
	});
	await catalogChanged(page);
	await expect(page.locator('[data-group-id="focus"] [data-session-id="temporarily-missing"]')).toHaveCount(1);
	expect(await page.evaluate(() => window.sessionGroupsFixture.groups)).toEqual([originalGroup]);
});

test("单次读取失败不移出分组，后续目录刷新可重新解析旧 ID", async ({ page }) => {
	const originalGroup = group("focus", ["old"]);
	await openPlugin(page, { groups: [originalGroup], sessions: [session("current")], aliases: { old: "current" }, failures: { old: "rate-limited" } });
	await expect(page.locator('[data-group-id="focus"] .card-meta')).toHaveText("0 个会话 · 0 个目录");
	expect(await page.evaluate(() => window.sessionGroupsFixture.groups)).toEqual([originalGroup]);
	expect(await page.evaluate(() => window.sessionGroupsFixture.saved)).toEqual([]);
	await page.evaluate(() => {
		window.sessionGroupsFixture.failures = {};
	});
	await catalogChanged(page);
	await expect.poll(() => page.evaluate(() => window.sessionGroupsFixture.groups)).toEqual([{ ...originalGroup, sessionIds: ["current"] }]);
	await expect(page.locator('[data-group-id="focus"] .card-meta')).toHaveText("1 个会话 · 1 个目录");
});
