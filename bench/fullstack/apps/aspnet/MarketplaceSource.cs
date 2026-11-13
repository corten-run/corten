using System.Text.Json;
using System.Diagnostics;

namespace ItemPage;

public sealed record MarketplaceCategory(string Name, string Slug);
public sealed record MarketplaceField(string Name, string Value);
public sealed record MarketplaceSummary(long? LowestMinor, long Count, long Quantity);
public sealed record MarketplaceListing(string Id, string Seller, int? RatingHundredths, long Reviews,
    string Condition, string ShipsFrom, long Quantity, long? PriceMinor);
public sealed record MarketplaceOffer(string Id, string Buyer, string Condition, long Quantity, long? PriceMinor);
public sealed record MarketplaceLine(string Id, string ItemId, string Title, long Quantity);
public sealed record MarketplaceRecord(string Id, string Title, string? Subtitle, string Description,
    MarketplaceCategory[] Categories, string[] Badges, string[] Tags, string[] Images,
    MarketplaceField[] Fields, MarketplaceSummary? Summary, MarketplaceListing[] Listings,
    MarketplaceOffer[] Offers, MarketplaceLine[] Contents, MarketplaceLine[] IncludedIn);

public sealed class MarketplaceSource
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };
    readonly HttpClient http;
    readonly Dictionary<string, MarketplaceRecord>? fixture;

    public MarketplaceSource(IHttpClientFactory factory)
    {
        http = factory.CreateClient(nameof(MarketplaceSource));
        if (Environment.GetEnvironmentVariable("MARKETPLACE_SOURCE") == "fixture")
        {
            using var file = File.OpenRead(Environment.GetEnvironmentVariable("MARKETPLACE_FIXTURE_PATH") ?? "/fixtures/marketplace.json");
            fixture = JsonSerializer.Deserialize<Dictionary<string, MarketplaceRecord>>(file, Json)
                ?? throw new JsonException("Missing marketplace fixture");
        }
    }

    public async Task<MarketplaceRecord?> Get(string id, CancellationToken cancellationToken = default, string? traceParent = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (fixture is not null) return fixture.GetValueOrDefault(id);
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/marketplace/records/{Uri.EscapeDataString(id)}");
        if (Parent(traceParent) is { } parent) request.Headers.Add("traceparent", parent);
        using var response = await http.SendAsync(request,
            HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<MarketplaceRecord>(Json, cancellationToken)
            ?? throw new JsonException("Missing marketplace record");
    }

    static string? Parent(string? value)
    {
        if (value is null || value.Length < 55 || value.Contains(',')
            || value[2] != '-' || value[35] != '-' || value[52] != '-'
            || (value.Length > 55 && (value.StartsWith("00-", StringComparison.Ordinal) || value[55] != '-')))
            return null;
        var prefix = value[..55];
        return ActivityContext.TryParse(prefix, null, out _) ? "00" + prefix[2..] : null;
    }
}
