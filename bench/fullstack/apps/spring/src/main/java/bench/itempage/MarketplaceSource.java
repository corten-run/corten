package bench.itempage;

import java.io.File;
import java.net.URI;
import java.net.http.HttpTimeoutException;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.util.UriComponentsBuilder;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.cfg.CoercionAction;
import tools.jackson.databind.cfg.CoercionInputShape;
import tools.jackson.databind.type.LogicalType;

@Component
public class MarketplaceSource {
    private final ObjectMapper json;
    private final RestClient api;
    private final String base;
    private final Map<String, MarketplaceRecord> fixture;
    private final ObjectMapper writeJson;
    private final ObjectReader writeRecord;
    private final boolean matched;

    @org.springframework.beans.factory.annotation.Autowired
    public MarketplaceSource(ObjectMapper json) {
        this(json, System.getenv().getOrDefault("API_BASE", "http://localhost:8080"),
                "fixture".equals(System.getenv("MARKETPLACE_SOURCE"))
                        ? System.getenv().getOrDefault("MARKETPLACE_FIXTURE_PATH", "/fixtures/marketplace.json") : null,
                System.getenv("PROFILE"));
    }

    MarketplaceSource(ObjectMapper json, String base, String fixturePath) {
        this(json, base, fixturePath, null);
    }

    MarketplaceSource(ObjectMapper json, String base, String fixturePath, String profile) {
        this.json = json;
        matched = "matched".equals(profile);
        writeJson = json.rebuild()
                .enable(DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES,
                        DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES,
                        DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
                .withCoercionConfig(LogicalType.Textual, config -> config
                        .setCoercion(CoercionInputShape.Integer, CoercionAction.Fail)
                        .setCoercion(CoercionInputShape.Float, CoercionAction.Fail)
                        .setCoercion(CoercionInputShape.Boolean, CoercionAction.Fail))
                .build();
        writeRecord = writeJson.readerFor(MarketplaceRecord.class);
        this.base = base;
        var factory = new org.springframework.http.client.JdkClientHttpRequestFactory(
                java.net.http.HttpClient.newBuilder().followRedirects(java.net.http.HttpClient.Redirect.NEVER).build());
        if (matched) factory.setReadTimeout(java.time.Duration.ofSeconds(10));
        api = RestClient.builder().requestFactory(factory).build();
        fixture = fixturePath != null
                ? writeJson.readValue(new File(fixturePath),
                        new TypeReference<Map<String, MarketplaceRecord>>() {}) : null;
    }

    public MarketplaceRecord get(String id) {
        return get(id, null);
    }

    public MarketplaceRecord get(String id, String traceparent) {
        return get(id, false, traceparent);
    }

    public MarketplaceRecord getForWrite(String id) {
        return getForWrite(id, null);
    }

    public MarketplaceRecord getForWrite(String id, String traceparent) {
        return get(id, true, traceparent);
    }

    private MarketplaceRecord get(String id, boolean write, String traceparent) {
        if (fixture != null) return fixture.get(id);
        URI uri = UriComponentsBuilder.fromUriString(base).path("/marketplace/records/{id}").encode().buildAndExpand(id).toUri();
        var read = api.get().uri(uri);
        if (traceparent != null) read.header("traceparent", traceparent);
        try {
            return read.exchange((req, res) -> {
                if (res.getStatusCode().value() == 404) return null;
                if (res.getStatusCode().value() != 200) throw new IllegalStateException("marketplace API returned " + res.getStatusCode());
                MarketplaceRecord record = write ? writeRecord.readValue(res.getBody())
                        : json.readValue(res.getBody(), MarketplaceRecord.class);
                if (record == null) throw new IllegalStateException("Missing marketplace record");
                return record;
            });
        } catch (ResourceAccessException failure) {
            if (matched && failure.getCause() instanceof HttpTimeoutException)
                throw new ResponseStatusException(HttpStatus.GATEWAY_TIMEOUT, null, failure);
            throw failure;
        }
    }
}
