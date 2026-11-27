//go:build !js && !android && !ios

package workbench

import (
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestTaskSessionValidatesBeforeRegistering(t *testing.T) {
	for _, tc := range []struct {
		name    string
		backend string
		preset  string
		trusted bool
		wantErr bool
	}{
		{name: "deleted preset", backend: "acp", preset: "deleted-preset", trusted: true, wantErr: true},
		{name: "untrusted project", backend: "pi", wantErr: true},
		{name: "pi", backend: "pi", trusted: true},
		{name: "acp", backend: "acp", preset: "claude", trusted: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			project := t.TempDir()
			var a *app
			var ws *workspace
			var created *session
			var err error
			nsgotest.Start(t, func(cx *core.Scope) core.Node {
				ws = &workspace{Path: project, Target: localTarget,
					Sessions: core.NewSignalFunc(cx, []*session(nil), nil)}
				a = &app{cx: cx, byID: map[string]*session{},
					workspaces: core.NewSignalFunc(cx, []*workspace{ws}, nil)}
				if tc.trusted {
					a.cfg.TrustedProjects = []string{trustKey(ws)}
				}
				created, err = a.taskSession(scheduledTask{Name: "Daily", Project: project,
					Backend: tc.backend, ACPPreset: tc.preset})
				return core.View{}
			})
			if (err != nil) != tc.wantErr {
				t.Fatalf("taskSession error = %v, want error %v", err, tc.wantErr)
			}
			want := 1
			if tc.wantErr {
				want = 0
				if created != nil {
					t.Errorf("rejected task returned a session: %s", created.ID)
				}
			} else if created == nil || created.backend != tc.backend || created.acpPreset != tc.preset {
				t.Fatalf("created session = %+v, want backend %q, preset %q", created, tc.backend, tc.preset)
			}
			if len(a.byID) != want || len(a.all) != want || len(ws.Sessions.GetUntracked()) != want {
				t.Fatalf("registered sessions = byID:%d all:%d project:%d, want %d",
					len(a.byID), len(a.all), len(ws.Sessions.GetUntracked()), want)
			}
		})
	}
}
