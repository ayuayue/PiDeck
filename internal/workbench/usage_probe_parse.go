//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"example.com/pideck/internal/apptext"
)

type usageProbeResult struct {
	Summary string
	Details []string
	At      time.Time
}

type usageProbeWindow struct {
	key                             string
	total, used, remaining, percent *float64
	resetsAt                        time.Time
}

type usageProbeBooster struct {
	balance, total, monthlyUsed, monthlyLimit *float64
	currency                                  string
	unlimited                                 bool
}

type usageProbeValues struct {
	balance, total, used, remaining *float64
	currency                        string
	windows                         []usageProbeWindow
	booster                         *usageProbeBooster
}

var usageProbePathSplit = regexp.MustCompile(`[.\[\]]`)

func usageProbeGet(body any, path string) any {
	if path == "" {
		return nil
	}
	for _, part := range usageProbePathSplit.Split(path, -1) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		switch current := body.(type) {
		case map[string]any:
			var exists bool
			body, exists = current[part]
			if !exists {
				return nil
			}
		case []any:
			index, err := strconv.Atoi(part)
			if err != nil || index < 0 || index >= len(current) {
				return nil
			}
			body = current[index]
		default:
			return nil
		}
	}
	return body
}

func usageProbeNumber(raw any) *float64 {
	var value float64
	var err error
	switch number := raw.(type) {
	case json.Number:
		value, err = number.Float64()
	case float64:
		value = number
	case string:
		number = strings.TrimSpace(number)
		if number == "" {
			return nil
		}
		value, err = strconv.ParseFloat(number, 64)
	default:
		return nil
	}
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return &value
}

func usageProbeObject(raw any) map[string]any {
	object, _ := raw.(map[string]any)
	return object
}

func usageProbeString(raw any) string {
	text, _ := raw.(string)
	return strings.TrimSpace(text)
}

func usageProbeN(body any, path string) *float64 { return usageProbeNumber(usageProbeGet(body, path)) }
func usageProbeFloat(value float64) *float64     { return &value }
func usageProbeClamp(value float64) float64      { return math.Max(0, math.Min(100, value)) }

func usageProbeParseBody(body any, spec usageProbeParse) (usageProbeValues, bool) {
	values := usageProbeValues{}
	if usageProbeObject(body) == nil {
		return values, false
	}
	switch spec.kind {
	case "custom":
		return usageProbeParseCustom(body, spec.resolver)
	case "balance":
		values.balance = usageProbeN(body, spec.valuePath)
		values.currency = usageProbeCurrency(usageProbeGet(body, spec.currencyPath))
		return values, values.balance != nil
	case "credits":
		scale := spec.scale
		if scale <= 0 || math.IsInf(scale, 0) || math.IsNaN(scale) {
			scale = 1
		}
		scaled := func(path string) *float64 {
			if n := usageProbeN(body, path); n != nil {
				return usageProbeNumber(*n / scale)
			}
			return nil
		}
		values.total, values.used, values.remaining = scaled(spec.totalPath), scaled(spec.usedPath), scaled(spec.remainingPath)
		if values.remaining == nil && values.total != nil && values.used != nil {
			values.remaining = usageProbeNumber(*values.total - *values.used)
		}
		for _, spec := range spec.windows {
			scope := body
			if spec.listPath != "" {
				scope = nil
				list, _ := usageProbeGet(body, spec.listPath).([]any)
				for _, item := range list {
					if usageProbeObject(item) == nil {
						continue
					}
					match := true
					for _, condition := range spec.where {
						if !usageProbeEquals(usageProbeGet(item, condition.path), condition.eq) {
							match = false
							break
						}
					}
					if match {
						scope = item
						break
					}
				}
			}
			w := usageProbeWindow{key: spec.key, total: usageProbeN(scope, spec.totalPath), used: usageProbeN(scope, spec.usedPath), remaining: usageProbeN(scope, spec.remainingPath), percent: usageProbeN(scope, spec.percentPath)}
			if spec.remainingPath == "" && w.total != nil && w.used != nil {
				w.remaining = usageProbeNumber(*w.total - *w.used)
			}
			if w.percent != nil {
				w.percent = usageProbeFloat(usageProbeClamp(*w.percent))
			}
			if w.total != nil || w.used != nil || w.remaining != nil || w.percent != nil {
				values.windows = append(values.windows, w)
			}
		}
		values.booster = usageProbeParseBooster(body, spec.booster)
		return values, values.total != nil || values.used != nil || values.remaining != nil || len(values.windows) > 0 || values.booster != nil
	default:
		for _, key := range []string{"rolling", "weekly", "monthly"} {
			entry := usageProbeObject(usageProbeGet(body, "usage."+key))
			if entry == nil {
				continue
			}
			w := usageProbeWindow{key: key}
			// Periods' percent is a JSON number; unlike balance paths it is
			// not a numeric-string compatibility field in the dev contract.
			if _, ok := entry["percent"].(json.Number); ok {
				w.percent = usageProbeNumber(entry["percent"])
			}
			if _, ok := entry["percent"].(float64); ok {
				w.percent = usageProbeNumber(entry["percent"])
			}
			if w.percent != nil {
				w.percent = usageProbeFloat(usageProbeClamp(*w.percent))
			}
			w.resetsAt, _ = time.Parse(time.RFC3339, usageProbeString(entry["resetsAt"]))
			if w.percent != nil || !w.resetsAt.IsZero() {
				values.windows = append(values.windows, w)
			}
		}
		return values, len(values.windows) > 0
	}
}

