using System.Text.Json;

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

    public async Task<MarketplaceRecord?> Get(string id)
    {
        if (fixture is not null) return fixture.GetValueOrDefault(id);
        using var response = await http.GetAsync($"/marketplace/records/{Uri.EscapeDataString(id)}");
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<MarketplaceRecord>(Json)
            ?? throw new JsonException("Missing marketplace record");
    }
}
