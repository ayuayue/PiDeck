package client

// Checks the phone API's auth and parsing, the session reading it serves,
// and the phone screen against a fake desktop.

import (
	"bytes"
	"encoding/json"
	"errors"
	"image"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	qrcode "github.com/skip2/go-qrcode"
)

// TestMobileConnect drives the phone screen against a fake desktop.
func TestMobileConnect(t *testing.T) {
	const token = "phone-token"
	state := remotewire.Snapshot{Name: "PiDeck V2", Version: "0.2.0", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{
			{ID: "s1", Title: "电脑上的会话", Status: "idle", Updated: time.Now().UnixMilli()},
		},
	}}}
	transcript := remotewire.Transcript{ID: "s1", Title: "电脑上的会话", Messages: []remotewire.Message{
		{Role: "user", Text: "手机能看到吗"},
		{Role: "thinking", Text: "用户在问手机端能不能看到会话内容。"},
		{Role: "tool", Text: "read src/app.ts"},
		{Role: "tool", Text: "edit src/app.ts"},
		{Role: "assistant", Text: "看到了，这是电脑上的会话。"},
	}}
	server := newTestHTTPServer(t, token, state, transcript)
	defer server.Close()

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-server", 10*time.Second)
	shot(app, "59-mobile-connect")
	app.Type("id:mobile-server", server.URL)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")
	waitApp(app, "text:电脑项目", 15*time.Second)
	shot(app, "60-mobile-home")
	// The projects and their sessions live in the drawer.
	openPhoneRail(app)
	app.WaitFor("id:mobile-session", 10*time.Second)
	shot(app, "60-mobile-rail")
	// A press can land while the list is still settling; try again.
	for i := 0; i < 3; i++ {
		app.Press("id:mobile-session")
		if waitQuiet(app, "text:看到了，这是电脑上的会话。", 5*time.Second) {
			break
		}
	}
	waitApp(app, "text:看到了，这是电脑上的会话。", 15*time.Second)
	shot(app, "61-mobile-transcript")
	// A finished turn folds its process into one row that opens in place.
	app.Press("id:mobile-process")
	waitApp(app, "text:read src/app.ts", 5*time.Second)
	shot(app, "66-mobile-tools")
}

func TestMobileConnectUsesEnteredTokenOverLinkToken(t *testing.T) {
	const token = "fresh-connect-token"
	state := remotewire.Snapshot{Name: "PiDeck V2", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "新令牌连接", Sessions: []remotewire.Session{{ID: "s1", Title: "连接会话"}},
	}}}
	server := newTestHTTPServer(t, token, state, remotewire.Transcript{ID: "s1"})
	defer server.Close()

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-server", 10*time.Second)
	app.Type("id:mobile-server", server.URL+"?token=expired-token")
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")
	waitApp(app, "text:新令牌连接", 15*time.Second)
}

func TestMobilePasteConnectUsesTokenFromLink(t *testing.T) {
	seenAuth := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth <- r.Header.Get("Authorization")
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-token", 10*time.Second)
	app.Type("id:mobile-token", "stale-token")
	app.Clipboard = server.URL + "?token=link-token"
	app.Press("id:mobile-paste-connect")
	select {
	case got := <-seenAuth:
		if got != "Bearer link-token" {
			t.Fatalf("authorization = %q, want pasted link token", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pasted connection did not reach the server")
	}
}

func TestMobilePasteAddressKeepsEnteredToken(t *testing.T) {
	seenAuth := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth <- r.Header.Get("Authorization")
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-token", 10*time.Second)
	app.Type("id:mobile-token", "manual-token")
	app.Clipboard = server.URL
	app.Press("id:mobile-paste-connect")
	select {
	case got := <-seenAuth:
		if got != "Bearer manual-token" {
			t.Fatalf("authorization = %q, want manually entered token", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pasted address did not reach the server")
	}
}

// newTestHTTPServer is the desktop the mobile test connects to.
func newTestHTTPServer(t *testing.T, token string, state remotewire.Snapshot, transcript remotewire.Transcript) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	check := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "PiDeck V2", "host": "desk"})
		}
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(state)
		}
	})
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			if strings.HasSuffix(r.URL.Path, "/s1") {
				_ = json.NewEncoder(w).Encode(transcript)
				return
			}
			http.NotFound(w, r)
		}
	})
	return httptest.NewServer(mux)
}

