//go:build !js && !android && !ios

package main

// The app's event bus: internal subscribers and plugin hooks. Events are
// emitted on the UI thread after something happened. A plugin hook runs a
// safe action (url, command or theme) and is guarded so an action cannot
// trigger itself.

import (
	"regexp"
	"strings"
	"sync"
)

// The events the app emits. A plugin hook may listen to any of them.
const (
	eventTurnStart      = "turn.start"
	eventTurnDone       = "turn.done"
	eventSessionCreated = "session.created"
	eventSessionOpened  = "session.opened"
	eventSessionDeleted = "session.deleted"
	eventThemeChanged   = "theme.changed"
	eventPlanFinished   = "plan.finished"
	eventGitCommit      = "git.commit"
	eventImageGenerated = "image.generated"
)

// appEvent is something that happened.
type appEvent struct {
	Name    string
	Session *session
	Data    map[string]string
}

// eventSub listens to one event.
type eventSub func(appEvent)

// pluginEventRef matches ${event:key} in a hook's text.
var pluginEventRef = regexp.MustCompile(`\$\{event:([A-Za-z0-9_.-]+)\}`)

// eventBus is the app's subscriptions; a nil bus is quiet.
type eventBus struct {
	mu   sync.Mutex
	subs map[string][]eventSub
}

// on subscribes to an event.
func (b *eventBus) on(name string, fn eventSub) {
	if b == nil || fn == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.subs == nil {
		b.subs = map[string][]eventSub{}
	}
	b.subs[name] = append(b.subs[name], fn)
}

// subscribers copies an event's listeners.
func (b *eventBus) subscribers(name string) []eventSub {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]eventSub(nil), b.subs[name]...)
}

// on subscribes to an app event.
func (a *app) on(name string, fn eventSub) { a.events.on(name, fn) }

// emit runs subscribers and plugin hooks for an event.
func (a *app) emit(name string, ev appEvent) {
	if a == nil {
		return
	}
	ev.Name = name
	if ev.Data == nil {
		ev.Data = map[string]string{}
	}
	if ev.Session != nil {
		ev.Data["session"] = ev.Session.ID
		ev.Data["title"] = ev.Session.title.GetUntracked()
		ev.Data["project"] = ev.Session.WS
	}
	for _, fn := range a.events.subscribers(name) {
		fn(ev)
	}
	a.runPluginHooks(ev)
}

// runPluginHooks runs the actions plugins declared for an event.
func (a *app) runPluginHooks(ev appEvent) {
	if a.inHook || a.plugins == nil {
		return
	}
	for _, p := range a.plugins.GetUntracked() {
		if p.Disabled || p.Error != "" {
			continue
		}
		for _, act := range p.Contributes.Hooks[ev.Name] {
			cmd := pluginCommand{ID: "hook:" + ev.Name, Title: "事件 " + ev.Name, Action: act}
			a.inHook = true
			a.runPluginActionFor(p, cmd, ev.Session, ev.Data)
			a.inHook = false
		}
	}
}

// sessionCreated announces a session the user just made, by how it was
// made: project, chat, acp or fork.
func (a *app) sessionCreated(s *session, origin string) {
	if s == nil {
		return
	}
	a.emit(eventSessionCreated, appEvent{Session: s, Data: map[string]string{"origin": origin}})
}

// expandPluginTextFor fills ${setting:key} and ${event:key} references.
func (a *app) expandPluginTextFor(p plugin, text string, data map[string]string) string {
	text = a.expandPluginText(p, text)
	if len(data) == 0 || !strings.Contains(text, "${event:") {
		return text
	}
	return pluginEventRef.ReplaceAllStringFunc(text, func(m string) string {
		return data[pluginEventRef.FindStringSubmatch(m)[1]]
	})
}
