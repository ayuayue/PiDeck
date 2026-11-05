import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 回归（用户反馈「添加完项目没反应，要自己滚动才看到」）：
 * 侧栏三个分段（活动 / 聊天 / 项目）只挂载当前分段，新增项目落在「项目」分段，
 * 而默认停在「聊天」——不揭示的话列表看起来毫无变化，右侧切到了项目引导页，
 * 左侧却要手动滚动才找得到新行。
 *
 * 揭示计划（切到哪个分段、先展开哪个父项目）是纯函数，侧栏只按计划切分段 + 展开 + 滚动；
 * 这里验证计划本身，滚动定位由 SidebarContent 执行。
 */
const { planSidebarProjectReveal } = loadTsCommonJs("src/renderer/src/components/sidebar/projectRevealModel.ts");
// VM 里创建的对象原型与本 realm 不同：展开一层再深比较，否则 deepStrictEqual 会因原型不同报错。
const plan = (target, projects) => ({ ...planSidebarProjectReveal(target, projects) });

const project = (overrides = {}) => ({ id: "p-root", name: "demo", lastOpenedAt: 1, path: "/repo/demo", ...overrides });

test("工作区项目：揭示到「项目」分段里的自身行", () => {
	assert.deepEqual(plan(project(), [project()]), {
		tab: "projects",
		parentProjectId: undefined,
		projectId: "p-root",
	});
});

test("内置 Chat 只挂在「聊天」分段", () => {
	assert.equal(plan(project({ id: "p-chat", kind: "chat" }), [project({ id: "p-chat", kind: "chat" })]).tab, "chats");
});

test("worktree 子项目先展开父项目，再定位子项目行", () => {
	const parent = project({ id: "p-parent" });
	const child = project({ id: "p-child", path: "/repo/worktrees/feature", worktreeParentId: "p-parent" });
	assert.deepEqual(plan(child, [parent, child]), {
		tab: "projects",
		parentProjectId: "p-parent",
		projectId: "p-child",
	});
});

test("父项目不在清单时仍返回自身定位，不静默丢弃请求", () => {
	const orphan = project({ id: "p-orphan", worktreeParentId: "p-gone" });
	assert.deepEqual(plan(orphan, [orphan]), {
		tab: "projects",
		parentProjectId: undefined,
		projectId: "p-orphan",
	});
});

test("远端项目（没有本机路径）同样在「项目」分段揭示", () => {
	const remote = { id: "p-ssh", name: "srv", lastOpenedAt: 2, locator: { kind: "ssh", hostId: "h1", remotePath: "/srv/demo" } };
	assert.deepEqual(plan(remote, [remote]), {
		tab: "projects",
		parentProjectId: undefined,
		projectId: "p-ssh",
	});
});
