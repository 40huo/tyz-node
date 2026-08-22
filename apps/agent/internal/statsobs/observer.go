// Package statsobs implements the in-process GOST observer: stats events
// from the embedded runtime are flattened into samples and queued for the
// control-plane uploader, replacing the old HTTP-plugin observer hop.
package statsobs

import (
	"context"

	"github.com/go-gost/core/observer"
	"github.com/go-gost/x/observer/stats"
	"github.com/laoshan-tech/tyz/apps/agent/internal/model"
)

// Queue receives one flattened sample per stats event.
type Queue interface {
	Enqueue(sample model.GostStatsSample)
}

type Observer struct {
	queue Queue
}

var _ observer.Observer = (*Observer)(nil)

func New(queue Queue) *Observer {
	return &Observer{queue: queue}
}

// Observe forwards stats events; status events are ignored.
func (o *Observer) Observe(_ context.Context, events []observer.Event, _ ...observer.Option) error {
	for _, event := range events {
		statsEvent, ok := event.(stats.StatsEvent)
		if !ok {
			continue
		}
		o.queue.Enqueue(model.GostStatsSample{
			Service:      statsEvent.Service,
			Client:       statsEvent.Client,
			TotalConns:   statsEvent.TotalConns,
			CurrentConns: statsEvent.CurrentConns,
			InputBytes:   statsEvent.InputBytes,
			OutputBytes:  statsEvent.OutputBytes,
			TotalErrs:    statsEvent.TotalErrs,
		})
	}
	return nil
}
