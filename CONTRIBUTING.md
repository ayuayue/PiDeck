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

## Structure rules

Put bootstrap in the module root and application logic in `internal/`. Keep `client` and `workbench` independent. Shared code goes into a small package with a specific purpose. Add an import rule to `internal/architecture/structure_test.go` and the matching table in `ARCHITECTURE.md` for a new package.

All `sessionimport` files and all production files in `workbench` must exclude `js`, `android` and `ios`. Production files are capped at 800 lines and tests at 1000. Split a file when it mixes state, I/O, protocol parsing and rendering; keep types and small helpers with their owner.

Use stable domain IDs for keyed UI. Read reactive signals inside render callbacks, keep disk and network work off the UI goroutine, and publish results through `cx.Post`. Use `cx.Now()` for app-visible durations. No test should depend on a real sleep if `Settle`, `WaitFor`, `WaitUntil` or a manual clock can express the condition.

## Code style

Follow standard Go naming and error handling. Imports are grouped as standard library, third-party modules, then `example.com/pideck-lite/...`. Comments explain why and ownership; avoid repeating function names. Keep package APIs narrow and avoid global mutable state.

Wrap user-visible text with `apptext.T`, add all translations under `internal/apptext/locales`, and test catalog parity. Keep external file formats and credential semantics intact unless a migration is part of the task.

Do not edit generated files under `webassets/site` by hand and do not commit that directory. The embedding Go sources in `webassets/` are committed. `assets` and `extensions` own their embedded files.
