//go:build !js && !android && !ios

package workbench

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestReplyShortcutsStore(t *testing.T) {
	dir := t.TempDir()
	defaults, err := readReplyShortcuts(dir)
	if err != nil || len(defaults.QuickMessages) == 0 || len(defaults.ReplyActions) == 0 {
		t.Fatalf("defaults = %+v, %v", defaults, err)
	}
	data := replyShortcuts{Version: 1, QuickMessages: []string{" hello ", "hello", "世界"}, ReplyActions: []replyActionRule{{Text: "test", Triggers: []replyActionTrigger{{Kind: "onStop"}, {Kind: "textMatch", Patterns: []string{"done"}}}}}}
	if _, err := saveReplyShortcuts(dir, data); err != nil {
		t.Fatal(err)
	}
	loaded, err := readReplyShortcuts(dir)
	if err != nil || !reflect.DeepEqual(loaded.QuickMessages, []string{"hello", "世界"}) || len(loaded.ReplyActions) != 1 {
		t.Fatalf("round trip = %+v, %v", loaded, err)
	}
	if got := matchedReplyActions(loaded.ReplyActions, []turn{{Status: chat.Completed, Final: "DONE"}}); !reflect.DeepEqual(got, []string{"test"}) {
		t.Fatalf("compiled round trip = %v", got)
	}
	if _, err := saveReplyShortcuts(dir, replyShortcuts{Version: 1}); err != nil {
		t.Fatal(err)
	}
	empty, err := readReplyShortcuts(dir)
	if err != nil || len(empty.QuickMessages) != 0 || len(empty.ReplyActions) != 0 {
		t.Fatalf("empty configuration restored defaults: %+v, %v", empty, err)
	}
	if !backupPathAllowed(replyShortcutsFile) {
		t.Fatal("shortcuts missing from settings backup allowlist")
	}
	a := &app{st: &store{dir: dir}}
	raw, err := a.settingsZip()
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	names, err := settingsArchiveNames(zr)
	if err != nil || !reflect.DeepEqual(names, []string{replyShortcutsFile}) {
		t.Fatalf("backup names = %v, %v", names, err)
	}
}

func TestReplyShortcutsRejectInvalidSaveAndDegradeRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, replyShortcutsFile)
	good := replyShortcuts{Version: 1, QuickMessages: []string{"keep"}}
	if _, err := saveReplyShortcuts(dir, good); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	for _, data := range []replyShortcuts{
		{Version: 2},
		{Version: 1, QuickMessages: make([]string, replyShortcutsLimit+1)},
		{Version: 1, QuickMessages: []string{""}},
		{Version: 1, ReplyActions: []replyActionRule{{Text: "bad", Triggers: []replyActionTrigger{{Kind: "textMatch", Patterns: []string{"["}}}}}},
		{Version: 1, ReplyActions: []replyActionRule{{Text: "bad", Triggers: []replyActionTrigger{{Kind: "unknown"}}}}},
	} {
		if _, err := saveReplyShortcuts(dir, data); err == nil {
			t.Fatalf("invalid save accepted: %+v", data)
		}
		if after, _ := os.ReadFile(path); !bytes.Equal(after, before) {
			t.Fatal("rejected save changed existing file")
		}
	}
	fixture := "version: 1\nquickMessages: [hello, '']\nreplyActions:\n  - text: bad\n    triggers: [{kind: textMatch, patterns: ['[']}]\n  - text: good\n    triggers: [{kind: onStop}]\n"
	if err := os.WriteFile(path, []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := readReplyShortcuts(dir)
	if err != nil || len(data.QuickMessages) != 1 || len(data.ReplyActions) != 1 || data.ReplyActions[0].Text != "good" {
		t.Fatalf("bad item isolation = %+v, %v", data, err)
	}
	for _, raw := range []string{"not: [yaml", "version: 9\nquickMessages: [hello]", "version: 1\n---\nversion: 1", strings.Repeat("x", replyShortcutsMaxBytes+1)} {
		if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := readReplyShortcuts(dir)
		if err == nil || len(got.ReplyActions) != 0 || len(got.QuickMessages) != 0 {
			t.Fatalf("corrupt read = %+v, %v", got, err)
		}
		if after, _ := os.ReadFile(path); string(after) != raw {
			t.Fatal("corrupt file was overwritten")
		}
	}
}

