package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type traceHTTPResult struct {
	status int
	body   []byte
	err    error
}

func traceSend(client *http.Client, method, url, parent string, body io.Reader) traceHTTPResult {
	r, err := http.NewRequest(method, url, body)
	if err != nil {
		return traceHTTPResult{err: err}
	}
	if parent != "" {
		r.Header.Set("traceparent", parent)
		r.Header.Set("tracestate", "vendor=\xe9")
	}
	if method == "POST" {
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	res, err := client.Do(r)
	if err != nil {
		return traceHTTPResult{err: err}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	return traceHTTPResult{res.StatusCode, data, err}
}

func traceOK(t *testing.T, result traceHTTPResult) {
	t.Helper()
	if result.err != nil || result.status != 200 {
		t.Fatalf("status=%d body=%s error=%v", result.status, result.body, result.err)
	}
}

func traceAppRouter(t *testing.T, profile, mode, base string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv("MARKETPLACE_SOURCE", mode)
	t.Setenv("API_BASE", base)
	if mode == "fixture" {
		file := filepath.Join(t.TempDir(), "marketplace.json")
		data, err := json.Marshal(map[string]*marketplaceRecord{"item_1": sampleMarketplace()})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("MARKETPLACE_FIXTURE_PATH", file)
	}
	t.Setenv("PROFILE", profile)
	t.Setenv("HOSTS", "127.0.0.1")
	r := gin.New()
	if err := configureProduction(r); err != nil {
		t.Fatal(err)
	}
	source, err := newMarketplaceSource()
	if err != nil {
		t.Fatal(err)
	}
	if source.client != nil {
		t.Cleanup(source.client.CloseIdleConnections)
	}
	source.routes(r)
	return r
}

func TestMarketplaceTraceConcurrentHTTP(t *testing.T) {
	for _, profile := range []string{"default", "matched"} {
		for _, phase := range []string{"headers", "body"} {
			for _, route := range []struct{ method, path string }{
				{"GET", "/api/marketplace/item_1"}, {"HEAD", "/api/marketplace/item_1"},
				{"GET", "/marketplace/en-US/item_1"}, {"POST", "/marketplace/en-US/item_1"},
				{"GET", "/marketplace/fr-FR/item_1"}, {"POST", "/marketplace/fr-FR/item_1"},
				{"GET", "/marketplace/de-DE/item_1"}, {"POST", "/marketplace/de-DE/item_1"},
			} {
				t.Run(profile+"/"+phase+"/"+route.method+route.path, func(t *testing.T) {
					entered, release := make(chan struct{}), make(chan struct{})
					var once sync.Once
					releaseOld := func() { once.Do(func() { close(release) }) }
					observed := make(chan traceObservation, 10)
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						observed <- traceObservation{r.URL.Path, r.Header.Get("traceparent"), r.Header.Get("tracestate")}
						data, _ := json.Marshal(sampleMarketplace())
						if r.Header.Get("traceparent") == traceFirst {
							if phase == "body" {
								_, _ = w.Write(data[:len(data)/2])
								w.(http.Flusher).Flush()
							}
							close(entered)
							select {
							case <-release:
							case <-r.Context().Done():
								return
							}
							if phase == "body" {
								_, _ = w.Write(data[len(data)/2:])
								return
							}
						}
						_, _ = w.Write(data)
					}))
					defer upstream.Close()
					defer releaseOld()
					router := traceAppRouter(t, profile, "api", upstream.URL)
					app := httptest.NewServer(router)
					defer app.Close()
					jar, _ := cookiejar.New(nil)
					client := &http.Client{Timeout: 5 * time.Second, Jar: jar}
					defer client.CloseIdleConnections()
					form := "email=trace%40example.test&target_price=12,50"
					if strings.Contains(route.path, "en-US") {
						form = strings.ReplaceAll(form, ",", ".")
					}
					// Establish the native alert session before concurrent writes.
					if route.method == "POST" {
						traceOK(t, traceSend(client, route.method, app.URL+route.path, "", strings.NewReader(form)))
						<-observed
					}
					old := make(chan traceHTTPResult, 1)
					go func() {
						old <- traceSend(client, route.method, app.URL+route.path, traceFirst, strings.NewReader(form))
					}()
					awaitNative(t, entered, "old traced source read")
					traceOK(t, traceSend(client, route.method, app.URL+route.path, traceSecond, strings.NewReader(form)))
					traceOK(t, traceSend(client, route.method, app.URL+route.path, "", strings.NewReader(form)))
					select {
					case result := <-old:
						t.Fatalf("held response completed before release: %+v", result)
					default:
					}
					releaseOld()
					traceOK(t, <-old)
					traceOK(t, traceSend(client, route.method, app.URL+route.path, "", strings.NewReader(form)))
					for _, parent := range []string{traceFirst, traceSecond, "", ""} {
						want := traceObservation{Path: "/marketplace/records/item_1", Parent: parent}
						if parent != "" {
							want.State = "vendor=\xe9"
						}
						got := <-observed
						if got != want {
							t.Fatalf("got=%q want=%q", got, want)
						}
						t.Logf("native source %s: %q", phase, got)
					}
					if route.method == "POST" {
						result := traceSend(client, "GET", app.URL+"/api/alerts", traceSecond, nil)
						traceOK(t, result)
						var rows []storedAlert
						if err := json.Unmarshal(result.body, &rows); err != nil || len(rows) != 5 {
							t.Fatal("readback", string(result.body), err)
						}
						for _, row := range rows {
							if row.ItemID != "item_1" || row.Email != "trace@example.test" || row.TargetMinor != 1250 {
								t.Fatal(row)
							}
						}
					}
					select {
					case got := <-observed:
						t.Fatalf("readback/extra fetch %q", got)
					default:
					}
				})
			}
		}
	}
}

