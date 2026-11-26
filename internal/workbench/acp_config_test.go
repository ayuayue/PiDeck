//go:build !js && !android && !ios

package workbench

// Checks ACP config options: the string-or-boolean value, the tolerant
// option list, the type a switch is sent with, and what a preset replays.

import (
	"encoding/json"
	"os"
	"testing"
)

// TestACPConfigOptionReadsSwitches reads a response whose options mix a
// select, a switch, an unreadable entry and a number.
func TestACPConfigOptionReadsSwitches(t *testing.T) {
	var cfg acpSessionConfig
	body := `{"configOptions":[
		{"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"auto",
		 "options":[{"value":"auto","name":"Auto"},{"group":"more","name":"More","options":[{"value":"fullAccess","name":"Full access"}]}]},
		{"id":"auto_approve","name":"Auto approve","type":"boolean","currentValue":true},
		{"id":"broken","name":42},
		{"id":"budget","name":"Budget","type":"select","currentValue":4096}
	]}`
	if err := json.Unmarshal([]byte(body), &cfg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(cfg.Options) != 3 {
		t.Fatalf("options = %+v, want the unreadable entry skipped", cfg.Options)
	}
	mode := cfg.Options[0]
	if mode.isBool() || mode.CurrentValue.text() != "auto" {
		t.Fatalf("mode = %+v", mode)
	}
	if choices := mode.Choices(); len(choices) != 2 || choices[1].Value != "fullAccess" {
		t.Fatalf("grouped choices = %+v", choices)
	}
	if !mode.hasValue(acpTextValue("fullAccess")) || mode.hasValue(acpTextValue("yolo")) {
		t.Fatal("a select should only accept its own values")
	}
	approve := cfg.Options[1]
	if !approve.isBool() || !approve.CurrentValue.truthy() || approve.Choices() != nil {
		t.Fatalf("switch = %+v", approve)
	}
	if !approve.hasValue(acpBoolValue(false)) || approve.hasValue(acpTextValue("true")) {
		t.Fatal("a switch should only accept booleans")
	}
	// A bare number is not the protocol's shape, but reading it as text
	// keeps the entry instead of failing its siblings.
	if budget := cfg.Options[2]; budget.CurrentValue.text() != "4096" {
		t.Fatalf("number value = %+v", budget)
	}
}

// TestACPConfigValueWireShapes checks each value marshals back as its own
// shape, which is what the agent validates.
func TestACPConfigValueWireShapes(t *testing.T) {
	for _, c := range []struct {
		value acpConfigValue
		want  string
	}{
		{acpBoolValue(true), "true"},
		{acpBoolValue(false), "false"},
		{acpTextValue("fullAccess"), `"fullAccess"`},
		{acpConfigValue{}, "null"},
	} {
		raw, err := json.Marshal(c.value)
		if err != nil || string(raw) != c.want {
			t.Errorf("marshal(%+v) = %s, %v; want %s", c.value, raw, err, c.want)
		}
	}
	// Booleans are kept as text in config.json so the file keeps the shape
	// older builds read; the preference turns them back into a switch.
	if text := acpPreferenceText(acpBoolValue(true)); text != "true" {
		t.Fatalf("preference text = %q", text)
	}
	if value := acpPreferredValue(acpConfigOption{Type: "boolean"}, "false"); !value.isBool() || value.truthy() {
		t.Fatalf("stored switch = %+v", value)
	}
	if value := acpPreferredValue(acpConfigOption{Type: "select"}, "false"); value.isBool() || value.text() != "false" {
		t.Fatalf("stored select = %+v", value)
	}
	if value := acpPreferredValue(acpConfigOption{Type: "boolean"}, "bogus"); value.isSet() {
		t.Fatalf("unreadable switch = %+v", value)
	}
}

// TestACPOptionMirrorsModes checks a mode config option is hidden only when
// it carries exactly ACP's own modes.
func TestACPOptionMirrorsModes(t *testing.T) {
	modes := []acpMode{{ID: "ask", Name: "Ask"}, {ID: "code", Name: "Code"}}
	option := acpConfigOption{ID: "mode", Category: "mode", Type: "select",
		Values: json.RawMessage(`[{"value":"ask","name":"Ask"},{"value":"code","name":"Code"}]`)}
	if !acpOptionMirrorsModes(option, modes) {
		t.Fatal("the same values were not seen as ACP's modes")
	}
	option.Values = json.RawMessage(`[{"value":"auto","name":"Auto"},{"value":"fullAccess","name":"Full access"}]`)
	if acpOptionMirrorsModes(option, modes) {
		t.Fatal("a different mode list was treated as a duplicate")
	}
	if acpOptionMirrorsModes(option, nil) {
		t.Fatal("no ACP modes should never mirror")
	}
}

// TestACPConfigOptionClassifies finds the model and thinking options the
// composer shows as chips, without mistaking a model parameter for a model.
func TestACPConfigOptionClassifies(t *testing.T) {
	cases := []struct {
		option acpConfigOption
		want   acpOptionKind
	}{
		{acpConfigOption{ID: "model", Category: "model"}, acpOptionModel},
		{acpConfigOption{ID: "reasoning_effort", Category: "thought_level"}, acpOptionThinking},
		{acpConfigOption{ID: "permission_mode", Category: "mode"}, acpOptionMode},
		{acpConfigOption{ID: "temperature", Category: "model_config"}, acpOptionOther},
		{acpConfigOption{ID: "deep_thinking", Name: "Deep Thinking"}, acpOptionThinking},
		{acpConfigOption{ID: "anything", Name: "Model"}, acpOptionModel},
	}
	for _, c := range cases {
		if got := c.option.kind(); got != c.want {
			t.Errorf("kind(%+v) = %v, want %v", c.option, got, c.want)
		}
	}
}

// startFakeACP starts the fake agent and opens a session.
func startFakeACP(t *testing.T) (*acpClient, string, acpModeState) {
	t.Helper()
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=^TestFakeACPAgent$"}, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.stop)
	if _, err := c.initialize(); err != nil {
		t.Fatal(err)
	}
	sid, state, err := c.newSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return c, sid, state
}

// TestACPSetConfigOptionSendsBooleanType writes both kinds of option: the
// fake agent rejects a bare boolean the way CodeBuddy does.
func TestACPSetConfigOptionSendsBooleanType(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") == "1" {
		t.Skip("the helper process")
	}
	t.Setenv("PIDECK_FAKE_ACP", "1")
	c, sid, state := startFakeACP(t)
	idx := acpModeOptionIndex(state.Options)
	if idx < 0 {
		t.Fatalf("no mode option in %+v", state.Options)
	}
	var approve acpConfigOption
	for _, option := range state.Options {
		if option.ID == "auto_approve" {
			approve = option
		}
	}
	if !approve.isBool() {
		t.Fatalf("switch = %+v", approve)
	}
	options, err := c.setConfigOption(sid, approve, acpBoolValue(true))
	if err != nil {
		t.Fatalf("a switch was rejected: %v", err)
	}
	if len(options) != 3 || !options[1].CurrentValue.truthy() {
		t.Fatalf("table = %+v", options)
	}
	if _, err := c.setConfigOption(sid, state.Options[idx], acpTextValue("fullAccess")); err != nil {
		t.Fatalf("a select was rejected: %v", err)
	}
}

