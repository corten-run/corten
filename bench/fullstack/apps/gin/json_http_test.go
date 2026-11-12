package main

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

var nativeRecords = []struct {
	name, id, page string
	record         func() any
}{
	{"catalog", "record_1", "/catalog/record_1", func() any { return sampleCatalogRecord() }},
	{"marketplace", "item_1", "/marketplace/fr-FR/item_1", func() any { return sampleMarketplace() }},
}

func nativeSourceRouter(t *testing.T, name, source, base string, record any) (*gin.Engine, *http.Client) {
	t.Helper()
	prefix := strings.ToUpper(name)
	t.Setenv(prefix+"_SOURCE", source)
	t.Setenv("API_BASE", base)
	if source == "fixture" {
		path := filepath.Join(t.TempDir(), "records.json")
		body, err := json.Marshal(map[string]any{nativeRecordID(name): record})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv(prefix+"_FIXTURE_PATH", path)
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	var client *http.Client
	if name == "catalog" {
		s, err := newCatalogSource()
		if err != nil {
			t.Fatal(err)
		}
		s.routes(router)
		client = s.client
	} else {
		s, err := newMarketplaceSource()
		if err != nil {
			t.Fatal(err)
		}
		s.routes(router)
		client = s.client
	}
	if client != nil {
		t.Cleanup(client.CloseIdleConnections)
	}
	return router, client
}

func nativeRecordID(name string) string {
	if name == "catalog" {
		return "record_1"
	}
	return "item_1"
}

func nativeRequest(t *testing.T, client *http.Client, method, url string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res, body
}

func nativeJSON(t *testing.T, res *http.Response, body []byte, status int, head bool) {
	t.Helper()
	if res.StatusCode != status {
		t.Errorf("status=%d want=%d body=%s", res.StatusCode, status, body)
	}
	media, _, err := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		t.Errorf("JSON content type=%q error=%v", res.Header.Get("Content-Type"), err)
	}
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("cache-control=%q", res.Header.Get("Cache-Control"))
	}
	if head {
		if len(body) != 0 {
			t.Errorf("HEAD body=%s", body)
		}
	} else if !json.Valid(body) {
		t.Errorf("invalid JSON: %q", body)
	}
}

func nativeSameRecord(t *testing.T, body []byte, record any) {
	t.Helper()
	expected, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(expected, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("complete numeric record differs: got=%s want=%s", body, expected)
	}
}

func TestNativeJSONHTTP(t *testing.T) {
	for _, tc := range nativeRecords {
		for _, mode := range []string{"fixture", "api"} {
			t.Run(tc.name+"/"+mode, func(t *testing.T) {
				var calls, status atomic.Int32
				status.Store(200)
				var redirected atomic.Int32
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					if r.URL.Path == "/redirect-target" {
						redirected.Add(1)
						_ = json.NewEncoder(w).Encode(tc.record())
						return
					}
					if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/"+tc.name+"/records/") {
						t.Errorf("unexpected upstream request: %s %s", r.Method, r.URL.Path)
					}
					if status.Load() == 302 {
						w.Header().Set("Location", "/redirect-target")
					}
					if strings.HasSuffix(r.URL.Path, "/missing") {
						w.WriteHeader(404)
						return
					}
					w.WriteHeader(int(status.Load()))
					_ = json.NewEncoder(w).Encode(tc.record())
				}))
				t.Cleanup(upstream.Close)
				router, _ := nativeSourceRouter(t, tc.name, mode, upstream.URL, tc.record())
				app := httptest.NewServer(router)
				t.Cleanup(app.Close)
				client := &http.Client{Timeout: 2 * time.Second}
				t.Cleanup(client.CloseIdleConnections)
				path := app.URL + "/api/" + tc.name + "/" + tc.id
				for _, method := range []string{"GET", "HEAD"} {
					res, body := nativeRequest(t, client, method, path+"?field=NoMatch&seller=NoMatch&locale=fr-FR")
					nativeJSON(t, res, body, 200, method == "HEAD")
					if method == "GET" {
						nativeSameRecord(t, body, tc.record())
					}
					res, body = nativeRequest(t, client, method, app.URL+"/api/"+tc.name+"/missing")
					nativeJSON(t, res, body, 404, method == "HEAD")
				}
				before := calls.Load()
				for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "CUSTOM"} {
					res, body := nativeRequest(t, client, method, path)
					nativeJSON(t, res, body, 405, false)
					allow := strings.Split(strings.ReplaceAll(res.Header.Get("Allow"), " ", ""), ",")
					if len(allow) != 2 || !(allow[0] == "GET" && allow[1] == "HEAD" || allow[1] == "GET" && allow[0] == "HEAD") {
						t.Errorf("Allow=%q", res.Header.Get("Allow"))
					}
				}
				if calls.Load() != before {
					t.Errorf("wrong methods did source work: %d", calls.Load()-before)
				}
				res, body := nativeRequest(t, client, "DELETE", app.URL+tc.page)
				if res.StatusCode != 404 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") || res.Header.Get("Allow") != "" || calls.Load() != before {
					t.Errorf("page fallback changed: status=%d headers=%v body=%s", res.StatusCode, res.Header, body)
				}
				if mode == "fixture" {
					if calls.Load() != 0 {
						t.Errorf("fixture used upstream %d times", calls.Load())
					}
					return
				}
				if before != 4 {
					t.Errorf("GET/HEAD/missing upstream reads=%d want=4", before)
				}
				for _, code := range []int32{503, 302} {
					status.Store(code)
					for _, method := range []string{"GET", "HEAD"} {
						before := calls.Load()
						res, body := nativeRequest(t, client, method, path)
						nativeJSON(t, res, body, 502, method == "HEAD")
						if calls.Load() != before+1 || redirected.Load() != 0 {
							t.Errorf("upstream %d: reads=%d redirected=%d", code, calls.Load()-before, redirected.Load())
						}
					}
				}
			})
		}
	}
}

