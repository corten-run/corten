using System.Net;
using System.Text.Json;
using AngleSharp.Html.Parser;
using ItemPage;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

public sealed class MarketplaceTests
{
    static string Spaces(string value) => value.Replace('\u00a0', ' ').Replace('\u202f', ' ');
    [Fact]
    public void NativeFormattingAndPluralRules()
    {
        var en = new MarketplaceFormat("en-US");
        var fr = new MarketplaceFormat("fr-FR");
        var de = new MarketplaceFormat("de-DE");
        Assert.Equal("-$1,234.50", en.Money(-123450));
        Assert.Equal("1 234,50 $US", Spaces(fr.Money(123450)));
        Assert.DoesNotContain(" ", fr.Money(123450));
        Assert.DoesNotContain(" ", de.Money(123450));
        Assert.Equal("1.234,50 $", Spaces(de.Money(123450)));
        Assert.Equal("0 annonce", fr.Listings(0));
        Assert.Equal("1 000 000 d’annonces", Spaces(fr.Listings(1000000)));
        foreach (var f in new[] { en, fr, de })
        {
            Assert.Equal("5", f.Rating(499));
            Assert.Equal(f == en ? "4.3" : "4,3", f.Rating(425));
            Assert.Equal(f == en ? "4.8" : "4,8", f.Rating(475));
            Assert.Contains(f.Money(123450), f.Alert("a@b", f == en ? "1234.50" : "1234,50", "Title"));
            Assert.Equal(f.Text["invalid_email"], f.Alert("bad", "1", "Title"));
            Assert.Equal(f.Text["invalid_price"], f.Alert("a@b", "0", "Title"));
            Assert.Equal(f.Text["invalid_price"], f.Alert("a@b", "NaN", "Title"));
        }
    }
    static MarketplaceListing Row(string id, string seller, long? price) => new(id, seller, 425, 1000, "NM", "US", 2, price);
    static MarketplaceRecord Sample() => new("item_1", "<script> & Title", null, "Description",
        [new("Cards", "cards")], [], [], ["/one"], [new("Set", "<&>")], new(-123450, 1000000, 1000),
        [Row("a", "Alice", 100), Row("b", "alice", null), Row("c", "Alice", 100), Row("d", " Alice", -100)],
        Enumerable.Range(0, 7).Select(i => new MarketplaceOffer("o" + i, "Buyer", "NM", 1, null)).ToArray(),
        [new("line", "item_2", "Other", 1000)], []);

    [Fact]
    public void StableSortAndUntrimmedCaseSensitivePrefix()
    {
        Assert.Equal(["a", "c"], MarketplaceFormat.Listings(Sample(), "Alice", "desc").Select(r => r.Id));
        Assert.Equal(["a", "c", "d", "b"], MarketplaceFormat.Listings(Sample(), "", "desc").Select(r => r.Id));
        Assert.Equal(["d"], MarketplaceFormat.Listings(Sample(), " ", "asc").Select(r => r.Id));
    }

    [Fact]
    public async Task FixtureLoadsOnceAndKeepsNumericShape()
    {
        var file = Path.GetTempFileName();
        var previousSource = Environment.GetEnvironmentVariable("MARKETPLACE_SOURCE");
        var previousPath = Environment.GetEnvironmentVariable("MARKETPLACE_FIXTURE_PATH");
        try
        {
            await File.WriteAllTextAsync(file, JsonSerializer.Serialize(new Dictionary<string, MarketplaceRecord> { ["item_1"] = Sample() }, MarketplaceSource.Json));
            Environment.SetEnvironmentVariable("MARKETPLACE_SOURCE", "fixture");
            Environment.SetEnvironmentVariable("MARKETPLACE_FIXTURE_PATH", file);
            using var services = new ServiceCollection().AddHttpClient().BuildServiceProvider();
            var source = new MarketplaceSource(services.GetRequiredService<IHttpClientFactory>());
            await File.WriteAllTextAsync(file, "{}");
            Assert.Equal(Sample().Title, (await source.Get("item_1"))!.Title);
            Assert.Equal(JsonSerializer.Serialize(Sample(), MarketplaceSource.Json), JsonSerializer.Serialize(await source.Get("item_1"), MarketplaceSource.Json));
            Assert.Null(await source.Get("missing"));
        }
        finally
        {
            Environment.SetEnvironmentVariable("MARKETPLACE_SOURCE", previousSource);
            Environment.SetEnvironmentVariable("MARKETPLACE_FIXTURE_PATH", previousPath);
            File.Delete(file);
        }
    }

