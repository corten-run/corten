package bench.itempage;

import static org.junit.jupiter.api.Assertions.*;
import com.sun.net.httpserver.HttpServer;
import java.net.CookieManager;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

class AlertsHttpTest {
    private static MarketplaceSource source;

    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    @Import(MarketplaceController.class)
    static class TestApplication {
        @Bean MarketplaceSource marketplaceSource() { return source; }
    }

    @Test void failedNativeTemplateRenderDoesNotCommitAnAlert() throws Exception {
        var json = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
        String valid = json.writeValueAsString(MarketplaceTest.sample());
        var current = new AtomicReference<>(valid);
        var upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        upstream.createContext("/marketplace/records/item_1", exchange -> {
            byte[] bytes = current.get().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (var body = exchange.getResponseBody()) { body.write(bytes); }
        });
        upstream.start();
        try {
            source = new MarketplaceSource(json, "http://127.0.0.1:" + upstream.getAddress().getPort(), null);
            try (var context = new SpringApplicationBuilder(TestApplication.class).run("--server.port=0");
                    var client = HttpClient.newBuilder().cookieHandler(new CookieManager()).build()) {
                String base = "http://127.0.0.1:" + ((WebServerApplicationContext) context).getWebServer().getPort();
                assertEquals("[]", send(client, base, false).body());
                assertEquals(200, send(client, base, true).statusCode());
                var before = json.readTree(send(client, base, false).body());
                assertEquals(1, before.size());
                var malformed = json.readTree(valid).deepCopy();
                ((tools.jackson.databind.node.ObjectNode) malformed).set("fields", json.readTree("[null]"));
                ((tools.jackson.databind.node.ObjectNode) malformed).put("title", "large rendered prefix ".repeat(4096));
                current.set(json.writeValueAsString(malformed));
                // A real Thymeleaf render, after the controller returns, fails on field.name.
                var failure = send(client, base, true);
                assertEquals(500, failure.statusCode());
                assertFalse(failure.body().contains("large rendered prefix"));
                assertEquals(before, json.readTree(send(client, base, false).body()));
                try (var fresh = HttpClient.newBuilder().cookieHandler(new CookieManager()).build()) {
                    failure = send(fresh, base, true);
                    assertEquals(500, failure.statusCode());
                    assertTrue(failure.headers().allValues("Set-Cookie").stream().noneMatch(cookie -> cookie.startsWith("JSESSIONID=")));
                    assertEquals("[]", send(fresh, base, false).body());
                }
                current.set(valid);
                assertEquals(200, send(client, base, true).statusCode());
                var after = json.readTree(send(client, base, false).body());
                assertEquals(2, after.size());
                assertEquals(before.get(0), after.get(0));
                assertEquals(before.get(0), after.get(1));
            }
        } finally { upstream.stop(0); }
    }

    private static HttpResponse<String> send(HttpClient client, String base, boolean post) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create(base + (post ? "/marketplace/en-US/item_1" : "/api/alerts")))
                .timeout(Duration.ofSeconds(10));
        if (post) builder.header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString("email=render%40example.test&target_price=12.50"));
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }
}
