package bench.itempage;

import java.io.File;
import java.util.Map;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

@Component
public class CatalogSource {
    private final ObjectMapper json;
    private final RestClient api;
    private final Map<String, CatalogRecord> fixture;

    public CatalogSource(ObjectMapper json) {
        this.json = json;
        api = RestClient.create(System.getenv().getOrDefault("API_BASE", "http://localhost:8080"));
        fixture = "fixture".equals(System.getenv("CATALOG_SOURCE"))
                ? json.readValue(new File(System.getenv().getOrDefault("CATALOG_FIXTURE_PATH", "/fixtures/catalog.json")),
                        new TypeReference<Map<String, CatalogRecord>>() {})
                : null;
    }

    public CatalogRecord get(String id) {
        if (fixture != null) return fixture.get(id);
        return api.get().uri("/catalog/records/{id}", id).exchange((req, res) -> {
            if (res.getStatusCode().value() == 404) return null;
            if (res.getStatusCode().value() != 200) throw new IllegalStateException("catalog API returned " + res.getStatusCode());
            var record = json.readValue(res.getBody(), CatalogRecord.class);
            if (record == null) throw new IllegalStateException("Missing catalog record");
            return record;
        });
    }
}