func usageProbeParseBooster(body any, spec *usageProbeBoosterSpec) *usageProbeBooster {
	if spec == nil {
		return nil
	}
	balance := usageProbeN(body, spec.balancePath)
	if balance == nil {
		return nil
	}
	fixed := spec.fixedPointPerCent
	if fixed <= 0 {
		fixed = 1_000_000
	}
	convert := func(n *float64, divisor float64) *float64 {
		if n == nil {
			return nil
		}
		return usageProbeNumber(*n / divisor)
	}
	booster := &usageProbeBooster{
		balance: convert(balance, fixed*100), total: convert(usageProbeN(body, spec.totalPath), fixed*100),
		currency:     usageProbeCurrency(usageProbeGet(body, spec.currencyPath)),
		monthlyUsed:  convert(usageProbeN(body, spec.monthlyUsedPath), 100),
		monthlyLimit: convert(usageProbeN(body, spec.monthlyLimitPath), 100),
		unlimited:    usageProbeGet(body, spec.monthlyEnabledPath) == false,
	}
	if booster.unlimited {
		booster.monthlyLimit = nil
	}
	return booster
}

func usageProbeCurrency(value any) string {
	text := usageProbeString(value)
	if len(text) > 16 || strings.IndexFunc(text, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsSymbol(r) && r != ' ' }) >= 0 {
		return ""
	}
	return text
}

func usageProbeWindowLabel(key string) string {
	switch key {
	case "rolling", "fiveHour", "primary":
		return apptext.T("5 小时")
	case "daily":
		return apptext.T("每日")
	case "weekly", "secondary":
		return apptext.T("每周")
	case "monthly":
		return apptext.T("每月")
	case "mcpMonthly":
		return apptext.T("MCP 月额度")
	case "included":
		return apptext.T("套餐内")
	case "onDemand":
		return apptext.T("按需")
	}
	if len(key) > 40 || strings.IndexFunc(key, unicode.IsControl) >= 0 {
		return apptext.T("额度窗口")
	}
	return key
}

func usageProbeFormat(values usageProbeValues) usageProbeResult {
	result := usageProbeResult{At: time.Now()}
	number := func(n float64) string { return strconv.FormatFloat(n, 'f', 2, 64) }
	var summary []string
	if values.balance != nil {
		text := strings.TrimSpace(fmt.Sprintf(apptext.T("余额 %s %s"), number(*values.balance), values.currency))
		result.Details = append(result.Details, text)
		summary = append(summary, text)
	}
	var main []string
	if values.remaining != nil {
		main = append(main, fmt.Sprintf(apptext.T("剩余 %s"), number(*values.remaining)))
	}
	if values.used != nil {
		main = append(main, fmt.Sprintf(apptext.T("已使用 %s"), number(*values.used)))
	}
	if values.total != nil {
		main = append(main, fmt.Sprintf(apptext.T("总额 %s"), number(*values.total)))
	}
	if len(main) > 0 {
		text := strings.Join(main, " · ")
		result.Details = append(result.Details, text)
		if len(values.windows) == 0 {
			summary = append(summary, text)
		}
	}
	for _, w := range values.windows {
		var parts []string
		if w.used != nil && w.total != nil && *w.total > 0 {
			parts = append(parts, fmt.Sprintf(apptext.T("已用 %s / %s"), number(*w.used), number(*w.total)))
		} else if w.percent != nil {
			parts = append(parts, fmt.Sprintf(apptext.T("已用 %s%%"), number(*w.percent)))
		} else if w.used != nil {
			parts = append(parts, fmt.Sprintf(apptext.T("已使用 %s"), number(*w.used)))
		}
		if w.remaining != nil {
			parts = append(parts, fmt.Sprintf(apptext.T("剩余 %s"), number(*w.remaining)))
		}
		text := usageProbeWindowLabel(w.key) + " " + strings.Join(parts, " · ")
		summary = append(summary, strings.TrimSpace(text))
		if !w.resetsAt.IsZero() {
			text += " · " + fmt.Sprintf(apptext.T("重置于 %s"), w.resetsAt.Local().Format("01-02 15:04"))
		}
		result.Details = append(result.Details, text)
	}
	if b := values.booster; b != nil && b.balance != nil {
		text := strings.TrimSpace(fmt.Sprintf(apptext.T("Boost 余额 %s %s"), number(*b.balance), b.currency))
		summary = append(summary, text)
		result.Details = append(result.Details, text)
		if b.total != nil {
			result.Details = append(result.Details, fmt.Sprintf(apptext.T("Boost 总额 %s"), number(*b.total)))
		}
		if b.monthlyUsed != nil {
			result.Details = append(result.Details, fmt.Sprintf(apptext.T("Boost 本月已用 %s"), number(*b.monthlyUsed)))
		}
		if b.monthlyLimit != nil {
			result.Details = append(result.Details, fmt.Sprintf(apptext.T("Boost 月限额 %s"), number(*b.monthlyLimit)))
		} else if b.unlimited {
			result.Details = append(result.Details, apptext.T("Boost 月限额不限"))
		}
	}
	result.Summary = strings.Join(summary, " · ")
	return result
}
