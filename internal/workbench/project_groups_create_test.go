//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestCreateProjectGroupAndDissolve(t *testing.T) {
	home, first, second := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	cfg := config{Version: 1, Theme: "system", SidebarOpen: true, ProjectSort: "manual",
		Workspaces: []workspaceCfg{{Path: first, Name: "已有项目", Pinned: true, Expanded: true}}}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var built *app
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	app.WaitFor("id:project-row", 5*time.Second)
	original := built.workspaceOf(first)
	s := built.blankSession("group-existing-session", original, "已有目录的会话")
	original.Sessions.Set([]*session{s})
	app.Settle()
	app.PickDirectories = func(pick nsgotest.DirectoryPick) []core.Directory {
		if pick.Limit == 1 {
			t.Fatal("the group picker only accepts one directory")
		}
		dirs := []core.Directory{{Path: first}, {Path: second}, {Path: second}}
		if runtime.GOOS == "windows" {
			dirs = append(dirs, core.Directory{Path: strings.ToUpper(first)})
		}
		return dirs
	}
	app.Press("id:add-project")
	app.Press("id:add-project-group")
	app.WaitFor("id:project-group-create", 5*time.Second)
	app.Type("id:project-group-create-name", "联合项目")
	app.Press("id:project-group-add-directories")
	app.Settle()
	if got := len(built.projects()); got != 1 {
		t.Fatalf("choosing folders before saving changed project count to %d", got)
	}
	if got := len(app.Query("role:checkbox")); got != 2 {
		t.Fatalf("the directory picker lists %d choices, want 2 unique folders", got)
	}
	app.Press("id:project-group-create-save")
	app.WaitFor("text:联合项目", 5*time.Second)
	if got := len(app.Query("id:project-row")); got != 2 {
		t.Fatalf("grouped projects appear %d times, want exactly 2", got)
	}
	if got := len(built.projects()); got != 2 {
		t.Fatalf("project count = %d, want 2 unique directories", got)
	}
	other := built.workspaceOf(second)
	if built.workspaceOf(first) != original || original.Group != "联合项目" || other == nil || other.Group != "联合项目" {
		t.Fatal("group creation did not reuse the existing workspace and group both directories")
	}
	groups := built.projectGroups()
	if len(groups) != 1 || groups[0].Name != "联合项目" || len(groups[0].Projects) != 2 {
		t.Fatalf("a pinned member escaped its group: %#v", groups)
	}
	otherSession := built.blankSession("group-new-session", other, "新目录的会话")
	other.Sessions.Set([]*session{otherSession})
	app.WaitFor("text:已有目录的会话", 5*time.Second)
	app.WaitFor("text:新目录的会话", 5*time.Second)
	// Re-adding a grouped directory still resolves to the same workspace.
	built.addWorkspace(first)
	app.Settle()
	if len(built.projects()) != 2 || len(app.Query("id:project-row")) != 2 {
		t.Fatal("adding a grouped directory separately duplicated its display")
	}
	assertStored := func(group string) {
		t.Helper()
		var got config
		data, err := os.ReadFile(filepath.Join(home, "config.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatal(err)
		}
		if len(got.Workspaces) != 2 {
			t.Fatalf("stored workspace count = %d, want 2", len(got.Workspaces))
		}
		for _, ws := range got.Workspaces {
			if ws.Group != group {
				t.Fatalf("stored group = %q, want %q", ws.Group, group)
			}
		}
	}
	assertStored("联合项目")
	app.Press("id:project-group-menu-联合项目")
	app.Press("id:project-group-dissolve")
	app.Settle()
	if original.Group != "" || other.Group != "" || !original.Pinned || original.Name != "已有项目" {
		t.Fatal("dissolving the group lost the original project's state")
	}
	if len(app.Query("id:project-row")) != 2 || original.Sessions.GetUntracked()[0] != s || other.Sessions.GetUntracked()[0] != otherSession {
		t.Fatal("dissolving the group lost projects or sessions")
	}
	assertStored("")
}

func TestProjectGroupSelectExistingTargets(t *testing.T) {
	home, local, untouched := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	remote := target{Kind: targetSSH, Host: "group-test.invalid"}
	cfg := config{Version: 1, Theme: "system", SidebarOpen: true, ProjectSort: "manual",
		Workspaces: []workspaceCfg{
			{Path: local, Name: "本机项目", Pinned: true},
			{Path: "/work/project", Name: "远端项目", Target: remote.key()},
			{Path: untouched, Name: "不加入的项目"},
		}}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var built *app
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	app.Press("id:add-project")
	app.Press("id:add-project-group")
	app.WaitFor("id:project-group-create", 5*time.Second)
	if !app.Find("id:project-group-create-save").Props.Disabled {
		t.Fatal("an empty group can be saved")
	}
	app.Type("id:project-group-create-name", "未分组")
	if !app.Find("id:project-group-create-save").Props.Disabled {
		t.Fatal("a group with no directories can be saved")
	}
	for _, d := range []projectGroupDirectory{{target: localTarget, path: local}, {target: remote, path: "/work/project"}} {
		id := "id:project-group-choice-" + d.key()
		app.Press(id)
		if !app.Find(id).Props.Checked {
			t.Fatalf("directory %q was not selected", d.path)
		}
	}
	app.Press("id:project-group-create-save")
	app.Settle()
	localWS, remoteWS := built.workspaceOf(local), built.workspaceFor(remote, "/work/project")
	if localWS.Group != "未分组" || remoteWS.Group != "未分组" || built.workspaceOf(untouched).Group != "" {
		t.Fatal("checkbox selection changed the wrong project memberships")
	}
	if localWS.Expanded.GetUntracked() || remoteWS.Expanded.GetUntracked() {
		t.Fatal("grouping changed existing projects' expansion state")
	}
	groups := built.projectGroups()
	if len(groups) != 2 || !groups[0].Named || groups[1].Named || len(groups[0].Projects) != 2 || len(groups[1].Projects) != 1 {
		t.Fatalf("a named group collided with the ungrouped heading: %#v", groups)
	}
	built.dissolveProjectGroup("未分组")
	app.Settle()
	if len(built.projects()) != 3 || len(app.Query("id:project-row")) != 3 || !localWS.Pinned {
		t.Fatal("ungrouping did not preserve all selected and unselected projects")
	}
}

func TestCancelProjectGroupDoesNotAddDirectories(t *testing.T) {
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	var built *app
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	// The projects column is also reachable without an existing project.
	built.openRailTab(railTabProjects)
	app.Settle()
	dir := t.TempDir()
	app.PickDirectories = func(nsgotest.DirectoryPick) []core.Directory {
		return []core.Directory{{Path: dir}}
	}
	app.Press("id:add-project")
	app.Press("id:add-project-group")
	app.WaitFor("id:project-group-create", 5*time.Second)
	app.Press("id:project-group-add-directories")
	app.Press("id:project-group-create-cancel")
	app.Settle()
	if len(built.projects()) != 0 || built.workspaceOf(dir) != nil {
		t.Fatal("cancelling group creation left a project behind")
	}
}
