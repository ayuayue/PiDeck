# PiDeck Lite architecture

PiDeck Lite has one Go program with two hosts. The desktop host owns pi and ACP processes, files, Git, terminals and the loopback HTTP service. Android, iOS and Web run the client host and use that HTTP API. Both hosts render with NSGo.

## Package boundaries

Dependencies point down this list. A package may import a package below it when the table allows it; sibling hosts never import each other.

| Package | Role | Local dependencies |
| --- | --- | --- |
| module root | NSGo bootstrap, platform-specific `Root`, window frame and shutdown | `client`, `crashlog`, `workbench` |
| `internal/client` | Android, iOS, Web and desktop mobile preview | `alerts`, `assets`, `appinfo`, `apptext`, `remotewire`, `viewkit` |
| `internal/workbench` | Desktop application and loopback server | shared packages, `sessionimport`, `schedule` |
| `internal/sessionimport` | External transcript readers and pi JSONL writer | `apptext` |
| `internal/alerts` | Notification sounds: embedded sounds, default per moment, one decoded player | `assets`, NSGo |
| `internal/viewkit` | Display helpers shared by the hosts | `apptext`, NSGo |
| `internal/crashlog` | Crash reports | `appinfo` |
| `internal/remotewire` | JSON transport types | standard library |
| `internal/relaywire` | pairing link for the outbound relay | standard library |
| `internal/relay` | WebSocket relay pairing one desktop and one phone | `relaywire` |
| `internal/schedule` | cron parsing and occurrence calculation | standard library |
| `internal/apptext` | language selection and embedded catalogs | standard library |
| `internal/appinfo` | application version | standard library |
| `assets`, `extensions`, `webassets` | embedded resources and Web asset adapter | acyclic |

`cmd/pideck-relay` builds a self-hosted relay, and `infra/relay-worker` is the same protocol
as a Cloudflare Worker (the recommended deployment: no server, no fixed IP). Neither is part
of the desktop or phone binaries. The relay copies bytes only: the desktop's TLS lives inside the
tunnel, so the relay never reads the token or a session.

`internal/architecture/structure_test.go` is the executable version of this table. Every package under `internal/` needs an explicit rule there. Add the rule and this table together before introducing a package.

The workbench and client are separate application hosts. `client` must not import `workbench`, `sessionimport`, desktop services, SQLite, or process execution. Pure matching algorithms and DTOs move to packages below both hosts.

## Desktop platform isolation

Every file in `internal/sessionimport` and every production file in `internal/workbench` starts with:

```go
//go:build !js && !android && !ios
```

`sessionimport` is desktop-only as a package, so its test helpers need the same tag as its production files. Workbench tests may omit it while every production file is excluded together. Shared code belongs in `remotewire`, `schedule`, `apptext`, `viewkit`, `appinfo` or `assets`, with its own platform restrictions. The structure test checks all source files, including files excluded by the current host build. A Windows-only test run therefore cannot hide a Web or phone build break.

`internal/client` is the code WebAssembly may contain. A desktop UI import there is a boundary violation even if an individual build currently tolerates it.

## State and concurrency

Signals are the source of truth for observable state. Each fact has one owner:

* `turn.running()` decides whether a turn is running.
* Session files, config and pi responses remain the owners of their respective values; do not derive a competing kind of value in the UI.
* Views may read signals; they do not own or mutate durable application state while constructing a tree.
* Read a signal inside `ContentFunc`, `StyleFunc`, `When`, `Count` or another reactive callback when it should update. A `Get()` in a one-shot component constructor captures one value.
* Use `Untracked()` in handlers only when intentionally avoiding a dependency.
* Do work outside the UI thread. Return to the graph with `cx.Post`; use `cx.Now()` for durations users experience.
* Keep keyed controls stable across rerenders. A selection or expansion state belongs to the domain object keyed by an ID, not an ephemeral component instance.

## Package and file organization

Create packages around a stable capability, protocol or host boundary. Keep private state private; move files inside a package when they share the same state and lifecycle. Export a type only when another package genuinely needs it.

Do not add generic `util`, `common`, `models`, `helpers` or `global` packages. A helper belongs next to its caller or in a narrowly named package such as `schedule`.

Split by responsibility, not by declaration count. Suggested names are:

* `*_state`, `*_events`, `*_actions`, `*_engine` for behavior and lifecycle.
* `ui_<area>` plus `_header`, `_list`, `_dialog`, `_row` for visual regions.
* `<source>` and `convert` for adapters and shared conversion.
* `<protocol>_wire` and `<domain>_types` for transport and domain contracts.

A production Go file may not exceed 800 lines; a test file may not exceed 1000. Aim to split before 400 lines when two recognizable responsibilities appear. Do not create one function per file.

## APIs and data formats

* Code, identifiers and comments use English. User-visible text is Chinese source passed through `apptext.T` and translated in `internal/apptext/locales`.
* JSON remains where it is an external protocol: pi session JSONL, `models.json`, the remote API, backups and compatibility fixtures.
* Human-maintained configuration should be YAML when this project defines the format. Existing external JSON contracts are not migrated casually.
* Use `errors.Is`/`errors.As` for classification and `%w` when wrapping.
* Prefer context-first functions and explicit timeouts for subprocesses and network calls.
* Write imported sessions atomically in the app's own directory. Never overwrite another agent's source files.

## Tests and commands

Run repository commands through the NSGo tool:

```sh
go tool nsgo check
go tool nsgo test -- -short -count=1 -timeout 20m
go run ./scripts web
```

Use `nsgotest` selectors that match user-visible text or stable `TestID`s. A test that drives asynchronous file I/O should settle the app while waiting; manual clocks do not advance external goroutines. Tests with real process, network or disk dependencies need an explicit environment fixture or skip condition.
