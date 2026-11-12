using System.Net.Http.Json;
using System.Text.Json;

namespace ItemJson;

public sealed record CatalogField(string Name, string Value);
public sealed record CatalogRelated(string Id, string Title);
public sealed record CatalogRecord(string Id, string Title, string Subtitle, string Description,
    string[] Tags, CatalogField[] Fields, CatalogRelated[] Related);

public sealed class CatalogSource
{
    readonly HttpClient http;
    readonly Dictionary<string, CatalogRecord>? fixture;

    public CatalogSource(IHttpClientFactory factory)
    {
        http = factory.CreateClient(nameof(CatalogSource));
        if (Environment.GetEnvironmentVariable("CATALOG_SOURCE") == "fixture")
        {
            using var file = File.OpenRead(Environment.GetEnvironmentVariable("CATALOG_FIXTURE_PATH") ?? "/fixtures/catalog.json");
            fixture = JsonSerializer.Deserialize(file, RecordJson.Default.DictionaryStringCatalogRecord)
                ?? throw new JsonException("Missing catalog fixture");
            foreach (var record in fixture.Values) Validate(record);
        }
    }

    static CatalogRecord Validate(CatalogRecord record)
    {
        if (record is null || record.Tags.Any(t => t is null)
            || record.Fields.Any(f => f is null) || record.Related.Any(r => r is null))
            throw new JsonException("Invalid catalog record");
        return record;
    }

    public async Task<CatalogRecord?> Get(string id, CancellationToken cancel)
    {
        if (fixture is not null) return fixture.GetValueOrDefault(id);
        using var response = await http.GetAsync($"/catalog/records/{Uri.EscapeDataString(id)}", cancel);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return Validate(await response.Content.ReadFromJsonAsync(RecordJson.Default.CatalogRecord, cancel)
            ?? throw new JsonException("Missing catalog record"));
    }
}
