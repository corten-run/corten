using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;
using ItemJson;

Check(!JsonSerializer.IsReflectionEnabledByDefault, "reflection fallback is disabled");
await Run("catalog", """
    {"id":"sample","title":"Sample <&\"\\\n café","subtitle":"Notes","description":"Text",
    "tags":["<&>"],"fields":[{"name":"Name","value":"Value"}],"related":[{"id":"other","title":"Other"}]}
    """, RecordJson.Default.CatalogRecord, factory => new CatalogSource(factory).Get);
await Run("marketplace", """
    {"id":"sample","title":"Sample <&\"\\\n café","subtitle":null,"description":"Text",
    "categories":[{"name":"Cards","slug":"cards"}],"badges":["Rare"],"tags":["<&>"],"images":["/one"],
    "fields":[{"name":"Name","value":"Value"}],"summary":{"lowest_minor":-123450,"count":1000000,"quantity":1000},
    "listings":[{"id":"listing","seller":"Seller","rating_hundredths":425,"reviews":1000,
    "condition":"NM","ships_from":"US","quantity":2,"price_minor":null}],
    "offers":[{"id":"offer","buyer":"Buyer","condition":"NM","quantity":3,"price_minor":0}],
    "contents":[{"id":"line","item_id":"sample","title":"Other","quantity":2}],
    "included_in":[{"id":"box","item_id":"sample","title":"Box","quantity":1}]}
    """, RecordJson.Default.MarketplaceRecord, factory => new MarketplaceSource(factory).Get);
Console.WriteLine("PASS all source/model/serialization checks (reflection disabled)");

