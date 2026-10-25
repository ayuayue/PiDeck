import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const injector = readFileSync("src/renderer/src/components/session/SessionRuntimeInjector.tsx", "utf8");
const services = readFileSync("src/renderer/src/components/session/SessionPaneServices.tsx", "utf8");
const hookSource = readFileSync("src/renderer/src/hooks/usePaneGitInfo.ts", "utf8");

/**
 * 分屏中的 Git 分支属于会话所在项目（worktree），不能跟随 App 的聚焦项目。
 * 这个契约覆盖用户操作链：点击任一栏会改变 activeProjectId，但另一栏的分支展示与切换目标必须保持不变。
 */
describe("session pane git project scope", () => {
	it("loads and switches Git branches with the pane project id", () => {
		// 栏级 hook 以本栏项目为参数；分支 chip 由栏内状态驱动（不再注入聚焦项目的全局 gitInfo）。
		assert.match(injector, /usePaneGitInfo\(paneProjectId/);
		assert.match(injector, /gitInfo=\{paneGit\.gitInfo\}/);
		assert.match(injector, /onSwitchBranch=\{paneGit\.switchBranch\}/);
		// hook 内部：读取与切换必须带项目参数，绝不落到无参全局调用。
		assert.match(hookSource, /desktopApi\.git\.branches\(projectId\)/);
		assert.match(hookSource, /desktopApi\.git\.checkout\(projectId, branch\)/);
	});

	it("does not inject the focused project's Git state into every pane", () => {
		assert.doesNotMatch(injector, /gitInfo=\{services\.gitInfo\}/);
		assert.doesNotMatch(injector, /onSwitchBranch=\{services\.onSwitchBranch\}/);
		// 共享服务不再暴露全局面 gitInfo / 无项目参数的切换回调。
		assert.doesNotMatch(services, /gitInfo:\s*GitBranchInfo/);
		assert.doesNotMatch(services, /onSwitchBranch:\s*\(branch:\s*string\)/);
		// App 侧不再把全局 gitInfo / switchBranch 注入 pane 服务。
		const app = readFileSync("src/renderer/src/App.tsx", "utf8");
		assert.doesNotMatch(app, /sessionPaneServices[\s\S]{0,400}?gitInfo,/, "App 不得把全局 gitInfo 包进 sessionPaneServices");
		assert.doesNotMatch(app, /onSwitchBranch:\s*switchBranch/, "App 不得把全局 switchBranch 包进 sessionPaneServices");
	});

	describe("usePaneGitInfo behavior", () => {
		/** 构造可注入 React hooks 与 desktopApi 的沙箱，驱动 hook 行为。 */
		function runHook() {
			// 模拟 React:state 按调用序存取;effects 收集后由测试手动驱动(充当挂载效应)。
			const states = [];
			const effects = [];
			let stateSeq = 0;
			const reactMock = {
				useState(initial) {
					const id = stateSeq++;
					if (!(id in states)) states[id] = initial;
					const set = (v) => {
						states[id] = typeof v === "function" ? v(states[id]) : v;
					};
					return [states[id], set];
				},
				useEffect(fn) {
					effects.push(fn);
				},
				useCallback(fn) {
					return fn;
				},
				useRef(initial) {
					return { current: initial };
				},
			};
			const gitCalls = [];
			// refs 事件源 mock：与真实 preload 行为对齐——watchRefs 返回 watchId，
			// onRefsChanged 返回退订函数；事件由测试按需手动触发。
			const refsListeners = [];
			let watchSeq = 0;
			const gitApiMock = {
				branches: async (projectId) => {
					gitCalls.push(["branches", projectId]);
					// 每个项目有独立分支集，模拟两个 worktree 处于不同分支。
					return {
						current: projectId === "projectA" ? "branch-a" : "branch-b",
						branches: ["branch-a", "branch-b"],
					};
				},
				checkout: async (projectId, branch) => {
					gitCalls.push(["checkout", projectId, branch]);
					return { current: branch, branches: ["branch-a", "branch-b"] };
				},
				watchRefs: async (projectId) => {
					gitCalls.push(["watchRefs", projectId]);
					watchSeq += 1;
					return `watch-${watchSeq}`;
				},
				unwatchRefs: async (watchId) => {
					gitCalls.push(["unwatchRefs", watchId]);
				},
				onRefsChanged: (listener) => {
					refsListeners.push(listener);
					return () => {
						const index = refsListeners.indexOf(listener);
						if (index >= 0) refsListeners.splice(index, 1);
					};
				},
			};
			const js = ts.transpileModule(hookSource, {
				compilerOptions: {
					module: ts.ModuleKind.CommonJS,
					target: ts.ScriptTarget.ES2020,
					esModuleInterop: true,
				},
			}).outputText;
			const context = vm.createContext({
				module: { exports: {} },
				exports: {},
				require(spec) {
					if (spec === "react") return reactMock;
					if (spec.endsWith("desktopApi")) return { desktopApi: { git: gitApiMock } };
					throw new Error(`unexpected require: ${spec}`);
				},
				window: {
					setInterval: () => 1,
					clearInterval: () => {},
				},
				Promise,
			});
			const wrapped = `const module = { exports: {} };\nconst exports = module.exports;\n${js}\nmodule.exports.usePaneGitInfo;`;
			// vm.runInContext 返回最后一个表达式的值，避免被 const module 词法声明遮蔽读不回 exports。
			const bareHook = vm.runInContext(wrapped, context);
			// 每次调用视为一次渲染：state slot 按调用序从 0 复用（与 React 一致），
			// 测试可重渲染读取最新状态；effect 仍被收集进本次实例的 effects 数组。
			const usePaneGitInfo = (projectId, options) => {
				stateSeq = 0;
				return bareHook(projectId, options);
			};
			return {
				usePaneGitInfo,
				hooks: { states, effects, gitCalls },
				runEffects: async () => {
					// 消费当前收集的所有 effect（含异步 refresh），再等待微任务落定。
					while (effects.length) {
						effects.shift()();
						await new Promise((resolve) => setImmediate(resolve));
					}
				},
				gitCalls,
				assertNoCheckout: () => {
					assert.ok(
						gitCalls.every((c) => c[0] !== "checkout"),
						"不应发生任何 checkout",
					);
				},
			};
		}

		it("polls and checks out strictly with its own pane project id", async () => {
			const paneA = runHook();
			// 挂载 栏A(projectA): 轮询必须落到 projectA。
			paneA.usePaneGitInfo("projectA");
			await paneA.runEffects();
			// 重渲染读取最新状态（React 语义：state 更新后重新渲染才可见）。
			let hook = paneA.usePaneGitInfo("projectA");
			assert.equal(hook.gitInfo.current, "branch-a");
			assert.deepEqual(
				paneA.gitCalls.filter((c) => c[0] === "branches").map((c) => c[1]),
				["projectA"],
			);

			// 栏A 内切分支: checkout 目标必须是 projectA。
			await hook.switchBranch("branch-b");
			assert.deepEqual(
				paneA.gitCalls.filter((c) => c[0] === "checkout"),
				[["checkout", "projectA", "branch-b"]],
			);
			hook = paneA.usePaneGitInfo("projectA");
			assert.equal(hook.gitInfo.current, "branch-b");
		});

		it("two panes on different worktrees stay isolated (user bug scope)", async () => {
			// 栏A 与 栏B 各挂载一份 hook: 互不共享状态, 切换也不落到对方项目。
			const paneA = runHook();
			const paneB = runHook();
			paneA.usePaneGitInfo("projectA");
			paneB.usePaneGitInfo("projectB");
			await paneA.runEffects();
			await paneB.runEffects();

			let hookA = paneA.usePaneGitInfo("projectA");
			let hookB = paneB.usePaneGitInfo("projectB");
			assert.equal(hookA.gitInfo.current, "branch-a");
			assert.equal(hookB.gitInfo.current, "branch-b");

			// 栏B 切分支只影响 projectB; 栏A 的状态与项目参数不受影响。
			await hookB.switchBranch("branch-a");
			assert.deepEqual(
				paneB.gitCalls.filter((c) => c[0] === "checkout"),
				[["checkout", "projectB", "branch-a"]],
			);
			hookA = paneA.usePaneGitInfo("projectA");
			assert.equal(hookA.gitInfo.current, "branch-a");
			paneA.assertNoCheckout();
		});

		it("notifies onChanged only with the pane project id", async () => {
			const pane = runHook();
			const changed = [];
			const hook = pane.usePaneGitInfo("projectA", {
				onChanged: (projectId, info) => changed.push([projectId, info.current]),
			});
			await pane.runEffects();
			// 轮询不回调（App 自身按聚焦项目轮询）；只有本栏主动切换才通知 App 同步。
			assert.deepEqual(changed, []);
			await hook.switchBranch("branch-b");
			assert.deepEqual(changed, [["projectA", "branch-b"]]);
		});
	});
});
