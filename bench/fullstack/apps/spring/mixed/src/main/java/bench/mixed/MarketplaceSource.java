package bench.mixed;

import bench.itempage.MarketplaceRecord;
import java.io.File;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.TimeoutException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.util.UriComponentsBuilder;
import reactor.core.publisher.Mono;
import reactor.netty.http.HttpProtocol;
import reactor.netty.http.client.HttpClient;
import reactor.netty.resources.ConnectionProvider;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;
import tools.jackson.databind.cfg.CoercionAction;
import tools.jackson.databind.cfg.CoercionInputShape;
import tools.jackson.databind.type.LogicalType;

@Component
class MarketplaceSource {
    private final ObjectReader readRecord;
    private final ObjectReader writeRecord;
    private final Map<String, MarketplaceRecord> fixture;
    private final WebClient api;
    private final String base;
    private final boolean matched;

    MarketplaceSource(ObjectMapper json, @Value("${API_BASE:http://localhost:8080}") String base,
            @Value("${MARKETPLACE_SOURCE:api}") String source,
            @Value("${MARKETPLACE_FIXTURE_PATH:/fixtures/marketplace.json}") String fixturePath,
            @Value("${PROFILE:}") String profile) {
        this.base = base;
        matched = "matched".equals(profile);
        readRecord = json.readerFor(MarketplaceRecord.class);
        var strict = json.rebuild()
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
        writeRecord = strict.readerFor(MarketplaceRecord.class);
        fixture = "fixture".equals(source) ? strict.readValue(new File(fixturePath),
                new TypeReference<Map<String, MarketplaceRecord>>() {}) : null;
        var pool = ConnectionProvider.builder("marketplace").maxIdleTime(Duration.ofSeconds(4)).build();
        var client = HttpClient.create(pool).protocol(HttpProtocol.HTTP11).disableRetry(true).followRedirect(false);
        api = WebClient.builder().clientConnector(new ReactorClientHttpConnector(client)).build();
    }

    Mono<MarketplaceRecord> get(String id, boolean write, String traceparent) {
        if (fixture != null) return Mono.justOrEmpty(fixture.get(id));
        var uri = UriComponentsBuilder.fromUriString(base).path("/marketplace/records/{id}").encode().buildAndExpand(id).toUri();
        var request = api.get().uri(uri);
        if (traceparent != null) request.header("traceparent", traceparent);
        // Exchange and full body read stay in the caller's subscription. Do not cache,
        // subscribe independently, or retry a request after cancellation.
        var record = request.exchangeToMono(response -> {
            if (response.statusCode().value() == 404) return Mono.empty();
            if (response.statusCode().value() != 200) return Mono.error(new IllegalStateException("upstream status"));
            return response.bodyToMono(byte[].class)
                    .switchIfEmpty(Mono.error(new IllegalStateException("missing marketplace record")))
                    .map(body -> {
                        MarketplaceRecord value = (write ? writeRecord : readRecord).readValue(body);
                        if (value == null) throw new IllegalStateException("missing marketplace record");
                        return value;
                    });
        });
        return matched ? record.timeout(Duration.ofSeconds(10))
                .onErrorMap(TimeoutException.class, e -> new ResponseStatusException(HttpStatus.GATEWAY_TIMEOUT, null, e)) : record;
    }
}
