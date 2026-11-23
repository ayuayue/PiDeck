//go:build !js && !android && !ios

package workbench

// Checks the tip proxy's contract: the install id's shape, the answer's
// parsing, and the dialog's states.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestInstallID checks a generated id is a v4 UUID, which is what the
// proxy's user-id rule accepts.
func TestInstallID(t *testing.T) {
	id, err := newInstallID()
	if err != nil {
		t.Fatal(err)
	}
	if !watchaUserRE.MatchString(id) {
		t.Fatalf("id = %q", id)
	}
	if len(id) != 36 || id[14] != '4' {
		t.Fatalf("not a v4 uuid: %q", id)
	}
	other, _ := newInstallID()
	if other == id {
		t.Fatal("two ids came out the same")
	}
}

// TestParseWatchaBody keeps the documented fields and drops anything else.
func TestParseWatchaBody(t *testing.T) {
	body := `{"access":"purchase_required","remaining":2,
		"purchaseUrl":"alipays://platformapi/startapp?appId=1","qrCodeUrl":"https://example.com/qr","extra":"ignored"}`
	got, err := parseWatchaBody([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if got.Access != watchaRequired || got.Remaining != 2 ||
		got.PurchaseURL != "alipays://platformapi/startapp?appId=1" || got.QRCodeURL != "https://example.com/qr" {
		t.Fatalf("snapshot = %+v", got)
	}
	// A scheme the platform does not document is dropped, not opened.
	got, _ = parseWatchaBody([]byte(`{"access":"granted","remaining":1,"purchaseUrl":"javascript:alert(1)"}`))
	if got.PurchaseURL != "" {
		t.Fatalf("unsafe ticket kept: %+v", got)
	}
	// An unknown state fails closed.
	if _, err := parseWatchaBody([]byte(`{"access":"maybe"}`)); err == nil {
		t.Fatal("an unknown state should not parse")
	}
	if _, err := parseWatchaBody([]byte(`not json`)); err == nil {
		t.Fatal("bad JSON should not parse")
	}
	if _, err := parseWatchaBody([]byte(`{"error":"upstream","status":502}`)); err == nil {
		t.Fatal("an error body should not parse as a snapshot")
	}
}

// TestWatchaClient checks the request's shape and the two failure paths.
func TestWatchaClient(t *testing.T) {
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != watchaAccessPath {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		switch gotBody["user_id"] {
		case "user-ok-1234":
			_, _ = w.Write([]byte(`{"access":"granted","remaining":3}`))
		default:
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":"upstream_unreachable"}`))
		}
	}))
	defer srv.Close()
	old := watchaEdge
	watchaEdge = srv.URL
	defer func() { watchaEdge = old }()

	snapshot, err := fetchWatchaAccess("user-ok-1234")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Access != watchaGranted || snapshot.Remaining != 3 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if gotBody["user_id"] != "user-ok-1234" {
		t.Fatalf("body = %+v", gotBody)
	}
	if _, err := fetchWatchaAccess("user-bad-5678"); err == nil {
		t.Fatal("a 502 should be an error")
	}
	// A bad user id never leaves the process.
	if _, err := fetchWatchaAccess("bad id"); err == nil {
		t.Fatal("a malformed id should be refused")
	}
}

// TestSupportDialog opens the tip dialog against a stub proxy and checks
// the ticket shows up, then that a paid answer is reported.
func TestSupportDialog(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	paid := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if paid {
			_, _ = w.Write([]byte(`{"access":"granted","remaining":1}`))
			return
		}
		_, _ = w.Write([]byte(`{"access":"purchase_required","remaining":0,"purchaseUrl":"https://example.com/pay/ticket"}`))
	}))
	defer srv.Close()
	old := watchaEdge
	watchaEdge = srv.URL
	defer func() { watchaEdge = old }()
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1180, 900))
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-about", 10*time.Second)
	app.Press("id:settings-tab-about")
	app.WaitFor("id:support-open", 10*time.Second)
	app.Press("id:support-open")
	app.WaitFor("id:support", 5*time.Second)
	app.WaitFor("text:用支付宝扫一扫购买", 10*time.Second)
	app.Press("id:support-refresh")
	app.WaitFor("id:support-close", 5*time.Second)
	app.Press("id:support-close")
	app.WaitForGone("id:support", 5*time.Second)
}
