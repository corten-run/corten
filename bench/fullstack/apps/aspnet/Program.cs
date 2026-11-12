using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Unicode;
using ItemPage;
using Microsoft.Extensions.WebEncoders;

var builder = WebApplication.CreateBuilder(args);
// The matched tier's production profile (bench/fullstack/README.md, "The matched tier"), from
// ASP.NET Core's own middleware and settings; without it the app is as the template starts it.
var matched = Environment.GetEnvironmentVariable("PROFILE") == "matched";
builder.Services.AddRazorPages();
// Razor encodes every character outside Basic Latin by default ("·" becomes "&#xB7;"); the usual
// setting for a site with text in other scripts lets them through. HTML's own characters are
// still encoded.
builder.Services.Configure<WebEncoderOptions>(o => o.TextEncoderSettings = new TextEncoderSettings(UnicodeRanges.All));
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower);
// Both record JSON routes need JSON errors in the default profile too.
builder.Services.AddProblemDetails();
// The item API's client. In the profile a read gives up after 10 seconds, card-market's deadline,
// and the exception handler answers 500: ASP.NET Core's request timeout (UseRequestTimeouts) only
// cancels code that reads the request's token, which the app's reads do not take.
void Client(HttpClient c)
{
    c.BaseAddress = new Uri(Environment.GetEnvironmentVariable("API_BASE") ?? "http://localhost:8080");
    if (matched) c.Timeout = TimeSpan.FromSeconds(10);
}
builder.Services.AddHttpClient<ItemSource>(Client);
builder.Services.AddSingleton<ItemSource>();
builder.Services.AddHttpClient<CatalogSource>(Client);
builder.Services.AddSingleton<CatalogSource>();
builder.Services.AddHttpClient<MarketplaceSource>(Client)
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
builder.Services.AddSingleton<MarketplaceSource>();
builder.Services.AddSingleton<LivePrices>();
if (matched)
{
    builder.WebHost.ConfigureKestrel(o =>
    {
        // Forms of at most 2 MiB, as Corten's (Kestrel's default is 30 MB, and a form field may be 4 MiB).
        o.Limits.MaxRequestBodySize = 2 * 1024 * 1024;
        // The profile's connection cap; Kestrel closes a connection past it. Its request head
        // timeout is already 30 seconds, as Corten's header timeout.
        if (long.TryParse(Environment.GetEnvironmentVariable("MAX_CONNECTIONS"), out var cap)) o.Limits.MaxConcurrentConnections = cap;
    });
    // Names it answers to: localhost, the loopback addresses and the deploy's HOSTS (comma separated,
    // ".example.com" for the domain and every subdomain); others get the host filter's 400, before
    // any of the app's middleware. Corten also answers to any IP address.
    var hosts = (Environment.GetEnvironmentVariable("HOSTS") ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
    builder.Services.AddHostFiltering(o => o.AllowedHosts = ["localhost", "*.localhost", "127.0.0.1", "[::1]", .. hosts.SelectMany(h => h.StartsWith('.') ? new[] { h[1..], "*" + h } : new[] { h })]);
    // Brotli and gzip at their fastest when the client asks.
    builder.Services.AddResponseCompression();
    builder.Services.AddHealthChecks();
}

var app = builder.Build();
// Load the fixture before the first request.
app.Services.GetRequiredService<ItemSource>();
app.Services.GetRequiredService<CatalogSource>();
app.Services.GetRequiredService<MarketplaceSource>();
if (matched)
{
    // The security headers on every answer, as ASP.NET Core's documentation sets a header ("Control
    // headers in C# code": middleware that appends it, then calls the next). The exception handler
    // clears the headers before it answers, so its answers go without them.
    app.Use(async (context, next) =>
    {
        SecurityHeaders.Append(context.Response.Headers);
        await next();
    });
    app.UseResponseCompression();
    // A private Cache-Control on matched API answers; static files and forms keep their policies.
    app.UseWhen(c => c.Request.Path.StartsWithSegments("/api"), api => api.Use(async (context, next) =>
    {
        context.Response.Headers.Append("Cache-Control", "private, no-cache");
        await next();
    }));
    app.UseWhen(c => !c.Request.Path.StartsWithSegments("/api"), pages => pages.UseExceptionHandler("/Error"));
}
app.UseWhen(c => c.Request.Path.StartsWithSegments("/api/catalog") || c.Request.Path.StartsWithSegments("/api/marketplace")
    || (matched && c.Request.Path.StartsWithSegments("/api")), api => api.UseExceptionHandler().UseStatusCodePages());
if (matched)
{
    // Routing after the exception handler, as the template places it: the handler clears the failed
    // request's endpoint and runs it again as /Error, which routing before it would not match again.
    app.UseRouting();
    app.MapHealthChecks("/health/live");
    app.MapHealthChecks("/health/ready");
}
app.MapStaticAssets();
app.MapRazorPages().WithStaticAssets();
// The item as JSON for other services: the same data the page renders. In the profile GET and
// HEAD, as Corten's get routes (Kestrel leaves out HEAD's body).
string[] get = matched ? ["GET", "HEAD"] : ["GET"];
app.MapMethods("/api/items/{id}", get, async (string id, ItemSource items) => await items.Get(id) is { } item ? Results.Ok(item) : Results.NotFound());
app.MapMethods("/api/catalog/{id}", ["GET", "HEAD"], async (string id, CatalogSource catalog) => await catalog.Get(id) is { } record ? Results.Ok(record) : Results.NotFound());
app.MapMethods("/api/marketplace/{id}", ["GET", "HEAD"], async (string id, MarketplaceSource source) => await source.Get(id) is { } record ? Results.Ok(record) : Results.NotFound());
// The live benchmark (bench/live): server-sent events, and the publisher that feeds them.
app.MapGet("/live/prices", (LivePrices live, CancellationToken cancel) => TypedResults.ServerSentEvents(live.Subscribe(cancel)));
app.MapPost("/live/publish", async (HttpRequest request, LivePrices live) =>
{
    using var reader = new StreamReader(request.Body);
    live.Publish(await reader.ReadToEndAsync());
    return Results.NoContent();
});
app.Run();

public partial class Program { }

/// <summary>The profile's security headers, axum-maud's: a strict CSP (the page's scripts are files), and the rest Corten sends.</summary>
static class SecurityHeaders
{
    public static void Append(IHeaderDictionary h)
    {
        h.Append("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
        h.Append("X-Content-Type-Options", "nosniff");
        h.Append("Referrer-Policy", "strict-origin-when-cross-origin");
        h.Append("X-Frame-Options", "DENY");
        h.Append("Cross-Origin-Opener-Policy", "same-origin");
        h.Append("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()");
    }
}
