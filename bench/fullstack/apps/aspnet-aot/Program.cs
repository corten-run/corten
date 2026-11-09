using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Unicode;
using ItemJson;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Http.Timeouts;
using Microsoft.Extensions.Diagnostics.HealthChecks;

// The item as JSON, and only that, on ASP.NET Core minimal APIs published with native AOT. It
// answers with what card-market's JSON route answers with (bench/fullstack/README.md, "aspnet-aot"):
// each piece is ASP.NET Core's own middleware for it, as the webapiaot template would add it.
var builder = WebApplication.CreateSlimBuilder(args);
// The matched tier's connection cap (bench/fullstack/README.md, "The matched tier"); Kestrel closes a
// connection past it. Its request head timeout is already 30 seconds, as Corten's header timeout.
if (Environment.GetEnvironmentVariable("PROFILE") == "matched" && long.TryParse(Environment.GetEnvironmentVariable("MAX_CONNECTIONS"), out var cap))
    builder.WebHost.ConfigureKestrel(o => o.Limits.MaxConcurrentConnections = cap);
// Errors, warnings and startup, as apps/aspnet logs (its appsettings.json). HttpClient's request
// lines are Information too (four for each item API call), and Corten logs none per request.
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.Logging.AddFilter("System.Net.Http.HttpClient", LogLevel.Warning);
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.TypeInfoResolverChain.Insert(0, ViewJson.Default);
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;
    // Text in other scripts as UTF-8, as Corten writes it; HTML's characters are still escaped.
    o.SerializerOptions.Encoder = JavaScriptEncoder.Create(UnicodeRanges.All);
});
// Names it answers to: localhost, the loopback addresses and the deploy's HOSTS (comma separated,
// ".example.com" for the domain and every subdomain), as Corten's host check, which also answers to
// any IP address. ASP.NET Core's filter runs before the app's middleware (WebApplication adds it)
// and answers others with a 400 HTML page without the headers below (Corten: 421 with its headers).
var hosts = (Environment.GetEnvironmentVariable("HOSTS") ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
builder.Services.AddHostFiltering(o => o.AllowedHosts = ["localhost", "*.localhost", "127.0.0.1", "[::1]", .. hosts.SelectMany(h => h.StartsWith('.') ? new[] { h[1..], "*" + h } : new[] { h })]);
// Failures as application/problem+json (RFC 9457): 404, 405 and an exception's 500.
builder.Services.AddProblemDetails();
// Brotli and gzip at their fastest when the client asks (Corten also offers zstd).
builder.Services.AddResponseCompression();
// A request that has not started its answer in 10 seconds gets a 503, as card-market's deadline.
builder.Services.AddRequestTimeouts(o => o.DefaultPolicy = new RequestTimeoutPolicy { Timeout = TimeSpan.FromSeconds(10), TimeoutStatusCode = StatusCodes.Status503ServiceUnavailable });
builder.Services.AddHttpClient(nameof(ItemSource), c => c.BaseAddress = new Uri(Environment.GetEnvironmentVariable("API_BASE") ?? "http://localhost:8080"));
builder.Services.AddSingleton(s => ItemSource.FromEnv(s.GetRequiredService<IHttpClientFactory>()));
builder.Services.AddHealthChecks().AddCheck<ItemsReachable>("items", tags: ["ready"]);

var app = builder.Build();
// Load the fixture before the first request.
app.Services.GetRequiredService<ItemSource>();
// The headers Corten puts on a JSON answer, as ASP.NET Core's documentation sets a header ("Control
// headers in C# code": middleware that appends it, then calls the next). The exception handler
// clears the headers before it answers, so its 500 goes without them; the 404 and 405 keep them.
app.Use(async (context, next) =>
{
    Headers.Append(context.Response.Headers);
    await next();
});
app.UseResponseCompression();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseRequestTimeouts();
app.MapHealthChecks("/health/live", new() { Predicate = _ => false });
app.MapHealthChecks("/health/ready", new() { Predicate = check => check.Tags.Contains("ready") });
// The item as JSON for other services: the same view model card-market's page renders.
// GET and HEAD, as Corten's get routes (Kestrel leaves out HEAD's body).
app.MapMethods("/api/items/{id}", ["GET", "HEAD"], async Task<Results<Ok<ItemView>, NotFound>> (string id, ItemSource items, CancellationToken cancel) =>
    await items.Get(id, cancel) is { } item ? TypedResults.Ok(item) : TypedResults.NotFound());
app.Run();

static class Headers
{
    public static void Append(IHeaderDictionary h)
    {
        h.Append("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        h.Append("X-Content-Type-Options", "nosniff");
        h.Append("Referrer-Policy", "strict-origin-when-cross-origin");
        h.Append("X-Frame-Options", "DENY");
        h.Append("Cross-Origin-Opener-Policy", "same-origin");
        h.Append("Cache-Control", "private, no-cache");
    }
}

/// <summary>Ready while items can be read: what a load balancer asks before sending traffic.</summary>
sealed class ItemsReachable(ItemSource items) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancel = default) =>
        await items.Reachable(cancel) ? HealthCheckResult.Healthy() : HealthCheckResult.Unhealthy("the item API does not answer");
}

// The item API's responses, read with the source generator (no reflection under AOT).
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower, NumberHandling = JsonNumberHandling.AllowReadingFromString)]
[JsonSerializable(typeof(Dictionary<string, ApiItem>))]
[JsonSerializable(typeof(ApiItem))]
partial class ApiJson : JsonSerializerContext;

// The view model, written with the source generator.
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower)]
[JsonSerializable(typeof(ItemView))]
partial class ViewJson : JsonSerializerContext;
