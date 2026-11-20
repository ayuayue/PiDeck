//go:build !js && !android && !ios

package workbench

import (
	"html"
	"os"
	"regexp"
	"slices"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base/textview"
)

const shareRedacted = "[redacted]"

var (
	sharePrivateKey  = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	shareCredentials = regexp.MustCompile(`(?im)(\b(?:[a-z0-9_-]*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|credential)[a-z0-9_-]*|authorization|token|secret)["']?[ \t]*[:=][ \t]*)(?:(?:bearer|basic)[ \t]+)?(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s"'<>\x60,;&]+)`)
	shareToken       = regexp.MustCompile(`(?i)\b(?:sk-(?:proj-|ant-)?|sk_(?:live|test)_|rk_(?:live|test)_|glpat-|gldt-|glrt-|glcbt-|github_pat_|gh[pousr]_|xox[baprs]-|hf_|npm_|gocspx-|AIza|AKIA|ASIA)[A-Za-z0-9_-]{12,}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
	shareBearerToken = regexp.MustCompile(`(?i)(\bBearer[ \t]+)[A-Za-z0-9._~+/-]{16,}=*`)
	shareURLAuth     = regexp.MustCompile(`(?i)(https?://)[^\s/@]+:[^\s/@]+@`)
	shareImage       = regexp.MustCompile(`(?i)data:image/[^\s"'<>)]*`)
	sharePath        = regexp.MustCompile(`(?im)(^|[\s\x60"'(<\[=])(?:file://[^\s\x60"'<>\])]+|(?:[a-z]:[/\\]|\\\\|/|~/)[^/\s\x60"'<>\])][^\s\x60"'<>\])]*)`)
	shareQuotedPath  = regexp.MustCompile("(?im)([\"'`])(?:[a-z]:[/\\\\]|\\\\\\\\|/|~/)[^\\r\\n\"'`]+[\"'`]")
)

func (a *app) shareExportSecrets() []string {
	if a.st == nil {
		return nil
	}
	c := a.st.config()
	return []string{c.RemoteToken, c.RemoteRelayKey, c.VoiceAccessToken, c.FeishuWebhook, c.FeishuSecret, c.FeishuVerifyToken}
}

// Build a new document from conversation text. Metadata, tool results,
// error details and images never make it into this projection.
func shareExport(d exportData, secrets []string) exportData {
	secrets = slices.Clone(secrets)
	if home, err := os.UserHomeDir(); err == nil {
		secrets = append(secrets, home, strings.ReplaceAll(home, `\`, "/"))
	}
	secrets = append(secrets, d.Project, strings.ReplaceAll(d.Project, `\`, "/"))
	slices.SortFunc(secrets, func(a, b string) int { return len(b) - len(a) })
	replacements := make([]string, 0, len(secrets)*2)
	for _, secret := range secrets {
		if len(secret) >= 4 {
			replacements = append(replacements, secret, shareRedacted)
		}
	}
	replace := strings.NewReplacer(replacements...)
	clean := func(text string) string {
		text = html.UnescapeString(text)
		// Decode visible Markdown/HTML text before redacting: entities can
		// conceal credential prefixes. The chat parser also strips image
		// links while keeping their alt text, without fetching the images.
		if strings.Contains(text, "![") || strings.Contains(text, "<") {
			text = textview.ParseWith(text, textview.Options{NoMath: true}).PlainText()
		}
		text = replace.Replace(text)
		text = sharePrivateKey.ReplaceAllString(text, shareRedacted)
		text = shareCredentials.ReplaceAllString(text, "${1}"+shareRedacted)
		text = shareBearerToken.ReplaceAllString(text, "${1}"+shareRedacted)
		text = shareToken.ReplaceAllString(text, shareRedacted)
		text = shareURLAuth.ReplaceAllString(text, "${1}"+shareRedacted+"@")
		text = shareQuotedPath.ReplaceAllString(text, shareRedacted)
		text = sharePath.ReplaceAllString(text, "${1}"+shareRedacted)
		return strings.TrimSpace(shareImage.ReplaceAllString(text, ""))
	}
	shared := exportData{Title: apptext.T("分享副本"), Shared: true, Turns: make([]turn, 0, len(d.Turns))}
	for _, t := range d.Turns {
		prompt, answer := clean(t.Prompt), clean(exportAnswer(t))
		if prompt != "" || answer != "" {
			shared.Turns = append(shared.Turns, turn{Prompt: prompt, Final: answer})
		}
	}
	return shared
}
