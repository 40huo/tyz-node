// Package cp talks to the control-plane worker over HTTP: versioned config
// fetch (304 when unchanged) and batched stats upload.
package cp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/laoshan-tech/tyz-node/apps/agent/internal/model"
)

const httpTimeout = 30 * time.Second

// maxConfigBytes caps the config response so a misbehaving control plane
// cannot balloon the agent's memory.
const maxConfigBytes = 8 << 20

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		baseURL: baseURL,
		token:   token,
		http:    &http.Client{Timeout: httpTimeout},
	}
}

// FetchConfig returns the config for the node. changed=false means the server
// answered 304 (version unchanged).
func (c *Client) FetchConfig(ctx context.Context, version int64) (resp *model.AgentConfigResponse, changed bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/api/agent/config?version=%d", c.baseURL, version), nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	httpResp, err := c.http.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer httpResp.Body.Close()
	httpResp.Body = http.MaxBytesReader(nil, httpResp.Body, maxConfigBytes)

	switch {
	case httpResp.StatusCode == http.StatusNotModified:
		return nil, false, nil
	case httpResp.StatusCode == http.StatusOK:
		var data model.AgentConfigResponse
		if err := json.NewDecoder(httpResp.Body).Decode(&data); err != nil {
			return nil, false, fmt.Errorf("config poll failed: decode body: %w", err)
		}
		return &data, true, nil
	default:
		return nil, false, fmt.Errorf("config poll failed: %d %s", httpResp.StatusCode, httpResp.Status)
	}
}

// UploadStats posts one batch of stats samples plus the current service
// health snapshot. Either may be empty.
func (c *Client) UploadStats(ctx context.Context, samples []model.GostStatsSample, health []model.ServiceHealthSample) error {
	// A nil slice marshals as JSON null, which older servers reject — an
	// idle node (services running, no stats buffered yet) would otherwise
	// fail every flush. Emit [] instead.
	if samples == nil {
		samples = []model.GostStatsSample{}
	}
	if health == nil {
		health = []model.ServiceHealthSample{}
	}
	body, err := json.Marshal(struct {
		Samples []model.GostStatsSample     `json:"samples"`
		Health  []model.ServiceHealthSample `json:"health,omitempty"`
	}{samples, health})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/api/agent/stats", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	httpResp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer httpResp.Body.Close()
	// Keep a truncated response body so server-side validation errors (400)
	// are self-explanatory in the agent log instead of a bare status code.
	respBody, _ := io.ReadAll(io.LimitReader(httpResp.Body, 512))

	if httpResp.StatusCode != http.StatusOK {
		return fmt.Errorf("stats upload failed: %d %s: %s", httpResp.StatusCode, httpResp.Status, respBody)
	}
	return nil
}
