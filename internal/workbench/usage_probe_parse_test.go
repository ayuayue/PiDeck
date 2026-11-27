//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"math"
	"testing"
)

func usageProbeTestNumber(t *testing.T, got *float64, want float64) {
	t.Helper()
	if got == nil || math.Abs(*got-want) > 1e-8 {
		t.Fatalf("number=%v want %g", got, want)
	}
}

func TestUsageProbePathAndNumberParsing(t *testing.T) {
	body := usageProbeTestJSON(t, `{"a":[{"balance":" 12.5 "}],"zero":0}`)
	usageProbeTestNumber(t, usageProbeN(body, "a[0].balance"), 12.5)
	usageProbeTestNumber(t, usageProbeN(body, "zero"), 0)
	for _, path := range []string{"a[-1].balance", "a[9].balance", "a.x", "a[0].missing", "a[0].balance.x"} {
		if got := usageProbeGet(body, path); got != nil {
			t.Errorf("path %s=%v want nil", path, got)
		}
	}
	for _, invalid := range []any{nil, true, "", "NaN", "+Inf", "1e999", math.Inf(1), json.Number("1e999")} {
		if got := usageProbeNumber(invalid); got != nil {
			t.Errorf("unsafe number %v accepted", invalid)
		}
	}
}

func TestUsageProbeCreditsWindowsAndBooster(t *testing.T) {
	body := usageProbeTestJSON(t, `{"main":{"total":10000,"used":"2500"},"windows":[{"type":"TOKENS_LIMIT","unit":3,"cap":100,"used":30,"percentage":130},{"type":"TOKENS_LIMIT","unit":6,"cap":100,"used":20}],"boost":{"balance":250000000,"total":500000000,"used":120,"limit":1000,"enabled":false,"currency":"CNY"}}`)
	spec := usageProbeParse{kind: "credits", totalPath: "main.total", usedPath: "main.used", scale: 100,
		windows: []usageProbeWindowSpec{{key: "fiveHour", listPath: "windows", totalPath: "cap", usedPath: "used", percentPath: "percentage", where: []usageProbeCondition{{"type", []any{"CREDIT_LIMIT", "TOKENS_LIMIT"}}, {"unit", json.Number("3")}}}},
		booster: &usageProbeBoosterSpec{balancePath: "boost.balance", totalPath: "boost.total", monthlyUsedPath: "boost.used", monthlyLimitPath: "boost.limit", monthlyEnabledPath: "boost.enabled", currencyPath: "boost.currency", fixedPointPerCent: 1_000_000},
	}
	values, matched := usageProbeParseBody(body, spec)
	if !matched || len(values.windows) != 1 || values.booster == nil {
		t.Fatalf("parse=%+v matched=%v", values, matched)
	}
	usageProbeTestNumber(t, values.remaining, 75)
	usageProbeTestNumber(t, values.windows[0].remaining, 70)
	usageProbeTestNumber(t, values.windows[0].percent, 100)
	usageProbeTestNumber(t, values.booster.balance, 2.5)
	usageProbeTestNumber(t, values.booster.monthlyUsed, 1.2)
	if values.booster.monthlyLimit != nil || !values.booster.unlimited {
		t.Fatal("explicit unlimited booster limit was displayed")
	}
	if _, matched := usageProbeParseBody(usageProbeTestJSON(t, `{}`), spec); matched {
		t.Fatal("empty credits shape matched")
	}
}