// TestQRRoundTrip encodes a connection link and reads it back, the way the
// desktop shows a code and the phone scans it.
func TestQRRoundTrip(t *testing.T) {
	link := "http://10.0.2.2:8787/?token=abc123"
	if given := os.Getenv("PIDECK_QR_LINK"); given != "" {
		link = given
	}
	png, err := qrcode.Encode(link, qrcode.Medium, 256)
	if err != nil {
		t.Fatal(err)
	}
	if len(png) == 0 {
		t.Fatal("no QR image")
	}
	// PIDECK_QR_OUT writes the code to a file, for trying it on a device.
	if out := os.Getenv("PIDECK_QR_OUT"); out != "" {
		if err := os.WriteFile(out, png, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := decodeQRLink(png)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got != link {
		t.Fatalf("decoded %q, want %q", got, link)
	}
}

func TestDecodeQRLinkRejectsOversizedDimensionsBeforeDecode(t *testing.T) {
	data := []byte{
		0xff, 0xd8, // SOI
		0xff, 0xc0, 0x00, 0x11, // baseline SOF, 17-byte segment
		0x08, 0x27, 0x10, 0x27, 0x10, 0x03, // precision, 10000x10000, three components
		0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
		0xff, 0xda, 0x00, 0x0c, // SOS, 12-byte segment
		0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00,
		0xff, 0xd9, // EOI; no pixel data is present
	}
	if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
		t.Fatalf("test JPEG header is invalid: %v", err)
	}
	if _, err := decodeQRLink(data); !errors.Is(err, errScanImageDimensionsTooLarge) {
		t.Fatalf("oversized image error = %v, want %v", err, errScanImageDimensionsTooLarge)
	}
}

func TestReadScanImageBoundsGalleryInput(t *testing.T) {
	dir := t.TempDir()
	large := filepath.Join(dir, "large-image.png")
	if err := os.WriteFile(large, []byte{0}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(large, maxScanImageBytes+1); err != nil {
		t.Fatal(err)
	}
	if _, err := readScanImage(large); !errors.Is(err, errScanImageTooLarge) {
		t.Fatalf("large image error = %v, want %v", err, errScanImageTooLarge)
	}

	small := filepath.Join(dir, "small-image.png")
	want := []byte("not a decoded image yet")
	if err := os.WriteFile(small, want, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readScanImage(small)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("small image bytes = %q, want %q", got, want)
	}
}

// TestMobileLiveScanConnects uses NSGo's native scanner result instead of
// making the user take a separate photo first.
func TestMobileLiveScanConnects(t *testing.T) {
	const token = "scan-token"
	state := remotewire.Snapshot{Name: "PiDeck V2", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "扫码项目", Sessions: []remotewire.Session{{ID: "s1", Title: "扫码会话"}},
	}}}
	server := newTestHTTPServer(t, token, state, remotewire.Transcript{ID: "s1"})
	defer server.Close()

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860),
		nsgotest.Environment(core.Environment{Camera: true, ScanCode: true}))
	app.ScanCode = func(core.ScanRequest) (*core.ScannedCode, error) {
		return &core.ScannedCode{Text: server.URL + "?token=" + token}, nil
	}
	app.WaitFor("id:mobile-scan", 5*time.Second)
	app.Press("id:mobile-scan")
	waitApp(app, "text:扫码项目", 15*time.Second)
	if len(app.Scans) != 1 {
		t.Fatalf("scan requests = %d, want 1", len(app.Scans))
	}
}

// TestMobileLiveScanWithoutTokenKeepsAddress lets the user fill a token after
// scanning an address-only code.
func TestMobileLiveScanWithoutTokenKeepsAddress(t *testing.T) {
	const token = "manual-scan-token"
	state := remotewire.Snapshot{Name: "PiDeck V2", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "手动令牌项目", Sessions: []remotewire.Session{{ID: "s1", Title: "扫码会话"}},
	}}}
	server := newTestHTTPServer(t, token, state, remotewire.Transcript{ID: "s1"})
	defer server.Close()

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860),
		nsgotest.Environment(core.Environment{Camera: true, ScanCode: true}))
	app.ScanCode = func(core.ScanRequest) (*core.ScannedCode, error) {
		return &core.ScannedCode{Text: server.URL}, nil
	}
	app.WaitFor("id:mobile-scan", 5*time.Second)
	app.Press("id:mobile-scan")
	app.WaitFor("text:请填写访问令牌，或粘贴完整的连接链接", 5*time.Second)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")
	waitApp(app, "text:手动令牌项目", 15*time.Second)
}

