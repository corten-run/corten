package bench.itempage;

import static org.junit.jupiter.api.Assertions.assertEquals;

import bench.itempage.transport.DisconnectSockets;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

@Timeout(30)
class MarketplaceDisconnectHttpTest {
    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    @Import(MarketplaceController.class)
    static class TestApplication {}

    @Test void mvcCallerAbortLeavesUpstreamPending() throws Exception { observe(true); }

    @Test void mvcConnectedCallerWaitsForRelease() throws Exception { observe(false); }

    private void observe(boolean abort) throws Exception {
        var json = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
        byte[] body = json.writeValueAsBytes(MarketplaceTest.sample());
        try (var upstream = new DisconnectSockets();
                var context = new SpringApplicationBuilder(TestApplication.class)
                        .initializers(app -> app.getBeanFactory().registerSingleton("marketplaceSource",
                                new MarketplaceSource(json, upstream.base(), null, "matched")))
                        .run("--server.address=127.0.0.1", "--server.port=0");
                var caller = DisconnectSockets.request(((WebServerApplicationContext) context).getWebServer().getPort());
                var exchange = upstream.awaitRecord(body)) {
            assertEquals("TomcatWebServer", ((WebServerApplicationContext) context).getWebServer().getClass().getSimpleName());
            DisconnectSockets.assertNoResponse(caller);
            if (abort) caller.close();
            exchange.assertPending();
            if (!abort) {
                DisconnectSockets.assertNoResponse(caller);
                exchange.complete();
                DisconnectSockets.assertOk(caller, "lang=\"en-US\"");
            }
            upstream.assertNoSecondExchange();
        }
    }
}
