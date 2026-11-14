package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const traceFirst = "00-11111111111111111111111111111111-1111111111111111-00"
const traceSecond = "00-22222222222222222222222222222222-2222222222222222-01"

type traceObservation struct{ Path, Parent, State string }

func TestMarketplaceTraceHTTP(t *testing.T) {
	for _, profile := range []string{"default", "matched"} {
		for _, mode := range []string{"api", "fixture"} {
			t.Run(profile+"/"+mode, func(t *testing.T) {
				observed := make(chan traceObservation, 100)
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					observed <- traceObservation{r.URL.Path, r.Header.Get("traceparent"), r.Header.Get("tracestate")}
					_ = json.NewEncoder(w).Encode(sampleMarketplace())
				}))
				defer upstream.Close()
				app := httptest.NewServer(traceAppRouter(t, profile, mode, upstream.URL))
				defer app.Close()
				client := &http.Client{Timeout: 5 * time.Second}
				defer client.CloseIdleConnections()
				for _, route := range []struct{ method, path string }{
					{"GET", "/api/marketplace/item_1"}, {"HEAD", "/api/marketplace/item_1"},
					{"GET", "/marketplace/en-US/item_1"}, {"POST", "/marketplace/en-US/item_1"},
					{"GET", "/marketplace/fr-FR/item_1"}, {"POST", "/marketplace/fr-FR/item_1"},
					{"GET", "/marketplace/de-DE/item_1"}, {"POST", "/marketplace/de-DE/item_1"},
				} {
					var baseline []byte
					for index, trace := range []struct{ input, parent string }{
						{"", ""}, {traceFirst, traceFirst}, {traceSecond, traceSecond},
						{"01" + traceFirst[2:53] + "80-future", traceFirst},
						{"01" + traceFirst[2:53] + "81-future", traceFirst[:53] + "01"},
						{"bad", ""}, {traceFirst + ", " + traceSecond, ""}, {"", ""},
					} {
						form := "email=trace%40example.test&target_price=12,50"
						if strings.Contains(route.path, "en-US") {
							form = strings.ReplaceAll(form, ",", ".")
						}
						req, _ := http.NewRequest(route.method, app.URL+route.path, strings.NewReader(form))
						req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
						if trace.input != "" {
							req.Header.Set("traceparent", trace.input)
							req.Header.Set("tracestate", "vendor=\xe9")
						}
						res, err := client.Do(req)
						if err != nil {
							t.Fatal(err)
						}
						body, err := io.ReadAll(res.Body)
						res.Body.Close()
						if err != nil || res.StatusCode != 200 {
							t.Fatalf("%s %s: %s %s %v", route.method, route.path, res.Status, body, err)
						}
						if index == 0 {
							baseline = body
						} else if !bytes.Equal(body, baseline) {
							t.Fatalf("%s %s: trace changed native body bytes", route.method, route.path)
						}
						if mode == "api" {
							got := <-observed
							want := traceObservation{Path: "/marketplace/records/item_1"}
							if trace.parent != "" {
								want.Parent = trace.parent
								want.State = "vendor=\xe9"
							}
							if got != want {
								t.Errorf("%s %s: source got=%q want=%q", route.method, route.path, got, want)
							}
							t.Logf("%s %s source: %q", route.method, route.path, got)
						}
					}
				}
				select {
				case got := <-observed:
					t.Fatalf("extra/fixture source fetch: %q", got)
				default:
				}
			})
		}
	}
}
