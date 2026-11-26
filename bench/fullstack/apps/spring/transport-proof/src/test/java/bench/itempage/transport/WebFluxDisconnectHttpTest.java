package bench.itempage.transport;

import static java.nio.charset.StandardCharsets.US_ASCII;
import static org.junit.jupiter.api.Assertions.*;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;
import java.net.SocketException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;
import reactor.netty.http.HttpProtocol;
import reactor.netty.http.client.HttpClient;

@Timeout(30)
class WebFluxDisconnectHttpTest {
    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    @Import(TransportController.class)
    static class TestApplication {}

    @RestController
    static class TransportController {
        private final WebClient upstream;
        final CountDownLatch bodyStarted = new CountDownLatch(1);

        TransportController(@Value("${proof.upstream}") String base) {
            var http = HttpClient.create().protocol(HttpProtocol.HTTP11).disableRetry(true).followRedirect(false);
            upstream = WebClient.builder().baseUrl(base).clientConnector(new ReactorClientHttpConnector(http)).build();
        }

        @GetMapping(value = DisconnectSockets.PAGE, produces = MediaType.TEXT_PLAIN_VALUE)
        Mono<String> get(@RequestHeader("traceparent") String trace) {
            return upstream.get().uri(DisconnectSockets.RECORD).header("traceparent", trace)
                    .exchangeToMono(response -> response.bodyToFlux(byte[].class)
                            .doOnNext(bytes -> bodyStarted.countDown())
                            .then(Mono.just("transport complete\n")));
        }
    }

    @Test void abortClosesHeldHeaders() throws Exception { observe(false, true); }

    @Test void abortClosesPartialBody() throws Exception { observe(true, true); }

    @Test void connectedCallerKeepsHeldHeadersPending() throws Exception { observe(false, false); }

    @Test void connectedCallerKeepsPartialBodyPending() throws Exception { observe(true, false); }

    @Test void onlyEofOrPeerResetCountsAsClose() throws Exception {
        try (var eof = new BufferedReader(new StringReader(""))) {
            DisconnectSockets.assertPeerClosed(eof);
        }
        for (String message : new String[] {"Connection reset", "Connection reset by peer"}) {
            try (var reset = failingRead(new SocketException(message))) {
                DisconnectSockets.assertPeerClosed(reset);
            }
        }
        for (String message : new String[] {"Network is unreachable", "Socket is closed", null}) {
            var failure = new SocketException(message);
            try (var read = failingRead(failure)) {
                assertSame(failure, assertThrows(SocketException.class, () -> DisconnectSockets.assertPeerClosed(read)));
            }
        }
    }

    private static BufferedReader failingRead(SocketException failure) {
        return new BufferedReader(new StringReader("")) {
            @Override public int read() throws IOException { throw failure; }
        };
    }

    private void observe(boolean partialBody, boolean abort) throws Exception {
        try (var upstream = new DisconnectSockets();
                var context = new SpringApplicationBuilder(TestApplication.class).web(WebApplicationType.REACTIVE)
                        .run("--server.address=127.0.0.1", "--server.port=0", "--proof.upstream=" + upstream.base());
                var caller = DisconnectSockets.request(((WebServerApplicationContext) context).getWebServer().getPort());
                var exchange = upstream.awaitRecord("{\"proof\":true}".getBytes(US_ASCII))) {
            assertEquals("NettyWebServer", ((WebServerApplicationContext) context).getWebServer().getClass().getSimpleName());
            if (partialBody) {
                exchange.startBody();
                assertTrue(context.getBean(TransportController.class).bodyStarted.await(5, TimeUnit.SECONDS),
                        "WebClient did not receive the incomplete body");
            }
            DisconnectSockets.assertNoResponse(caller);
            if (abort) {
                exchange.assertOpenBeforeAbort();
                long abortNanos = System.nanoTime();
                caller.close();
                exchange.assertClosedSince(abortNanos);
            } else {
                exchange.assertPending();
                DisconnectSockets.assertNoResponse(caller);
                exchange.complete();
                DisconnectSockets.assertOk(caller, "transport complete");
            }
            upstream.assertNoSecondExchange();
        }
    }
}
