package client

import (
	"net/http"
	"testing"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
)

type mobileListFixture struct {
	load  func()
	busy  *core.Signal[bool]
	err   *core.Signal[string]
	id    func() string
	reply func(string) any
}

func mobileListForTest(a *mobileApp, kind string) mobileListFixture {
	switch kind {
	case "agents":
		return mobileListFixture{a.loadAgents, a.agentsBusy, a.agentsErr, func() string {
			if list := a.agents.GetUntracked(); len(list) > 0 {
				return list[0].ID
			}
			return ""
		}, func(id string) any { return remotewire.Agents{Agents: []remotewire.Agent{{ID: id}}} }}
	case "tasks":
		return mobileListFixture{a.loadTasks, a.tasksBusy, a.tasksErr, func() string {
			if list := a.tasks.GetUntracked(); len(list) > 0 {
				return list[0].ID
			}
			return ""
		}, func(id string) any { return remotewire.Tasks{Tasks: []remotewire.Task{{ID: id}}} }}
	default:
		return mobileListFixture{a.loadFavorites, a.favoritesBusy, a.favoritesErr, func() string {
			if list := a.favorites.GetUntracked(); len(list) > 0 {
				return list[0].ID
			}
			return ""
		}, func(id string) any { return remotewire.Favorites{Favorites: []remotewire.Favorite{{ID: id}}} }}
	}
}

func TestMobileListsClearOnDisconnect(t *testing.T) {
	a, _ := newConnectionTestApp(t)
	a.agents.Set([]remotewire.Agent{{ID: "old-agent"}})
	a.tasks.Set([]remotewire.Task{{ID: "old-task"}})
	a.favorites.Set([]remotewire.Favorite{{ID: "old-favorite", Text: "private reply"}})
	a.agentsOpen.Set(true)
	a.tasksOpen.Set(true)
	a.favoritesOpen.Set(true)
	a.taskOpen.Set("old-task")
	a.taskBusy.Set("old-task")
	a.favOpen.Set("old-favorite")
	for _, kind := range []string{"agents", "tasks", "favorites"} {
		list := mobileListForTest(a, kind)
		list.busy.Set(true)
		list.err.Set("old error")
	}
	a.disconnect()
	for _, kind := range []string{"agents", "tasks", "favorites"} {
		list := mobileListForTest(a, kind)
		if list.id() != "" || list.busy.GetUntracked() || list.err.GetUntracked() != "" {
			t.Errorf("%s retained previous connection: id=%q busy=%v error=%q", kind, list.id(), list.busy.GetUntracked(), list.err.GetUntracked())
		}
	}
	if a.agentsOpen.GetUntracked() || a.tasksOpen.GetUntracked() || a.favoritesOpen.GetUntracked() ||
		a.taskOpen.GetUntracked() != "" || a.taskBusy.GetUntracked() != "" || a.favOpen.GetUntracked() != "" {
		t.Fatal("disconnect kept a previous list, detail or task operation open")
	}
}

func TestMobileListsIgnorePreviousConnection(t *testing.T) {
	for _, kind := range []string{"agents", "tasks", "favorites"} {
		for _, status := range []int{http.StatusOK, http.StatusForbidden} {
			for _, reconnect := range []bool{false, true} {
				name := kind + "/" + http.StatusText(status) + "/disconnect"
				if reconnect {
					name += "-reconnect"
				}
				t.Run(name, func(t *testing.T) {
					a, posts := newConnectionTestApp(t)
					client, reads := newSessionReadServer(t)
					a.client = client
					a.connected.Set(true)
					list := mobileListForTest(a, kind)
					list.load()
					old := nextSessionRead(t, reads)
					a.disconnect()
					if list.busy.GetUntracked() {
						t.Fatal("disconnect kept previous list request busy")
					}
					var current pendingSessionRead
					if reconnect {
						a.client = newSessionReadClient(client)
						a.connected.Set(true)
						list.load()
						current = nextSessionRead(t, reads)
					}
					list.err.Set("current notice")
					replySessionRead(t, posts, old, status, list.reply("old"))
					if list.id() != "" || list.err.GetUntracked() != "current notice" || list.busy.GetUntracked() != reconnect {
						t.Fatalf("old list changed current connection: id=%q busy=%v error=%q", list.id(), list.busy.GetUntracked(), list.err.GetUntracked())
					}
					if reconnect {
						replySessionRead(t, posts, current, http.StatusOK, list.reply("current"))
						if list.id() != "current" || list.busy.GetUntracked() {
							t.Fatal("current connection did not load its list")
						}
					}
				})
			}
		}
	}
}

