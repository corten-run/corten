package bench.itempage;

import static org.junit.jupiter.api.Assertions.*;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
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

class JsonHttpTest {
    private static CatalogSource catalog;
    private static MarketplaceSource marketplace;

    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    @Import({CatalogController.class, MarketplaceController.class, RecordJsonErrors.class})
    static class TestApplication {
        @Bean CatalogSource catalogSource() { return catalog; }
        @Bean MarketplaceSource marketplaceSource() { return marketplace; }
    }

    @Test void nativeJsonForBothPayloadsAndSources() throws Exception {
        var json = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
        var catalogRecord = new CatalogRecord("record_1", "Title", "Subtitle", "Description", List.of(), List.of(), List.of());
        var marketplaceRecord = MarketplaceTest.sample();
        var status = new AtomicInteger(200);
        var malformed = new AtomicReference<String>();
        var requests = new AtomicInteger();
        var upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        upstream.createContext("/", exchange -> {
            requests.incrementAndGet();
            var path = exchange.getRequestURI().getPath();
            boolean missing = path.endsWith("/missing");
            String body = malformed.get() != null ? malformed.get() : json.writeValueAsString(
                    path.startsWith("/catalog/") ? catalogRecord : marketplaceRecord);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(missing ? 404 : status.get(), bytes.length);
            try (var output = exchange.getResponseBody()) { output.write(bytes); }
        });
        var folder = Files.createTempDirectory("spring-json-");
        upstream.start();
        try {
            var catalogFile = folder.resolve("catalog.json");
            var marketplaceFile = folder.resolve("marketplace.json");
            Files.writeString(catalogFile, json.writeValueAsString(Map.of("record_1", catalogRecord)));
            Files.writeString(marketplaceFile, json.writeValueAsString(Map.of("item_1", marketplaceRecord)));
            String api = "http://127.0.0.1:" + upstream.getAddress().getPort();
            for (boolean fixture : List.of(true, false)) {
                catalog = new CatalogSource(json, api, fixture ? catalogFile.toString() : null);
                marketplace = new MarketplaceSource(json, api, fixture ? marketplaceFile.toString() : null);
                try (var context = new SpringApplicationBuilder(TestApplication.class).run("--server.port=0")) {
                    int port = ((WebServerApplicationContext) context).getWebServer().getPort();
                    try (var client = HttpClient.newHttpClient()) {
                        for (String payload : List.of("catalog", "marketplace")) {
                            String id = payload.equals("catalog") ? "record_1" : "item_1";
                            String path = "http://127.0.0.1:" + port + "/api/" + payload + "/";
                            int before = requests.get();
                            var success = send(client, path + id, "GET");
                            assertEquals(200, success.statusCode());
                            assertTrue(success.headers().firstValue("Content-Type").orElse("").startsWith("application/json"));
                            assertEquals(json.readTree(json.writeValueAsString(payload.equals("catalog") ? catalogRecord : marketplaceRecord)), json.readTree(success.body()));
                            assertEquals(before + (fixture ? 0 : 1), requests.get());
                            var head = send(client, path + id, "HEAD");
                            assertEquals(200, head.statusCode());
                            assertEquals("", head.body());
                            problem(json, send(client, path + "missing", "GET"), 404);
                            headProblem(send(client, path + "missing", "HEAD"), 404);
                            for (String verb : List.of("POST", "PUT", "PATCH", "DELETE")) {
                                var method = send(client, path + id, verb);
                                problem(json, method, 405);
                                assertEquals("GET", method.headers().firstValue("Allow").orElse(""));
                            }
                            var options = send(client, path + id, "OPTIONS");
                            assertEquals(200, options.statusCode());
                            assertTrue(options.headers().firstValue("Allow").orElse("").contains("HEAD"));
                            var htmlAccept = client.send(HttpRequest.newBuilder(URI.create(path + "missing"))
                                    .timeout(Duration.ofSeconds(10)).header("Accept", "text/html").build(), HttpResponse.BodyHandlers.ofString());
                            problem(json, htmlAccept, 404);
                            var aliases = List.of(
                                    "http://127.0.0.1:" + port + "/api/" + (payload.equals("catalog") ? "%63atalog" : "%6Darketplace") + "/",
                                    "http://127.0.0.1:" + port + "/api/" + payload + ";test=x/",
                                    "http://127.0.0.1:" + port + "/%61pi/" + payload + "/",
                                    "http://127.0.0.1:" + port + "/api;test=x/" + payload + "/");
                            for (String alias : aliases) {
                                int aliasReads = requests.get();
                                var aliased = send(client, alias + id, "GET", "application/json");
                                assertEquals(200, aliased.statusCode());
                                assertEquals(json.readTree(success.body()), json.readTree(aliased.body()));
                                var aliasHead = send(client, alias + id, "HEAD", "application/json");
                                assertEquals(200, aliasHead.statusCode());
                                assertTrue(aliasHead.headers().firstValue("Content-Type").orElse("").startsWith("application/json"));
                                assertEquals("", aliasHead.body());
                                assertEquals(aliasReads + (fixture ? 0 : 2), requests.get());
                                problem(json, send(client, alias + "missing", "GET", "text/html"), 404);
                                headProblem(send(client, alias + "missing", "HEAD", "text/html"), 404);
                                int methodReads = requests.get();
                                for (String verb : List.of("POST", "PUT", "PATCH", "DELETE")) {
                                    var method = send(client, alias + id, verb, "text/html");
                                    problem(json, method, 405);
                                    assertEquals("GET", method.headers().firstValue("Allow").orElse(""));
                                }
                                assertEquals(methodReads, requests.get());
                            }
                            if (!fixture) {
                                status.set(503);
                                problem(json, send(client, path + id, "GET"), 500);
                                headProblem(send(client, path + id, "HEAD"), 500);
                                for (String alias : aliases) {
                                    problem(json, send(client, alias + id, "GET", "text/html"), 500);
                                    headProblem(send(client, alias + id, "HEAD", "text/html"), 500);
                                }
                                status.set(200);
                                for (String invalid : List.of("secret upstream malformed JSON", "null")) {
                                    malformed.set(invalid);
                                    var error = send(client, path + id, "GET");
                                    problem(json, error, 500);
                                    assertFalse(error.body().contains("secret upstream"));
                                    headProblem(send(client, path + id, "HEAD"), 500);
                                    for (String alias : aliases) {
                                        var aliasError = send(client, alias + id, "GET", "text/html");
                                        problem(json, aliasError, 500);
                                        assertFalse(aliasError.body().contains("secret upstream"));
                                        headProblem(send(client, alias + id, "HEAD", "text/html"), 500);
                                    }
                                }
                                malformed.set(null);
                                assertEquals(200, send(client, path + id, "GET").statusCode());
                            }
                        }
                        var page = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/marketplace/fr-FR/missing"))
                                .timeout(Duration.ofSeconds(10)).header("Accept", "text/html").build(), HttpResponse.BodyHandlers.ofString());
                        assertEquals(404, page.statusCode());
                        assertTrue(page.headers().firstValue("Content-Type").orElse("").startsWith("text/html"));
                        for (String alias : List.of("/%63atalog/missing", "/catalog;test=x/missing",
                                "/%6Darketplace/fr-FR/missing", "/marketplace;test=x/fr-FR/missing",
                                "/api/catalog-other/missing", "/api/marketplace-other/missing")) {
                            var nonJson = send(client, "http://127.0.0.1:" + port + alias, "GET", "text/html");
                            assertEquals(404, nonJson.statusCode());
                            assertTrue(nonJson.headers().firstValue("Content-Type").orElse("").startsWith("text/html"));
                        }
                    }
                }
            }
        } finally {
            upstream.stop(0);
            try (var paths = Files.list(folder)) { for (var path : paths.toList()) Files.delete(path); }
            Files.delete(folder);
        }
    }

    private static HttpResponse<String> send(HttpClient client, String url, String method) throws Exception {
        return send(client, url, method, "*/*");
    }

    private static HttpResponse<String> send(HttpClient client, String url, String method, String accept) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(10))
                .header("Accept", accept)
                .method(method, HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
    }

    private static void problem(JsonMapper json, HttpResponse<String> response, int status) {
        assertEquals(status, response.statusCode());
        assertEquals("application/problem+json", response.headers().firstValue("Content-Type").orElse(""));
        var body = json.readTree(response.body());
        assertEquals(status, body.get("status").intValue());
        assertTrue(body.get("title").isString());
        assertFalse(response.body().contains("stackTrace"));
    }

    private static void headProblem(HttpResponse<String> response, int status) {
        assertEquals(status, response.statusCode());
        assertEquals("application/problem+json", response.headers().firstValue("Content-Type").orElse(""));
        assertEquals("", response.body());
    }
}