func awaitNative(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for " + what)
	}
}

func TestNativeSourceDeadlineAndCallerAbort(t *testing.T) {
	for _, tc := range nativeRecords {
		for _, phase := range []string{"headers", "body"} {
			for _, abort := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/abort=%t", tc.name, phase, abort), func(t *testing.T) {
					started, canceled, closed := make(chan struct{}), make(chan struct{}), make(chan struct{}, 4)
					var calls atomic.Int32
					upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						n := calls.Add(1)
						if n == 1 {
							if phase == "body" {
								w.Header().Set("Content-Type", "application/json")
								_, _ = io.WriteString(w, `{"id":`)
								w.(http.Flusher).Flush()
							}
							close(started)
							<-r.Context().Done()
							close(canceled)
							return
						}
						record := tc.record()
						switch record := record.(type) {
						case *catalogRecord:
							record.Title = fmt.Sprintf("Changed %d", n)
						case *marketplaceRecord:
							record.Title = fmt.Sprintf("Changed %d", n)
						}
						_ = json.NewEncoder(w).Encode(record)
					}))
					upstream.Config.ConnState = func(_ net.Conn, state http.ConnState) {
						if state == http.StateClosed {
							closed <- struct{}{}
						}
					}
					upstream.Start()
					t.Cleanup(upstream.Close)
					router, sourceClient := nativeSourceRouter(t, tc.name, "api", upstream.URL, nil)
					app := httptest.NewServer(router)
					t.Cleanup(app.Close)
					path := "/api/" + tc.name + "/" + tc.id
					if abort {
						conn, err := net.DialTimeout("tcp", app.Listener.Addr().String(), time.Second)
						if err != nil {
							t.Fatal(err)
						}
						t.Cleanup(func() { _ = conn.Close() })
						if _, err := fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\n\r\n", path, app.Listener.Addr()); err != nil {
							t.Fatal(err)
						}
						awaitNative(t, started, "upstream start")
						_ = conn.Close()
					} else {
						bound := sourceClient.Timeout
						if bound <= 0 || bound > 30*time.Second {
							t.Errorf("source has no bounded total read deadline: %v", bound)
							bound = 300 * time.Millisecond
						}
						client := &http.Client{Timeout: bound + time.Second}
						t.Cleanup(client.CloseIdleConnections)
						res, body := nativeRequest(t, client, "GET", app.URL+path)
						nativeJSON(t, res, body, 502, false)
						awaitNative(t, started, "upstream start")
					}
					awaitNative(t, canceled, "upstream request cancellation")
					awaitNative(t, closed, "stalled socket closure")
					client := &http.Client{Timeout: 2 * time.Second}
					t.Cleanup(client.CloseIdleConnections)
					for n := 2; n <= 3; n++ {
						res, body := nativeRequest(t, client, "GET", app.URL+path)
						nativeJSON(t, res, body, 200, false)
						var got struct{ Title string }
						if err := json.Unmarshal(body, &got); err != nil || got.Title != fmt.Sprintf("Changed %d", n) {
							t.Fatalf("healthy recovery/caching: %s error=%v", body, err)
						}
					}
					if calls.Load() != 3 {
						t.Errorf("upstream reads=%d want=3", calls.Load())
					}
				})
			}
		}
	}
}