    sealed class Upstream : HttpMessageHandler
    {
        public int Requests;
        public MarketplaceRecord Record = Sample();
        public HttpStatusCode Status = HttpStatusCode.OK;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests++;
            var json = request.RequestUri!.AbsolutePath.StartsWith("/catalog/")
                ? JsonSerializer.Serialize(new CatalogRecord("record_1", "Title", "Subtitle", "Description", [], [], []), new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase })
                : JsonSerializer.Serialize(Record, MarketplaceSource.Json);
            return Task.FromResult(new HttpResponseMessage(Status) { Content = new StringContent(json) });
        }
    }
    sealed class App(Upstream upstream) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.UseContentRoot(Directory.GetCurrentDirectory())
            .ConfigureTestServices(services =>
            {
                services.AddHttpClient(nameof(MarketplaceSource)).ConfigurePrimaryHttpMessageHandler(() => upstream);
                services.AddHttpClient(nameof(CatalogSource)).ConfigurePrimaryHttpMessageHandler(() => upstream);
            });
    }

    [Fact]
    public async Task AcceptedFormsPersistWithIsolatedReadbackAndConcurrentAppends()
    {
        var upstream = new Upstream();
        using var app = new App(upstream);
        using var client = app.CreateClient(new() { AllowAutoRedirect = false, BaseAddress = new Uri("https://localhost") });
        using var other = app.CreateClient(new() { AllowAutoRedirect = false, BaseAddress = new Uri("https://localhost") });
        var parser = new HtmlParser();
        var concurrent = false;
        async Task<JsonElement> Read(HttpClient browser)
        {
            var beforeRead = upstream.Requests;
            using var response = await browser.GetAsync("/api/alerts");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
            Assert.False(response.Headers.Contains("Set-Cookie"));
            // Other concurrent requests can fetch records; no single-threaded read may do so.
            if (!concurrent) Assert.Equal(beforeRead, upstream.Requests);
            return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
        }
        async Task<string> Token(HttpClient browser, string locale)
        {
            var doc = parser.ParseDocument(await browser.GetStringAsync($"/marketplace/{locale}/item_1"));
            return doc.QuerySelector("input[name=__RequestVerificationToken]")!.GetAttribute("value")!;
        }
        Task<HttpResponseMessage> Post(HttpClient browser, string locale, string token, string email, string price, string id = "item_1", string? origin = null, string? site = null)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, $"/marketplace/{locale}/{id}")
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["__RequestVerificationToken"] = token, ["email"] = email, ["target_price"] = price
                })
            };
            if (origin is not null) request.Headers.Add("Origin", origin);
            if (site is not null) request.Headers.Add("Sec-Fetch-Site", site);
            return browser.SendAsync(request);
        }
        Assert.Empty((await Read(client)).EnumerateArray());
        const string chosen = "0000000000000000000000000000000000000000000000000000000000000000";
        client.DefaultRequestHeaders.Add("Cookie", "marketplace-alerts=" + chosen);
        Assert.Empty((await Read(client)).EnumerateArray());
        var invalidKey = await Token(client, "en-US");
        using var invalidFresh = await Post(client, "en-US", invalidKey, "bad", "1");
        Assert.Equal(HttpStatusCode.OK, invalidFresh.StatusCode);
        Assert.DoesNotContain(invalidFresh.Headers.TryGetValues("Set-Cookie", out var cookies) ? cookies : [],
            cookie => cookie.StartsWith("marketplace-alerts="));
        Assert.Empty((await Read(client)).EnumerateArray());
        var expected = new List<object>();
        foreach (var locale in new[] { "en-US", "fr-FR", "de-DE" })
        {
            var token = await Token(client, locale);
            var email = locale + "@example.test";
            using var accepted = await Post(client, locale, token, email, locale == "en-US" ? "1234.50" : "1234,50");
            Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
            if (expected.Count == 0)
            {
                var cookie = Assert.Single(accepted.Headers.GetValues("Set-Cookie"), value => value.StartsWith("marketplace-alerts="));
                Assert.Contains("httponly", cookie.ToLowerInvariant());
                Assert.Contains("secure", cookie.ToLowerInvariant());
                Assert.Contains("samesite=lax", cookie.ToLowerInvariant());
                Assert.DoesNotContain("=" + chosen, cookie);
                client.DefaultRequestHeaders.Remove("Cookie");
            }
            expected.Add(new { item_id = "item_1", email, target_minor = 123450 });
            Assert.Equal(JsonSerializer.Serialize(expected), (await Read(client)).GetRawText());
            foreach (var (badEmail, badPrice) in new[] { ("", ""), ("bad", "1"), (email, "0"), (email, "NaN") })
            {
                using var invalid = await Post(client, locale, token, badEmail, badPrice);
                Assert.Equal(HttpStatusCode.OK, invalid.StatusCode);
                Assert.Equal(JsonSerializer.Serialize(expected), (await Read(client)).GetRawText());
            }
        }
        var key = await Token(client, "en-US");
        using var noToken = await Post(client, "en-US", "", "reject@example.test", "1");
        Assert.Equal(HttpStatusCode.BadRequest, noToken.StatusCode);
        using var crossSite = await Post(client, "en-US", key, "reject@example.test", "1", origin: "https://attacker.test");
        Assert.Equal(HttpStatusCode.Forbidden, crossSite.StatusCode);
        using var fetchSite = await Post(client, "en-US", key, "reject@example.test", "1", site: "cross-site");
        Assert.Equal(HttpStatusCode.Forbidden, fetchSite.StatusCode);
        upstream.Status = HttpStatusCode.NotFound;
        using var missing = await Post(client, "en-US", key, "reject@example.test", "1", "missing");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        upstream.Status = HttpStatusCode.OK;
        Assert.Equal(JsonSerializer.Serialize(expected), (await Read(client)).GetRawText());
        Assert.Empty((await Read(other)).EnumerateArray());
        var otherKey = await Token(other, "en-US");
        using var otherPost = await Post(other, "en-US", otherKey, "other@example.test", "2");
        Assert.Equal(HttpStatusCode.OK, otherPost.StatusCode);
        Assert.Equal(1, (await Read(other)).GetArrayLength());
        var emails = Enumerable.Range(0, 24).Select(i => $"concurrent-{i}@example.test").ToArray();
        concurrent = true;
        await Task.WhenAll(emails.Select(async email =>
        {
            using var response = await Post(client, "en-US", key, email, "3.25");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var snapshot = (await Read(client)).EnumerateArray().ToArray();
            Assert.Equal(snapshot.Length, snapshot.Select(row => row.GetProperty("email").GetString()).Distinct().Count());
            Assert.All(snapshot.Skip(expected.Count), row => Assert.Equal(325, row.GetProperty("target_minor").GetInt64()));
        }));
        concurrent = false;
        var rows = await Read(client);
        Assert.Equal(expected.Count + emails.Length, rows.GetArrayLength());
        Assert.Equal(emails.Order(), rows.EnumerateArray().Skip(expected.Count).Select(row => row.GetProperty("email").GetString()).Order());
        Assert.Equal(rows.GetRawText(), (await Read(client)).GetRawText());
        for (var count = 1; count <= 2; count++)
        {
            using var repeated = await Post(client, "en-US", key, "repeat@example.test", "4");
            Assert.Equal(HttpStatusCode.OK, repeated.StatusCode);
            var after = await Read(client);
            Assert.Equal(rows.GetArrayLength() + count, after.GetArrayLength());
            Assert.Equal("repeat@example.test", after.EnumerateArray().Last().GetProperty("email").GetString());
            Assert.Equal(400, after.EnumerateArray().Last().GetProperty("target_minor").GetInt64());
        }
        using var largest = await Post(client, "en-US", key, "large@example.test", decimal.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Assert.Equal(HttpStatusCode.OK, largest.StatusCode);
        var largestRow = (await Read(client)).EnumerateArray().Last();
        Assert.Equal("large@example.test", largestRow.GetProperty("email").GetString());
        Assert.Equal("7922816251426433759354395033500", largestRow.GetProperty("target_minor").GetRawText());
        Assert.Equal(1, (await Read(other)).GetArrayLength());
    }

    [Theory]
    [InlineData("/api/catalog/record_1")]
    [InlineData("/api/marketplace/item_1")]
    public async Task JsonErrorsAndHeadDoNotDependOnMatchedProfile(string path)
    {
        var upstream = new Upstream();
        using var app = new App(upstream);
        using var client = app.CreateClient(new() { AllowAutoRedirect = false });
        using var head = await client.SendAsync(new HttpRequestMessage(HttpMethod.Head, path));
        Assert.Equal(HttpStatusCode.OK, head.StatusCode);
        Assert.Equal("application/json", head.Content.Headers.ContentType?.MediaType);
        using var wrongMethod = await client.PostAsync(path, new StringContent(""));
        Assert.Equal(HttpStatusCode.MethodNotAllowed, wrongMethod.StatusCode);
        Assert.Contains("HEAD", wrongMethod.Content.Headers.Allow);
        Assert.Equal("application/problem+json", wrongMethod.Content.Headers.ContentType?.MediaType);
        Assert.Equal(405, JsonDocument.Parse(await wrongMethod.Content.ReadAsStringAsync()).RootElement.GetProperty("status").GetInt32());
        upstream.Status = HttpStatusCode.NotFound;
        using var missing = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("application/problem+json", missing.Content.Headers.ContentType?.MediaType);
        Assert.Equal(404, JsonDocument.Parse(await missing.Content.ReadAsStringAsync()).RootElement.GetProperty("status").GetInt32());
        upstream.Status = HttpStatusCode.ServiceUnavailable;
        using var failed = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.InternalServerError, failed.StatusCode);
        Assert.Equal("application/problem+json", failed.Content.Headers.ContentType?.MediaType);
        Assert.Equal(500, JsonDocument.Parse(await failed.Content.ReadAsStringAsync()).RootElement.GetProperty("status").GetInt32());
    }

    [Theory]
    [InlineData("/api/catalog/missing", "application/json", "application/problem+json")]
    [InlineData("/api/catalog/missing", "application/problem+json", "application/problem+json")]
    [InlineData("/api/catalog/missing", "text/html", "text/plain")]
    [InlineData("/api/marketplace/missing", "application/json", "application/problem+json")]
    [InlineData("/api/marketplace/missing", "application/problem+json", "application/problem+json")]
    [InlineData("/api/marketplace/missing", "text/html", "text/plain")]
    public async Task JsonErrorsRetainNativeContentNegotiation(string path, string accept, string mediaType)
    {
        using var app = new App(new Upstream { Status = HttpStatusCode.NotFound });
        using var client = app.CreateClient(new() { AllowAutoRedirect = false });
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Accept.ParseAdd(accept);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(mediaType, response.Content.Headers.ContentType?.MediaType);
        if (mediaType == "application/problem+json")
            Assert.Equal(404, JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("status").GetInt32());
    }

    [Fact]
    public async Task NativeRazorFormsJsonAndUncachedSource()
    {
        var upstream = new Upstream();
        using var app = new App(upstream);
        using var client = app.CreateClient(new() { AllowAutoRedirect = false });
        var parser = new HtmlParser();
        var html = await client.GetStringAsync("/marketplace/fr-FR/item_1");
        var doc = parser.ParseDocument(html);
        Assert.Equal("fr-FR", doc.DocumentElement.GetAttribute("lang"));
        Assert.Equal("<script> & Title", doc.QuerySelector("article h1")!.TextContent);
        Assert.Equal(5, doc.QuerySelectorAll("[data-offer-id]").Length);
        Assert.Equal("1 000 000 d’annonces", Spaces(doc.QuerySelectorAll(".marketplace__summary > span")[1].TextContent));
        Assert.NotNull(doc.QuerySelector(".marketplace__more"));
        Assert.Equal(1, upstream.Requests);
        var form = doc.QuerySelector(".marketplace__alert form")!;
        var token = form.QuerySelector("input[name=__RequestVerificationToken]")!.GetAttribute("value")!;
        using var response = await client.PostAsync(form.GetAttribute("action"), new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["__RequestVerificationToken"] = token, ["email"] = "a@b", ["target_price"] = "1234,50"
        }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var post = parser.ParseDocument(await response.Content.ReadAsStringAsync());
        Assert.Contains("1 234,50 $US", Spaces(post.QuerySelector(".marketplace__message")!.TextContent));
        Assert.Equal(2, upstream.Requests);
        using var rejected = await client.PostAsync("/marketplace/fr-FR/item_1", new FormUrlEncodedContent(new Dictionary<string, string>()));
        Assert.Equal(HttpStatusCode.BadRequest, rejected.StatusCode);
        upstream.Record = Sample() with { Title = "Fresh title" };
        var json = await client.GetStringAsync("/api/marketplace/item_1");
        Assert.Equal("Fresh title", JsonDocument.Parse(json).RootElement.GetProperty("title").GetString());
        Assert.Contains("\"price_minor\":null", json);
        Assert.Contains("\"lowest_minor\":-123450", json);
        Assert.Equal(3, upstream.Requests);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/marketplace/es-ES/item_1")).StatusCode);
        upstream.Status = HttpStatusCode.NotFound;
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/marketplace/en-US/missing")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/marketplace/missing")).StatusCode);
        upstream.Status = HttpStatusCode.ServiceUnavailable;
        Assert.Equal(HttpStatusCode.InternalServerError, (await client.GetAsync("/api/marketplace/item_1")).StatusCode);
    }
}
