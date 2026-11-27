//go:build !js && !android && !ios

package workbench

import (
	"maps"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func startSessionGroupRenameApp(t *testing.T, root, child string) (*app, *nsgotest.App, *workspace) {
	t.Helper()
	if nsgotest.Target() != "" {
		t.Skip("headless session group persistence regression")
	}
	home := t.TempDir()
	var a *app
	var ws *workspace
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		ws = &workspace{Path: "/project", Target: localTarget,
			Sessions: core.NewSignalFunc(cx, []*session(nil), nil), Pi: core.NewSignalFunc(cx, []*session(nil), nil)}
		sessions := []*session{
			{ID: "root", WS: ws.Path, Target: ws.Target},
			{ID: "child", WS: ws.Path, Target: ws.Target},
			{ID: "other-project", WS: "/other", Target: ws.Target},
			{ID: "other-target", WS: ws.Path, Target: target{Kind: targetSSH, Host: "fixture"}},
			{ID: "sibling", WS: ws.Path, Target: ws.Target},
		}
		ws.Sessions.Set(sessions[:2])
		a = &app{cx: cx, st: &store{dir: home}, byID: map[string]*session{},
			workspaces: core.NewSignalFunc(cx, []*workspace{ws}, nil),
			organization: core.NewSignalFunc(cx, sessionOrganization{Version: 1, Groups: map[string]string{
				"root": root, "child": child, "other-project": "A/B/C/D", "other-target": "A/B/C/D", "sibling": "AB",
			}}, nil),
			organizationDialog: core.NewSignal(cx, sessionOrganizationDialog{kind: "rename", path: root, ws: ws}),
			organizationInput:  core.NewSignal(cx, root), chatWidthPctSig: core.NewSignal(cx, 72),
			toaster: ui.NewToaster(cx),
		}
		for _, s := range sessions {
			a.byID[s.ID] = s
		}
		return a.sessionOrganizationPanel()
	}, nsgotest.Size(1000, 700))
	return a, screen, ws
}

func TestSessionGroupRenameRejectsInvalidDescendants(t *testing.T) {
	a, screen, ws := startSessionGroupRenameApp(t, "A", "A/B/C/D")
	before := maps.Clone(a.organization.GetUntracked().Groups)
	screen.Clear("id:session-group-input")
	screen.Type("id:session-group-input", "X/Y")
	if screen.Enabled("id:session-group-save") {
		t.Error("rename with a fifth-level descendant is enabled")
	}
	screen.Submit("id:session-group-input")
	if !maps.Equal(a.organization.GetUntracked().Groups, before) || a.organizationDialog.GetUntracked().kind != "rename" {
		t.Error("submitting an invalid subtree rename changed the groups or closed the dialog")
	}
	screen.Post(func() { a.changeGroupPath(ws, "A", "X/Y") })
	screen.Settle()
	if !maps.Equal(a.organization.GetUntracked().Groups, before) {
		t.Fatal("invalid rename partially moved the subtree")
	}
	if _, err := os.Stat(filepath.Join(a.st.dir, sessionOrganizationFile)); !os.IsNotExist(err) {
		t.Fatalf("invalid rename wrote the organization: %v", err)
	}
}

func TestSessionGroupRenameKeepsSubtreeAndProjectBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, root, child, to, wantChild string
	}{
		{name: "same depth", root: "A", child: "A/B/C/D", to: "Renamed", wantChild: "Renamed/B/C/D"},
		{name: "shallower", root: "A/B", child: "A/B/C/D", to: "X", wantChild: "X/C/D"},
		{name: "deeper within limit", root: "A", child: "A/B", to: "X/Y/Z", wantChild: "X/Y/Z/B"},
		{name: "ungroup", root: "A", child: "A/B/C/D"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, screen, _ := startSessionGroupRenameApp(t, tc.root, tc.child)
			screen.Clear("id:session-group-input")
			if tc.to != "" {
				screen.Type("id:session-group-input", tc.to)
			}
			screen.Press("id:session-group-save")
			screen.WaitUntil(5*time.Second, func() bool {
				return readSessionOrganization(a.st.dir).Groups["child"] == tc.wantChild &&
					readSessionOrganization(a.st.dir).Version == 1
			})
			want := map[string]string{"other-project": "A/B/C/D", "other-target": "A/B/C/D", "sibling": "AB"}
			if tc.to != "" {
				want["root"], want["child"] = tc.to, tc.wantChild
			}
			if got := a.organization.GetUntracked().Groups; !maps.Equal(got, want) {
				t.Fatalf("groups = %v, want %v", got, want)
			}
			if got := readSessionOrganization(a.st.dir).Groups; !maps.Equal(got, want) {
				t.Fatalf("persisted groups = %v, want %v", got, want)
			}
		})
	}
}
