using System.Net.Http.Json;
using System.Text.Json;

namespace ItemJson;

/// <summary>
/// ITEM_SOURCE=fixture: API responses from FIXTURE_PATH, converted once, so the benchmark measures
/// the web server alone. Otherwise every call fetches the item from the item API. The same sources
/// as apps/aspnet, read with the source-generated serializer instead of reflection.
/// </summary>
public sealed class ItemSource(HttpClient http, Dictionary<string, ItemView>? fixture)
{
    public static ItemSource FromEnv(IHttpClientFactory factory)
    {
        var http = factory.CreateClient(nameof(ItemSource));
        if (Environment.GetEnvironmentVariable("ITEM_SOURCE") != "fixture") return new(http, null);
        using var file = File.OpenRead(Environment.GetEnvironmentVariable("FIXTURE_PATH") ?? "fixtures/items.json");
        var items = JsonSerializer.Deserialize(file, ApiJson.Default.DictionaryStringApiItem)!;
        return new(http, items.ToDictionary(kv => kv.Key, kv => ItemView.From(kv.Value)));
    }

    public async Task<ItemView?> Get(string id, CancellationToken cancel)
    {
        if (fixture is not null) return fixture.GetValueOrDefault(id);
        using var res = await http.GetAsync($"/api/discovery/items/{Uri.EscapeDataString(id)}", cancel);
        if (res.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        res.EnsureSuccessStatusCode();
        var api = await res.Content.ReadFromJsonAsync(ApiJson.Default.ApiItem, cancel);
        return ItemView.From(api!);
    }

    /// <summary>Whether items can be read: the fixture always, the item API when it answers at all (any status).</summary>
    public async Task<bool> Reachable(CancellationToken cancel)
    {
        if (fixture is not null) return true;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            using var res = await http.GetAsync("/", timeout.Token);
            return true;
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { return false; }
    }
}
