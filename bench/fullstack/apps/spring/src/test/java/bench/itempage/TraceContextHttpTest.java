package bench.itempage;

import static org.junit.jupiter.api.Assertions.*;
import com.sun.net.httpserver.HttpServer;
import java.net.CookieManager;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

class TraceContextHttpTest {
    private static final String FIRST = "00-11111111111111111111111111111111-1111111111111111-00";
    private static final String SECOND = "00-22222222222222222222222222222222-2222222222222222-01";
    private static MarketplaceSource source;

    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    @Import(MarketplaceController.class)
    static class TestApplication {
        @Bean MarketplaceSource marketplaceSource() { return source; }
    }

    private static class Delay {
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);

        void waitForRelease() {
            entered.countDown();
            try {
                if (!release.await(10, TimeUnit.SECONDS)) throw new AssertionError("delayed read was not released");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new AssertionError(error);
            }
        }
    }

    private static class DelayedSource extends MarketplaceSource {
        volatile Delay delay;

        DelayedSource(JsonMapper json, String base) { super(json, base, null); }

        private void pause(String traceparent) {
            var captured = delay;
            if (FIRST.equals(traceparent) && captured != null) captured.waitForRelease();
        }

        @Override public MarketplaceRecord get(String id, String traceparent) {
            pause(traceparent);
            return super.get(id, traceparent);
        }

        @Override public MarketplaceRecord getForWrite(String id, String traceparent) {
            pause(traceparent);
            return super.getForWrite(id, traceparent);
        }
    }

    record Observation(String path, String traceparent) {}
    record Route(String path, boolean post) {}

    @Test void nativeRequestsKeepTheirTraceAcrossDelayedFetchesAndBodyReads() throws Exception {
        var json = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
        byte[] body = json.writeValueAsString(MarketplaceTest.sample()).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var observations = new CopyOnWriteArrayList<Observation>();
        var bodyDelay = new java.util.concurrent.atomic.AtomicReference<Delay>();
        var upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var workers = Executors.newCachedThreadPool();
        upstream.setExecutor(workers);
        upstream.createContext("/marketplace/records/", exchange -> {
            String trace = exchange.getRequestHeaders().getFirst("traceparent");
            observations.add(new Observation(exchange.getRequestURI().getRawPath(), trace));
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            var delayed = bodyDelay.get();
            if (FIRST.equals(trace) && delayed != null) delayed.waitForRelease();
            try (var output = exchange.getResponseBody()) { output.write(body); }
        });
        upstream.start();
        var nativeSource = new DelayedSource(json, "http://127.0.0.1:" + upstream.getAddress().getPort());
        source = nativeSource;
        try (var context = new SpringApplicationBuilder(TestApplication.class).run("--server.port=0");
                var client = HttpClient.newBuilder().cookieHandler(new CookieManager()).build()) {
            String base = "http://127.0.0.1:" + ((WebServerApplicationContext) context).getWebServer().getPort();
            assertEquals(200, client.send(request(base, new Route("/marketplace/en-US/item_1", true), null),
                    HttpResponse.BodyHandlers.ofString()).statusCode());
            var routes = new ArrayList<Route>();
            routes.add(new Route("/api/marketplace/item_1", false));
            for (String locale : List.of("en-US", "fr-FR", "de-DE"))
                for (boolean post : List.of(false, true)) routes.add(new Route("/marketplace/" + locale + "/item_1", post));
            for (var route : routes) {
                var delay = new Delay();
                nativeSource.delay = delay;
                int start = observations.size();
                var old = client.sendAsync(request(base, route, FIRST), HttpResponse.BodyHandlers.ofString());
                try {
                    assertTrue(delay.entered.await(5, TimeUnit.SECONDS), route.toString());
                    assertEquals(200, client.send(request(base, route, SECOND), HttpResponse.BodyHandlers.ofString()).statusCode());
                    assertFalse(old.isDone());
                    assertEquals(200, client.send(request(base, route, null), HttpResponse.BodyHandlers.ofString()).statusCode());
                } finally { delay.release.countDown(); }
                assertEquals(200, old.get(10, TimeUnit.SECONDS).statusCode());
                for (String trace : new String[] {"not-a-valid-traceparent", null})
                    assertEquals(200, client.send(request(base, route, trace), HttpResponse.BodyHandlers.ofString()).statusCode());
                assertEquals(java.util.Arrays.asList(SECOND, null, FIRST, "not-a-valid-traceparent", null),
                        observations.subList(start, observations.size()).stream().map(Observation::traceparent).toList());
                assertTrue(observations.stream().allMatch(o -> o.path().equals("/marketplace/records/item_1")));
            }
            nativeSource.delay = null;
            var delayed = new Delay();
            bodyDelay.set(delayed);
            int start = observations.size();
            var route = new Route("/api/marketplace/item_1", false);
            var old = client.sendAsync(request(base, route, FIRST), HttpResponse.BodyHandlers.ofString());
            try {
                assertTrue(delayed.entered.await(5, TimeUnit.SECONDS));
                assertEquals(200, client.send(request(base, route, SECOND), HttpResponse.BodyHandlers.ofString()).statusCode());
                assertFalse(old.isDone());
            } finally { delayed.release.countDown(); }
            assertEquals(200, old.get(10, TimeUnit.SECONDS).statusCode());
            assertEquals(200, client.send(request(base, route, null), HttpResponse.BodyHandlers.ofString()).statusCode());
            assertEquals(java.util.Arrays.asList(FIRST, SECOND, null),
                    observations.subList(start, observations.size()).stream().map(Observation::traceparent).toList());
            var readback = client.send(request(base, new Route("/api/alerts", false), null), HttpResponse.BodyHandlers.ofString());
            var rows = json.readTree(readback.body());
            assertEquals(16, rows.size());
            for (var row : rows) {
                assertEquals("trace@example.test", row.get("email").asString());
                assertEquals(1250, row.get("target_minor").asLong());
            }
        } finally {
            if (nativeSource.delay != null) nativeSource.delay.release.countDown();
            if (bodyDelay.get() != null) bodyDelay.get().release.countDown();
            upstream.stop(0);
            workers.shutdownNow();
            assertTrue(workers.awaitTermination(10, TimeUnit.SECONDS));
        }
    }

    @Test void fixtureModeDoesNotFetchEvenWithTraceContext() throws Exception {
        var json = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
        var fixture = Files.createTempFile("marketplace-trace", ".json");
        try {
            Files.writeString(fixture, json.writeValueAsString(Map.of("item_1", MarketplaceTest.sample())));
            var fixtureSource = new MarketplaceSource(json, "http://127.0.0.1:1", fixture.toString());
            assertEquals(MarketplaceTest.sample(), fixtureSource.get("item_1", FIRST));
            assertEquals(MarketplaceTest.sample(), fixtureSource.getForWrite("item_1", SECOND));
            assertNull(fixtureSource.get("missing", FIRST));
        } finally { Files.delete(fixture); }
    }

    private static HttpRequest request(String base, Route route, String traceparent) {
        var builder = HttpRequest.newBuilder(URI.create(base + route.path())).timeout(Duration.ofSeconds(10));
        if (traceparent != null) builder.header("traceparent", traceparent);
        if (route.post()) {
            String target = route.path().contains("/en-US/") ? "12.50" : "12%2C50";
            builder.header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString("email=trace%40example.test&target_price=" + target));
        }
        return builder.build();
    }
}