func TestReplyShortcutsMatchLatestTurn(t *testing.T) {
	apptext.SetLanguage(apptext.LangZhCN)
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	data, err := prepareReplyShortcuts(defaultReplyShortcuts(), true)
	if err != nil {
		t.Fatal(err)
	}
	edit := turnStep{Tools: []toolRun{{Action: "编辑", Detail: "app.go", Status: chat.Completed}}}
	for _, tc := range []struct {
		name  string
		turns []turn
		want  []string
	}{
		{"empty", nil, nil},
		{"success", []turn{{Status: chat.Completed, Final: "你好"}}, []string{"继续"}},
		{"question", []turn{{Status: chat.Completed, Final: "请确认是否需要修改"}}, []string{"继续", "再确认一下"}},
		{"code", []turn{{Status: chat.Completed, Final: "例子：\n```\n测试通过，完成，请确认\n```\n`完成`"}}, []string{"继续"}},
		{"thinking", []turn{{Status: chat.Completed, Final: "<think>测试通过，请确认</think>你好"}}, []string{"继续"}},
		{"no edits", []turn{{Status: chat.Completed, Final: "已完成"}}, []string{"继续"}},
		{"edits", []turn{{Status: chat.Completed, Steps: []turnStep{edit}}, {Status: chat.Completed, Final: "已完成，测试通过"}}, []string{"继续", "提交", "提交并推送", "运行测试看看结果"}},
		{"failure", []turn{{Status: chat.Failed, Err: "bad request", Final: "已完成"}}, []string{"重新排查", "检查报错并修复", "重试一次"}},
		{"cancelled", []turn{{Status: chat.Cancelled, Final: "完成"}}, nil},
		{"new running turn", []turn{{Status: chat.Completed, Final: "请确认"}, {Status: chat.Running}}, nil},
		{"retry waiting", []turn{{Status: chat.Waiting, Final: "请确认"}}, nil},
		{"system", []turn{{Status: chat.Completed, Final: "完成", System: true}}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchedReplyActions(data.ReplyActions, tc.turns); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("matches = %q, want %q", got, tc.want)
			}
		})
	}
	badEdit := edit
	badEdit.Tools = []toolRun{{Action: "编辑", Detail: "app.go", Status: chat.Failed, IsError: true}}
	if got := matchedReplyActions(data.ReplyActions, []turn{{Status: chat.Completed, Final: "完成", Steps: []turnStep{badEdit}}}); !reflect.DeepEqual(got, []string{"继续"}) {
		t.Fatalf("failed edit offered commit: %v", got)
	}
	rule, _ := compileReplyAction(replyActionRule{Text: "any", Triggers: []replyActionTrigger{{Kind: "always"}}})
	if got := matchedReplyActions([]replyActionRule{rule, rule}, []turn{{Status: chat.Cancelled}}); !reflect.DeepEqual(got, []string{"any"}) {
		t.Fatalf("always / dedupe = %v", got)
	}
}

func replyShortcutFixture(t *testing.T) (*nsgotest.App, *app, *session) {
	t.Helper()
	fakeProviders(t)
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"scanPi":false,"telemetryEnabled":false,"autoModelCatalog":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sessionDraftWrites.Wait)
	var a *app
	var s *session
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		s = a.makeSession(sessionMeta{ID: "shortcuts", Title: "Shortcut fixture"}, localTarget)
		a.activeID.Set(s.ID)
		s.turns.Set([]turn{{ID: "reply-1", Status: chat.Completed, Final: "你好"}})
		return core.View{Style: ui.FillRest, Children: []core.Node{
			a.composerAccessory(s)(cx),
			a.turnReplyShortcuts(s, func() turn { return s.turns.Get()[0] }),
			a.replyShortcutSettingsDialog(),
		}}
	}, nsgotest.Size(1100, 760), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	t.Cleanup(a.closeDiag)
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.loading.GetUntracked() })
	return screen, a, s
}