static async Task Run<T>(string name, string payload, JsonTypeInfo<T> type,
    Func<IHttpClientFactory, Func<string, CancellationToken, Task<T?>>> source) where T : class
{
    var expected = JsonDocument.Parse(payload).RootElement.Clone();
    var model = JsonSerializer.Deserialize(payload, type)!;
    var serialized = JsonSerializer.Serialize(model, type);
    Equal(expected, JsonDocument.Parse(serialized).RootElement);
    Check(!serialized.Contains("<"), "HTML-sensitive text escaped");
    Check(serialized.Contains("\\u0026"), "ampersand escaped");
    Console.WriteLine($"PASS {name}: full DTO round-trip, numeric/null shape and escaping");
    if (model is MarketplaceRecord marketplace) await MarketplaceValidation(marketplace);

    var upstream = new Upstream { Body = payload };
    using var http = new HttpClient(upstream) { BaseAddress = new Uri("http://localhost") };
    var factory = new Factory(http);
    var env = name.ToUpperInvariant() + "_SOURCE";
    var path = name.ToUpperInvariant() + "_FIXTURE_PATH";
    var previousSource = Environment.GetEnvironmentVariable(env);
    var previousPath = Environment.GetEnvironmentVariable(path);
    var file = Path.GetTempFileName();
    try
    {
        Environment.SetEnvironmentVariable(env, "fixture");
        Environment.SetEnvironmentVariable(path, file);
        await File.WriteAllTextAsync(file, "{\"sample\":" + payload + "}");
        var fixture = source(factory);
        await File.WriteAllTextAsync(file, "{}");
        Equal(expected, JsonSerializer.SerializeToElement((await fixture("sample", default))!, type));
        Check(await fixture("missing", default) is null, "fixture missing");
        Check(upstream.Requests == 0, "fixture does not fetch HTTP");
        foreach (var invalid in new[] { "null", "{\"sample\":null}", "{\"sample\":{}}", "{\"sample\":" + payload.Replace("[\"<&>\"]", "[null]") + "}" })
        {
            await File.WriteAllTextAsync(file, invalid);
            await Throws<JsonException>(() => { source(factory); return Task.CompletedTask; });
        }
        Console.WriteLine($"PASS {name}: fixture parsed once, missing record, invalid startup data");

        Environment.SetEnvironmentVariable(env, "api");
        var get = source(factory);
        Equal(expected, JsonSerializer.SerializeToElement((await get("sample", default))!, type));
        Check(upstream.Requests == 1, "one request");
        upstream.Body = payload.Replace("Sample", "Fresh");
        upstream.Body = upstream.Body.Replace("\"id\":\"sample\"", "\"id\":\"a/b ?#%é\"");
        var fresh = JsonSerializer.SerializeToElement((await get("a/b ?#%é", default))!, type);
        Check(fresh.GetProperty("title").GetString()!.StartsWith("Fresh"), "fresh parse each request");
        Check(upstream.Requests == 2, "exactly one fetch each");
        Check(upstream.Path == $"/{name}/records/a%2Fb%20%3F%23%25%C3%A9", "encoded id");
        upstream.Body = payload[..^1] + ",\"unknown_upstream\":true}";
        Equal(expected, JsonSerializer.SerializeToElement((await get("sample", default))!, type));
        upstream.Status = HttpStatusCode.NotFound;
        Check(await get("missing", default) is null, "upstream 404");
        foreach (var status in new[] { HttpStatusCode.ServiceUnavailable, HttpStatusCode.Redirect })
        {
            upstream.Status = status;
            await Throws<HttpRequestException>(async () => { await get("sample", default); });
        }
        upstream.Status = HttpStatusCode.OK;
        foreach (var invalid in new[] { "null", "{", "{}", payload.Replace("[\"<&>\"]", "[null]"), payload.Replace("\"title\":", "\"absent_title\":") })
        {
            upstream.Body = invalid;
            await Throws<JsonException>(async () => { await get("sample", default); });
        }
        if (name == "marketplace")
        {
            upstream.Body = payload.Replace("\"reviews\":1000", "\"reviews\":\"1000\"");
            await Throws<JsonException>(async () => { await get("sample", default); });
        }
        using var cancel = new CancellationTokenSource();
        var stalled = new StallingUpstream();
        using var stalledHttp = new HttpClient(stalled) { BaseAddress = new Uri("http://localhost") };
        var stalledGet = source(new Factory(stalledHttp));
        var pending = stalledGet("sample", cancel.Token);
        await stalled.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Check(!pending.IsCompleted && stalled.Active == 1, "HTTP work really in flight before cancellation");
        cancel.Cancel();
        await Throws<OperationCanceledException>(async () => { await pending.WaitAsync(TimeSpan.FromSeconds(5)); });
        Check(stalled.Active == 0 && stalled.Canceled && stalled.Requests == 1, "in-flight HTTP work released without retry");
        Console.WriteLine($"PASS {name}: fresh HTTP parse/reserialize, encoded id, 404, errors, redirects, invalid JSON/schema, cancellation");
    }
    finally
    {
        Environment.SetEnvironmentVariable(env, previousSource);
        Environment.SetEnvironmentVariable(path, previousPath);
        File.Delete(file);
    }
}

