package volcvoice

// The service answers in headers as well as a body, so the client's test
// plays both: a refusal must not read as an empty recording, and a silent
// recording must not read as a failure.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func serve(t *testing.T, status int, headers map[string]string, body string) (*Client, *http.Request, *[]byte) {
	t.Helper()
	var got http.Request
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = *r
		gotBody, _ = io.ReadAll(r.Body)
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return &Client{HTTP: srv.Client(), Endpoint: srv.URL}, &got, &gotBody
}

func TestTranscribeSuccess(t *testing.T) {
	client, req, body := serve(t, http.StatusOK, map[string]string{"x-api-status-code": "20000000"},
		`{"result":{"text":" 你好，世界 "}}`)
	text, err := client.Transcribe(context.Background(), Credentials{AppID: "app", AccessToken: "token"}, []byte("RIFFdata"))
	if err != nil || text != "你好，世界" {
		t.Fatalf("transcribe = %q, %v", text, err)
	}
	if got := req.Header.Get("X-Api-Resource-Id"); got != "volc.bigasr.auc_turbo" {
		t.Fatalf("resource = %q", got)
	}
	if got := req.Header.Get("X-Api-App-Key"); got != "app" {
		t.Fatalf("app key = %q", got)
	}
	if got := req.Header.Get("X-Api-Access-Key"); got != "token" {
		t.Fatalf("access key = %q", got)
	}
	if req.Header.Get("X-Api-Request-Id") == "" {
		t.Fatal("no request id")
	}
	var sent request
	if err := json.Unmarshal(*body, &sent); err != nil {
		t.Fatal(err)
	}
	if sent.Audio.Format != "wav" || !sent.Request.EnablePunc || !sent.Request.EnableITN || sent.User.UID != "app" {
		t.Fatalf("request = %+v", sent)
	}
	if decoded, _ := base64.StdEncoding.DecodeString(sent.Audio.Data); string(decoded) != "RIFFdata" {
		t.Fatalf("audio = %q", decoded)
	}
}

func TestTranscribeResultAsString(t *testing.T) {
	client, _, _ := serve(t, http.StatusOK, map[string]string{"x-api-status-code": "20000000"}, `{"result":" 一行的结果 "}`)
	text, err := client.Transcribe(context.Background(), Credentials{AppID: "a", AccessToken: "t"}, []byte("wav"))
	if err != nil || text != "一行的结果" {
		t.Fatalf("transcribe = %q, %v", text, err)
	}
}

func TestTranscribeRefusals(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		headers map[string]string
		body    string
		want    error
	}{
		{"unauthorized", http.StatusUnauthorized, nil, "", ErrAuth},
		{"app id mismatch", http.StatusOK, map[string]string{"x-api-status-code": "45000010"}, "", ErrAuth},
		{"resource not granted", http.StatusOK, map[string]string{"x-api-status-code": "45000030"}, "", ErrAuth},
		{"bad params", http.StatusOK, map[string]string{"x-api-status-code": "45000001"}, "", ErrRejected},
		{"silent", http.StatusOK, map[string]string{"x-api-status-code": "20000003"}, "", ErrSilent},
		{"no transcript", http.StatusOK, map[string]string{"x-api-status-code": "20000000"}, `{"result":{}}`, ErrSilent},
		{"server error", http.StatusInternalServerError, nil, "", ErrRejected},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client, _, _ := serve(t, tc.status, tc.headers, tc.body)
			if _, err := client.Transcribe(context.Background(), Credentials{AppID: "a", AccessToken: "t"}, []byte("wav")); !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestTranscribeWithoutCredentials(t *testing.T) {
	called := false
	client, _, _ := serve(t, http.StatusOK, nil, `{}`)
	client.HTTP = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, errors.New("must not be called")
	})}
	if _, err := client.Transcribe(context.Background(), Credentials{AppID: "a"}, []byte("wav")); !errors.Is(err, ErrAuth) {
		t.Fatalf("err = %v, want ErrAuth", err)
	}
	if called {
		t.Fatal("the service was called without a token")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
