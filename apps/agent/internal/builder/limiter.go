package builder

import (
	"encoding/json"
	"math"
	"strconv"

	"github.com/go-gost/x/config"
)

// limiterSet is the GOST limiter object lists parsed from one rule's limit.
type limiterSet struct {
	limiters  []*config.LimiterConfig
	rlimiters []*config.LimiterConfig
	climiters []*config.LimiterConfig
}

// Wire representation of the rule's limit JSON (see @tyz/shared LimiterConfig).
type limiterData struct {
	Traffic *struct {
		ServiceIn  *float64 `json:"service_in"`
		ServiceOut *float64 `json:"service_out"`
		ConnIn     *float64 `json:"conn_in"`
		ConnOut    *float64 `json:"conn_out"`
		IPs        []struct {
			IP  string   `json:"ip"`
			In  *float64 `json:"in"`
			Out *float64 `json:"out"`
		} `json:"ips"`
	} `json:"traffic"`
	Request *struct {
		ServiceRate *float64 `json:"service_rate"`
		IPs         []struct {
			IP   string   `json:"ip"`
			Rate *float64 `json:"rate"`
		} `json:"ips"`
	} `json:"request"`
	Connection *struct {
		ServiceLimit *float64 `json:"service_limit"`
		IPs          []struct {
			IP    string   `json:"ip"`
			Limit *float64 `json:"limit"`
		} `json:"ips"`
	} `json:"connection"`
}

// parseLimiters parses a rule's limit field. The stored value may be an object
// or a legacy JSON string; anything null, empty ("{}"), or malformed yields an
// empty set — matching the previous agent's tolerant behavior.
func parseLimiters(raw json.RawMessage, ruleID int) limiterSet {
	if len(raw) == 0 || string(raw) == "null" {
		return limiterSet{}
	}
	data := raw
	if raw[0] == '"' {
		// Legacy string form: unwrap and parse the inner JSON.
		var inner string
		if err := json.Unmarshal(raw, &inner); err != nil {
			return limiterSet{}
		}
		if inner == "{}" {
			return limiterSet{}
		}
		data = json.RawMessage(inner)
	}

	var parsed limiterData
	if err := json.Unmarshal(data, &parsed); err != nil {
		return limiterSet{}
	}

	var set limiterSet
	if t := parsed.Traffic; t != nil {
		if t.ServiceIn != nil || t.ServiceOut != nil {
			set.limiters = append(set.limiters, &config.LimiterConfig{
				Name:   "limiter-service-" + strconv.Itoa(ruleID),
				Limits: []string{"$ " + num(t.ServiceIn) + " " + num(t.ServiceOut)},
			})
		}
		if t.ConnIn != nil || t.ConnOut != nil {
			set.limiters = append(set.limiters, &config.LimiterConfig{
				Name:   "limiter-conn-" + strconv.Itoa(ruleID),
				Limits: []string{"$$ " + num(t.ConnIn) + " " + num(t.ConnOut)},
			})
		}
		for idx, ip := range t.IPs {
			if ip.IP == "" {
				continue
			}
			set.limiters = append(set.limiters, &config.LimiterConfig{
				Name:   "limiter-ip-" + strconv.Itoa(ruleID) + "-" + strconv.Itoa(idx),
				Limits: []string{ip.IP + " " + num(ip.In) + " " + num(ip.Out)},
			})
		}
	}
	if r := parsed.Request; r != nil {
		if r.ServiceRate != nil {
			set.rlimiters = append(set.rlimiters, &config.LimiterConfig{
				Name:   "rlimiter-service-" + strconv.Itoa(ruleID),
				Limits: []string{"$ " + num(r.ServiceRate)},
			})
		}
		for idx, ip := range r.IPs {
			if ip.IP == "" {
				continue
			}
			set.rlimiters = append(set.rlimiters, &config.LimiterConfig{
				Name:   "rlimiter-ip-" + strconv.Itoa(ruleID) + "-" + strconv.Itoa(idx),
				Limits: []string{ip.IP + " " + num(ip.Rate)},
			})
		}
	}
	if c := parsed.Connection; c != nil {
		if c.ServiceLimit != nil {
			set.climiters = append(set.climiters, &config.LimiterConfig{
				Name:   "climiter-service-" + strconv.Itoa(ruleID),
				Limits: []string{"$ " + num(c.ServiceLimit)},
			})
		}
		for idx, ip := range c.IPs {
			if ip.IP == "" {
				continue
			}
			set.climiters = append(set.climiters, &config.LimiterConfig{
				Name:   "climiter-ip-" + strconv.Itoa(ruleID) + "-" + strconv.Itoa(idx),
				Limits: []string{ip.IP + " " + num(ip.Limit)},
			})
		}
	}
	return set
}

// num renders an optional limit value; absent means 0. Integers print without
// a decimal point, matching the previous agent's string conversion.
func num(v *float64) string {
	if v == nil {
		return "0"
	}
	if *v == math.Trunc(*v) {
		return strconv.FormatInt(int64(*v), 10)
	}
	return strconv.FormatFloat(*v, 'f', -1, 64)
}
