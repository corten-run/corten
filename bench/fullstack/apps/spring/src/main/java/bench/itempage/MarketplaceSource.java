package bench.itempage;

import java.io.File;
import java.net.URI;
import java.util.Map;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.util.UriComponentsBuilder;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

@Component
public class MarketplaceSource {
    private final ObjectMapper json;
    private final RestClient api;
    private final String base;
    private final Map<String, MarketplaceRecord> fixture;

    @org.springframework.beans.factory.annotation.Autowired
    public MarketplaceSource(ObjectMapper json) {
        this(json, System.getenv().getOrDefault("API_BASE", "http://localhost:8080"),
                "fixture".equals(System.getenv("MARKETPLACE_SOURCE"))
                        ? System.getenv().getOrDefault("MARKETPLACE_FIXTURE_PATH", "/fixtures/marketplace.json") : null);
    }

    MarketplaceSource(ObjectMapper json, String base, String fixturePath) {
        this.json = json;
        this.base = base;
        api = RestClient.builder().requestFactory(new org.springframework.http.client.JdkClientHttpRequestFactory(
                java.net.http.HttpClient.newBuilder().followRedirects(java.net.http.HttpClient.Redirect.NEVER).build())).build();
        fixture = fixturePath != null
                ? json.readValue(new File(fixturePath),
                        new TypeReference<Map<String, MarketplaceRecord>>() {}) : null;
    }

    public MarketplaceRecord get(String id) {
        if (fixture != null) return fixture.get(id);
        URI uri = UriComponentsBuilder.fromUriString(base).path("/marketplace/records/{id}").encode().buildAndExpand(id).toUri();
        return api.get().uri(uri).exchange((req, res) -> {
            if (res.getStatusCode().value() == 404) return null;
            if (res.getStatusCode().value() != 200) throw new IllegalStateException("marketplace API returned " + res.getStatusCode());
            var record = json.readValue(res.getBody(), MarketplaceRecord.class);
            if (record == null) throw new IllegalStateException("Missing marketplace record");
            return record;
        });
    }
}
