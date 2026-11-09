package bench.itempage;

import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.firewall.StrictHttpFirewall;
import org.springframework.security.web.header.writers.CrossOriginOpenerPolicyHeaderWriter.CrossOriginOpenerPolicy;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy;

/**
 * The matched tier's production profile (PROFILE=matched; bench/fullstack/README.md, "The matched
 * tier"), from Spring Security's builder: its default headers (nosniff, X-Frame-Options DENY and a
 * Cache-Control that keeps every answer that sets none from shared caches) with axum-maud's CSP,
 * Referrer-Policy, Cross-Origin-Opener-Policy and Permissions-Policy added, its CSRF check on posts
 * (Thymeleaf writes the token into each form), and its firewall's host check (localhost and the
 * deploy's HOSTS, as Corten's). Every request is let through: the app has no sign-in. Without Boot's
 * security starter the filter chain is a plain servlet filter, so it runs for a request's own
 * dispatch, not the error page's: the headers it writes stay on that answer.
 * application-matched.properties has Spring Boot's part.
 */
@Configuration
@Profile("matched")
@EnableWebSecurity
public class Matched {
    @Bean
    SecurityFilterChain security(HttpSecurity http) throws Exception {
        return http
                .authorizeHttpRequests(requests -> requests.anyRequest().permitAll())
                // The token in a cookie, as Django keeps it: the default keeps it in a server session,
                // which would hold one session for every page a load phase reads.
                // /live/publish takes bench/live's publisher's posts, as Django's handler (csrf_exempt) does.
                .csrf(csrf -> csrf.csrfTokenRepository(new CookieCsrfTokenRepository()).ignoringRequestMatchers("/live/publish"))
                .headers(headers -> headers
                        .contentSecurityPolicy(csp -> csp.policyDirectives(
                                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"))
                        .referrerPolicy(referrer -> referrer.policy(ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN))
                        .crossOriginOpenerPolicy(opener -> opener.policy(CrossOriginOpenerPolicy.SAME_ORIGIN))
                        .permissionsPolicyHeader(permissions -> permissions.policy(
                                "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()")))
                .build();
    }

    @Bean
    WebSecurityCustomizer hosts() {
        Set<String> hosts = Stream.concat(Stream.of("localhost", "127.0.0.1", "::1", "[::1]"),
                Arrays.stream(System.getenv().getOrDefault("HOSTS", "").split(",")).map(String::trim).filter(h -> !h.isEmpty()))
                .collect(Collectors.toSet());
        var firewall = new StrictHttpFirewall();
        firewall.setAllowedHostnames(hosts::contains);
        return web -> web.httpFirewall(firewall);
    }
}
