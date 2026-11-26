//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

type reviewCLICall struct {
	Dir   string
	Args  []string
	Stdin string
}

type reviewCLIResult struct {
	Out  string
	Err  string
	Code int
}

// A copy of this test executable acts as gh. Requests only reach the local
// fixture server; neither the developer's GitHub account nor the network is used.
func init() {
	name := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	if name != "gh" || os.Getenv("PIDECK_TEST_REVIEW_CLI") == "" {
		return
	}
	dir, _ := os.Getwd()
	stdin, _ := io.ReadAll(os.Stdin)
	body, _ := json.Marshal(reviewCLICall{Dir: dir, Args: os.Args[1:], Stdin: string(stdin)})
	client := http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(os.Getenv("PIDECK_TEST_REVIEW_CLI"), "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprint(os.Stderr, err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	var result reviewCLIResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		fmt.Fprint(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Fprint(os.Stdout, result.Out)
	fmt.Fprint(os.Stderr, result.Err)
	os.Exit(result.Code)
}

func reviewTestCLI(t *testing.T, run func(reviewCLICall) reviewCLIResult) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var call reviewCLICall
		if err := json.NewDecoder(r.Body).Decode(&call); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(run(call))
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	name := "gh"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	data, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_TEST_REVIEW_CLI", server.URL)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func reviewTestRepo(t *testing.T, parent, name string) string {
	t.Helper()
	dir := filepath.Join(parent, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", dir}, {"-C", dir, "remote", "add", "origin", "https://github.com/test/" + name + ".git"}} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	return dir
}

func reviewTestScreen(t *testing.T, projects []workspaceCfg) (*nsgotest.App, *app) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: projects, Theme: "system", ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.reviewPane()
	}, nsgotest.Size(1100, 850))
	// Native test hosts dispose their scope after testing's TempDir cleanup.
	// Close the fixture's journal first so Windows can remove its data directory.
	t.Cleanup(built.closeDiag)
	screen.Post(built.reviewAttach)
	screen.Settle()
	return screen, built
}

func reviewTestRead[T any](screen *nsgotest.App, read func() T) T {
	var value T
	screen.Post(func() { value = read() })
	screen.Settle()
	return value
}

func reviewTestResponse(call reviewCLICall) reviewCLIResult {
	name := filepath.Base(call.Dir)
	if len(call.Args) >= 2 && call.Args[1] == "list" {
		return reviewCLIResult{Out: fmt.Sprintf(`[{"number":1,"title":%q,"state":"OPEN","url":"https://github.com/test/%s/pull/1"}]`, name+" item", name)}
	}
	if len(call.Args) >= 2 && call.Args[1] == "view" {
		return reviewCLIResult{Out: fmt.Sprintf(`{"number":1,"title":%q,"state":"OPEN","body":"Fixture detail"}`, name+" item")}
	}
	return reviewCLIResult{Err: "fixture refuses unexpected command", Code: 1}
}

func TestReviewReposPreferChildRepositories(t *testing.T) {
	parent := t.TempDir()
	alpha := reviewTestRepo(t, parent, "alpha")
	reviewTestRepo(t, parent, "beta")
	repos := reviewRepos(localTarget, parent)
	if len(repos) != 2 || !samePath(repos[0].Path, alpha) || repos[0].Name != "test/alpha" {
		t.Fatalf("repositories = %+v, want only the two child clones, starting with alpha", repos)
	}
}