func TestReplyShortcutsPickerAndDraftIsolation(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless behavior regression")
	}
	screen, a, s := replyShortcutFixture(t)
	s.draft.Set("unfinished")
	s.images.Set([]remotewire.Image{{MimeType: "image/png", Data: []byte("draft-image")}})
	a.openQuickMessages(s)
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.loading.GetUntracked() })
	screen.Type("id:quick-messages-search", "继续")
	screen.Press("id:quick-insert-继续")
	if got := s.draft.GetUntracked(); got != "unfinished\n继续" {
		t.Fatalf("insert replaced draft: %q", got)
	}
	s.draft.Set("keep me")
	s.turns.Set([]turn{{ID: "running", Status: chat.Running}})
	s.runningSig.Set(true)
	s.sendMode.Set(deliveryFollowUp)
	a.openQuickMessages(s)
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.loading.GetUntracked() })
	screen.Press("id:quick-send-继续")
	if got := s.sending.GetUntracked(); len(got) != 1 || got[0].Text != "继续" || len(got[0].Images) != 0 {
		t.Fatalf("shortcut queue = %+v", got)
	}
	if s.draft.GetUntracked() != "keep me" || len(s.images.GetUntracked()) != 1 {
		t.Fatal("direct send consumed draft or attachments")
	}
	s.retrying.Set(true)
	a.sendShortcut(s, "blocked")
	if len(s.sending.GetUntracked()) != 1 {
		t.Fatal("shortcut sent during retry")
	}
}

func TestQuickMessagesPopoverAndPhraseEditing(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless popover regression")
	}
	screen, a, s := replyShortcutFixture(t)
	if _, err := saveReplyShortcuts(a.st.dir, replyShortcuts{Version: 1, QuickMessages: []string{"🧩 first", "选择这一条"}}); err != nil {
		t.Fatal(err)
	}
	s.draft.Set("keep this draft")
	screen.Press("id:composer-quick-messages")
	screen.WaitFor("id:quick-insert-选择这一条", 5*time.Second)
	popup := screen.Find("id:quick-messages-dialog").Bounds()
	trigger := screen.Find("id:composer-quick-messages").Bounds()
	if popup.Size.Width > 340 || popup.Size.Height > 320 {
		t.Fatalf("quick phrases should be compact: popup=%+v", popup)
	}
	above := trigger.Origin.Y - (popup.Origin.Y + popup.Size.Height)
	below := popup.Origin.Y - (trigger.Origin.Y + trigger.Size.Height)
	if (above < 0 || above > 16) && (below < 0 || below > 16) {
		t.Fatalf("quick phrases should be beside their trigger: popup=%+v trigger=%+v", popup, trigger)
	}
	for _, phrase := range []string{"🧩 first", "选择这一条"} {
		screen.Find("id:quick-edit-" + phrase)
		screen.Find("id:quick-send-" + phrase)
	}
	screen.Press("id:quick-edit-选择这一条")
	screen.WaitUntil(5*time.Second, func() bool {
		return a.quickReplies.form.GetUntracked() != nil && !a.quickReplies.form.GetUntracked().busy.GetUntracked()
	})
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find("id:shortcut-phrases").Focused })
	if selection := screen.Find("id:shortcut-phrases").Selection; selection.Start != 9 || selection.End != 14 {
		t.Fatalf("editor did not select the clicked phrase in UTF-16 units: %+v", selection)
	}
	if a.quickReplies.picker.GetUntracked() != nil || s.draft.GetUntracked() != "keep this draft" {
		t.Fatal("opening phrase settings kept the picker open or changed the draft")
	}
	screen.Press("id:shortcut-cancel")
	screen.Press("id:composer-quick-messages")
	screen.WaitFor("id:quick-insert-选择这一条", 5*time.Second)
	screen.Key("Escape")
	screen.WaitUntil(5*time.Second, func() bool { return a.quickReplies.picker.GetUntracked() == nil })
}

