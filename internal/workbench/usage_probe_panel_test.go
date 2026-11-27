//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestUsageProbeSub2APIPanelRefreshAndPersistence(t *testing.T) {
	usageProbeTestConfigDir(t)
	expired := "header." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":1}`)) + ".signature"
	var refreshes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/usage":
			io.WriteString(w, `{"remaining":-1,"usage":{"total":{"actual_cost":2}}}`)
		case "/api/v1/auth/refresh":
			refreshes.Add(1)
			if r.Method != "POST" || r.Header.Get("Authorization") != "" {
				t.Error("refresh must POST without API key/Bearer")
			}
			body, _ := io.ReadAll(r.Body)
			if string(body) != `{"refresh_token":"old-refresh"}` {
				t.Errorf("refresh body=%s", body)
			}
			io.WriteString(w, `{"code":0,"data":{"access_token":"fresh-jwt","refresh_token":"fresh-refresh"}}`)
		case "/api/v1/auth/me":
			if r.Header.Get("Authorization") != "Bearer fresh-jwt" {
				w.WriteHeader(401)
				return
			}
			io.WriteString(w, `{"data":{"balance":12.34,"email":"private@example.test"}}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	config := usageProbeConfig{Enabled: usageProbeTestEnabled(), Template: "sub2api", PanelJWT: expired, PanelRefreshToken: "old-refresh"}
	if err := saveUsageProbeConfig("sample", config); err != nil {
		t.Fatal(err)
	}
	provider := providerConfig{ID: "sample", BaseURL: server.URL + "/v1"}
	var workers sync.WaitGroup
	for i := 0; i < 2; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			result, err := queryProviderUsage(context.Background(), server.Client(), provider, providerModelCredential{Value: "api-key"}, config)
			if err != nil || !strings.Contains(result.Summary, "12.34") || strings.Contains(strings.Join(result.Details, " "), "private@") {
				t.Errorf("panel result=%+v err=%v", result, err)
			}
		}()
	}
	workers.Wait()
	if refreshes.Load() != 1 {
		t.Fatalf("single-use refresh raced: calls=%d", refreshes.Load())
	}
	got, _, err := loadUsageProbeConfig("sample")
	if err != nil || got.PanelJWT != "fresh-jwt" || got.PanelRefreshToken != "fresh-refresh" {
		t.Fatalf("rotated pair not saved: %+v err=%v", got, err)
	}
}

func TestUsageProbeSub2APIPanelDraftAndFailure(t *testing.T) {
	usageProbeTestConfigDir(t)
	config := usageProbeConfig{Enabled: usageProbeTestEnabled(), Template: "sub2api", PanelJWT: "saved-jwt", PanelRefreshToken: "saved-refresh"}
	if err := saveUsageProbeConfig("sample", config); err != nil {
		t.Fatal(err)
	}
	if err := usageProbePersistPanelTokens("sample", usageProbeConfig{Template: "sub2api", PanelJWT: "draft-jwt"}, "new-jwt", "new-refresh"); err != nil {
		t.Fatal(err)
	}
	got, _, _ := loadUsageProbeConfig("sample")
	if got.PanelJWT != "saved-jwt" {
		t.Fatal("draft changed saved tokens")
	}
	var refreshes atomic.Int32
	client := &http.Client{Transport: usageProbeRoundTripper(func(req *http.Request) (*http.Response, error) {
		if strings.Contains(req.URL.Path, "refresh") {
			refreshes.Add(1)
			return usageProbeTestResponse(401, "secret-refresh-response"), nil
		}
		if strings.Contains(req.URL.Path, "auth/me") {
			return usageProbeTestResponse(401, "secret-panel-response"), nil
		}
		return usageProbeTestResponse(200, `{"usage":{"total":{"actual_cost":3}}}`), nil
	})}
	result, err := queryProviderUsage(context.Background(), client, providerConfig{ID: "sample", BaseURL: "https://example.test/v1"}, providerModelCredential{Value: "key"}, config)
	if err != nil || len(result.Details) < 2 || refreshes.Load() != 1 || strings.Contains(strings.Join(result.Details, " "), "secret-") {
		t.Fatalf("panel failure must degrade once: %+v refreshes=%d err=%v", result, refreshes.Load(), err)
	}
}

func TestUsageProbePanelJWTExpiry(t *testing.T) {
	now := time.Unix(1000, 0)
	for _, test := range []struct {
		token string
		want  bool
	}{
		{"opaque", false}, {"a.invalid!.b", false},
		{"a." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":1060}`)) + ".b", true},
		{"a." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":1061}`)) + ".b", false},
		{"a." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":0}`)) + ".b", false},
	} {
		if got := usageProbePanelNeedsRefresh(test.token, now); got != test.want {
			t.Errorf("expiry got=%v want=%v", got, test.want)
		}
	}
}

