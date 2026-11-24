# Contributing

Agent 协作、代码与测试规范见 [AGENTS.md](AGENTS.md)。

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing package boundaries or shared behavior.

## Workflow

```sh
go tool nsgo check
go tool nsgo test
go run ./scripts
```

Use `go tool nsgo check` and `go tool nsgo test`; they apply NSGo's catalog, build-tag and reactive-owner checks. Use `go run ./scripts` for development, packaging, Web embedding and device tasks. `go run ./scripts` is the project's thin wrapper around the same tool.

Run NSGo build/check/test commands serially in one checkout. The Windows builder writes and removes a temporary `.syso` in the module root; overlapping commands can make each other fail with "file not found". Separate CI jobs and separate worktrees can run in parallel.

Before handing off a change:

1. Format Go files with `gofmt`.
2. Run the narrow tests for the changed package.
3. Run `go tool nsgo check`.
4. Run `go tool nsgo test -- -short -count=1 -timeout 20m` for cross-cutting changes.
5. Build Web when changing client code and at least one desktop target when changing desktop code.
6. Run `git diff --check`.

## Driving the real app (optional)

NSGo 0.3.0 ships an automation server: an agent can press, type, scroll, screenshot and read the running app's windows the way a user would. It is a development tool, not part of the product.

```sh
# terminal A: the app, with automation on
go tool nsgo dev -automation

# terminal B or your agent: the MCP server that drives it
pi mcp add nsgo -- go tool nsgo mcp     # claude mcp add nsgo -- go tool nsgo mcp
```

`go tool nsgo mcp` uses the `dev -automation` session running in this directory, or starts one with the same flags and stops it when the client leaves. Only automation builds carry it, and only tools on this machine holding `.nsgo/automation.yaml` can connect.

The app's own tools ride along: `pideck_state` reads the open session, the page and the counts; `pideck_open_page` opens a workbench page; `pideck_seed_turns` fills a transcript without asking pi. They are registered in `internal/workbench/automation_tools.go` and are a no-op in release builds, so a test can call the same handlers through `automation.Call` instead of pressing its way to a state.

Two cautions. It drives the app with real data: a real `~/.pi`, real projects, and a real pi process that spends tokens if a step sends a prompt — drive UI-only flows, or point `PIDECK_V2_HOME` at a scratch folder. And saving a Go file reloads the app, which invalidates every `view:` reference the snapshot printed.

## Structure rules

Put bootstrap in the module root and application logic in `internal/`. Keep `client` and `workbench` independent. Shared code goes into a small package with a specific purpose. Add an import rule to `internal/architecture/structure_test.go` and the matching table in `ARCHITECTURE.md` for a new package.

All `sessionimport` files and all production files in `workbench` must exclude `js`, `android` and `ios`. Production files are capped at 800 lines and tests at 1000. Split a file when it mixes state, I/O, protocol parsing and rendering; keep types and small helpers with their owner.

Use stable domain IDs for keyed UI. Read reactive signals inside render callbacks, keep disk and network work off the UI goroutine, and publish results through `cx.Post`. Use `cx.Now()` for app-visible durations. No test should depend on a real sleep if `Settle`, `WaitFor`, `WaitUntil` or a manual clock can express the condition.

## Code style

Follow standard Go naming and error handling. Imports are grouped as standard library, third-party modules, then `example.com/pideck-v2/...`. Comments explain why and ownership; avoid repeating function names. Keep package APIs narrow and avoid global mutable state.

Wrap user-visible text with `apptext.T`, add all translations under `internal/apptext/locales`, and test catalog parity. Keep external file formats and credential semantics intact unless a migration is part of the task.

Do not edit generated files under `webassets/site` by hand and do not commit that directory. The embedding Go sources in `webassets/` are committed. `assets` and `extensions` own their embedded files.