func TestQuickMessagesPopoverListAndDismissal(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless list regression")
	}
	screen, a, _ := replyShortcutFixture(t)
	phrases := []string{strings.Repeat("很长的自定义短语", 10)}
	for i := 1; i < 13; i++ {
		phrases = append(phrases, "自定义"+strings.Repeat("x", i))
	}
	if _, err := saveReplyShortcuts(a.st.dir, replyShortcuts{Version: 1, QuickMessages: phrases}); err != nil {
		t.Fatal(err)
	}
	screen.Press("id:composer-quick-messages")
	screen.WaitFor("id:quick-edit-"+phrases[0], 5*time.Second)
	popup := screen.Find("id:quick-messages-dialog").Bounds()
	insert := screen.Find("id:quick-insert-" + phrases[0]).Bounds()
	edit := screen.Find("id:quick-edit-" + phrases[0]).Bounds()
	if insert.Origin.X+insert.Size.Width > edit.Origin.X || edit.Origin.X+edit.Size.Width > popup.Origin.X+popup.Size.Width+1 {
		t.Fatalf("long phrase pushed its edit action outside the popover: popup=%+v insert=%+v edit=%+v", popup, insert, edit)
	}
	if popup.Size.Height > 320 || screen.Exists("id:quick-edit-"+phrases[12]) {
		t.Fatal("large phrase list was not bounded and windowed")
	}
	screen.Press("id:quick-messages-more")
	screen.Find("id:quick-edit-" + phrases[12])
	screen.Type("id:quick-messages-search", "no matches")
	screen.WaitFor("text:没有匹配的快捷短语", 5*time.Second)
	screen.Find("id:quick-messages-manage")
	if !screen.Find("id:quick-messages-search").Focused {
		t.Fatal("filtering the phrase list lost input focus")
	}
	screen.Key("Escape")
	screen.WaitUntil(5*time.Second, func() bool { return a.quickReplies.picker.GetUntracked() == nil })
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find("id:composer-quick-messages").Focused })
}

func TestReplyShortcutSettingsSections(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless settings interaction")
	}
	screen, a, _ := replyShortcutFixture(t)
	a.openReplyShortcutSettings()
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.form.GetUntracked().busy.GetUntracked() })
	if bounds := screen.Find("id:reply-shortcuts-dialog").Bounds(); bounds.Size.Width > 680 {
		t.Fatalf("shortcut settings should have a readable width: %+v", bounds)
	}
	screen.Find("id:shortcut-tab-phrases")
	screen.Find("id:shortcut-tab-rules")
	screen.Type("id:shortcut-phrases", "\nkeep my phrase")
	screen.Press("id:shortcut-tab-rules")
	if screen.Exists("id:shortcut-rule-继续-patterns") {
		t.Fatal("all rule fields were expanded before selecting a rule")
	}
	screen.Press("id:shortcut-rule-继续-toggle")
	screen.Type("id:shortcut-rule-继续-text", " edited")
	screen.Type("id:shortcut-rule-继续-patterns", "done")
	screen.Press("id:shortcut-tab-phrases")
	if got := screen.Find("id:shortcut-phrases").Text; !strings.HasSuffix(got, "\nkeep my phrase") {
		t.Fatalf("switching sections lost phrase edits: %q", got)
	}
	screen.Press("id:shortcut-tab-rules")
	if got := screen.Find("id:shortcut-rule-继续-text").Text; got != "继续 edited" {
		t.Fatalf("switching sections lost rule edits: %q", got)
	}
	screen.Press("id:shortcut-rule-add")
	f := a.quickReplies.form.GetUntracked()
	rule := f.rules.GetUntracked()[len(f.rules.GetUntracked())-1]
	screen.Type("id:"+rule.id+"-text", "new reply")
	screen.Press("id:" + rule.id + "-delete")
	screen.Press("id:shortcut-cancel")
	if data, err := readReplyShortcuts(a.st.dir); err != nil || !reflect.DeepEqual(data.QuickMessages, defaultReplyShortcuts().QuickMessages) {
		t.Fatalf("cancelling settings published phrase edits: %+v, %v", data, err)
	}
}