func TestReviewImportedProjects(t *testing.T) {
	reviewTestCLI(t, reviewTestResponse)
	parent := t.TempDir()
	reviewTestRepo(t, parent, "alpha")
	reviewTestRepo(t, parent, "beta")
	gamma := reviewTestRepo(t, t.TempDir(), "gamma")
	screen, built := reviewTestScreen(t, []workspaceCfg{{Path: parent, Name: "First project"}, {Path: gamma, Name: "Second project"}})
	screen.WaitFor("id:review-project", 5*time.Second)
	screen.WaitFor("text:alpha item", 10*time.Second)
	screen.Press("id:review-repo")
	screen.Press("id:review-repo-beta")
	screen.WaitFor("text:beta item", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("text:Fixture detail", 10*time.Second)
	screen.Type("id:review-comment", "First project's draft")
	screen.Press("id:review-repo")
	screen.Press("id:review-repo-alpha")
	screen.WaitFor("id:review-row-pr#1", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("id:review-comment", 10*time.Second)
	if got := screen.Find("id:review-comment").Text; got != "" {
		t.Fatalf("another repository's draft = %q, want empty", got)
	}
	screen.Press("id:review-repo")
	screen.Press("id:review-repo-beta")
	screen.WaitFor("id:review-comment", 10*time.Second)
	if got := screen.Find("id:review-comment").Text; got != "First project's draft" {
		t.Fatalf("restored repository's draft = %q", got)
	}
	screen.Press("id:review-project")
	screen.Press("text:Second project")
	screen.WaitFor("text:gamma item", 10*time.Second)
	if got := built.review.commentText.GetUntracked(); got != "" {
		t.Fatalf("second project's draft = %q, want empty", got)
	}
	screen.Press("id:review-kind-issue")
	screen.WaitFor("id:review-row-issue#1", 10*time.Second)
	screen.Type("id:review-search", "label:bug")
	screen.Key("enter")
	screen.WaitUntil(5*time.Second, func() bool {
		return built.review.query.GetUntracked() == "label:bug" && !built.review.state.GetUntracked().Loading
	})
	screen.Press("id:review-project")
	screen.Press("text:First project")
	screen.WaitFor("text:Fixture detail", 10*time.Second)
	_, selected := built.review.repo()
	if filepath.Base(selected) != "beta" || built.review.commentText.GetUntracked() != "First project's draft" {
		t.Fatalf("first project restored repo %q, draft %q", selected, built.review.commentText.GetUntracked())
	}
	screen.Press("id:review-project")
	screen.Press("text:Second project")
	screen.WaitFor("id:review-row-issue#1", 10*time.Second)
	if built.review.search.GetUntracked() != "label:bug" || built.review.query.GetUntracked() != "label:bug" {
		t.Fatalf("second project's search was not restored")
	}
	screen.Screenshot("review/projects")
}

func TestReviewRepositorySwitchDuringRead(t *testing.T) {
	started, release := make(chan struct{}, 1), make(chan struct{})
	reviewTestCLI(t, func(call reviewCLICall) reviewCLIResult {
		if filepath.Base(call.Dir) == "alpha" && len(call.Args) > 1 && call.Args[1] == "list" {
			select {
			case started <- struct{}{}:
			default:
			}
			<-release
		}
		return reviewTestResponse(call)
	})
	defer close(release)
	parent := t.TempDir()
	alpha := reviewTestRepo(t, parent, "alpha")
	beta := reviewTestRepo(t, parent, "beta")
	screen, built := reviewTestScreen(t, []workspaceCfg{{Path: alpha, Name: "Project"}})
	screen.WaitUntil(10*time.Second, func() bool {
		select {
		case <-started:
			return true
		default:
			return false
		}
	})
	screen.Post(func() { built.review.setRepoPath(beta) })
	screen.WaitFor("text:beta item", 10*time.Second)
}

func TestReviewCommentFailureKeepsDraft(t *testing.T) {
	reviewTestCLI(t, func(call reviewCLICall) reviewCLIResult {
		if len(call.Args) > 1 && call.Args[1] == "comment" {
			return reviewCLIResult{Err: "fixture permission denied", Code: 1}
		}
		return reviewTestResponse(call)
	})
	repo := reviewTestRepo(t, t.TempDir(), "alpha")
	screen, built := reviewTestScreen(t, []workspaceCfg{{Path: repo, Name: "Project"}})
	screen.WaitFor("id:review-row-pr#1", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("id:review-comment", 10*time.Second)
	screen.Type("id:review-comment", "Keep this draft")
	screen.Press("id:review-comment-send")
	screen.WaitFor("text:fixture permission denied", 10*time.Second)
	if got := built.review.commentText.GetUntracked(); got != "Keep this draft" {
		t.Fatalf("draft after failed comment = %q, want preserved", got)
	}
}
