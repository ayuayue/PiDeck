//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestACPFinishCompletesRegisteredSession(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		s.backend = "acp"
		s.acpTurnID = "in-flight"
		s.turns.Set([]turn{{ID: "in-flight", Prompt: "keep prompt", Status: chat.Running}})
		s.runningSig.Set(true)
		a.acpFinish(s, "in-flight", "end_turn", nil)
	})
	if s.acpTurnID != "" || s.runningSig.GetUntracked() || s.turns.GetUntracked()[0].Status != chat.Completed {
		t.Fatal("registered session did not complete its turn")
	}
	if s.acpArchiveTail == nil {
		t.Fatal("registered session did not save its completed turn")
	}
}

func TestACPFinishDoesNotReviveDeletedSession(t *testing.T) {
	for _, phase := range []string{"during deletion", "after deletion"} {
		t.Run(phase, func(t *testing.T) {
			a, screen, s := startSessionLifecycleApp(t)
			stopped := make(chan struct{})
			var once sync.Once
			release := func() { once.Do(func() { close(stopped) }) }
			t.Cleanup(release)
			onNativeUI(t, screen, a, func() {
				s.backend = "acp"
				s.acpTurnID = "in-flight"
				s.agentStopped = stopped
				s.turns.Set([]turn{{ID: "in-flight", Prompt: "keep prompt", Status: chat.Running}})
				s.runningSig.Set(true)
				a.saveACPArchive(s)
			})
			acpArchiveWrites.Wait()
			file := filepath.Join(a.acpArchiveDir(), archiveName(s.ID))
			if _, err := os.Stat(file); err != nil {
				t.Fatal(err)
			}
			removed := false
			var removeErr error
			onNativeUI(t, screen, a, func() {
				a.removeSession(s, func(err error) { removeErr, removed = err, true })
			})
			if phase == "after deletion" {
				release()
				screen.WaitUntil(5*time.Second, func() bool { return removed })
			}
			tail := s.acpArchiveTail
			onNativeUI(t, screen, a, func() {
				a.acpFinish(s, "in-flight", "", errors.New("closed ACP connection"))
			})
			if s.acpArchiveTail != tail {
				t.Error("late completion queued another archive write")
			}
			if got := s.turns.GetUntracked()[0].Status; got != chat.Cancelled {
				t.Errorf("late completion changed the cancelled turn to %v", got)
			}
			acpArchiveWrites.Wait()
			release()
			screen.WaitUntil(5*time.Second, func() bool { return removed })
			if removeErr != nil {
				t.Fatal(removeErr)
			}
			if a.byID[s.ID] != nil || len(a.all) != 0 || len(a.workspaces.GetUntracked()[0].Sessions.GetUntracked()) != 0 {
				t.Error("late completion restored the deleted session to the project")
			}
			if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("deleted archive exists after late completion: %v", err)
			}
		})
	}
}
