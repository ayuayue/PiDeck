//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

const acpConfigTimeout = 20 * time.Second

// ACP agents can expose selects such as model, mode and thought level,
// and on/off switches such as approvals. ACP declares which per option;
// a server may send a flat list or groups of the same option values.
type acpConfigOption struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Category     string          `json:"category"`
	Type         string          `json:"type"`
	CurrentValue acpConfigValue  `json:"currentValue"`
	Values       json.RawMessage `json:"options"`
}

// acpConfigKind is what a config value holds.
type acpConfigKind uint8

const (
	acpValueNone acpConfigKind = iota
	acpValueText
	acpValueBool
)

// acpConfigValue is one configuration value on the wire: a value id, or a
// boolean. The shape travels with the value because agents disagree about
// which options are switches, and a mismatched read used to fail the whole
// session/new response.
type acpConfigValue struct {
	str  string
	flag bool
	kind acpConfigKind
}

func acpTextValue(text string) acpConfigValue { return acpConfigValue{str: text, kind: acpValueText} }
func acpBoolValue(on bool) acpConfigValue     { return acpConfigValue{flag: on, kind: acpValueBool} }

func (v acpConfigValue) isSet() bool  { return v.kind != acpValueNone }
func (v acpConfigValue) isBool() bool { return v.kind == acpValueBool }
func (v acpConfigValue) text() string { return v.str }
func (v acpConfigValue) truthy() bool { return v.kind == acpValueBool && v.flag }
func (v acpConfigValue) equal(o acpConfigValue) bool {
	return v.kind == o.kind && v.str == o.str && v.flag == o.flag
}

// String is what a value reads as in the transcript-free UI.
func (v acpConfigValue) String() string {
	switch {
	case v.kind == acpValueBool:
		if v.flag {
			return "true"
		}
		return "false"
	case v.kind == acpValueText:
		return v.str
	}
	return ""
}

// MarshalJSON writes the value in the shape it arrived in.
func (v acpConfigValue) MarshalJSON() ([]byte, error) {
	switch v.kind {
	case acpValueBool:
		return json.Marshal(v.flag)
	case acpValueText:
		return json.Marshal(v.str)
	}
	return []byte("null"), nil
}

// UnmarshalJSON reads a string, a boolean or (for the odd server that
// sends one) a number; anything else leaves the value unset instead of
// failing its option.
func (v *acpConfigValue) UnmarshalJSON(data []byte) error {
	raw := strings.TrimSpace(string(data))
	*v = acpConfigValue{}
	switch {
	case raw == "" || raw == "null":
		return nil
	case raw == "true", raw == "false":
		v.flag = raw == "true"
		v.kind = acpValueBool
	case raw[0] == '"':
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return nil
		}
		v.str, v.kind = text, acpValueText
	default:
		var number json.Number
		if json.Unmarshal(data, &number) != nil {
			return nil
		}
		v.str, v.kind = number.String(), acpValueText
	}
	return nil
}

