using System.Diagnostics;
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Channels;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
var feed = new KeyedFeed();
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapPost("/parity/configure", (Configuration c) => feed.Configure(c));
app.MapGet("/parity/resources", () => feed.Resources());
app.MapGet("/parity/snapshot", () => feed.Snapshot());
app.MapGet("/parity/events", (long from, HttpContext http) =>
    TypedResults.ServerSentEvents(feed.Subscribe(from, http.RequestAborted)));
app.MapPost("/parity/publish", (Publication p) => feed.Publish(p));
app.MapPost("/parity/control", (Control c) => feed.Control(c));
app.Run();

record Listing(string Id, long Version, int PriceCents, int Quantity);
record Change(long Seq, string EffectId, string Key, string Op, Listing? Row);
record Configuration(Listing[] Initial, int QueueLimit, int HistoryLimit);
record Publication(Change? Event, Change[]? Events);
record Control(string Action, long Seq);

sealed class Reader(int capacity)
{
    public readonly Channel<Change> Queue = Channel.CreateBounded<Change>(new BoundedChannelOptions(capacity)
    { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    // One replaceable wake signal, not an unbounded second payload queue.
    public readonly SemaphoreSlim Wake = new(0, 1);
    public object? Overflow;
    public void Notify() { if (Wake.CurrentCount == 0) Wake.Release(); }
}

sealed class KeyedFeed
{
    readonly object gate = new();
    readonly Dictionary<string, Listing> rows = new();
    readonly List<Change> history = new();
    readonly HashSet<Reader> readers = new();
    long through, dropSeq;
    int queuePeak, historyPeak, snapshotReads;
    int queueLimit = 2, historyLimit = 4;
    long transportBytes;
    bool hold;
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

    public IResult Configure(Configuration c)
    {
        lock (gate)
        {
            if (readers.Count != 0) return Results.Conflict();
            if (!((c.QueueLimit == 2 && c.HistoryLimit == 4) || (c.QueueLimit == 1024 && c.HistoryLimit == 1025)) || c.Initial.Length > 1000) return Results.BadRequest();
            queueLimit = c.QueueLimit; historyLimit = c.HistoryLimit;
            rows.Clear(); foreach (var row in c.Initial) rows.Add(row.Id, row);
            through = dropSeq = transportBytes = 0; queuePeak = historyPeak = snapshotReads = 0;
            history.Clear(); hold = false;
            return Results.Json(new { configured = true, framework = "aspnet", version = Environment.Version.ToString() });
        }
    }
    object Counters()
    {
        using var p = Process.GetCurrentProcess();
        return new { subscriptions = readers.Count, connections = readers.Count, pendingTasks = readers.Count,
            queueLimit, queueEvents = readers.Sum(r => r.Queue.Reader.Count), queuePeak,
            historyLimit, historyEvents = history.Count, historyPeak,
            process = new { pid = Environment.ProcessId, workingSetBytes = p.WorkingSet64, peakWorkingSetBytes = p.PeakWorkingSet64, cpuMs = p.TotalProcessorTime.TotalMilliseconds, version = Environment.Version.ToString() },
            inventory = new { applicationQueues = readers.Count, wakeSignals = readers.Sum(r => r.Wake.CurrentCount),
                overflowSlots = readers.Count(r => r.Overflow != null), historyRows = rows.Count, snapshotReads,
                transportPayloadBytes = transportBytes, replayCopyLimitEvents = historyLimit, overflowSlotsLimit = 1, timers = 0, backgroundPublishers = 0,
                nativeWriter = "one awaited SseItem at a time; Kestrel default response backpressure" } };
    }
    public object Resources() { lock (gate) return Counters(); }
    public object Snapshot()
    {
        lock (gate) { snapshotReads++; return new { through, rows = rows.Values.ToArray(), work = new { reads = 1, rows = rows.Count } }; }
    }
    string Encode(object value)
    {
        var json = JsonSerializer.Serialize(value, Json);
        transportBytes += System.Text.Encoding.UTF8.GetByteCount(json);
        return json;
    }
    void Enqueue(Reader reader, Change e)
    {
        if (!reader.Queue.Writer.TryWrite(e))
        {
            reader.Overflow = new { outcome = "resnapshot", resources = Counters() };
            while (reader.Queue.Reader.TryRead(out _)) { }
            hold = false;
        }
        queuePeak = Math.Max(queuePeak, reader.Queue.Reader.Count);
        reader.Notify();
    }
    public IResult Publish(Publication input)
    {
        lock (gate)
        {
            var batch = input.Events != null;
            var events = input.Events ?? (input.Event == null ? [] : new[] { input.Event });
            if (batch && (queueLimit != 1024 || input.Event != null) || events.Length is < 1 or > 1044
                || events.Where((e, i) => e == null || e.Seq != through + i + 1 || e.Key == null || e.EffectId == null
                    || e.Op is not ("remove" or "upsert") || e.Op == "upsert" && e.Row?.Id != e.Key).Any()) return Results.BadRequest();
            var acks = new List<object>();
            foreach (var e in events)
            {
            through = e.Seq; if (e.Op == "remove") rows.Remove(e.Key); else rows[e.Key] = e.Row!;
            if (history.Count == historyLimit) history.RemoveAt(0); history.Add(e); historyPeak = Math.Max(historyPeak, history.Count);
            if (e.Seq != dropSeq) foreach (var r in readers) Enqueue(r, e);
                acks.Add(new { seq = through, resources = Counters() });
            }
            return batch ? Results.Json(new { acks }) : Results.Json(acks[0]);
        }
    }
    public IResult Control(Control c)
    {
        lock (gate)
        {
            if (c.Action == "hold") hold = true;
            else if (c.Action == "drop") dropSeq = c.Seq;
            else if (c.Action == "duplicate" && history.Count > 0) foreach (var r in readers) Enqueue(r, history[^1]);
            else return Results.BadRequest();
            return Results.Json(new { resources = Counters() });
        }
    }
    public async IAsyncEnumerable<SseItem<string>> Subscribe(long from, [EnumeratorCancellation] CancellationToken cancel)
    {
        Reader reader; string ready;
        lock (gate)
        {
            if (readers.Count >= 16 || from < 0 || from > through) throw new InvalidOperationException("invalid subscription");
            reader = new Reader(queueLimit);
            readers.Add(reader);
            var expired = from < through && (history.Count == 0 || from < history[0].Seq - 1);
            ready = Encode(new { from, status = expired ? "expired" : "accepted", resources = Counters() });
            // Replay is read directly from the finite history, never put in an unbounded queue.
        }
        try
        {
            yield return new SseItem<string>(ready, "ready");
            Change[] replay;
            lock (gate) replay = from < through && from < history[0].Seq - 1 ? [] : history.Where(e => e.Seq >= from).ToArray();
            foreach (var e in replay)
            {
                string encoded; lock (gate) encoded = Encode(e);
                yield return new SseItem<string>(encoded, "update");
            }
            while (!cancel.IsCancellationRequested)
            {
                await reader.Wake.WaitAsync(cancel);
                while (true)
                {
                    string? message = null; string type = "update";
                    lock (gate)
                    {
                        if (reader.Overflow is { } overflow) { reader.Overflow = null; message = Encode(overflow); type = "overflow"; }
                        else if (!hold && reader.Queue.Reader.TryRead(out var e)) message = Encode(e);
                    }
                    if (message == null) break;
                    yield return new SseItem<string>(message, type);
                }
            }
        }
        finally
        {
            lock (gate)
            {
                readers.Remove(reader); reader.Queue.Writer.TryComplete();
                while (reader.Queue.Reader.TryRead(out _)) { }
                reader.Wake.Dispose();
            }
        }
    }
}