func TestMobileListsCurrentErrorAllowsRetry(t *testing.T) {
	for _, kind := range []string{"agents", "tasks", "favorites"} {
		t.Run(kind, func(t *testing.T) {
			a, posts := newConnectionTestApp(t)
			client, reads := newSessionReadServer(t)
			a.client = client
			list := mobileListForTest(a, kind)
			list.load()
			replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusBadRequest, map[string]string{"error": "list failed"})
			if list.busy.GetUntracked() || list.err.GetUntracked() == "" {
				t.Fatal("current failure did not release loading and report the error")
			}
			list.load()
			replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusOK, list.reply("retry"))
			if list.id() != "retry" || list.busy.GetUntracked() || list.err.GetUntracked() != "" {
				t.Fatal("retry did not replace the error with the current list")
			}
		})
	}
}

func TestMobileTaskActionsIgnorePreviousConnection(t *testing.T) {
	for _, action := range []string{"toggle", "run"} {
		for _, status := range []int{http.StatusOK, http.StatusBadRequest} {
			t.Run(action+"/"+http.StatusText(status), func(t *testing.T) {
				a, posts := newConnectionTestApp(t)
				a.notice = core.NewSignal(a.cx, "")
				client, reads := newSessionReadServer(t)
				a.client = client
				a.connected.Set(true)
				start := func(id string) {
					if action == "toggle" {
						a.setTaskEnabled(id, true)
					} else {
						a.runTask(id)
					}
				}
				start("old")
				old := nextSessionRead(t, reads)
				a.disconnect()
				if a.taskBusy.GetUntracked() != "" {
					t.Fatal("disconnect kept previous task action busy")
				}
				a.client = newSessionReadClient(client)
				a.connected.Set(true)
				start("current")
				current := nextSessionRead(t, reads)
				if current.path != "/api/tasks/current/"+action {
					t.Fatalf("task action path = %q", current.path)
				}
				a.tasksErr.Set("current error")
				a.notice.Set("current notice")
				replySessionRead(t, posts, old, status, map[string]string{"error": "old failure"})
				if a.taskBusy.GetUntracked() != "current" || a.tasksErr.GetUntracked() != "current error" || a.notice.GetUntracked() != "current notice" || a.tasksBusy.GetUntracked() {
					t.Fatal("old task action changed current operation or refreshed the new desktop")
				}
				replySessionRead(t, posts, current, http.StatusOK, nil)
				if a.taskBusy.GetUntracked() != "" {
					t.Fatal("current task action did not finish")
				}
				if action == "run" && a.notice.GetUntracked() == "current notice" {
					t.Fatal("current run did not show its confirmation")
				}
				list := nextSessionRead(t, reads)
				if list.path != "/api/tasks" {
					t.Fatalf("task refresh path = %q", list.path)
				}
				replySessionRead(t, posts, list, http.StatusOK, remotewire.Tasks{Tasks: []remotewire.Task{{ID: "current"}}})
				if a.tasksBusy.GetUntracked() || len(a.tasks.GetUntracked()) != 1 || a.tasks.GetUntracked()[0].ID != "current" {
					t.Fatal("current task refresh did not load")
				}
			})
		}
	}
}