static async Task MarketplaceValidation(MarketplaceRecord record)
{
    var invalid = new List<(string Name, MarketplaceRecord Record)>();
    void Bounds(string name, Func<long, MarketplaceRecord> change, long min = 0)
    {
        invalid.Add((name + " below minimum", change(min - 1)));
        invalid.Add((name + " above maximum", change(1_000_000_001)));
    }
    Bounds("summary.count", n => record with { Summary = record.Summary! with { Count = n } });
    Bounds("summary.quantity", n => record with { Summary = record.Summary! with { Quantity = n } });
    Bounds("summary.lowest_minor", n => record with { Summary = record.Summary! with { LowestMinor = n } }, -1_000_000_000);
    Bounds("listing.reviews", n => record with { Listings = [record.Listings[0] with { Reviews = n }] });
    Bounds("listing.quantity", n => record with { Listings = [record.Listings[0] with { Quantity = n }] });
    Bounds("listing.price_minor", n => record with { Listings = [record.Listings[0] with { PriceMinor = n }] }, -1_000_000_000);
    Bounds("offer.quantity", n => record with { Offers = [record.Offers[0] with { Quantity = n }] });
    Bounds("offer.price_minor", n => record with { Offers = [record.Offers[0] with { PriceMinor = n }] }, -1_000_000_000);
    Bounds("contents.quantity", n => record with { Contents = [record.Contents[0] with { Quantity = n }] });
    Bounds("included_in.quantity", n => record with { IncludedIn = [record.IncludedIn[0] with { Quantity = n }] });
    foreach (var rating in new[] { -1, 501 })
        invalid.Add(($"listing.rating_hundredths {rating}", record with { Listings = [record.Listings[0] with { RatingHundredths = rating }] }));
    invalid.Add(("duplicate listing ids", record with { Listings = [record.Listings[0], record.Listings[0]] }));
    invalid.Add(("duplicate offer ids", record with { Offers = [record.Offers[0], record.Offers[0]] }));
    invalid.Add(("duplicate contents ids", record with { Contents = [record.Contents[0], record.Contents[0]] }));
    invalid.Add(("duplicate included_in ids", record with { IncludedIn = [record.IncludedIn[0], record.IncludedIn[0]] }));
    invalid.Add(("record id mismatch", record with { Id = "wrong" }));
    var cases = invalid.Select(c => (c.Name, Json: JsonSerializer.Serialize(c.Record, RecordJson.Default.MarketplaceRecord))).ToList();
    var original = JsonNode.Parse(JsonSerializer.Serialize(record, RecordJson.Default.MarketplaceRecord))!;
    var nullable = new HashSet<string> { "subtitle", "summary", "summary.lowest_minor", "listings.0.rating_hundredths", "listings.0.price_minor", "offers.0.price_minor" };
    JsonNode At(JsonNode root, string[] path) => path.Aggregate(root, (node, key) => node is JsonArray array ? array[int.Parse(key)]! : node[key]!);
    void Add(string name, string[] path, Action<JsonNode> mutate)
    {
        var copy = original.DeepClone();
        mutate(At(copy, path));
        cases.Add((name, copy.ToJsonString()));
    }
    void Shape(JsonObject value, string[] path)
    {
        foreach (var (key, field) in value)
        {
            string[] next = [.. path, key];
            var name = string.Join('.', next);
            Add(name + " missing", path, node => node.AsObject().Remove(key));
            if (!nullable.Contains(name)) Add(name + " null", path, node => node[key] = null);
            Add(name + " wrong type", path, node => node[key] = true);
            if (field is JsonArray { Count: > 0 } array)
            {
                Add(name + " null entry", next, node => node.AsArray()[0] = null);
                Add(name + " wrong entry type", next, node => node.AsArray()[0] = false);
                if (array[0] is JsonObject child) Shape(child, [.. next, "0"]);
            }
            else if (field is JsonObject child) Shape(child, next);
        }
    }
    Shape(original.AsObject(), []);

    var previousSource = Environment.GetEnvironmentVariable("MARKETPLACE_SOURCE");
    var previousPath = Environment.GetEnvironmentVariable("MARKETPLACE_FIXTURE_PATH");
    var file = Path.GetTempFileName();
    var upstream = new Upstream();
    using var http = new HttpClient(upstream) { BaseAddress = new Uri("http://localhost") };
    var factory = new Factory(http);
    try
    {
        Environment.SetEnvironmentVariable("MARKETPLACE_SOURCE", "api");
        var source = new MarketplaceSource(factory);
        foreach (var (name, json) in cases)
        {
            upstream.Body = json;
            try { await Throws<JsonException>(async () => { await source.Get("sample", default); }); }
            catch { Console.WriteLine($"FAIL HTTP accepted schema-invalid marketplace: {name}"); throw; }
        }
        Environment.SetEnvironmentVariable("MARKETPLACE_SOURCE", "fixture");
        Environment.SetEnvironmentVariable("MARKETPLACE_FIXTURE_PATH", file);
        foreach (var (name, json) in cases)
        {
            await File.WriteAllTextAsync(file, "{\"sample\":" + json + "}");
            try { await Throws<JsonException>(() => { new MarketplaceSource(factory); return Task.CompletedTask; }); }
            catch { Console.WriteLine($"FAIL fixture accepted schema-invalid marketplace: {name}"); throw; }
        }
        await File.WriteAllTextAsync(file, "{\"sample\":" + JsonSerializer.Serialize(record with { Contents = [record.Contents[0] with { ItemId = "missing" }] }, RecordJson.Default.MarketplaceRecord) + "}");
        await Throws<JsonException>(() => { new MarketplaceSource(factory); return Task.CompletedTask; });
        Environment.SetEnvironmentVariable("MARKETPLACE_SOURCE", "api");
        foreach (var boundary in new long[] { 0, 1_000_000_000 })
        {
            var valid = record with {
                Summary = new(boundary == 0 ? -1_000_000_000 : boundary, boundary, boundary),
                Listings = [record.Listings[0] with { RatingHundredths = boundary == 0 ? 0 : 500, Reviews = boundary, Quantity = boundary, PriceMinor = -boundary }],
                Offers = [record.Offers[0] with { Quantity = boundary, PriceMinor = boundary }],
                Contents = [record.Contents[0] with { Quantity = boundary }], IncludedIn = [record.IncludedIn[0] with { Quantity = boundary }]
            };
            upstream.Body = JsonSerializer.Serialize(valid, RecordJson.Default.MarketplaceRecord);
            Equal(JsonDocument.Parse(upstream.Body).RootElement, JsonSerializer.SerializeToElement((await source.Get("sample", default))!, RecordJson.Default.MarketplaceRecord));
            await File.WriteAllTextAsync(file, "{\"sample\":" + upstream.Body + "}");
            Environment.SetEnvironmentVariable("MARKETPLACE_SOURCE", "fixture");
            new MarketplaceSource(factory);
            Environment.SetEnvironmentVariable("MARKETPLACE_SOURCE", "api");
        }
        Console.WriteLine($"PASS marketplace: {cases.Count} complete-schema invalid cases rejected by fixture startup and HTTP source; missing fixture reference rejected; inclusive numeric boundaries accepted");
    }
    finally
    {
        Environment.SetEnvironmentVariable("MARKETPLACE_SOURCE", previousSource);
        Environment.SetEnvironmentVariable("MARKETPLACE_FIXTURE_PATH", previousPath);
        File.Delete(file);
    }
}

static void Equal(JsonElement expected, JsonElement actual) => Check(JsonElement.DeepEquals(expected, actual), "exact JSON schema and values");
static void Check(bool value, string message)
{
    if (!value) throw new Exception(message);
}
static async Task Throws<T>(Func<Task> action) where T : Exception
{
    try { await action(); }
    catch (T) { return; }
    throw new Exception($"Expected {typeof(T).Name}");
}

sealed class Factory(HttpClient http) : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => http;
}
sealed class StallingUpstream : HttpMessageHandler
{
    public readonly TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public int Active;
    public int Requests;
    public bool Canceled;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Active++;
        Requests++;
        Started.TrySetResult();
        try { await Task.Delay(Timeout.Infinite, cancellationToken); }
        catch (OperationCanceledException) { Canceled = true; throw; }
        finally { Active--; }
        throw new Exception("Stalled request unexpectedly completed");
    }
}
sealed class Upstream : HttpMessageHandler
{
    public string Body = "null";
    public HttpStatusCode Status = HttpStatusCode.OK;
    public int Requests;
    public string? Path;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Requests++;
        Path = request.RequestUri!.AbsolutePath;
        return Task.FromResult(new HttpResponseMessage(Status) { Content = new StringContent(Body) });
    }
}
