# NSGo upgrade

PiDeck V2 was upgraded from the pseudo-version:

```text
github.com/nsgo-dev/nsgo v0.0.0-20261115143443-330763d1c121
```

to the latest `main` revision available on 2026-11-18:

```text
github.com/nsgo-dev/nsgo v0.1.1-0.20261117160323-0d5b51b32e46
commit 0d5b51b32e467ca1ecd125e2a0adc20fcd3c1f25
```

The `nsgo` tool is pinned to the same module revision. The most recent stable tag at the time was `v0.1.0`; this app follows the repository and skill instruction to use the latest development version because the API is still changing quickly.

The upgrade spans 417 upstream commits. The direct application benefits are:

* Windows commits IME composition before input blur, fixing mixed Chinese/English editing when focus moves.
* Focused views removed from the tree now receive blur before the next focus, and completed `AfterFunc` timers are released promptly. This reduces stale input and lifecycle callbacks in long-running workbench sessions.
* `ui.Input` now merges caller styles, lets those styles override colors, and lets multiline inputs set height. Composer and settings controls inherit the intended layout.
* Layout and text measurement fixes preserve fractional measurements and improve mixed-size wrapped text.
* Desktop menu roles, notification lifecycle and WinSparkle localization improve native behavior.
* `nsgotest` now waits for pending engine commits, supports multiple packages and selected subtests, applies target build tags and enables reactive ownership checks. Tests expose invalid signal ownership instead of hiding it.
* `ui.IconButton.IconFunc` was removed; reactive icon access is now provided by `Icon func() *core.SVG`. PiDeck's session row was migrated to the new field.
* The platform secure-store API is available for future credential work. PiDeck still keeps its existing pi auth/models JSON contracts so installed users and pi itself remain compatible.

## Structure migration

The previous root package contained roughly 330 Go files and several monoliths: `app.go` was 4652 lines, `i18n.go` 3734, and the mobile, remote, settings, chat, Git and store files ranged from roughly 1200 to 2200 lines.

The code is now organized as:

```text
main.go, root_desktop.go, root_client.go
internal/
  architecture/
  client/
  workbench/
  remotewire/
  sessionimport/
  schedule/
  viewkit/
  apptext/
  appinfo/
  crashlog/
assets/
extensions/
webassets/
scripts/
```

Large workbench and client files were split by state, events, actions, settings sections, UI regions and protocol endpoints. Session readers became an independent `sessionimport` package. Translation data moved from Go maps to embedded JSON catalogs. Web embedding now lives under `webassets/site`, leaving committed Go sources beside generated site assets.

`internal/architecture/structure_test.go` enforces the dependency direction, desktop target exclusions and maximum source size. The rules and rationale are in [ARCHITECTURE.md](../ARCHITECTURE.md).

## Validation

The upgrade and migration are validated with:

```sh
go tool nsgo check
go tool nsgo test -- -short -count=1 -timeout 20m
go run ./scripts web
```

The Web build produces a Brotli wasm around 8.5 MB in this environment, below CI's 12 MB budget. The Web-enabled Windows host build is checked locally. Other release targets remain covered by the existing CI cross-build matrix.
