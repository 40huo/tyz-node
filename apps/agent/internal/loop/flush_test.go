package loop

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/laoshan-tech/tyz/apps/agent/internal/cp"
	"github.com/laoshan-tech/tyz/apps/agent/internal/model"
)

type statsBatchBody struct {
	Samples []model.GostStatsSample     `json:"samples"`
	Health  []model.ServiceHealthSample `json:"health"`
}

// statsRecorder captures every POST /api/agent/stats and can be told to fail
// selected request ordinals (1-based) with a 500.
type statsRecorder struct {
	mu      sync.Mutex
	batches []statsBatchBody
	failAt  map[int]bool
	fail    atomic.Bool
}

func (r *statsRecorder) handler(w http.ResponseWriter, req *http.Request) {
	var body statsBatchBody
	_ = json.NewDecoder(req.Body).Decode(&body)
	r.mu.Lock()
	r.batches = append(r.batches, body)
	ordinal := len(r.batches)
	failing := r.failAt[ordinal]
	r.mu.Unlock()
	if failing {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (r *statsRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.batches)
}

func newFlushLoop(t *testing.T, rec *statsRecorder) *Loop {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(rec.handler))
	t.Cleanup(server.Close)
	return New(cp.NewClient(server.URL, "test-token"), Options{}, slog.New(slog.DiscardHandler))
}

func makeSamples(n int) []model.GostStatsSample {
	out := make([]model.GostStatsSample, n)
	for i := range out {
		out[i] = model.GostStatsSample{Service: "service-1", TotalConns: uint64(i), InputBytes: 100, OutputBytes: 200}
	}
	return out
}

func staticHealth() []model.ServiceHealthSample {
	return []model.ServiceHealthSample{{Service: "service-1", State: "ready"}}
}

func TestFlushStatsChunksLargeBatches(t *testing.T) {
	rec := &statsRecorder{}
	l := newFlushLoop(t, rec)
	l.stats = makeSamples(45)
	l.opts.Health = staticHealth
	if err := l.flushStats(context.Background()); err != nil {
		t.Fatalf("flushStats: %v", err)
	}
	// 45 samples at 20 per request = 3 requests, health rides the first only.
	if got := rec.count(); got != 3 {
		t.Fatalf("requests = %d, want 3", got)
	}
	for i, b := range rec.batches {
		want := 20
		if i == 2 {
			want = 5
		}
		if len(b.Samples) != want {
			t.Fatalf("request %d samples = %d, want %d", i+1, len(b.Samples), want)
		}
		if h := len(b.Health); (i == 0 && h != 1) || (i > 0 && h != 0) {
			t.Fatalf("request %d health = %d, want 1 on first only", i+1, h)
		}
	}
	if len(l.stats) != 0 {
		t.Fatalf("buffer after flush = %d, want 0", len(l.stats))
	}
}

func TestFlushStatsKeepsUnsentOnPartialFailure(t *testing.T) {
	rec := &statsRecorder{failAt: map[int]bool{2: true}} // first chunk ok, second fails
	l := newFlushLoop(t, rec)
	l.stats = makeSamples(45)
	l.opts.Health = staticHealth
	if err := l.flushStats(context.Background()); err == nil {
		t.Fatal("flushStats should surface the upload error")
	}
	// The 20 sent samples are trimmed; the remaining 25 stay buffered for retry.
	if got := len(l.stats); got != 25 {
		t.Fatalf("buffer after partial failure = %d, want 25", got)
	}
	if rec.count() != 2 {
		t.Fatalf("requests = %d, want 2", rec.count())
	}
	// A later successful flush uploads the rest in two chunks.
	if err := l.flushStats(context.Background()); err != nil {
		t.Fatalf("retry flushStats: %v", err)
	}
	if got := len(l.stats); got != 0 {
		t.Fatalf("buffer after retry = %d, want 0", got)
	}
	if rec.count() != 4 {
		t.Fatalf("requests total = %d, want 4", rec.count())
	}
}

func TestFlushStatsHealthOnlyBatch(t *testing.T) {
	rec := &statsRecorder{}
	l := newFlushLoop(t, rec)
	// Idle node: no samples, but the health snapshot still ships every flush.
	l.opts.Health = staticHealth
	if err := l.flushStats(context.Background()); err != nil {
		t.Fatalf("flushStats: %v", err)
	}
	if rec.count() != 1 || len(rec.batches[0].Health) != 1 || len(rec.batches[0].Samples) != 0 {
		t.Fatalf("health-only flush malformed: %+v", rec.batches)
	}
}

func TestEnqueueMergesSameServiceClient(t *testing.T) {
	l := newFlushLoop(t, &statsRecorder{})
	// Service-level + one per-client key stay distinct entries.
	l.Enqueue(model.GostStatsSample{Service: "service-1", CurrentConns: 2, InputBytes: 100})
	l.Enqueue(model.GostStatsSample{Service: "service-1", CurrentConns: 5, InputBytes: 300})
	l.Enqueue(model.GostStatsSample{Service: "service-1", Client: "1.2.3.4:5", CurrentConns: 1, InputBytes: 50})
	if len(l.stats) != 2 {
		t.Fatalf("buffer = %d entries, want 2 (merged per service/client key)", len(l.stats))
	}
	merged := l.stats[0]
	if merged.InputBytes != 300 || merged.CurrentConns != 5 {
		t.Fatalf("latest cumulative not kept: %+v", merged)
	}
	// A later dip in CurrentConns must not lose the intra-window peak.
	l.Enqueue(model.GostStatsSample{Service: "service-1", CurrentConns: 3, InputBytes: 400})
	if l.stats[0].CurrentConns != 5 || l.stats[0].InputBytes != 400 {
		t.Fatalf("peak/current mix-up: %+v", l.stats[0])
	}
	if len(l.stats) != 2 {
		t.Fatalf("buffer grew on merge: %d", len(l.stats))
	}
}

func TestEnqueueCounterResetAdoptsNewInstance(t *testing.T) {
	l := newFlushLoop(t, &statsRecorder{})
	// Service restart: cumulative counters drop — the merged entry must follow
	// the NEW instance (the server treats the drop as a reset and bills the
	// fresh value), not keep the stale larger totals.
	l.Enqueue(model.GostStatsSample{Service: "service-1", TotalConns: 900, InputBytes: 1000})
	l.Enqueue(model.GostStatsSample{Service: "service-1", TotalConns: 1, InputBytes: 10})
	if l.stats[0].TotalConns != 1 || l.stats[0].InputBytes != 10 {
		t.Fatalf("reset not adopted: %+v", l.stats[0])
	}
}