type traceReadingBody struct {
	io.ReadCloser
	once    sync.Once
	entered chan struct{}
}

func (b *traceReadingBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.entered) })
	return b.ReadCloser.Read(p)
}

func TestMarketplaceTraceDelayedFormHTTP(t *testing.T) {
	for _, profile := range []string{"default", "matched"} {
		for _, mode := range []string{"api", "fixture"} {
			for _, locale := range []string{"en-US", "fr-FR", "de-DE"} {
				t.Run(profile+"/"+mode+"/"+locale, func(t *testing.T) {
					observed := make(chan traceObservation, 10)
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						observed <- traceObservation{r.URL.Path, r.Header.Get("traceparent"), r.Header.Get("tracestate")}
						_ = json.NewEncoder(w).Encode(sampleMarketplace())
					}))
					defer upstream.Close()
					router := traceAppRouter(t, profile, mode, upstream.URL)
					entered := make(chan struct{})
					app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.Method == "POST" && r.Header.Get("traceparent") == traceFirst {
							r.Body = &traceReadingBody{ReadCloser: r.Body, entered: entered}
						}
						router.ServeHTTP(w, r)
					}))
					defer app.Close()
					client := &http.Client{Timeout: 5 * time.Second}
					defer client.CloseIdleConnections()
					reader, writer := io.Pipe()
					defer reader.Close()
					defer writer.Close()
					old := make(chan traceHTTPResult, 1)
					path := "/marketplace/" + locale + "/item_1"
					go func() { old <- traceSend(client, "POST", app.URL+path, traceFirst, reader) }()
					awaitNative(t, entered, "native form body read")
					traceOK(t, traceSend(client, "GET", app.URL+"/api/marketplace/item_1", traceSecond, nil))
					traceOK(t, traceSend(client, "GET", app.URL+path, "", nil))
					select {
					case result := <-old:
						t.Fatalf("unfinished form completed: %+v", result)
					default:
					}
					form := "email=trace%40example.test&target_price=12,50"
					if locale == "en-US" {
						form = strings.ReplaceAll(form, ",", ".")
					}
					if _, err := fmt.Fprint(writer, form); err != nil {
						t.Fatal(err)
					}
					writer.Close()
					traceOK(t, <-old)
					if mode == "api" {
						for _, parent := range []string{traceSecond, "", traceFirst} {
							got := <-observed
							state := ""
							if parent != "" {
								state = "vendor=\xe9"
							}
							if got != (traceObservation{"/marketplace/records/item_1", parent, state}) {
								t.Fatal(got, parent)
							}
							t.Logf("delayed form native source: %q", got)
						}
					}
					select {
					case got := <-observed:
						t.Fatalf("fixture/extra fetch %q", got)
					default:
					}
				})
			}
		}
	}
}
