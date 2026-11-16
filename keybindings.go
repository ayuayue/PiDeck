//go:build !js

package main

// Keyboard shortcuts. Every command can be bound once, from the app's
// defaults, the user's config or a plugin, in that order of weakness.
// A key is bound to a router rather than to a handler, so a later change
// (a plugin disabled, a binding cleared) takes effect without leaving a
// stale handler behind.

import (
	"fmt"
	"slices"
	"strings"

	"github.com/nsgo-dev/nsgo/ui"
)

// defaultKeybindings is command → key. These are the keys the app has
// always had; a user's config replaces them one command at a time.
func defaultKeybindings() []keyBinding {
	return []keyBinding{
		{Command: "palette", Key: "mod+k"},
		{Command: "new-session", Key: "mod+n"},
		{Command: "chat-session", Key: "mod+shift+n"},
		{Command: "close-tab", Key: "mod+w"},
		{Command: "reopen-tab", Key: "mod+alt+t"},
		{Command: "save-file", Key: "mod+s"},
		{Command: "go-to-line", Key: "mod+g"},
		{Command: "quick-open", Key: "mod+p"},
		{Command: "search-files", Key: "mod+alt+f"},
		{Command: "save-all-files", Key: "mod+alt+s"},
		{Command: "appearance-cycle", Key: "mod+shift+l"},
		{Command: "next-tab", Key: "ctrl+tab"},
		{Command: "prev-tab", Key: "ctrl+shift+tab"},
		{Command: "sidebar", Key: "mod+b"},
		{Command: "drawer", Key: "mod+j"},
		{Command: "git", Key: "mod+shift+g"},
		{Command: "terminal", Key: "ctrl+shift+t"},
		{Command: "prompts", Key: "mod+shift+p"},
		{Command: "ask", Key: "mod+shift+a"},
		{Command: "shortcuts", Key: "mod+/"},
		{Command: "search-sessions", Key: "mod+shift+f"},
		{Command: "chat-find", Key: "mod+f"},
		{Command: "chat-outline", Key: "mod+shift+o"},
		{Command: "settings", Key: "mod+,"},
	}
}

// keyBinding is one command's key.
type keyBinding struct {
	Command string
	Key     string
	Source  string // "默认", "用户" or a plugin's name
}

// resolveKeybindings builds the key → command table and the conflicts it
// had to drop. Later sources are weaker than earlier ones: a user's
// binding beats a default, and a plugin only takes a free key.
func (a *app) resolveKeybindings() (map[string]string, []keyBinding, []string) {
	keyToCmd := map[string]string{}
	var all []keyBinding
	var conflicts []string
	for _, b := range defaultKeybindings() {
		keyToCmd[normalizeKey(b.Key)] = b.Command
		b.Source = "默认"
		all = append(all, b)
	}
	user := a.cfg.Keybindings
	// User entries are command → key, so a command's default goes first.
	for cmd, key := range user {
		for k, c := range keyToCmd {
			if c == cmd {
				delete(keyToCmd, k)
			}
		}
		if strings.TrimSpace(key) == "" {
			continue
		}
		nk := normalizeKey(key)
		if other, taken := keyToCmd[nk]; taken && other != cmd {
			conflicts = append(conflicts, fmt.Sprintf("用户键位 %s：%s 已被 %s 占用", key, cmd, other))
			continue
		}
		keyToCmd[nk] = cmd
		all = append(all, keyBinding{Command: cmd, Key: key, Source: "用户"})
	}
	if a.plugins != nil {
		added, more := resolvePluginKeybindings(keyToCmd, a.plugins.GetUntracked())
		all = append(all, added...)
		conflicts = append(conflicts, more...)
	}
	return keyToCmd, all, conflicts
}

// resolvePluginKeybindings takes the free keys a plugin asks for. It is
// separate from the app so the rules can be tested without a window.
func resolvePluginKeybindings(keyToCmd map[string]string, plugins []plugin) ([]keyBinding, []string) {
	var all []keyBinding
	var conflicts []string
	for _, p := range plugins {
		if p.Disabled || p.Error != "" {
			continue
		}
		for _, kb := range p.Contributes.Keybindings {
			cmd := strings.TrimSpace(kb.Command)
			if cmd == "" || strings.TrimSpace(kb.Key) == "" {
				continue
			}
			if !strings.Contains(cmd, ":") && !isBuiltinCommand(cmd) {
				cmd = pluginCommandID(p.ID, cmd)
			}
			nk := normalizeKey(kb.Key)
			if other, taken := keyToCmd[nk]; taken {
				conflicts = append(conflicts, fmt.Sprintf("%s 的键位 %s 已被 %s 占用", p.Name, kb.Key, other))
				continue
			}
			keyToCmd[nk] = cmd
			all = append(all, keyBinding{Command: cmd, Key: kb.Key, Source: p.Name})
		}
	}
	return all, conflicts
}

// bindKeys gives the app its shortcuts once; every later change goes
// through the router and applyKeybindings.
func (a *app) bindKeys() {
	a.keymap = map[string]string{}
	a.boundKeys = map[string]bool{}
	a.applyKeybindings()
}

