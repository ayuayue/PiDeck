# P 任务公共接线补丁（main/index.ts 由集成负责人单写）

在集成工作树中应用以下改动（三处，均在同一文件 src/main/index.ts）。这些是**必须**的接线，
否则池化/root 退休路径虽然编译通过，运行期会漏清该 root 的目录登记与保活租约。

## 1) 服务构造参数：root 退休通知（第 3385 行附近）

```diff
			// helper 1.24.0 的变更事件：只标脏事实，不触发装载（重读仍由读的人决定）。
			onHelperEvent: (entry) => remoteProjectFacts?.onHelperEvent(entry),
+			// root 会话退休（TTL/LRU/latched/显式）与主机断开是两件事：只清这个 root 的登记，不关终端。
+			onRootRetired: (entry) => remoteProjectFacts?.onRootRetired(entry),
		});
```

## 2) 事实层端口类型：事件带 sessionKey + root 退休入口（第 3445-3451 行）

```diff
	let remoteProjectFacts:
		| {
				afterWrite(projectId: string, paths: readonly string[]): void;
-				onHelperEvent(entry: { hostId: string; watchId: string; paths: readonly string[] }): void;
+				onHelperEvent(entry: { hostId: string; watchId: string; paths: readonly string[]; sessionKey: string }): void;
+				onRootRetired(entry: { hostId: string; root: string; sessionKey: string }): void;
				onHostDisconnected(hostId: string): void;
		  }
		| undefined;
```

## 3) 可选：开启池化（默认关闭，首版只在构造时选择）

不传 `rootPooling`（或传 `false`）时走原来的单会话路径，行为与 24529c394 一致。
要开启时在同一个 `createRemoteHostConnectionService({...})` 里加：

```ts
	// 空闲保温 2 条 / TTL 10 分钟 / 总预算 6 条 / 满载等待 30s；都可由设置项覆盖。
	rootPooling: { idleCapacity: 2, idleTtlMs: 10 * 60_000, maxEntries: 6, acquireTimeoutMs: 30_000 },
```

## 验证要求（接线后）

```powershell
npm run typecheck
npm run check:ipc-wiring
node --test tests/remoteHostConnectionService.test.mjs tests/remoteProjectReadIsolation.test.mjs tests/remoteProjectRootStatusIsolation.test.mjs tests/remoteRootSessionPool.test.mjs tests/remoteRootPooling.test.mjs tests/remoteDirWatchRegistry.test.mjs tests/remoteDirWatchLifecycle.test.mjs tests/remoteDirWatchDeep.test.mjs tests/remoteDirWatchSessionIsolation.test.mjs tests/remoteGitFactsBoundary.test.mjs tests/remoteFactsNotificationLoop.test.mjs tests/remoteFactsTreeInvalidation.test.mjs tests/remoteProjectDirFacts.test.mjs
```

补充（推荐，证明接线真的生效）：在 tests/remoteRootPooling.test.mjs 之外再加一条
「onRootRetired → remoteProjectFacts.onRootRetired → watchRegistry.clearSession」的接线断言，
或直接在 e2e 里断言 root 淘汰后该 root 的 watchId 不再标脏。
