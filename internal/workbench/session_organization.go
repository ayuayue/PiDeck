//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"io"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"time"

	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui"
)

const sessionOrganizationFile = "session-groups.json"

type sessionOrganization struct {
	Version int                    `json:"version"`
	Groups  map[string]string      `json:"groups,omitempty"`
	Links   map[string]sessionLink `json:"links,omitempty"`
}

type sessionLink struct {
	Parent string    `json:"parent"`
	When   time.Time `json:"when,omitempty"`
	Status string    `json:"status,omitempty"`
	Report string    `json:"report,omitempty"`
}

func sessionGroupPath(raw string) string {
	var segments []string
	for _, part := range strings.Split(raw, "/") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if len([]rune(part)) > 48 || len(segments) >= 4 || strings.ContainsAny(part, "\r\n\x00") {
			return ""
		}
		segments = append(segments, part)
	}
	return strings.Join(segments, "/")
}

func readSessionOrganization(dir string) sessionOrganization {
	const limit = 4 << 20
	var org sessionOrganization
	file, err := os.Open(filepath.Join(dir, sessionOrganizationFile))
	if err != nil {
		return org
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || len(raw) > limit || json.Unmarshal(raw, &org) != nil || org.Version != 1 {
		return sessionOrganization{}
	}
	for id, path := range org.Groups {
		if clean := sessionGroupPath(path); id == "" || clean == "" {
			delete(org.Groups, id)
		} else {
			org.Groups[id] = clean
		}
	}
	for child, link := range org.Links {
		if !org.canLink(child, link.Parent) {
			delete(org.Links, child)
		}
	}
	return org
}

func (org sessionOrganization) canLink(child, parent string) bool {
	if child == "" || parent == "" {
		return false
	}
	// The bound also rejects an imported loop that does not include child.
	for i := 0; parent != "" && i <= len(org.Links); i++ {
		if parent == child {
			return false
		}
		parent = org.Links[parent].Parent
	}
	return parent == ""
}

func (a *app) changeSessionOrganization(edit func(*sessionOrganization)) {
	if a.st == nil {
		return
	}
	org := a.organization.GetUntracked()
	org.Version = 1
	org.Groups = maps.Clone(org.Groups)
	org.Links = maps.Clone(org.Links)
	if org.Groups == nil {
		org.Groups = make(map[string]string)
	}
	if org.Links == nil {
		org.Links = make(map[string]sessionLink)
	}
	edit(&org)
	a.st.organizationMu.Lock()
	a.st.organization = org
	a.st.organizationMu.Unlock()
	a.organization.Set(org)
	go func() {
		if err := a.st.saveSessionOrganization(); err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "保存失败", err.Error()) })
		}
	}()
}

func (s *store) saveSessionOrganization() error {
	s.organizationWriteMu.Lock()
	defer s.organizationWriteMu.Unlock()
	s.organizationMu.Lock()
	org := s.organization
	s.organizationMu.Unlock()
	raw, err := json.MarshalIndent(org, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(s.dir, sessionOrganizationFile), raw, 0o600)
}

func (a *app) setSessionGroup(id, path string) {
	path = sessionGroupPath(path)
	a.changeSessionOrganization(func(org *sessionOrganization) {
		if path == "" {
			delete(org.Groups, id)
		} else {
			org.Groups[id] = path
		}
	})
}

func (a *app) changeGroupPath(ws *workspace, from, to string) {
	a.changeSessionOrganization(func(org *sessionOrganization) {
		for id, group := range org.Groups {
			if group != from && !strings.HasPrefix(group, from+"/") {
				continue
			}
			s := a.findSession(id)
			if s == nil || s.WS != ws.Path || s.Target != ws.Target {
				continue
			}
			if to == "" {
				delete(org.Groups, id)
			} else if path := sessionGroupPath(to + strings.TrimPrefix(group, from)); path != "" {
				org.Groups[id] = path
			}
		}
	})
}

func (a *app) linkSession(child, parent *session) bool {
	if child == nil || parent == nil || child.WS != parent.WS || child.Target != parent.Target ||
		!a.organization.GetUntracked().canLink(child.ID, parent.ID) {
		return false
	}
	a.changeSessionOrganization(func(org *sessionOrganization) {
		org.Links[child.ID] = sessionLink{Parent: parent.ID}
		if group := org.Groups[parent.ID]; group != "" {
			org.Groups[child.ID] = group
		} else {
			delete(org.Groups, child.ID)
		}
	})
	return true
}

func (a *app) linkedTurnDone(ev appEvent) {
	if ev.Session == nil {
		return
	}
	id := ev.Session.ID
	link := a.organization.GetUntracked().Links[id]
	if link.Parent == "" {
		return
	}
	link.When, link.Status = a.cx.Now(), ev.Data["status"]
	link.Report = viewkit.FirstLine(firstNonEmpty(ev.Data["answer"], ev.Data["error"]), 240)
	a.changeSessionOrganization(func(org *sessionOrganization) { org.Links[id] = link })
}

func (a *app) forgetSessionOrganization(id string) {
	org := a.organization.GetUntracked()
	linked := org.Links[id].Parent != ""
	for _, link := range org.Links {
		linked = linked || link.Parent == id
	}
	if org.Groups[id] == "" && !linked {
		return
	}
	a.changeSessionOrganization(func(org *sessionOrganization) {
		delete(org.Groups, id)
		delete(org.Links, id)
		for child, link := range org.Links {
			if link.Parent == id {
				delete(org.Links, child)
			}
		}
	})
}
