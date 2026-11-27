package bench.mixed;

import java.util.Arrays;
import java.util.Locale;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.WebFilter;

@SpringBootApplication
public class MarketplaceApplication {
    public static void main(String[] args) {
        SpringApplication.run(MarketplaceApplication.class, args);
    }

    @Bean
    WebFilter productionHeaders(@Value("${HOSTS:localhost,127.0.0.1}") String hosts) {
        var allowed = Arrays.stream(hosts.split(",")).map(String::strip)
                .map(host -> host.toLowerCase(Locale.ROOT)).collect(Collectors.toUnmodifiableSet());
        return (exchange, chain) -> {
            var request = exchange.getRequest().getHeaders();
            var response = exchange.getResponse();
            try {
                var authorities = request.get(HttpHeaders.HOST);
                var host = request.getHost();
                if (authorities == null || authorities.size() != 1 || host == null ||
                        !allowed.contains(host.getHostString().toLowerCase(Locale.ROOT))) {
                    response.setStatusCode(HttpStatus.BAD_REQUEST);
                    return response.setComplete();
                }
            } catch (IllegalArgumentException invalidHost) {
                response.setStatusCode(HttpStatus.BAD_REQUEST);
                return response.setComplete();
            }
            var headers = response.getHeaders();
            headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; object-src 'none'; "
                    + "base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
            headers.set("X-Content-Type-Options", "nosniff");
            headers.set("Referrer-Policy", "same-origin");
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
            return chain.filter(exchange);
        };
    }
}