func TestUsageProbeCustomParsers(t *testing.T) {
	for _, test := range []struct {
		name, resolver, raw string
		windows             int
		check               func(*testing.T, usageProbeValues)
	}{
		{"xai-cents", "xai-billing", `{"config":{"monthlyLimit":{"val":1000},"used":{"val":"250"},"onDemandUsed":{"val":50}}}`, 2, func(t *testing.T, v usageProbeValues) {
			usageProbeTestNumber(t, v.windows[0].total, 10)
			usageProbeTestNumber(t, v.windows[1].used, 0.5)
		}},
		{"codex", "codex-usage", `{"rate_limit":{"primary_window":{"used_percent":150}},"credits":{"has_credits":true,"unlimited":true,"balance":500}}`, 1, func(t *testing.T, v usageProbeValues) {
			usageProbeTestNumber(t, v.windows[0].used, 100)
			if v.remaining != nil {
				t.Fatal("unlimited credit balance displayed")
			}
		}},
		{"commandcode-trusted", "commandcode-credits", `{"credits":{"monthly_credits":63,"window_limits":{"five_hour":{"limit":14,"used":3},"weekly":{"cap":35,"used":4}}}}`, 3, func(t *testing.T, v usageProbeValues) {
			usageProbeTestNumber(t, v.windows[2].total, 70)
			usageProbeTestNumber(t, v.windows[2].used, 7)
		}},
		{"commandcode-untrusted", "commandcode-credits", `{"monthlyCredits":75,"windowLimits":{"fiveHour":{"cap":14},"weekly":{"cap":35}}}`, 1, func(t *testing.T, v usageProbeValues) {
			if v.windows[0].total != nil {
				t.Fatal("invented monthly cap for changed plan")
			}
		}},
		{"kimi", "kimi-credits", `{"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","used":3}}],"usage":{"limit":500,"used":40},"totalQuota":{"limit":100,"remaining":99},"boosterWallet":{"balance":{"amountLeft":100000000}}}`, 3, func(t *testing.T, v usageProbeValues) {
			usageProbeTestNumber(t, v.remaining, 460)
			usageProbeTestNumber(t, v.windows[2].used, 1)
			usageProbeTestNumber(t, v.booster.balance, 1)
		}},
		{"kimi-frozen", "kimi-credits", `{"totalQuota":{"limit":100,"used":1,"remaining":99}}`, 1, func(t *testing.T, v usageProbeValues) {
			usageProbeTestNumber(t, v.windows[0].used, 100)
			usageProbeTestNumber(t, v.windows[0].remaining, 0)
		}},
		{"sub2api-wallet", "sub2api-usage", `{"balance":"4.5","remaining":4.5,"unit":"USD"}`, 0, func(t *testing.T, v usageProbeValues) { usageProbeTestNumber(t, v.balance, 4.5) }},
		{"sub2api-quota", "sub2api-usage", `{"quota":{"limit":50,"used":7,"remaining":43},"rate_limits":[{"window":"5h","limit":10,"used":2}]}`, 1, func(t *testing.T, v usageProbeValues) {
			usageProbeTestNumber(t, v.remaining, 43)
			usageProbeTestNumber(t, v.used, 7)
		}},
		{"sub2api-unlimited", "sub2api-usage", `{"remaining":-1,"subscription":{"daily_limit_usd":null,"weekly_limit_usd":0},"usage":{"total":{"actual_cost":5}}}`, 0, func(t *testing.T, v usageProbeValues) {
			usageProbeTestNumber(t, v.used, 5)
			if v.remaining != nil {
				t.Fatal("negative unlimited sentinel displayed")
			}
		}},
		{"sub2api-old-subscription", "sub2api-usage", `{"subscription":{"total_quota":20,"used_quota":3}}`, 1, func(t *testing.T, v usageProbeValues) { usageProbeTestNumber(t, v.windows[0].total, 20) }},
		{"volcengine-afp", "volcengine-plan", `{"Result":{"AFPFiveHour":{"Quota":100,"Used":25,"ResetTime":1778806800000},"AFPWeekly":{"Quota":0,"Used":0},"AFPDaily":{"Quota":20,"Used":10}}}`, 1, func(t *testing.T, v usageProbeValues) {
			usageProbeTestNumber(t, v.windows[0].percent, 25)
			if v.windows[0].resetsAt.UnixMilli() != 1778806800000 {
				t.Fatal("AFP milliseconds not parsed")
			}
		}},
		{"volcengine-coding", "volcengine-plan", `{"Result":{"QuotaUsage":[{"Level":"session","Percent":120,"ResetTimestamp":-1},{"Window":"weekly","UsagePercent":20,"ResetTime":1782057600}]}}`, 2, func(t *testing.T, v usageProbeValues) {
			usageProbeTestNumber(t, v.windows[0].percent, 100)
			if !v.windows[0].resetsAt.IsZero() || v.windows[1].resetsAt.Unix() != 1782057600 {
				t.Fatal("coding reset timestamps incorrect")
			}
		}},
		{"minimax-percent-priority", "minimax-plan", `{"base_resp":{"status_code":0},"model_remains":[{"model_name":"video","current_interval_remaining_percent":100},{"model_name":"general","current_interval_remaining_percent":25,"current_interval_total_count":0,"current_interval_usage_count":0,"current_weekly_total_count":3,"current_weekly_usage_count":1}]}`, 2, func(t *testing.T, v usageProbeValues) {
			usageProbeTestNumber(t, v.windows[0].percent, 75)
			usageProbeTestNumber(t, v.windows[1].percent, 66.7)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			v, matched := usageProbeParseBody(usageProbeTestJSON(t, test.raw), usageProbeParse{kind: "custom", resolver: test.resolver})
			if !matched || len(v.windows) != test.windows {
				t.Fatalf("values=%+v matched=%v want windows=%d", v, matched, test.windows)
			}
			test.check(t, v)
			if result := usageProbeFormat(v); result.Summary == "" || len(result.Details) == 0 {
				t.Fatalf("matched result has no usable display: %+v", result)
			}
		})
	}
}

func TestUsageProbeCustomParsersRejectFailureShapes(t *testing.T) {
	for _, test := range []struct{ resolver, raw string }{
		{"unknown", `{"balance":123}`}, {"xai-billing", `{"config":{}}`}, {"codex-usage", `{}`},
		{"commandcode-credits", `{"credits":{}}`}, {"kimi-credits", `{"boosterWallet":{"balance":{"amountLeft":10}}}`},
		{"sub2api-usage", `{"remaining":-1,"subscription":{"monthly_limit_usd":0}}`},
		{"volcengine-plan", `{"Result":{"AFPFiveHour":{"Quota":0,"Used":0}}}`},
		{"minimax-plan", `{"base_resp":{"status_code":2049},"model_remains":[{"model_name":"general","current_interval_remaining_percent":10}]}`},
		{"minimax-plan", `{"model_remains":[{"model_name":"video","current_interval_remaining_percent":10}]}`},
	} {
		if _, matched := usageProbeParseBody(usageProbeTestJSON(t, test.raw), usageProbeParse{kind: "custom", resolver: test.resolver}); matched {
			t.Errorf("%s failure shape matched", test.resolver)
		}
	}
}