func TestReplyShortcutsSettingsSaveAndFailure(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless persistence regression")
	}
	screen, a, _ := replyShortcutFixture(t)
	a.openReplyShortcutSettings()
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.form.GetUntracked().busy.GetUntracked() })
	f := a.quickReplies.form.GetUntracked()
	f.phrases.Set("custom\nsecond")
	f.rules.Set(nil)
	screen.Press("id:shortcut-save")
	screen.WaitUntil(5*time.Second, func() bool { return a.quickReplies.form.GetUntracked() == nil })
	if got, err := readReplyShortcuts(a.st.dir); err != nil || !reflect.DeepEqual(got.QuickMessages, []string{"custom", "second"}) || len(got.ReplyActions) != 0 {
		t.Fatalf("saved form = %+v, %v", got, err)
	}
	a.openReplyShortcutSettings()
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.form.GetUntracked().busy.GetUntracked() })
	f = a.quickReplies.form.GetUntracked()
	f.phrases.Set("do not publish")
	path := filepath.Join(a.st.dir, replyShortcutsFile)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	screen.Press("id:shortcut-save")
	screen.WaitUntil(5*time.Second, func() bool { return !f.busy.GetUntracked() })
	if a.quickReplies.form.GetUntracked() != f || f.message.GetUntracked() == "" || a.quickReplies.data.GetUntracked().QuickMessages[0] != "custom" {
		t.Fatal("failed save closed editor or published unpersisted data")
	}
}

func TestReplyShortcutsNativeLayout(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot regression")
	}
	a, screen, s := startNativeSurfaceApp(t)
	screen.RightClick("id:chat-reply")
	screen.WaitFor("id:reply-action-继续", 5*time.Second)
	screen.Screenshot("reply-shortcuts/reply")
	screen.Key("escape")
	screen.Press("id:composer-quick-messages")
	screen.WaitFor("id:quick-send-继续", 5*time.Second)
	screen.Screenshot("reply-shortcuts/picker")
	screen.Press("id:quick-edit-继续")
	screen.WaitUntil(5*time.Second, func() bool {
		return a.quickReplies.form.GetUntracked() != nil && !a.quickReplies.form.GetUntracked().busy.GetUntracked()
	})
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find("id:shortcut-phrases").Focused })
	screen.Screenshot("reply-shortcuts/settings")
	screen.Press("id:shortcut-tab-rules")
	screen.WaitFor("id:shortcut-rule-继续-toggle", 5*time.Second)
	screen.Screenshot("reply-shortcuts/settings-rules")
	screen.Press("id:shortcut-rule-继续-toggle")
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find("id:shortcut-rule-继续-text").Focused })
	screen.Screenshot("reply-shortcuts/settings-rule-edit")
	screen.Resize(760, 640)
	screen.Screenshot("reply-shortcuts/settings-narrow")
	onNativeUI(t, screen, a, func() { a.setTheme("dark") })
	screen.Screenshot("reply-shortcuts/settings-dark")
	screen.Press("id:shortcut-rule-add")
	f := a.quickReplies.form.GetUntracked()
	rule := f.rules.GetUntracked()[len(f.rules.GetUntracked())-1]
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find("id:" + rule.id + "-text").Focused })
	screen.Screenshot("reply-shortcuts/settings-new-rule")
	onNativeUI(t, screen, a, func() { a.setTheme("light"); a.quickReplies.form.Set(nil); s.draft.Set("保留未发送的草稿") })
	screen.Press("id:composer-quick-messages")
	screen.WaitFor("id:quick-send-继续", 5*time.Second)
	screen.Screenshot("reply-shortcuts/picker-narrow")
	onNativeUI(t, screen, a, func() { a.setTheme("dark") })
	screen.WaitFor("id:quick-edit-继续", 5*time.Second)
	screen.Screenshot("reply-shortcuts/picker-dark")
	screen.Key("Escape")
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find("id:composer-quick-messages").Focused })
}