type acpConfigChoice struct {
	Value       string `json:"value"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// acpConfigOptions reads an option list entry by entry: the protocol says
// a reader skips an entry it cannot read rather than fail the response. A
// CodeBuddy boolean once made every session/new unreadable that way.
type acpConfigOptions []acpConfigOption

func (l *acpConfigOptions) UnmarshalJSON(data []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		*l = nil
		return nil
	}
	out := make(acpConfigOptions, 0, len(raw))
	for _, item := range raw {
		var option acpConfigOption
		if json.Unmarshal(item, &option) != nil || option.ID == "" {
			continue
		}
		out = append(out, option)
	}
	*l = out
	return nil
}

// acpOptionKind is the composer control an option belongs to. ACP declares
// the category for the options agents know (mode, model, thought level);
// older agents only name the id, so the id and then the name fall back.
type acpOptionKind uint8

const (
	acpOptionOther acpOptionKind = iota
	acpOptionMode
	acpOptionModel
	acpOptionThinking
)

// acpOptionKey normalizes a category or id for comparison: agents spell the
// same thing "thought_level", "thoughtLevel" and "Thinking".
func acpOptionKey(text string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '_', '-', ' ', '.':
			return -1
		}
		return r
	}, strings.ToLower(strings.TrimSpace(text)))
}

// kind classifies an option for the composer. A model's own parameters
// ("model_config") stay in the panel with the rest: they are not the model.
func (o acpConfigOption) kind() acpOptionKind {
	switch acpOptionKey(o.Category) {
	case "mode":
		return acpOptionMode
	case "model":
		return acpOptionModel
	case "thoughtlevel", "thinking", "reasoning", "reasoningeffort":
		return acpOptionThinking
	}
	switch acpOptionKey(o.ID) {
	case "mode", "permissionmode":
		return acpOptionMode
	case "model":
		return acpOptionModel
	case "thoughtlevel", "thinking", "reasoning", "reasoningeffort", "effort":
		return acpOptionThinking
	}
	name := strings.ToLower(strings.TrimSpace(o.Name))
	switch {
	case strings.Contains(name, "thinking"), strings.Contains(name, "reasoning"),
		strings.Contains(o.Name, "思考"), strings.Contains(o.Name, "思考等级"):
		return acpOptionThinking
	case name == "model", name == "模型":
		return acpOptionModel
	case name == "permission mode", name == "权限模式":
		return acpOptionMode
	}
	return acpOptionOther
}

// acpOptionByKind finds the first option of a kind, nil when the agent
// offers none.
func acpOptionByKind(options []acpConfigOption, kind acpOptionKind) *acpConfigOption {
	for i := range options {
		if options[i].kind() == kind {
			return &options[i]
		}
	}
	return nil
}

// acpOptionByID finds the live copy of an option, which an agent may
// replace with a different value after a choice.
func acpOptionByID(options []acpConfigOption, id string) *acpConfigOption {
	for i := range options {
		if options[i].ID == id {
			return &options[i]
		}
	}
	return nil
}

// currentChoiceLabel names the choice the option holds now, so a chip can
// show what is in force; an unknown value stays as the agent sent it.
func (o acpConfigOption) currentChoiceLabel() string {
	value := o.CurrentValue.text()
	if value == "" {
		return ""
	}
	for _, choice := range o.Choices() {
		if choice.Value == value {
			return firstNonEmpty(choice.Name, value)
		}
	}
	return value
}

// isBool reports whether the option is an on/off switch. Agents that send
// a boolean without declaring it are handled too.
func (o acpConfigOption) isBool() bool {
	if o.Type == "boolean" {
		return true
	}
	return o.Type == "" && o.CurrentValue.isBool()
}

// Choices are the values of a select, groups flattened. A switch has none.
func (o acpConfigOption) Choices() []acpConfigChoice {
	if o.isBool() {
		return nil
	}
	var wire []struct {
		acpConfigChoice
		Options []acpConfigChoice `json:"options"`
	}
	if err := json.Unmarshal(o.Values, &wire); err != nil {
		return nil
	}
	var out []acpConfigChoice
	for _, group := range wire {
		if group.Value != "" {
			out = append(out, group.acpConfigChoice)
		}
		for _, choice := range group.Options {
			if choice.Value != "" {
				out = append(out, choice)
			}
		}
	}
	return out
}

func (o acpConfigOption) hasValue(value acpConfigValue) bool {
	if o.isBool() {
		return value.isBool()
	}
	if !value.isSet() || value.isBool() {
		return false
	}
	for _, choice := range o.Choices() {
		if choice.Value == value.text() {
			return true
		}
	}
	return false
}

type acpSessionConfig struct {
	Modes   acpModeState     `json:"modes"`
	Options acpConfigOptions `json:"configOptions"`
}

func (c acpSessionConfig) modeState() acpModeState {
	c.Modes.Options = c.Options
	return c.Modes
}

// setConfigOption writes one option and returns the full table the agent
// answers with. A switch is sent with its declared type: several agents
// validate the value against that field and reject a bare boolean.
func (c *acpClient) setConfigOption(sessionID string, option acpConfigOption, value acpConfigValue) ([]acpConfigOption, error) {
	params := map[string]any{"sessionId": sessionID, "configId": option.ID, "value": value}
	if value.isBool() || option.isBool() {
		params["type"] = "boolean"
	}
	var out acpSessionConfig
	err := c.call("session/set_config_option", params, &out, acpConfigTimeout)
	return out.Options, err
}

type acpPreference struct {
	Mode   string            `json:"mode,omitempty"`
	Values map[string]string `json:"values,omitempty"`
}

// acpPreferenceText is a choice as config.json keeps it. Booleans are kept
// as "true"/"false" text so the file keeps the shape older builds read.
func acpPreferenceText(value acpConfigValue) string {
	if value.isBool() {
		return strconv.FormatBool(value.truthy())
	}
	return value.text()
}

// acpPreferredValue turns a stored choice back into a wire value for this
// option, or an unset value when it cannot apply.
func acpPreferredValue(option acpConfigOption, stored string) acpConfigValue {
	if stored == "" {
		return acpConfigValue{}
	}
	if option.isBool() {
		on, err := strconv.ParseBool(stored)
		if err != nil {
			return acpConfigValue{}
		}
		return acpBoolValue(on)
	}
	return acpTextValue(stored)
}

func (a *app) rememberACPPreference(preset string, update func(*acpPreference)) {
	if a.st == nil || preset == "" {
		return
	}
	a.st.change(func(c *config) {
		if c.ACPChoices == nil {
			c.ACPChoices = map[string]acpPreference{}
		}
		pref := c.ACPChoices[preset]
		update(&pref)
		c.ACPChoices[preset] = pref
	})
	go func() {
		if err := a.st.save(); err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "保存失败", err.Error()) })
		}
	}()
}

// remembered says whether a choice is replayed into the next session of
// the same preset. Models and model parameters stay with the CLI's own
// defaults (they are a project concern, and agents reset them per session);
// the rest — mode, thought level, permissions — is the user's preference.
func (o acpConfigOption) remembered() bool {
	switch strings.ToLower(strings.TrimSpace(o.Category)) {
	case "model", "model_config":
		return false
	}
	return !strings.EqualFold(strings.TrimSpace(o.ID), "model")
}

// acpModeOptionIndex finds the option that carries the session mode, which is
// also where most agents keep their permission mode.
func acpModeOptionIndex(options []acpConfigOption) int {
	for i, option := range options {
		if option.isBool() {
			continue
		}
		category := strings.ToLower(strings.TrimSpace(option.Category))
		if category == "mode" || strings.EqualFold(strings.TrimSpace(option.ID), "mode") {
			return i
		}
	}
	return -1
}

// acpOptionMirrorsModes reports whether a config option carries exactly the
// session modes: CodeBuddy exposes the permission modes both as ACP's
// "modes" and as a config option, and drawing both is one list twice.
func acpOptionMirrorsModes(option acpConfigOption, modes []acpMode) bool {
	if len(modes) == 0 || option.isBool() {
		return false
	}
	choices := option.Choices()
	if len(choices) != len(modes) {
		return false
	}
	ids := make(map[string]bool, len(modes))
	for _, mode := range modes {
		ids[mode.ID] = true
	}
	for _, choice := range choices {
		if !ids[choice.Value] {
			return false
		}
	}
	return true
}

// acpModeInfo names the mode in force: ACP's own modes when the agent has
// them, else the mode config option.
func acpModeInfo(modes []acpMode, modeID string, options []acpConfigOption) (string, string) {
	if len(modes) > 0 {
		return modeID, acpModeLabel(modes, modeID)
	}
	if option := acpOptionByKind(options, acpOptionMode); option != nil && !option.isBool() {
		value := option.CurrentValue.text()
		return value, firstNonEmpty(option.currentChoiceLabel(), value)
	}
	return "", ""
}

// acpModeFromOptions reads the mode a config table carries, when it can be
// trusted: with no ACP modes it is the only source, with modes beside it
// only a table that mirrors them (an agent's own mode update then wins).
func acpModeFromOptions(options []acpConfigOption, modes []acpMode) (string, bool) {
	option := acpOptionByKind(options, acpOptionMode)
	if option == nil || option.isBool() || (len(modes) > 0 && !acpOptionMirrorsModes(*option, modes)) {
		return "", false
	}
	value := option.CurrentValue.text()
	return value, value != ""
}

// acpNoBypassNotice tells the user a preset's bypass switch cannot apply:
// the agent offers no such mode, so its sessions keep asking.
const acpNoBypassNotice = "这个 ACP 没有旁路权限档，预设里的旁路权限不会生效。"

// acpBypassModes are the mode values that mean "stop asking", strongest
// first. CodeBuddy's fullAccess also allows dangerous commands, so it wins
// over bypassPermissions; Claude, Qoder and the rest name their own.
var acpBypassModes = []string{"fullaccess", "bypasspermissions", "bypass_permissions", "bypass", "yolo"}

// acpBypassChoice is the skip-approvals choice of a mode option, if the
// agent offers one.
func acpBypassChoice(option acpConfigOption) acpConfigValue {
	choices := option.Choices()
	for _, want := range acpBypassModes {
		for _, choice := range choices {
			if strings.EqualFold(strings.TrimSpace(choice.Value), want) {
				return acpTextValue(choice.Value)
			}
		}
	}
	return acpConfigValue{}
}

func (a *app) restoreACPChoices(c *acpClient, preset, sid string, state acpModeState, pinnedMode string) acpModeState {
	if a.st == nil {
		return state
	}
	pref := a.st.config().ACPChoices[preset]
	// A preset's bypass mode wins over an older remembered mode: replaying
	// it would quietly turn approvals back on.
	if pref.Mode != "" && pinnedMode == "" && pref.Mode != state.CurrentModeID &&
		slices.ContainsFunc(state.AvailableModes, func(m acpMode) bool { return m.ID == pref.Mode }) {
		if err := c.setMode(sid, pref.Mode); err == nil {
			state.CurrentModeID = pref.Mode
			// Keep the duplicate config option in step: an agent that
			// mirrors its modes there would otherwise replay the old one.
			if idx := acpModeOptionIndex(state.Options); idx >= 0 {
				option := state.Options[idx]
				if acpOptionMirrorsModes(option, state.AvailableModes) && option.hasValue(acpTextValue(pref.Mode)) {
					state.Options[idx].CurrentValue = acpTextValue(pref.Mode)
				}
			}
		}
	}
	// A model change can change the available reasoning settings, so every
	// choice is validated against the most recent response.
	snapshot := append([]acpConfigOption(nil), state.Options...)
	for _, option := range snapshot {
		if option.ID == pinnedMode || !option.remembered() {
			continue
		}
		live := state.optionByID(option.ID)
		if live == nil {
			continue
		}
		value := acpPreferredValue(*live, pref.Values[option.ID])
		if !live.hasValue(value) || live.CurrentValue.equal(value) {
			continue
		}
		if options, err := c.setConfigOption(sid, *live, value); err == nil && options != nil {
			state.Options = options
		}
	}
	return state
}

// optionByID is the live table's copy of an option, or nil when the agent
// dropped it after another choice.
func (c *acpModeState) optionByID(id string) *acpConfigOption {
	for i := range c.Options {
		if c.Options[i].ID == id {
			return &c.Options[i]
		}
	}
	return nil
}

// applyACPAccess switches a session to the preset's own "stop asking"
// permission mode. It has to happen after the handshake — Claude reads the
// initial mode from its settings, Qoder refuses the call outright — so a
// refusal is logged and never blocks the session. The returned notice is
// for the UI when the agent has no such mode at all.
func (a *app) applyACPAccess(c *acpClient, preset acpPreset, sid string, state acpModeState) (acpModeState, string) {
	if !preset.BypassPermissions {
		return state, ""
	}
	if idx := acpModeOptionIndex(state.Options); idx >= 0 {
		option := state.Options[idx]
		bypass := acpBypassChoice(option)
		if !bypass.isSet() {
			return state, acpNoBypassNotice
		}
		if option.CurrentValue.equal(bypass) {
			return state, ""
		}
		options, err := c.setConfigOption(sid, option, bypass)
		if err != nil {
			a.diagf("warn", "ACP bypass permission rejected: %v", err)
			return state, ""
		}
		if options != nil {
			state.Options = options
		} else {
			state.Options[idx].CurrentValue = bypass
		}
		// The badge reads the ACP mode; when the config option is the same
		// list, the bypass is the mode in force.
		if acpOptionMirrorsModes(option, state.AvailableModes) {
			state.CurrentModeID = bypass.text()
		}
		return state, ""
	}
	for _, mode := range state.AvailableModes {
		if !acpBypassModeID(mode.ID) {
			continue
		}
		if err := c.setMode(sid, mode.ID); err != nil {
			a.diagf("warn", "ACP bypass mode rejected: %v", err)
			return state, ""
		}
		state.CurrentModeID = mode.ID
		return state, ""
	}
	return state, acpNoBypassNotice
}

func acpBypassModeID(id string) bool {
	for _, want := range acpBypassModes {
		if strings.EqualFold(strings.TrimSpace(id), want) {
			return true
		}
	}
	return false
}

// acpPinnedMode is the option a preset's bypass pins: replaying an older
// remembered mode over it would silently turn approvals back on.
func acpPinnedMode(state acpModeState, preset acpPreset) string {
	if !preset.BypassPermissions {
		return ""
	}
	idx := acpModeOptionIndex(state.Options)
	if idx < 0 {
		return ""
	}
	option := state.Options[idx]
	if bypass := acpBypassChoice(option); bypass.isSet() && option.CurrentValue.equal(bypass) {
		return option.ID
	}
	return ""
}

func (a *app) chooseACPOption(s *session, id string, value acpConfigValue) {
	if s.acp == nil || s.acpSID == "" || s.busyNow() || s.acpOptionBusy.GetUntracked() {
		return
	}
	var option acpConfigOption
	for _, opt := range s.acpOptions.GetUntracked() {
		if opt.ID == id && !opt.CurrentValue.equal(value) && opt.hasValue(value) {
			option = opt
			break
		}
	}
	if option.ID == "" {
		return
	}
	s.acpOptionBusy.Set(true)
	c, sid, preset := s.acp, s.acpSID, s.acpPreset
	go func() {
		options, err := c.setConfigOption(sid, option, value)
		a.cx.Post(func() {
			if s.acp != c {
				return
			}
			s.acpOptionBusy.Set(false)
			if err != nil {
				a.toast(ui.ToastError, "保存失败", err.Error())
				return
			}
			if options != nil {
				s.acpOptions.Set(options)
			}
			// The agent keeps the permission mode here when it exposes no
			// ACP modes; the badge reads s.acpMode, so write it too.
			if option.kind() == acpOptionMode && len(s.acpModes.GetUntracked()) == 0 {
				if text := value.text(); text != "" {
					s.acpMode.Set(text)
				}
			}
			if option.remembered() && option.hasValue(value) {
				text := acpPreferenceText(value)
				a.rememberACPPreference(preset, func(p *acpPreference) {
					if p.Values == nil {
						p.Values = map[string]string{}
					}
					p.Values[id] = text
				})
			}
		})
	}()
}

// clearACPPreference forgets every remembered choice of one preset.
func (a *app) clearACPPreference(preset string) {
	if a.st == nil || preset == "" {
		return
	}
	a.st.change(func(c *config) { delete(c.ACPChoices, preset) })
	go func() {
		if err := a.st.save(); err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "保存失败", err.Error()) })
		}
	}()
}

func cloneACPPreferences(in map[string]acpPreference) map[string]acpPreference {
	out := maps.Clone(in)
	for k, v := range out {
		v.Values = maps.Clone(v.Values)
		out[k] = v
	}
	return out
}