// applyKeybindings rebuilds the table and binds any key it has not bound
// before. A key that left the table keeps its binding but now does
// nothing, which is safer than leaving a stale command behind.
func (a *app) applyKeybindings() {
	keyToCmd, all, conflicts := a.resolveKeybindings()
	a.keymap = keyToCmd
	a.keybindings = all
	a.keyConflicts = conflicts
	for key := range keyToCmd {
		if a.boundKeys[key] {
			continue
		}
		a.boundKeys[key] = true
		k := key
		a.cx.OnKey(k, func() { a.runKey(k) })
	}
}

// runKey runs whatever a key is bound to now, if the command applies.
func (a *app) runKey(key string) {
	id := a.keymap[key]
	if id == "" {
		return
	}
	for _, c := range a.commandList() {
		if c.ID != id {
			continue
		}
		if c.When != nil && !c.When(a) {
			return
		}
		c.Run(a)
		return
	}
}

// setKeybinding binds a command to a key, or unbinds it with an empty
// key. A key already taken by another command is refused.
func (a *app) setKeybinding(command, key string) bool {
	key = strings.TrimSpace(key)
	keyToCmd, _, _ := a.resolveKeybindings()
	if key != "" {
		if other, taken := keyToCmd[normalizeKey(key)]; taken && other != command {
			a.toast(ui.ToastError, "键位冲突", fmt.Sprintf("%s 已用于 %s", key, other))
			return false
		}
	}
	if a.st == nil {
		return false
	}
	a.st.edit(func(c *config) {
		if c.Keybindings == nil {
			c.Keybindings = map[string]string{}
		}
		c.Keybindings[command] = key
	})
	a.cfg = a.st.config()
	a.applyKeybindings()
	a.bumpSettings()
	return true
}

// resetKeybinding drops the user's choice for a command, restoring its
// default or a plugin's key.
func (a *app) resetKeybinding(command string) {
	if a.st == nil {
		return
	}
	a.st.edit(func(c *config) {
		delete(c.Keybindings, command)
	})
	a.cfg = a.st.config()
	a.applyKeybindings()
	a.bumpSettings()
}

// resetKeybindings clears every user binding.
func (a *app) resetKeybindings() {
	if a.st == nil {
		return
	}
	a.st.edit(func(c *config) { c.Keybindings = nil })
	a.cfg = a.st.config()
	a.applyKeybindings()
	a.bumpSettings()
	a.toast(ui.ToastInfo, "键位已恢复默认", "")
}

// effectiveKey is the key a command has now, "" when none.
func (a *app) effectiveKey(command string) string {
	for key, cmd := range a.keymap {
		if cmd == command {
			return key
		}
	}
	return ""
}

// bindingSource says where a command's key came from.
func (a *app) bindingSource(command string) string {
	key := a.effectiveKey(command)
	for _, b := range a.keybindings {
		if b.Command == command && normalizeKey(b.Key) == key {
			return b.Source
		}
	}
	return ""
}

// keybindingCommands are the commands the settings page lists: every
// command a key can usefully run, defaults first.
func (a *app) keybindingCommands() []appCommand {
	order := map[string]int{}
	for i, b := range defaultKeybindings() {
		order[b.Command] = i
	}
	var out []appCommand
	for _, c := range a.commandList() {
		if c.When != nil && !c.When(a) {
			continue
		}
		if _, ok := order[c.ID]; ok {
			out = append(out, c)
		}
	}
	// Plugin and user-only bindings come after the defaults.
	seen := map[string]bool{}
	for _, c := range out {
		seen[c.ID] = true
	}
	for _, b := range a.keybindings {
		if seen[b.Command] {
			continue
		}
		for _, c := range a.commandList() {
			if c.ID == b.Command {
				seen[c.ID] = true
				out = append(out, c)
				break
			}
		}
	}
	slices.SortStableFunc(out, func(x, y appCommand) int {
		if xi, ok := order[x.ID]; ok {
			if yi, ok2 := order[y.ID]; ok2 {
				return xi - yi
			}
			return -1
		}
		if _, ok := order[y.ID]; ok {
			return 1
		}
		return strings.Compare(x.Label, y.Label)
	})
	return out
}

// normalizeKey mirrors NSGo's own key names so two spellings of a key
// compare equal here and on the platform.
func normalizeKey(key string) string {
	parts := strings.Split(strings.ToLower(strings.ReplaceAll(strings.TrimSpace(key), " ", "")), "+")
	if len(parts) == 0 || parts[len(parts)-1] == "" {
		return ""
	}
	name := parts[len(parts)-1]
	alias := map[string]string{"cmd": "meta", "command": "meta", "option": "alt", "control": "ctrl"}
	var given []string
	for _, m := range parts[:len(parts)-1] {
		if a, ok := alias[m]; ok {
			m = a
		}
		given = append(given, m)
	}
	var mods []string
	for _, m := range []string{"mod", "ctrl", "alt", "shift", "meta"} {
		if slices.Contains(given, m) {
			mods = append(mods, m)
		}
	}
	return strings.Join(append(mods, name), "+")
}

// keyLabel is a key as a person reads it.
func keyLabel(key string) string {
	if key == "" {
		return "未设置"
	}
	return key
}

// isBuiltinCommand reports whether id names one of the app's own
// commands, so a plugin keybinding can target it without a prefix.
func isBuiltinCommand(id string) bool {
	for _, c := range builtinCommands() {
		if c.ID == id {
			return true
		}
	}
	return false
}
