using System.Net.Http.Json;
using System.Text.Json;

namespace ItemJson;

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
    readonly HttpClient http;
    readonly Dictionary<string, MarketplaceRecord>? fixture;

    public MarketplaceSource(IHttpClientFactory factory)
    {
        http = factory.CreateClient(nameof(MarketplaceSource));
        if (Environment.GetEnvironmentVariable("MARKETPLACE_SOURCE") == "fixture")
        {
            using var file = File.OpenRead(Environment.GetEnvironmentVariable("MARKETPLACE_FIXTURE_PATH") ?? "/fixtures/marketplace.json");
            fixture = JsonSerializer.Deserialize(file, RecordJson.Default.DictionaryStringMarketplaceRecord)
                ?? throw new JsonException("Missing marketplace fixture");
            foreach (var (id, record) in fixture) Validate(record, id);
            foreach (var record in fixture.Values)
                foreach (var line in record.Contents.Concat(record.IncludedIn))
                    if (!fixture.ContainsKey(line.ItemId)) throw new JsonException("Unknown marketplace item reference");
        }
    }

    static bool Count(long value) => value is >= 0 and <= 1_000_000_000;
    static bool Money(long? value) => value is null or (>= -1_000_000_000 and <= 1_000_000_000);

    static MarketplaceRecord Validate(MarketplaceRecord record, string id)
    {
        if (record is null || record.Id != id || record.Categories.Any(c => c is null) || record.Badges.Any(b => b is null)
            || record.Tags.Any(t => t is null) || record.Images.Any(i => i is null)
            || record.Fields.Any(f => f is null) || record.Listings.Any(l => l is null)
            || record.Offers.Any(o => o is null) || record.Contents.Any(l => l is null) || record.IncludedIn.Any(l => l is null))
            throw new JsonException("Invalid marketplace record");
        if (record.Summary is { } summary && (!Money(summary.LowestMinor) || !Count(summary.Count) || !Count(summary.Quantity)))
            throw new JsonException("Invalid marketplace summary");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var listing in record.Listings)
            if (!ids.Add(listing.Id) || listing.RatingHundredths is < 0 or > 500
                || !Count(listing.Reviews) || !Count(listing.Quantity) || !Money(listing.PriceMinor))
                throw new JsonException("Invalid marketplace listing");
        ids.Clear();
        foreach (var offer in record.Offers)
            if (!ids.Add(offer.Id) || !Count(offer.Quantity) || !Money(offer.PriceMinor))
                throw new JsonException("Invalid marketplace offer");
        foreach (var lines in new[] { record.Contents, record.IncludedIn })
        {
            ids.Clear();
            foreach (var line in lines)
                if (!ids.Add(line.Id) || !Count(line.Quantity)) throw new JsonException("Invalid marketplace line");
        }
        return record;
    }

    public async Task<MarketplaceRecord?> Get(string id, CancellationToken cancel)
    {
        if (fixture is not null) return fixture.GetValueOrDefault(id);
        using var response = await http.GetAsync($"/marketplace/records/{Uri.EscapeDataString(id)}", cancel);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return Validate(await response.Content.ReadFromJsonAsync(RecordJson.Default.MarketplaceRecord, cancel)
            ?? throw new JsonException("Missing marketplace record"), id);
    }
}
