package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMarketplaceTraceValidation(t *testing.T) {
	for _, value := range []string{traceFirst, traceSecond, "01" + traceFirst[2:], "fe" + traceFirst[2:] + "-future"} {
		if got := marketplaceTraceParent(value); got != "00"+value[2:55] {
			t.Errorf("%q: %q", value, got)
		}
	}
	for _, value := range []string{
		"", "bad", traceFirst[:54], strings.ReplaceAll(traceSecond, "2", "A"), "ff" + traceFirst[2:],
		"00-00000000000000000000000000000000-1111111111111111-00",
		"00-11111111111111111111111111111111-0000000000000000-00",
		traceFirst + "-extra", strings.ReplaceAll(traceFirst, "-", "_"),
		traceFirst + ", " + traceSecond, "01" + traceFirst[2:] + "x", "01" + traceFirst[2:] + "-\r\ninjected",
		strings.Repeat("\xe9", 55),
	} {
		if got := marketplaceTraceParent(value); got != "" {
			t.Errorf("invalid %q: %q", value, got)
		}
	}
	for _, state := range []string{"vendor=value", "vendor=\x80\xe9\xff", "a=x,\tb=y", ""} {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("traceparent", traceFirst)
		r.Header.Set("tracestate", state)
		got := marketplaceReadContext(r).Value(marketplaceTraceKey{}).(marketplaceTrace)
		if got != (marketplaceTrace{traceFirst, state}) {
			t.Errorf("safe state %q: %q", state, got)
		}
	}
	for _, state := range []string{"a=x\rb=y", "a=x\nb=y", "a=\x00", "a=\x1f", "a=\x7f"} {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("traceparent", traceFirst)
		r.Header.Set("tracestate", state)
		got := marketplaceReadContext(r).Value(marketplaceTraceKey{}).(marketplaceTrace)
		if got != (marketplaceTrace{parent: traceFirst}) {
			t.Errorf("unsafe state %q: %q", state, got)
		}
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.Header["Traceparent"] = []string{traceFirst, traceSecond}
	r.Header.Set("tracestate", "vendor=value")
	if got := marketplaceReadContext(r).Value(marketplaceTraceKey{}).(marketplaceTrace); got != (marketplaceTrace{}) {
		t.Fatal("duplicate parent", got)
	}
	r.Header.Set("traceparent", traceFirst)
	r.Header["Tracestate"] = []string{"a=x", "b=\xe9"}
	if got := marketplaceReadContext(r).Value(marketplaceTraceKey{}).(marketplaceTrace); got.state != "a=x,b=\xe9" {
		t.Fatal(got)
	}
	r.Header.Del("traceparent")
	if got := marketplaceReadContext(r).Value(marketplaceTraceKey{}).(marketplaceTrace); got != (marketplaceTrace{}) {
		t.Fatal("orphan state", got)
	}
}

func TestMarketplaceTraceFutureFlags(t *testing.T) {
	for _, flags := range []string{"80", "81", "fe", "ff"} {
		want := traceFirst[:53] + "0"
		if flags == "81" || flags == "ff" {
			want += "1"
		} else {
			want += "0"
		}
		value := "01" + traceFirst[2:53] + flags + "-future"
		if got := marketplaceTraceParent(value); got != want {
			t.Errorf("future %q: got %q want %q", value, got, want)
		}
		current := "00" + traceFirst[2:53] + flags
		if got := marketplaceTraceParent(current); got != current {
			t.Errorf("v00 flag transport changed: got %q want %q", got, current)
		}
	}
}

func TestMarketplaceTraceDelayedSnapshot(t *testing.T) {
	observed := make(chan traceObservation, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed <- traceObservation{r.URL.Path, r.Header.Get("traceparent"), r.Header.Get("tracestate")}
		_ = json.NewEncoder(w).Encode(sampleMarketplace())
	}))
	defer upstream.Close()
	client := newRecordHTTPClient()
	defer client.CloseIdleConnections()
	source := &marketplaceSource{base: upstream.URL, client: client}
	request := httptest.NewRequest("GET", "/", nil)
	request.Header.Set("traceparent", traceFirst)
	request.Header.Set("tracestate", "old=\xe9")
	ctx, cancel := context.WithCancel(request.Context())
	request = request.WithContext(ctx)
	captured := marketplaceReadContext(request)
	cancel()
	if captured.Err() != context.Canceled {
		t.Fatal("capture lost native cancellation")
	}
	request.Header.Set("traceparent", traceSecond)
	request.Header.Set("tracestate", "new=value")
	current := marketplaceReadContext(request.WithContext(context.Background()))
	untraced := marketplaceReadContext(httptest.NewRequest("GET", "/", nil).WithContext(current))
	// A retained immutable context can be used after the original response. Only this
	// test detaches cancellation; the production handlers retain native cancellation.
	for _, ctx := range []context.Context{current, untraced, context.WithoutCancel(captured), untraced} {
		if record, err := source.get(ctx, "item_1"); err != nil || record == nil {
			t.Fatal(record, err)
		}
	}
	for _, want := range []marketplaceTrace{{traceSecond, "new=value"}, {}, {traceFirst, "old=\xe9"}, {}} {
		got := <-observed
		if got != (traceObservation{"/marketplace/records/item_1", want.parent, want.state}) {
			t.Fatalf("got=%q want=%q", got, want)
		}
		t.Logf("delayed native source: %q", got)
	}
}
