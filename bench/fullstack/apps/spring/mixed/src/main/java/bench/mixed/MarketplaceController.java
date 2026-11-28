package bench.mixed;

import bench.itempage.MarketplaceFormat;
import bench.itempage.MarketplaceRecord;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.core.ReactiveAdapterRegistry;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import org.thymeleaf.context.WebContext;
import org.thymeleaf.spring6.SpringWebFluxTemplateEngine;
import org.thymeleaf.spring6.web.webflux.SpringWebFluxWebApplication;
import reactor.core.publisher.Mono;

@RestController
class MarketplaceController {
    private static final String ALERTS = MarketplaceController.class.getName() + ".alerts";
    private static final MediaType HTML = new MediaType("text", "html", StandardCharsets.UTF_8);
    private final MarketplaceSource source;
    private final SpringWebFluxTemplateEngine templates;
    private final SpringWebFluxWebApplication web = SpringWebFluxWebApplication.buildApplication(ReactiveAdapterRegistry.getSharedInstance());

    MarketplaceController(MarketplaceSource source, SpringWebFluxTemplateEngine templates) {
        this.source = source;
        this.templates = templates;
    }

    @RequestMapping(value = "/marketplace/{locale}/{id}", method = { RequestMethod.GET, RequestMethod.POST })
    Mono<ResponseEntity<String>> page(@PathVariable String locale, @PathVariable String id, ServerWebExchange exchange) {
        if (!MarketplaceFormat.supported(locale)) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        var request = exchange.getRequest();
        var headers = request.getHeaders();
        boolean post = HttpMethod.POST.equals(request.getMethod());
        var trace = headers.getFirst("traceparent");
        exchange.getResponse().getHeaders().set(HttpHeaders.CACHE_CONTROL, "private, no-store");
        if (!post) return record(id, false, trace)
                .map(value -> response(render(exchange, locale, value, request.getQueryParams(), "")))
                .onErrorResume(error -> Mono.just(ResponseEntity.status(errorStatus(error)).contentType(HTML)
                        .body("<!doctype html><title>Marketplace request failed</title><h1>Marketplace request failed</h1>")));

        var origins = headers.get(HttpHeaders.ORIGIN);
        if ("cross-site".equals(headers.getFirst("Sec-Fetch-Site")) || origins != null &&
                (origins.size() != 1 || !origins.getFirst().equals(request.getURI().getScheme() + "://" + headers.getFirst(HttpHeaders.HOST))))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        return exchange.getFormData().flatMap(form -> record(id, true, trace).flatMap(value -> {
            value.validateForWrite(id);
            var query = request.getQueryParams();
            var email = parameter(query, form, "email");
            var target = parameter(query, form, "target_price");
            var alert = new MarketplaceFormat(locale).validateAlert(email, target, value.title());
            // Finish rendering before mutating the session, as the MVC route does.
            var response = response(render(exchange, locale, value, query, alert.message()));
            if (alert.targetMinor() == null) return Mono.just(response);
            return exchange.getSession().map(session -> {
                var attrs = session.getAttributes();
                synchronized (attrs) {
                    var next = new ArrayList<>(alerts(attrs));
                    next.add(new Alert(id, email, alert.targetMinor()));
                    attrs.put(ALERTS, List.copyOf(next));
                    session.start();
                }
                return response;
            });
        }));
    }

    @GetMapping("/api/marketplace/{id}")
    Mono<ResponseEntity<?>> json(@PathVariable String id, ServerWebExchange exchange) {
        exchange.getResponse().getHeaders().set(HttpHeaders.CACHE_CONTROL, "private, no-store");
        return record(id, false, exchange.getRequest().getHeaders().getFirst("traceparent"))
                .<ResponseEntity<?>>map(value -> ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(value))
                .onErrorResume(error -> {
                    var status = errorStatus(error);
                    return Mono.just(ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON)
                            .body(ProblemDetail.forStatus(status)));
                });
    }

    @GetMapping("/health/live")
    Map<String, String> live() {
        return Map.of("status", "ok");
    }

    private static HttpStatusCode errorStatus(Throwable error) {
        return error instanceof ResponseStatusException status ? status.getStatusCode() : HttpStatus.INTERNAL_SERVER_ERROR;
    }

    @GetMapping("/api/alerts")
    Mono<ResponseEntity<List<Alert>>> readAlerts(ServerWebExchange exchange) {
        return exchange.getSession().map(session -> ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON)
                .header(HttpHeaders.CACHE_CONTROL, "private, no-store").body(alerts(session.getAttributes())));
    }

    private Mono<MarketplaceRecord> record(String id, boolean write, String trace) {
        return source.get(id, write, trace).switchIfEmpty(Mono.error(new ResponseStatusException(HttpStatus.NOT_FOUND)));
    }

    private String render(ServerWebExchange exchange, String locale, MarketplaceRecord record,
            MultiValueMap<String, String> query, String message) {
        var culture = Locale.forLanguageTag(locale);
        var format = new MarketplaceFormat(locale);
        var seller = query.getFirst("seller");
        if (seller == null) seller = "";
        var sort = "desc".equals(query.getFirst("sort")) ? "desc" : "asc";
        boolean all = "all".equals(query.getFirst("offers"));
        var model = new HashMap<String, Object>();
        model.put("record", record);
        model.put("f", format);
        model.put("t", format.getText());
        model.put("locale", locale);
        model.put("marketplacePage", true);
        model.put("pageTitle", record.title());
        model.put("prefix", seller);
        model.put("sort", sort);
        model.put("allOffers", all);
        model.put("listings", MarketplaceFormat.listings(record, seller, sort));
        model.put("offers", all ? record.offers() : record.offers().subList(0, Math.min(5, record.offers().size())));
        model.put("message", message);
        return templates.process("marketplace", new WebContext(web.buildExchange(exchange, culture, HTML, StandardCharsets.UTF_8), culture, model));
    }

    private static ResponseEntity<String> response(String page) {
        return ResponseEntity.ok().contentType(HTML).body(page);
    }

    private static String parameter(MultiValueMap<String, String> query, MultiValueMap<String, String> form, String name) {
        var value = query.getFirst(name);
        return value != null ? value : form.getFirst(name) != null ? form.getFirst(name) : "";
    }

    @SuppressWarnings("unchecked")
    private static List<Alert> alerts(Map<String, Object> attrs) {
        return (List<Alert>) attrs.getOrDefault(ALERTS, List.of());
    }

    private record Alert(String itemId, String email, long targetMinor) {}
}