// TestACPSessionToleratesUnreadableOption checks one bad entry no longer
// fails the whole session.
func TestACPSessionToleratesUnreadableOption(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") == "1" {
		t.Skip("the helper process")
	}
	t.Setenv("PIDECK_FAKE_ACP", "1")
	t.Setenv("PIDECK_FAKE_ACP_BAD_OPTION", "1")
	_, _, state := startFakeACP(t)
	if len(state.Options) != 3 {
		t.Fatalf("options = %+v, want the bad entry skipped", state.Options)
	}
}

// TestACPSessionAppliesPresetAccess checks a preset's bypass switch is set
// on a new session and wins over an older remembered mode.
func TestACPSessionAppliesPresetAccess(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") == "1" {
		t.Skip("the helper process")
	}
	t.Setenv("PIDECK_FAKE_ACP", "1")
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.change(func(c *config) {
		c.ACPChoices = map[string]acpPreference{"fake": {Mode: "code", Values: map[string]string{
			"auto_approve": "true", "model": "opus",
		}}}
	})
	a := &app{st: st}
	c, sid, state := startFakeACP(t)
	preset := acpPreset{ID: "fake", BypassPermissions: true}
	state, notice := a.applyACPAccess(c, preset, sid, state)
	if notice != "" {
		t.Fatalf("notice = %q, want the agent to offer a bypass mode", notice)
	}
	idx := acpModeOptionIndex(state.Options)
	if idx < 0 || !state.Options[idx].CurrentValue.equal(acpTextValue("fullAccess")) {
		t.Fatalf("mode option = %+v", state.Options)
	}
	if pinned := acpPinnedMode(state, preset); pinned != "mode" {
		t.Fatalf("pinned = %q", pinned)
	}
	state = a.restoreACPChoices(c, "fake", sid, state, acpPinnedMode(state, preset))
	if state.CurrentModeID == "code" {
		t.Fatal("a remembered mode overrode the preset's bypass")
	}
	options := map[string]acpConfigOption{}
	for _, option := range state.Options {
		options[option.ID] = option
	}
	if !options["auto_approve"].CurrentValue.truthy() {
		t.Fatalf("remembered switch not replayed: %+v", state.Options)
	}
	if got := options["model"].CurrentValue.text(); got != "sonnet" {
		t.Fatalf("model replayed as %q, want the agent's own default", got)
	}
}

// TestACPPresetWithoutBypassModeSaysSo checks the user is told a preset's
// bypass switch cannot apply.
func TestACPPresetWithoutBypassModeSaysSo(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") == "1" {
		t.Skip("the helper process")
	}
	t.Setenv("PIDECK_FAKE_ACP", "1")
	a := &app{}
	c, sid, state := startFakeACP(t)
	// Drop the value from the mode option so the agent offers no bypass.
	for i := range state.Options {
		if state.Options[i].ID == "mode" {
			state.Options[i].Values = json.RawMessage(`[{"value":"auto","name":"Auto"}]`)
		}
	}
	if _, notice := a.applyACPAccess(c, acpPreset{ID: "fake", BypassPermissions: true}, sid, state); notice == "" {
		t.Fatal("no notice when the agent has no bypass mode")
	}
}