// TestMobileLiveScanCancel keeps the connect form usable when the scanner is
// closed without reading a code.
func TestMobileLiveScanCancel(t *testing.T) {
	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860),
		nsgotest.Environment(core.Environment{Camera: true, ScanCode: true}))
	app.ScanCode = func(core.ScanRequest) (*core.ScannedCode, error) { return nil, nil }
	app.WaitFor("id:mobile-scan", 5*time.Second)
	app.Press("id:mobile-scan")
	app.Settle()
	if len(app.Scans) != 1 {
		t.Fatalf("scan requests = %d, want 1", len(app.Scans))
	}
	if len(app.Query("id:mobile-server")) != 1 {
		t.Fatal("connect form disappeared after scanner cancel")
	}
	if len(app.Query("text:扫码失败")) != 0 {
		t.Fatal("scanner cancel showed an error")
	}
}

// TestMobileLiveScanError preserves a recoverable error and leaves paste and
// photo-library alternatives on screen when camera permission is denied.
func TestMobileLiveScanError(t *testing.T) {
	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860),
		nsgotest.Environment(core.Environment{Camera: true, ScanCode: true}))
	app.ScanCode = func(core.ScanRequest) (*core.ScannedCode, error) {
		return nil, errors.New("相机权限被拒绝")
	}
	app.WaitFor("id:mobile-scan", 5*time.Second)
	app.Press("id:mobile-scan")
	app.WaitFor("text:扫码失败：相机权限被拒绝", 5*time.Second)
	if len(app.Query("id:mobile-paste-connect")) != 1 || len(app.Query("id:mobile-scan-library")) != 1 {
		t.Fatal("fallback connection actions disappeared after scanner error")
	}
}

// TestMobileLiveScanRejectsUntrustedText checks that a scanned payload goes
// through the same URL parser as pasted text.
func TestMobileLiveScanRejectsUntrustedText(t *testing.T) {
	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860),
		nsgotest.Environment(core.Environment{Camera: true, ScanCode: true}))
	app.ScanCode = func(core.ScanRequest) (*core.ScannedCode, error) {
		return &core.ScannedCode{Text: "ftp://example.com/?token=not-a-pideck-token"}, nil
	}
	app.WaitFor("id:mobile-scan", 5*time.Second)
	app.Press("id:mobile-scan")
	app.WaitFor("text:连接地址只支持 http 或 https", 5*time.Second)
	if len(app.Query("id:mobile-server")) != 1 {
		t.Fatal("invalid scanned link changed the connection form")
	}
}

// TestMobilePhotoScanFallback keeps QR capture working on targets that have a
// camera but do not expose NSGo's live scanner.
func TestMobilePhotoScanFallback(t *testing.T) {
	const token = "photo-scan-token"
	state := remotewire.Snapshot{Name: "PiDeck V2", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "拍照项目", Sessions: []remotewire.Session{{ID: "s1", Title: "拍照会话"}},
	}}}
	server := newTestHTTPServer(t, token, state, remotewire.Transcript{ID: "s1"})
	defer server.Close()
	// goqr confuses digits in the loopback IPv4 host; localhost is still
	// served by httptest and keeps this fallback test about scanning.
	link := strings.Replace(server.URL, "127.0.0.1", "localhost", 1) + "?token=" + token
	png, err := qrcode.Encode(link, qrcode.Medium, 256)
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860),
		nsgotest.Environment(core.Environment{Camera: true, ScanCode: false}))
	app.TakePhoto = func(core.PickRequest) (*core.PickedFile, error) {
		return &core.PickedFile{Data: png, MIME: "image/png"}, nil
	}
	app.WaitFor("id:mobile-scan", 5*time.Second)
	app.Press("id:mobile-scan")
	waitApp(app, "text:拍照项目", 15*time.Second)
	if len(app.Photos) != 1 || len(app.Scans) != 0 {
		t.Fatalf("photo fallback requests = %d photos, %d scans", len(app.Photos), len(app.Scans))
	}
}

func TestMobileScanWithoutCameraExplainsFallback(t *testing.T) {
	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860),
		nsgotest.Environment(core.Environment{}))
	app.WaitFor("id:mobile-scan", 5*time.Second)
	app.Press("id:mobile-scan")
	app.WaitFor("text:这台设备没有可用的相机，用下面的链接和令牌连接吧", 5*time.Second)
	if len(app.Scans) != 0 || len(app.Photos) != 0 {
		t.Fatal("scan without camera requested a native camera service")
	}
}

