//go:build !js && !android && !ios

package workbench

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestBrowserURL(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{name: "https", in: "https://example.com/docs", want: "https://example.com/docs", ok: true},
		{name: "http", in: "http://localhost:3000/", want: "http://localhost:3000/", ok: true},
		{name: "missing scheme", in: "  example.com/docs  ", want: "https://example.com/docs", ok: true},
		{name: "port without scheme", in: "127.0.0.1:8787", want: "https://127.0.0.1:8787", ok: true},
		{name: "protocol relative", in: "//example.com/docs", want: "https://example.com/docs", ok: true},
		{name: "http shorthand", in: "http:example.com", want: "http://example.com", ok: true},
		{name: "uppercase scheme", in: "HTTPS://example.com", want: "https://example.com", ok: true},
		{name: "query containing scheme", in: "example.com/search?next=https://other.example/path", want: "https://example.com/search?next=https://other.example/path", ok: true},
		{name: "localhost port", in: "localhost:3000/health", want: "https://localhost:3000/health", ok: true},
		{name: "unsupported scheme", in: "ftp://example.com", ok: false},
		{name: "script", in: "javascript:alert(1)", ok: false},
		{name: "data", in: "data:text/html,hello", ok: false},
		{name: "empty", in: "  ", ok: false},
		{name: "newline", in: "https://example.com\n/path", ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := browserURL(tt.in)
			if tt.ok {
				if err != nil || got != tt.want {
					t.Fatalf("browserURL(%q) = %q, %v; want %q", tt.in, got, err, tt.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("browserURL(%q) = %q, want an error", tt.in, got)
			}
		})
	}
}

func TestBrowserAddressSubmitLoadsURL(t *testing.T) {
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("id:browser-toggle")
	app.WaitFor("id:browser-address", 5*time.Second)
	app.Type("id:browser-address", "example.com")
	app.Submit("id:browser-address")
	app.WaitFor("id:browser-webview", 5*time.Second)
	got := app.Find("id:browser-webview").Web.Source.Src
	if got != "https://example.com" {
		t.Fatalf("browser source = %q, want https://example.com", got)
	}

	app.Clear("id:browser-address")
	app.Type("id:browser-address", "http://example.org/path?next=https://other.example")
	app.Press("id:browser-go")
	app.WaitFor("id:browser-webview", 5*time.Second)
	got = app.Find("id:browser-webview").Web.Source.Src
	if got != "http://example.org/path?next=https://other.example" {
		t.Fatalf("button navigation source = %q, want query URL", got)
	}

	app.Clear("id:browser-address")
	app.Type("id:browser-address", "javascript:alert(1)")
	app.Press("id:browser-go")
	app.WaitFor("id:browser-error", 5*time.Second)
	if !app.Exists("text:请输入有效的 HTTP 或 HTTPS 地址。") {
		t.Fatal("invalid address did not show an error message")
	}
}
