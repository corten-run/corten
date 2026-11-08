using System.Text.Json;

namespace ItemPage;

public sealed record CatalogField(string Name, string Value);
public sealed record CatalogRelated(string Id, string Title);
public sealed record CatalogRecord(string Id, string Title, string Subtitle, string Description,
    string[] Tags, CatalogField[] Fields, CatalogRelated[] Related);

public sealed class CatalogSource
{
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    readonly HttpClient http;
    readonly Dictionary<string, CatalogRecord>? fixture;

    public CatalogSource(IHttpClientFactory factory)
    {
        http = factory.CreateClient(nameof(CatalogSource));
        if (Environment.GetEnvironmentVariable("CATALOG_SOURCE") == "fixture")
        {
            using var file = File.OpenRead(Environment.GetEnvironmentVariable("CATALOG_FIXTURE_PATH") ?? "/fixtures/catalog.json");
            fixture = JsonSerializer.Deserialize<Dictionary<string, CatalogRecord>>(file, Json)
                ?? throw new JsonException("Missing catalog fixture");
            foreach (var record in fixture.Values) Validate(record);
        }
    }

    static CatalogRecord Validate(CatalogRecord record)
    {
        if (record is null || record.Id is null || record.Title is null || record.Subtitle is null || record.Description is null
            || record.Tags is null || record.Fields is null || record.Related is null
            || record.Tags.Any(t => t is null) || record.Fields.Any(f => f is null || f.Name is null || f.Value is null)
            || record.Related.Any(r => r is null || r.Id is null || r.Title is null))
            throw new JsonException("Invalid catalog record");
        return record;
    }

    public async Task<CatalogRecord?> Get(string id)
    {
        if (fixture is not null) return fixture.GetValueOrDefault(id);
        using var res = await http.GetAsync($"/catalog/records/{Uri.EscapeDataString(id)}");
        if (res.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        res.EnsureSuccessStatusCode();
        return Validate(await res.Content.ReadFromJsonAsync<CatalogRecord>(Json) ?? throw new JsonException("Missing catalog record"));
    }
}