func TestReplyShortcutsReactiveAndRuleEditor(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless reactive regression")
	}
	screen, a, s := replyShortcutFixture(t)
	screen.WaitFor("id:reply-action-继续", 5*time.Second)
	s.agentMode.Set(modeImage)
	screen.Settle()
	if screen.Exists("id:reply-action-strip") {
		t.Fatal("reply suggestions remained in image mode")
	}
	s.agentMode.Set(modeNormal)
	screen.WaitFor("id:reply-action-继续", 5*time.Second)
	s.turns.Set([]turn{{ID: "reply-1", Status: chat.Running}})
	screen.Settle()
	if screen.Exists("id:reply-action-strip") {
		t.Fatal("reply suggestions remained while running")
	}
	s.turns.Set([]turn{{ID: "reply-1", Status: chat.Failed, Err: "fixture"}})
	screen.WaitFor("id:reply-action-重新排查", 5*time.Second)
	a.openReplyShortcutSettings()
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.form.GetUntracked().busy.GetUntracked() })
	f := a.quickReplies.form.GetUntracked()
	screen.Press("id:shortcut-tab-rules")
	screen.Press("id:shortcut-rule-继续-toggle")
	screen.Type("id:shortcut-rule-继续-text", " more")
	if got := f.rules.GetUntracked()[0].text.GetUntracked(); got != "继续 more" {
		t.Fatalf("rule text edit = %q", got)
	}
	screen.Press("id:shortcut-rule-继续-delete")
	if len(f.rules.GetUntracked()) != 7 {
		t.Fatal("delete did not remove the selected rule")
	}
	screen.Press("id:shortcut-rule-add")
	if len(f.rules.GetUntracked()) != 8 {
		t.Fatal("add did not append a rule")
	}
	rule := f.rules.GetUntracked()[7]
	rule.patterns.Set("[")
	rule.conditionsEdited = true
	screen.Press("id:shortcut-save")
	screen.WaitUntil(5*time.Second, func() bool { return !f.busy.GetUntracked() })
	if f.message.GetUntracked() == "" || a.quickReplies.form.GetUntracked() != f {
		t.Fatal("invalid pattern was saved or editor closed")
	}
	screen.Press("id:shortcut-defaults")
	if len(f.rules.GetUntracked()) != 8 {
		t.Fatal("restore defaults did not replace rules")
	}
	screen.Press("id:shortcut-cancel")
	if a.quickReplies.form.GetUntracked() != nil {
		t.Fatal("cancel did not close the editor")
	}
}

func TestReplyShortcutsCommandRegistration(t *testing.T) {
	var quick, rules bool
	for _, cmd := range builtinCommands() {
		switch cmd.ID {
		case "quick-messages":
			quick = true
			if cmd.Shortcut != "mod+shift+m" || cmd.When == nil || cmd.Run == nil {
				t.Fatalf("quick messages command = %+v", cmd)
			}
		case "reply-shortcuts":
			rules = true
			if cmd.Run == nil {
				t.Fatal("rule management command has no handler")
			}
		}
	}
	if !quick || !rules {
		t.Fatalf("missing commands: quick=%t rules=%t", quick, rules)
	}
}
