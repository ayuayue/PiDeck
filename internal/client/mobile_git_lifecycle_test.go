package client

import (
	"net/http"
	"testing"

	"example.com/pideck-v2/internal/remotewire"
)

func TestMobileGitReadKeepsProjectVisit(t *testing.T) {
	for _, navigation := range []string{"project", "reopen", "connection"} {
		for _, status := range []int{http.StatusOK, http.StatusForbidden} {
			t.Run(navigation+"/"+http.StatusText(status), func(t *testing.T) {
				a, posts := newConnectionTestApp(t)
				client, reads := newSessionReadServer(t)
				a.client = client
				a.openGit("/a", "A")
				old := nextSessionRead(t, reads)
				project := "/a"
				if navigation == "project" {
					project = "/b"
				}
				if navigation == "connection" {
					a.disconnect()
					a.client = newSessionReadClient(client)
				} else {
					a.gitOpen.Set(false)
				}
				a.openGit(project, "current")
				a.gitErr.Set("current notice")
				replySessionRead(t, posts, old, status, remotewire.Git{IsRepo: true, Branch: "old", Files: []remotewire.GitFile{{Path: "old-only"}}})
				if a.gitState.GetUntracked().IsRepo || !a.gitBusy.GetUntracked() || a.gitErr.GetUntracked() != "current notice" {
					t.Fatal("old repository response replaced the current visit or released its loading state")
				}
				current := nextSessionRead(t, reads)
				replySessionRead(t, posts, current, http.StatusOK, remotewire.Git{IsRepo: true, Branch: "current"})
				if a.gitBusy.GetUntracked() || a.gitState.GetUntracked().Branch != "current" {
					t.Fatal("current repository did not load")
				}
			})
		}
	}
}

func TestMobileGitDiffKeepsLatestFile(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusBadRequest} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			a, posts := newConnectionTestApp(t)
			client, reads := newSessionReadServer(t)
			a.client = client
			a.openGit("/a", "A")
			replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusOK, remotewire.Git{IsRepo: true})
			a.openGitDiff("same.txt")
			old := nextSessionRead(t, reads)
			a.gitDiffOpen.Set(false)
			a.openGitDiff("same.txt")
			current := nextSessionRead(t, reads)
			replySessionRead(t, posts, old, status, map[string]string{"patch": "old"})
			if !a.gitDiffBusy.GetUntracked() || a.gitDiffText.GetUntracked() != "" || a.gitDiffErr.GetUntracked() != "" {
				t.Fatal("old diff replaced the reopened file")
			}
			replySessionRead(t, posts, current, http.StatusOK, map[string]string{"patch": "current"})
			if a.gitDiffBusy.GetUntracked() || a.gitDiffText.GetUntracked() != "current" {
				t.Fatal("current diff did not load")
			}
		})
	}
}

func TestMobileGitActionsKeepProjectVisit(t *testing.T) {
	for _, action := range []string{"stage", "commit", "checkout", "sync"} {
		for _, status := range []int{http.StatusOK, http.StatusBadRequest} {
			t.Run(action+"/"+http.StatusText(status), func(t *testing.T) {
				a, posts := newConnectionTestApp(t)
				client, reads := newSessionReadServer(t)
				a.client = client
				open := func(project string) {
					a.openGit(project, project)
					replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusOK, remotewire.Git{IsRepo: true, Branch: "main"})
				}
				start := func() {
					switch action {
					case "stage":
						a.gitStage("file.txt", true)
					case "commit":
						a.gitMsg.Set("message")
						a.commitGit()
					case "checkout":
						a.gitCheckout("feature")
					case "sync":
						a.gitSync("fetch")
					}
				}
				open("/a")
				start()
				old := nextSessionRead(t, reads)
				open("/b")
				if a.gitSending.GetUntracked() {
					t.Fatal("previous project kept new actions busy")
				}
				start()
				current := nextSessionRead(t, reads)
				a.notice.Set("current notice")
				a.gitMsg.Set("new draft")
				replySessionRead(t, posts, old, status, nil)
				if !a.gitSending.GetUntracked() || a.notice.GetUntracked() != "current notice" || a.gitMsg.GetUntracked() != "new draft" || a.gitBusy.GetUntracked() {
					t.Fatal("old action changed the current operation or refreshed another project")
				}
				replySessionRead(t, posts, current, http.StatusOK, nil)
				if a.gitSending.GetUntracked() {
					t.Fatal("current action did not finish")
				}
				replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusOK, remotewire.Git{IsRepo: true, Branch: "current"})
				if a.gitState.GetUntracked().Branch != "current" {
					t.Fatal("current action did not refresh its project")
				}
			})
		}
	}
}
