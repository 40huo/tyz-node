package builder

import (
	"strconv"

	"github.com/go-gost/x/config"
	"github.com/laoshan-tech/tyz/apps/agent/internal/model"
)

// quotaStoreFile persists quota counters (one JSON map for all quotas) in the
// working directory — mount it alongside last-config.json so counters survive
// restarts (flushed every 10s; a lost tail is bounded by one flush interval).
const quotaStoreFile = "quota-store.json"

// quotaFor renders a rule's traffic allowance as a GOST quota object. Rules
// of one owner share the quota NAME (e.g. quota-user-1), so services
// referencing the same object count against one shared counter. The
// listener-side wrapper resolves the quota from the registry on every Accept,
// so updating the object (Unregister+Register) hot-swaps the allowance
// without touching the service or its connections.
//
// Counter-reset semantics: gost restores a persisted counter only when the
// window matches exactly, so a changed StartsAt/ExpiresAt (换购/续费) starts
// from zero while a same-window limit refresh (remaining correction) keeps the
// accumulated count.
func (b *cfgBuilder) quotaFor(rule *model.RelayRule) *config.QuotaConfig {
	q := rule.Quota
	if q == nil || q.Name == "" || q.LimitBytes == 0 {
		return nil
	}
	return &config.QuotaConfig{
		Name: q.Name,
		// units.ParseBase2Bytes rejects unit-less integers — the B suffix is
		// required for the byte count to parse.
		Limit:     strconv.FormatUint(q.LimitBytes, 10) + "B",
		StartsAt:  q.StartsAt,
		ExpiresAt: q.ExpiresAt,
		Direction: "total", // count in+out
		Flush:     "10s",
		Store:     &config.QuotaStoreConfig{Type: "file", File: quotaStoreFile},
	}
}