// TestRememberConnection keeps the newest server first, once each.
func TestRememberConnection(t *testing.T) {
	saved := rememberConnection(nil, mobileRecent{Server: "http://a", Token: "1", Name: "a"})
	if saved.Server != "http://a" || len(saved.Recent) != 1 {
		t.Fatalf("first = %+v", saved)
	}
	saved = rememberConnection(saved.Recent, mobileRecent{Server: "http://b", Token: "2", Name: "b"})
	if saved.Server != "http://b" || len(saved.Recent) != 2 || saved.Recent[0].Server != "http://b" {
		t.Fatalf("second = %+v", saved)
	}
	saved = rememberConnection(saved.Recent, mobileRecent{Server: "http://a", Token: "3", Name: "a2"})
	if len(saved.Recent) != 2 || saved.Recent[0].Name != "a2" {
		t.Fatalf("moved = %+v", saved)
	}
	for i := 0; i < 8; i++ {
		saved = rememberConnection(saved.Recent, mobileRecent{Server: "http://x" + strconv.Itoa(i), Name: "x"})
	}
	if len(saved.Recent) != 5 {
		t.Fatalf("capped at %d", len(saved.Recent))
	}
}

// TestMobileRecentConnections shows the servers the phone has used.
func TestMobileRecentConnections(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", home)
	raw, err := json.Marshal(mobileSaved{Recent: []mobileRecent{
		{Server: "http://10.0.2.2:8787", Token: "a", Name: "caoayu", At: 2},
		{Server: "http://100.64.0.8:8787", Token: "b", Name: "笔记本", At: 1},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "remote.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("text:最近连接", 5*time.Second)
	if got := len(app.Query("id:mobile-recent")); got != 2 {
		t.Fatalf("recent rows = %d, want 2", got)
	}
	app.Advance(300 * time.Millisecond)
	shot(app, "68-mobile-recent")
}

// TestMobileRecentAfterConnect lists the server the phone just used, without
// restarting: the saved link alone does not fill the list.
func TestMobileRecentAfterConnect(t *testing.T) {
	const token = "phone-token"
	state := remotewire.Snapshot{Name: "PiDeck V2", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{{ID: "s1", Title: "电脑上的会话"}},
	}}}
	server := newTestHTTPServer(t, token, state, remotewire.Transcript{ID: "s1"})
	defer server.Close()

	home := t.TempDir()
	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", home)
	raw, err := json.Marshal(mobileSaved{Server: server.URL, Token: token})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "remote.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	waitApp(app, "text:电脑项目", 15*time.Second)
	openPhoneRail(app)
	app.Press("id:mobile-settings")
	app.WaitFor("id:mobile-settings-sheet", 5*time.Second)
	app.Press("id:mobile-disconnect")
	app.WaitFor("text:最近连接", 5*time.Second)
	if got := len(app.Query("id:mobile-recent")); got != 1 {
		t.Fatalf("recent rows = %d, want 1", got)
	}
}

// TestMobileAsk answers the desktop's pending question from the phone.
func TestMobileAsk(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	const token = "phone-token"
	var mu sync.Mutex
	ask := &remotewire.Ask{Method: "confirm", Title: "允许运行 go test？", Message: "桌面在等你"}
	var answered map[string]any
	state := remotewire.Snapshot{Name: "PiDeck V2", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{{ID: "s1", Title: "电脑上的会话"}},
	}}}
	check := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "PiDeck V2", "host": "desk"})
		}
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(state)
		}
	})
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		mu.Lock()
		tr := remotewire.Transcript{ID: "s1", Title: "电脑上的会话", Ask: ask}
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(tr)
	})
	mux.HandleFunc("/api/sessions/s1/answer", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		answered, ask = body, nil
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-server", 10*time.Second)
	app.Type("id:mobile-server", server.URL)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")
	waitApp(app, "text:电脑项目", 15*time.Second)
	openPhoneRail(app)
	app.WaitFor("id:mobile-session", 10*time.Second)
	// The press can land while the list settles; try again.
	for i := 0; i < 3; i++ {
		app.Press("id:mobile-session")
		if waitQuiet(app, "id:mobile-ask", 5*time.Second) {
			break
		}
	}
	waitApp(app, "id:mobile-ask", 15*time.Second)
	app.Press("id:mobile-ask-allow")
	deadline := time.Now().Add(10 * time.Second)
	for {
		mu.Lock()
		got := answered
		mu.Unlock()
		if got != nil && got["confirmed"] == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("answer = %+v", got)
		}
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
	app.WaitForGone("id:mobile-ask", 10*time.Second)
}
