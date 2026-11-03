package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
)

// ITEM_SOURCE=fixture: API responses from FIXTURE_PATH, converted once, so the benchmark measures
// the web server alone. Otherwise every call fetches the item from the item API.
type itemSource struct {
	fixture map[string]*itemView
	client  *http.Client
	base    string
}

func newItemSource() (*itemSource, error) {
	s := &itemSource{base: envOr("API_BASE", "http://localhost:8080")}
	if os.Getenv("ITEM_SOURCE") == "fixture" {
		file, err := os.Open(envOr("FIXTURE_PATH", "fixtures/items.json"))
		if err != nil {
			return nil, err
		}
		defer file.Close()
		var items map[string]*apiItem
		if err := json.NewDecoder(file).Decode(&items); err != nil {
			return nil, err
		}
		s.fixture = make(map[string]*itemView, len(items))
		for id, item := range items {
			s.fixture[id] = fromAPI(item)
		}
		return s, nil
	}
	// The default transport keeps two idle connections per host; every request here goes to one
	// host, so it may keep as many as the transport keeps in all.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = transport.MaxIdleConns
	s.client = &http.Client{Transport: transport}
	return s, nil
}

// The items the home page lists: the first 50 by id with items in memory, none from the item API.
func (s *itemSource) shelf() []*itemView {
	var out []*itemView
	for n := 1; n <= 50 && s.fixture != nil; n++ {
		if item, ok := s.fixture["item_"+strconv.Itoa(n)]; ok {
			out = append(out, item)
		}
	}
	return out
}

// The item, or nil when there is none.
func (s *itemSource) get(ctx context.Context, id string) (*itemView, error) {
	if s.fixture != nil {
		return s.fixture[id], nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.base+"/api/discovery/items/"+url.PathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	res, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("item API: %s", res.Status)
	}
	var item apiItem
	if err := json.NewDecoder(res.Body).Decode(&item); err != nil {
		return nil, err
	}
	return fromAPI(&item), nil
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
