package main

// End-to-end checks that drive a real pi process through the app.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// requirePi skips a test that drives a real pi when it is not installed:
// everything a session shows comes from pi, and a CI runner has none. Tests
// that check what the app does without pi do not ask for this.
func requirePi(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("pi"); err != nil {
		t.Skip("pi is not on PATH: this test drives a real pi")
	}
}

// startApp opens the app on a temp data directory and adds dir as the
// workspace through the folder browser.
func startApp(t *testing.T, dir string, width, height core.Points) *nsgotest.App {
	t.Helper()
	if os.Getenv("PIDECK_LITE_HOME") == "" {
		t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	}
	return openApp(t, dir, width, height)
}

// openApp opens the app on whatever data directory the test set, with the
// system's folder picker answering dir.
func openApp(t *testing.T, dir string, width, height core.Points) *nsgotest.App {
	t.Helper()
	requirePi(t)
	// Always give the app a data folder of its own: without one it would
	// write its config and seed files into the working directory.
	if os.Getenv("PIDECK_LITE_HOME") == "" {
		t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	}
	t.Cleanup(closeAllPi)
	app := nsgotest.Start(t, Root, nsgotest.Size(width, height))
	// The app's own browser works the same on every platform, so the
	// end-to-end tests drive it; the system picker has a test of its own.
	app.Press("id:rail-palette")
	app.WaitFor("text:浏览文件夹添加工作区", 15*time.Second)
	// The palette and the picker can still be settling under load; press
	// again until each step shows.
	for i := 0; i < 3 && len(app.Query("text:选择这个文件夹")) == 0; i++ {
		app.Press("text:浏览文件夹添加工作区")
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
	app.WaitFor("text:选择这个文件夹", 30*time.Second)
	// The picker can still be settling under load and take the field's text
	// with it, so type the path again before each submit.
	for i := 0; i < 4 && len(app.Query("text:note.txt")) == 0; i++ {
		app.Clear("label:文件夹路径")
		app.Type("label:文件夹路径", dir)
		app.Submit("label:文件夹路径")
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
	app.WaitFor("text:note.txt", 30*time.Second)
	for i := 0; i < 3 && len(app.Query("text:打开一个会话，或者新建一个。")) == 0; i++ {
		app.Press("text:选择这个文件夹")
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
	app.WaitFor("text:打开一个会话，或者新建一个。", 30*time.Second)
	// With a project in place the welcome's main action opens a session.
	app.Press("id:welcome-primary")
	app.WaitFor("id:composer", 30*time.Second)
	// A folder added at runtime starts untrusted; tests trust it once. A
	// press can land before the bar settles, so try a few times.
	for i := 0; i < 4; i++ {
		if len(app.Query("id:trust-project")) == 0 {
			break
		}
		app.Press("id:trust-project")
		time.Sleep(100 * time.Millisecond)
		app.Settle()
	}
	return app
}

// typeAll fills a field and checks it holds the whole text: a rebuild
// between keystrokes can drop the rest under load.
func typeAll(t *testing.T, app *nsgotest.App, selector, text string) {
	t.Helper()
	for i := 0; i < 5; i++ {
		app.Clear(selector)
		app.Type(selector, text)
		if got := app.Find(selector).Text; got == text {
			return
		}
		app.Settle()
	}
	t.Fatalf("%s holds %q, want %q", selector, app.Find(selector).Text, text)
}

// waitApp waits for what another goroutine posts: on a platform a frame
// alone does not run every posted callback, so this settles with real
// pauses between tries.
func waitApp(app *nsgotest.App, selector string, d time.Duration) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		app.Settle()
		if len(app.Query(selector)) > 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	app.WaitFor(selector, time.Second)
}

// waitQuiet reports whether a selector matched within d, without failing
// the test: a press that lands on a moving row can be tried again.
func waitQuiet(app *nsgotest.App, selector string, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		app.Settle()
		if len(app.Query(selector)) == 1 {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// shot captures a screenshot on a platform, where the pixels exist.
func shot(app *nsgotest.App, name string) {
	if nsgotest.Target() != "" {
		app.Screenshot(name)
	}
}

// openPhoneRail opens the project rail on a phone: the sessions live in
// the drawer there, not on the page.
func openPhoneRail(app *nsgotest.App) {
	// A drawer that just closed keeps its backdrop over the page for its
	// slide-out; let that finish, or the press lands on the backdrop.
	app.Advance(300 * time.Millisecond)
	app.Press("id:mobile-drawer")
}

// workspaceWith makes a temp project with a small file pi can read.
func workspaceWith(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "pideck-workspace-")
	if err != nil {
		t.Fatal(err)
	}
	// The app's file watcher can hold a handle for a moment after the test;
	// give it time rather than failing the cleanup.
	t.Cleanup(func() {
		for i := 0; i < 40; i++ {
			if os.RemoveAll(dir) == nil {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello tool"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// TestChatTurn sends a prompt to the real pi and waits for the answer.
func TestChatTurn(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	app.Type("id:composer", "只输出这个标记，不要别的：PONG-7431")
	app.Press("role:button 发送")
	waitApp(app, `text:"PONG-7431"`, 180*time.Second)
	app.Advance(300 * time.Millisecond)
	shot(app, "10-chat")
}

// TestToolTurn asks for a tool call, then opens the tool row to read its
// output.
func TestToolTurn(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	app.Type("id:composer", "用 read 工具读一下 note.txt，然后用一句话说文件里有什么")
	app.Press("role:button 发送")
	// The finished turn folds its work behind a summary row; open it, then
	// the tool row, to read what the tool returned.
	waitApp(app, "text:个工具调用", 180*time.Second)
	app.Press("text:个工具调用")
	app.Advance(200 * time.Millisecond)
	app.WaitFor("role:button 读取", 5*time.Second)
	// The row is its own button; the output is inside it once open.
	output := `role:button 读取 >> text:"hello tool"`
	app.Press("role:button 读取")
	if !waitQuiet(app, output, 3*time.Second) {
		app.Press("role:button 读取")
	}
	app.WaitFor(output, 10*time.Second)
	app.Advance(300 * time.Millisecond)
	shot(app, "11-tools")
}

// TestStopAborts starts a long answer and stops it.
func TestStopAborts(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	app.Type("id:composer", "写一篇一千字的散文，主题是雨。不要用工具，直接写。")
	app.Press("role:button 发送")
	app.WaitFor("role:button 停止", 30*time.Second)
	app.Press("role:button 停止")
	waitApp(app, "text:/已停止/", 90*time.Second)
	app.WaitFor("role:button 发送", 10*time.Second)
}

// TestDraftSurvives ticks the clock while typing and checks the field keeps
// its text: a rebuild of the composer must not reset it.
func TestDraftSurvives(t *testing.T) {
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	app.Type("id:composer", "第一行")
	app.Advance(1500 * time.Millisecond)
	app.Type("id:composer", "\n第二行")
	app.Advance(1500 * time.Millisecond)
	if got := app.Find("id:composer").Text; !strings.Contains(got, "第二行") || !strings.Contains(got, "第一行") {
		t.Fatalf("composer lost its draft: %q", got)
	}
	shot(app, "12-draft")
}

// TestRestore reopens the app on the same data directory and finds the
// conversation where it was left.
func TestRestore(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := workspaceWith(t)
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	t.Cleanup(closeAllPi)
	app := openApp(t, dir, 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	app.Type("id:composer", "只输出这个标记，不要别的：RESTORE-9182")
	app.Press("role:button 发送")
	waitApp(app, `text:"RESTORE-9182"`, 180*time.Second)
	app.Settle()
	// A second window on the same data, as the next launch would be.
	closeAllPi()
	app2 := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	app2.Settle()
	waitApp(app2, `text:"RESTORE-9182"`, 60*time.Second)
	shot(app2, "13-restore")
}

// TestLook captures the app in dark mode and while an answer streams.
func TestLook(t *testing.T) {
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	app.Press("label:会话面板")
	app.Advance(300 * time.Millisecond)
	shot(app, "20-drawer")
	app.Press("label:切换外观")
	app.Press("label:切换外观")
	app.Advance(300 * time.Millisecond)
	shot(app, "21-dark")
	app.Type("id:composer", "写一篇六百字左右的说明文，主题是本机编码助手，不要用工具，也不要列清单。")
	app.Press("role:button 发送")
	// Let a few hundred characters arrive, then look at the live state.
	app.Advance(2 * time.Second)
	shot(app, "21-streaming")
	waitApp(app, "role:button 复制回复", 180*time.Second)
	app.Advance(300 * time.Millisecond)
	shot(app, "22-answer")
}

// TestImport copies a session file into the app and opens it.
func TestImport(t *testing.T) {
	requirePi(t)
	dir := workspaceWith(t)
	src := filepath.Join(dir, "old-session.jsonl")
	body := `{"type":"session","version":3,"id":"11111111-2222-4333-8444-555555555555","timestamp":"2026-01-02T03:04:05.000Z","cwd":"` + filepath.ToSlash(dir) + `"}
{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":"旧的提问","timestamp":1767323046000}}
{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"assistant","content":[{"type":"text","text":"旧的回答"}],"api":"x","provider":"x","model":"x","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1767323047000}}
`
	if err := os.WriteFile(src, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	t.Cleanup(closeAllPi)
	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	app.Press("text:导入会话")
	app.WaitFor("id:import-dialog", 5*time.Second)
	app.Press("id:import-file")
	app.WaitFor("id:picker-choose", 5*time.Second)
	app.Clear("label:文件夹路径")
	app.Type("label:文件夹路径", dir)
	app.Submit("label:文件夹路径")
	app.WaitFor("text:old-session.jsonl", 5*time.Second)
	app.Press("text:old-session.jsonl")
	app.Press("id:picker-choose")
	app.WaitUntil(30*time.Second, func() bool { return len(app.Query("text:旧的提问")) > 0 })
	// Let the imported session's pi start, so closing it at the end of the
	// test is what frees the temp folder.
	waitApp(app, "id:pi-ready", 40*time.Second)
	shot(app, "30-import")
}

// TestModelSearch types into the model menu and checks the list filters.
func TestModelSearch(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	app.Press("id:model-picker")
	app.WaitFor("id:model-search", 5*time.Second)
	app.WaitUntil(30*time.Second, func() bool { return len(app.Query("role:option")) > 0 })
	before := len(app.Query("role:option"))
	if before == 0 {
		t.Fatal("the menu listed no models")
	}
	typeAll(t, app, "id:model-search", "zzzz")
	if got := app.Find("id:model-search").Text; got != "zzzz" {
		t.Fatalf("search field holds %q, want zzzz", got)
	}
	app.WaitFor("text:没有匹配的模型", 5*time.Second)
	app.Clear("id:model-search")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		app.Settle()
		if len(app.Query("role:option")) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := len(app.Query("role:option")); got != before {
		t.Fatalf("after clearing the search %d models show, want %d", got, before)
	}
}

// TestModelRefresh asks pi for its model list from the menu.
func TestModelRefresh(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	app.Press("id:model-picker")
	app.WaitFor("id:model-refresh", 5*time.Second)
	app.Press("id:model-refresh")
	app.WaitFor("text:模型列表已刷新", 15*time.Second)
}

// TestThinkingMenu switches the reasoning level from the composer.
func TestThinkingMenu(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:effort-picker", 90*time.Second)
	app.Press("id:effort-picker")
	app.WaitFor("text:低", 20*time.Second)
	app.Press("text:低")
	app.Advance(300 * time.Millisecond)
	// Close the panel again and check the chip alone names the level.
	app.Press("id:effort-picker")
	app.Advance(300 * time.Millisecond)
	if got := len(app.Query("text:低")); got != 1 {
		t.Fatalf("after choosing 低 the chip shows %d level labels, want 1", got)
	}
}

// TestDeleteSessionFromMenu deletes an imported session through its
// right-click menu and the confirmation.
func TestDeleteSessionFromMenu(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := workspaceWith(t)
	src := filepath.Join(dir, "gone.jsonl")
	cwd := filepath.ToSlash(dir)
	body := `{"type":"session","version":3,"id":"cccccccc-2222-4333-8444-555555555555","timestamp":"2026-01-02T03:04:05.000Z","cwd":"` + cwd + `"}
{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":"待删除的会话","timestamp":1767323046000}}
`
	if err := os.WriteFile(src, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	t.Cleanup(closeAllPi)
	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	app.Press("text:导入会话")
	app.WaitFor("id:import-dialog", 5*time.Second)
	app.Press("id:import-file")
	app.WaitFor("id:picker-choose", 5*time.Second)
	app.Clear("label:文件夹路径")
	app.Type("label:文件夹路径", dir)
	app.Submit("label:文件夹路径")
	app.WaitFor("text:gone.jsonl", 5*time.Second)
	app.Press("text:gone.jsonl")
	app.Press("id:picker-choose")
	waitApp(app, "text:待删除的会话", 30*time.Second)
	waitApp(app, "id:pi-ready", 40*time.Second)

	app.RightClick("id:session-row")
	app.WaitFor("text:删除会话", 5*time.Second)
	app.Press("text:删除会话")
	app.WaitFor("id:confirm-ok", 5*time.Second)
	app.Press("id:confirm-ok")
	app.WaitUntil(5*time.Second, func() bool {
		return len(app.Query("id:session-row")) == 0
	})
}

// TestProjectMenu walks a project's right-click menu: the items exist, the
// path can be copied, and removing the project asks first.
func TestProjectMenu(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := workspaceWith(t)
	app := startApp(t, dir, 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	label := "text:" + filepath.Base(dir)
	waitApp(app, label, 30*time.Second)
	// The row can rebuild while the press lands; try until its menu is up.
	for i := 0; i < 4; i++ {
		app.RightClick(label)
		if waitQuiet(app, `text:"在此新建会话"`, 2*time.Second) {
			break
		}
	}
	for _, item := range []string{"在此新建会话", "刷新会话", "在文件管理器中打开", "复制项目路径", "添加项目…", "移除项目"} {
		app.WaitFor(`text:"`+item+`"`, 5*time.Second)
	}
	app.Press("text:复制项目路径")
	if app.Clipboard != dir {
		t.Fatalf("copied %q, want %q", app.Clipboard, dir)
	}
}

// TestSessionMenuPinAndRename pins a session and renames it from its menu.
func TestSessionMenuPinAndRename(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	for i := 0; i < 4; i++ {
		app.RightClick("id:session-row")
		if waitQuiet(app, "text:置顶会话", 2*time.Second) {
			break
		}
	}
	app.Press("text:置顶会话")
	app.WaitFor("text:置顶", 10*time.Second)
	// Pinning moves the row; try the press until its menu is up.
	for i := 0; i < 4; i++ {
		app.RightClick("id:session-row")
		if waitQuiet(app, "role:menuitem 重命名", 2*time.Second) {
			break
		}
	}
	app.Press("role:menuitem 重命名")
	app.WaitFor("id:rename-ok", 5*time.Second)
	app.Clear("label:会话名称")
	app.Type("label:会话名称", "改过的名字")
	app.Press("id:rename-ok")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		app.Settle()
		if len(app.Query("text:改过的名字")) > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the new name is not shown")
}
