package main

// Checks the MCP list parser, the pi mcp arguments and the settings section.

import (
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestParseMCPServers(t *testing.T) {
	raw := `{"servers":[
		{"name":"a","scope":"global","transport":"http://x/mcp","state":"connected","tools":["t1","t2"],"exposure":"codemode"},
		{"name":"b","scope":"project","state":"failed","error":"boom"}
	]}`
	list, err := parseMCPServers([]byte(raw))
	if err != nil || len(list) != 2 {
		t.Fatalf("servers = %+v, %v", list, err)
	}
	if list[0].Name != "a" || len(list[0].Tools) != 2 || list[0].Transport != "http://x/mcp" {
		t.Fatalf("a = %+v", list[0])
	}
	if list[1].Error != "boom" || list[1].Scope != "project" {
		t.Fatalf("b = %+v", list[1])
	}
	if _, err := parseMCPServers([]byte("not json")); err == nil {
		t.Fatal("bad JSON should fail")
	}
}

func TestMCPArgs(t *testing.T) {
	args, err := mcpAddArgs("srv", "npx -y some-server", "", "does things", true)
	if err != nil {
		t.Fatal(err)
	}
	want := "mcp add srv -l --description does things -- npx -y some-server"
	if strings.Join(args, " ") != want {
		t.Fatalf("args = %q", strings.Join(args, " "))
	}
	args, err = mcpAddArgs("srv", "", "https://x/mcp", "", false)
	if err != nil || strings.Join(args, " ") != "mcp add srv --url https://x/mcp" {
		t.Fatalf("url args = %q, %v", strings.Join(args, " "), err)
	}
	if _, err := mcpAddArgs("", "x", "", "", false); err == nil {
		t.Fatal("an empty name should fail")
	}
	if _, err := mcpAddArgs("s", "", "ftp://x", "", false); err == nil {
		t.Fatal("a non-http URL should fail")
	}
	if _, err := mcpAddArgs("s", "  ", "", "", false); err == nil {
		t.Fatal("an empty command should fail")
	}
	if got := strings.Join(mcpRemoveArgs("srv", true), " "); got != "mcp remove srv -l" {
		t.Fatalf("remove = %q", got)
	}
}

func TestMCPSection(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-mcp")
	app.WaitFor("id:mcp-add", 5*time.Second)
	app.Press("id:mcp-add")
	app.WaitFor("id:mcp-dialog", 5*time.Second)
	app.Type("id:mcp-name", "demo")
	app.Type("id:mcp-url", "https://example.com/mcp")
	app.Press("id:mcp-cancel")
	app.WaitForGone("id:mcp-dialog", 5*time.Second)
}
