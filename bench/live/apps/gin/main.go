package main

import (
	"encoding/json"
	"net/http"
	"runtime"
	"sync"
	"syscall"

	"github.com/gin-gonic/gin"
)

type listing struct {
	ID         string `json:"id"`
	Version    int    `json:"version"`
	PriceCents int    `json:"priceCents"`
	Quantity   int    `json:"quantity"`
}
type change struct {
	Seq      int      `json:"seq"`
	EffectID string   `json:"effectId"`
	Key      string   `json:"key"`
	Op       string   `json:"op"`
	Row      *listing `json:"row,omitempty"`
}
type reader struct {
	queue    chan change
	wake     chan struct{}
	overflow any
}
type feed struct {
	mu                                           sync.Mutex
	rows                                         map[string]listing
	history                                      []change
	readers                                      map[*reader]bool
	through, queuePeak, historyPeak, reads, drop int
	bytes                                        int
	hold                                         bool
}

func (f *feed) counters() gin.H {
	queued, slots := 0, 0
	for r := range f.readers {
		queued += len(r.queue)
		if r.overflow != nil {
			slots++
		}
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	var usage syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	return gin.H{"subscriptions": len(f.readers), "connections": len(f.readers), "pendingTasks": len(f.readers),
		"queueLimit": 2, "queueEvents": queued, "queuePeak": f.queuePeak,
		"historyLimit": 4, "historyEvents": len(f.history), "historyPeak": f.historyPeak,
		"process": gin.H{"version": runtime.Version(), "heapBytes": memory.HeapAlloc, "heapPeakBytes": memory.HeapSys,
			"userCpuUs": usage.Utime.Sec*1000000 + usage.Utime.Usec, "systemCpuUs": usage.Stime.Sec*1000000 + usage.Stime.Usec, "rssPeakKiB": usage.Maxrss},
		"inventory": gin.H{"applicationQueues": len(f.readers), "overflowSlots": slots, "historyRows": len(f.rows),
			"snapshotReads": f.reads, "transportPayloadBytes": f.bytes, "replayCopyLimitEvents": 4, "overflowSlotsLimit": 1, "timers": 0, "backgroundPublishers": 0,
			"nativeWriter": "one SSEvent plus Flush at a time; net/http write buffer and kernel socket outside queue"}}
}
func (f *feed) enqueue(r *reader, event change) {
	select {
	case r.queue <- event:
		if len(r.queue) > f.queuePeak {
			f.queuePeak = len(r.queue)
		}
	default:
		r.overflow = gin.H{"outcome": "resnapshot", "resources": f.counters()}
		for len(r.queue) > 0 {
			<-r.queue
		}
		f.hold = false
	}
	select {
	case r.wake <- struct{}{}:
	default:
	}
}
func (f *feed) stream(c *gin.Context) {
	var query struct {
		From int `form:"from" binding:"min=0"`
	}
	if c.ShouldBindQuery(&query) != nil {
		c.Status(400)
		return
	}
	r := &reader{queue: make(chan change, 2), wake: make(chan struct{}, 1)}
	f.mu.Lock()
	if len(f.readers) > 0 || query.From > f.through {
		f.mu.Unlock()
		c.Status(409)
		return
	}
	f.readers[r] = true
	expired := query.From < f.through && (len(f.history) == 0 || query.From < f.history[0].Seq-1)
	status := "accepted"
	if expired {
		status = "expired"
	}
	ready := gin.H{"from": query.From, "status": status, "resources": f.counters()}
	var replay []change
	if !expired {
		for _, e := range f.history {
			if e.Seq >= query.From {
				replay = append(replay, e)
			}
		}
	}
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		delete(f.readers, r)
		for len(r.queue) > 0 {
			<-r.queue
		}
		f.mu.Unlock()
	}()
	c.Header("Cache-Control", "no-store")
	c.Header("X-Accel-Buffering", "no")
	send := func(kind string, value any) {
		encoded, _ := json.Marshal(value)
		f.mu.Lock()
		f.bytes += len(encoded)
		f.mu.Unlock()
		c.SSEvent(kind, string(encoded))
		c.Writer.Flush()
	}
	send("ready", ready)
	for _, e := range replay {
		send("update", e)
	}
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-r.wake:
			for {
				var payload any
				kind := "update"
				f.mu.Lock()
				if r.overflow != nil {
					payload = r.overflow
					r.overflow = nil
					kind = "overflow"
				} else if !f.hold && len(r.queue) > 0 {
					payload = <-r.queue
				}
				f.mu.Unlock()
				if payload == nil {
					break
				}
				send(kind, payload)
			}
		}
	}
}
func main() {
	f := &feed{rows: make(map[string]listing), readers: make(map[*reader]bool)}
	r := gin.New()
	r.Use(gin.Recovery())
	r.GET("/", func(c *gin.Context) { c.File("index.html") })
	r.GET("/client.js", func(c *gin.Context) { c.File("client.js") })
	r.GET("/parity/events", f.stream)
	r.GET("/parity/resources", func(c *gin.Context) { f.mu.Lock(); defer f.mu.Unlock(); c.JSON(200, f.counters()) })
	r.GET("/parity/snapshot", func(c *gin.Context) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.reads++
		rows := make([]listing, 0, len(f.rows))
		for _, row := range f.rows {
			rows = append(rows, row)
		}
		c.JSON(200, gin.H{"through": f.through, "rows": rows, "work": gin.H{"reads": 1, "rows": len(rows)}})
	})
	r.POST("/parity/configure", func(c *gin.Context) {
		var p struct {
			Initial      []listing `json:"initial"`
			QueueLimit   int       `json:"queueLimit"`
			HistoryLimit int       `json:"historyLimit"`
		}
		if c.ShouldBindJSON(&p) != nil || p.QueueLimit != 2 || p.HistoryLimit != 4 || len(p.Initial) > 1000 {
			c.Status(400)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if len(f.readers) > 0 {
			c.Status(409)
			return
		}
		f.rows = make(map[string]listing)
		for _, row := range p.Initial {
			f.rows[row.ID] = row
		}
		f.history = nil
		f.through = 0
		f.queuePeak = 0
		f.historyPeak = 0
		f.reads = 0
		f.bytes = 0
		f.hold = false
		f.drop = 0
		c.JSON(200, gin.H{"configured": true, "framework": "gin", "version": gin.Version})
	})
	r.POST("/parity/publish", func(c *gin.Context) {
		var p struct {
			Event change `json:"event"`
		}
		if c.ShouldBindJSON(&p) != nil {
			c.Status(400)
			return
		}
		e := p.Event
		f.mu.Lock()
		defer f.mu.Unlock()
		if e.Seq != f.through+1 || (e.Op != "upsert" && e.Op != "remove") || e.Op == "upsert" && (e.Row == nil || e.Row.ID != e.Key) {
			c.Status(400)
			return
		}
		f.through = e.Seq
		if e.Op == "remove" {
			delete(f.rows, e.Key)
		} else {
			f.rows[e.Key] = *e.Row
		}
		if len(f.history) == 4 {
			copy(f.history, f.history[1:])
			f.history = f.history[:3]
		}
		f.history = append(f.history, e)
		if len(f.history) > f.historyPeak {
			f.historyPeak = len(f.history)
		}
		if e.Seq != f.drop {
			for reader := range f.readers {
				f.enqueue(reader, e)
			}
		}
		c.JSON(200, gin.H{"seq": f.through, "resources": f.counters()})
	})
	r.POST("/parity/control", func(c *gin.Context) {
		var p struct {
			Action string `json:"action"`
			Seq    int    `json:"seq"`
		}
		if c.ShouldBindJSON(&p) != nil {
			c.Status(400)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch p.Action {
		case "hold":
			f.hold = true
		case "drop":
			f.drop = p.Seq
		case "duplicate":
			if len(f.history) > 0 {
				for reader := range f.readers {
					f.enqueue(reader, f.history[len(f.history)-1])
				}
			}
		default:
			c.Status(400)
			return
		}
		c.JSON(200, gin.H{"resources": f.counters()})
	})
	server := &http.Server{Addr: ":8080", Handler: r, MaxHeaderBytes: 32768}
	if err := server.ListenAndServe(); err != nil {
		panic(err)
	}
}
