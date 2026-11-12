package bench.itempage;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.ErrorResponse;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.util.ServletRequestPathUtils;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;

@RestControllerAdvice
public class RecordJsonErrors {
    private static final PathPattern CATALOG = PathPatternParser.defaultInstance.parse("/api/catalog/**");
    private static final PathPattern MARKETPLACE = PathPatternParser.defaultInstance.parse("/api/marketplace/**");

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ProblemDetail> handle(Exception failure, HttpServletRequest request) throws Exception {
        var path = ServletRequestPathUtils.getParsedRequestPath(request).pathWithinApplication();
        // Use MVC's parsed path, including its decoding and matrix-parameter handling.
        // Method mismatches have no controller handler, so select the JSON patterns here.
        // Rethrowing leaves pages, forms, assets and live routes with their native handling.
        if (!CATALOG.matches(path) && !MARKETPLACE.matches(path)) throw failure;
        var status = failure instanceof ErrorResponse error ? error.getStatusCode() : HttpStatus.INTERNAL_SERVER_ERROR;
        var headers = failure instanceof ErrorResponse error ? error.getHeaders() : HttpHeaders.EMPTY;
        return ResponseEntity.status(status).headers(headers).contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(ProblemDetail.forStatus(status));
    }
}
