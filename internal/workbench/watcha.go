//go:build !js && !android && !ios

package workbench

// 爱猹收（watcha）的打赏：一次只读查询，拿当次的购买入口。
//
// 钱流是 用户 → 爱猹收 → 作者；平台的服务端 Key 只在边缘代理里（PiDeck 的
// pideck-pay 代理），客户端拿不到，也不该拿。这里只做一件事：把本机的安装级
// 用户 ID 发给代理，换回 { access, remaining, purchaseUrl, qrCodeUrl }。
//
// 纯打赏：不扣次数、不拦会话，remaining 只作展示。

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
)

const (
	// watchaEdgeURL is PiDeck's payment proxy, which holds the platform key.
	watchaEdgeURL = "https://pideck-pay.caoayu.top"
	// watchaAccessPath is the proxy's only route.
	watchaAccessPath = "/access"
	// watchaTimeout is generous: the proxy itself waits on a cross-border
	// upstream, and the desktop has to outlast it.
	watchaTimeout = 20 * time.Second
	// watchaMaxBytes bounds an answer that is normally under a kilobyte.
	watchaMaxBytes = 64 << 10
)

// The states the proxy reports.
const (
	watchaGranted     = "granted"
	watchaRequired    = "purchase_required"
	watchaUnavailable = "unavailable"
)

// watchaSnapshot is one read-only look at the tip page's state.
type watchaSnapshot struct {
	Access string
	// Remaining is how many times this install has supported the project.
	// It is a display value only; nothing is consumed.
	Remaining int
	// PurchaseURL is a short-lived ticket: an Alipay deep link or a page.
	PurchaseURL string
	QRCodeURL   string
}

// watchaError is a failure the dialog names in the user's language.
type watchaError struct {
	Code   string
	Detail string
}

// The codes the dialog translates.
const (
	watchaNotConfigured = "not-configured"
	watchaTimeoutCode   = "timeout"
	watchaNetworkCode   = "network"
	watchaHTTPCode      = "http"
	watchaBadAnswer     = "bad-response"
)

func (e watchaError) Error() string {
	if e.Detail != "" {
		return e.Code + ": " + e.Detail
	}
	return e.Code
}

// watchaEdge is the proxy's address; a test points it elsewhere.
var watchaEdge = watchaEdgeURL

// watchaUserRE is the proxy's rule for a user id: it ends up in a payment
// ticket, so no separators or quotes.
var watchaUserRE = regexp.MustCompile(`^[A-Za-z0-9._-]{6,80}$`)

// newInstallID is a random UUID v4 for this installation.
func newInstallID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// parseWatchaBody reads the proxy's answer. An unknown state is a bad
// answer, so the dialog fails closed instead of claiming the page worked.
func parseWatchaBody(raw []byte) (watchaSnapshot, error) {
	var body struct {
		Access      string  `json:"access"`
		Remaining   float64 `json:"remaining"`
		PurchaseURL string  `json:"purchaseUrl"`
		QRCodeURL   string  `json:"qrCodeUrl"`
		Error       string  `json:"error"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return watchaSnapshot{}, watchaError{Code: watchaBadAnswer}
	}
	if body.Error != "" {
		return watchaSnapshot{}, watchaError{Code: watchaHTTPCode, Detail: body.Error}
	}
	switch body.Access {
	case watchaGranted, watchaRequired, watchaUnavailable:
	default:
		return watchaSnapshot{}, watchaError{Code: watchaBadAnswer}
	}
	remaining := int(body.Remaining)
	if remaining < 0 {
		remaining = 0
	}
	return watchaSnapshot{
		Access:      body.Access,
		Remaining:   remaining,
		PurchaseURL: safeTicketURL(body.PurchaseURL),
		QRCodeURL:   safeTicketURL(body.QRCodeURL),
	}, nil
}

// safeTicketURL keeps the two schemes the platform documents, so a proxy
// answer cannot make the app open something else.
func safeTicketURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 4096 {
		return ""
	}
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "alipays://") {
		return value
	}
	return ""
}

// fetchWatchaAccess asks the proxy for this install's tip state.
func fetchWatchaAccess(userID string) (watchaSnapshot, error) {
	userID = strings.TrimSpace(userID)
	if !watchaUserRE.MatchString(userID) {
		return watchaSnapshot{}, watchaError{Code: watchaNotConfigured}
	}
	ctx, cancel := context.WithTimeout(context.Background(), watchaTimeout)
	defer cancel()
	payload, err := json.Marshal(map[string]string{"user_id": userID})
	if err != nil {
		return watchaSnapshot{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, watchaEdge+watchaAccessPath, bytes.NewReader(payload))
	if err != nil {
		return watchaSnapshot{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := appHTTPClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return watchaSnapshot{}, watchaError{Code: watchaTimeoutCode}
		}
		return watchaSnapshot{}, watchaError{Code: watchaNetworkCode, Detail: err.Error()}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, watchaMaxBytes))
	if resp.StatusCode != http.StatusOK {
		return watchaSnapshot{}, watchaError{Code: watchaHTTPCode, Detail: fmt.Sprintf("HTTP %d", resp.StatusCode)}
	}
	return parseWatchaBody(raw)
}

// watchaAccessLabel names a state for the dialog.
func watchaAccessLabel(s watchaSnapshot) string {
	switch s.Access {
	case watchaGranted:
		return apptext.T("已经支持过 %d 次，谢谢！", s.Remaining)
	case watchaRequired:
		return apptext.T("还没有支持过，可以请作者喝杯咖啡。")
	case watchaUnavailable:
		return apptext.T("暂时没有可用的购买入口（可能未开通或商品已下架）。")
	}
	return ""
}