func TestUsageProbeVolcengineSignatureAndFallback(t *testing.T) {
	now := time.Date(2026, 6, 1, 2, 3, 4, 0, time.UTC)
	headers := usageProbeVolcengineHeaders("test-ak", "test-sk", "GetAFPUsage", "cn-beijing", "ark.cn-beijing.volcengineapi.com", now)
	if headers["X-Date"] != "20260601T020304Z" || headers["X-Content-Sha256"] != "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" || !strings.HasPrefix(headers["Authorization"], "HMAC-SHA256 Credential=test-ak/20260601/cn-beijing/ark/request, SignedHeaders=host;x-date;x-content-sha256;content-type, Signature=") || headers["Host"] != "" {
		t.Fatalf("signing headers=%v", headers)
	}
	if headers["Authorization"] == usageProbeVolcengineHeaders("test-ak", "test-sk", "GetCodingPlanUsage", "cn-beijing", "ark.cn-beijing.volcengineapi.com", now)["Authorization"] {
		t.Fatal("signature did not bind Action")
	}
	for base, want := range map[string]string{"https://ark.cn-shanghai.volces.com/api/v3": "cn-shanghai", "ark.ap-southeast-1.volces.com": "cn-beijing", "https://unknown.test": "cn-beijing"} {
		if got := usageProbeResolveVolcengineRegion(base); got != want {
			t.Errorf("region %s=%s want %s", base, got, want)
		}
	}
	var calls int
	client := &http.Client{Transport: usageProbeRoundTripper(func(req *http.Request) (*http.Response, error) {
		calls++
		body, _ := io.ReadAll(req.Body)
		if req.Method != "POST" || string(body) != "{}" || !strings.HasPrefix(req.Header.Get("Authorization"), "HMAC-SHA256 ") || req.Header.Get("Content-Type") != "application/json; charset=utf-8" {
			t.Errorf("unsigned/invalid control-plane request")
		}
		if calls <= 2 {
			return usageProbeTestResponse(200, `{"Result":{"AFPFiveHour":{"Quota":0,"Used":0}}}`), nil
		}
		if req.URL.Query().Get("Action") != "GetCodingPlanUsage" || req.URL.Host != "ark.cn-beijing.volcengineapi.com" {
			t.Errorf("fallback order: %s", req.URL)
		}
		return usageProbeTestResponse(200, `{"Result":{"QuotaUsage":[{"Level":"session","Percent":35}]}}`), nil
	})}
	result, err := queryProviderUsage(context.Background(), client, providerConfig{BaseURL: "https://ark.cn-beijing.volces.com/api/v3"}, providerModelCredential{}, usageProbeConfig{Enabled: usageProbeTestEnabled(), Template: "volcengine", AccessKeyID: "test-ak", SecretAccessKey: "test-sk"})
	if err != nil || calls != 3 || !strings.Contains(result.Summary, "35.00") {
		t.Fatalf("fallback result=%+v calls=%d err=%v", result, calls, err)
	}
}
