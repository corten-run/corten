use super::api::checked_api;
use super::*;

/// JSON answers with a status or a cookie of their own, in a routes module and under an API.
#[cfg(feature = "json")]
#[crate::routes]
mod own_json_url {
    #[route("/started", post = own_started)]
    pub struct Started;

    #[route("/forecast", get = own_forecast)]
    pub struct Forecast;

    #[route("/session", post = own_session)]
    pub struct Session;

    #[route("/held", get = own_held)]
    pub struct Held;

    #[route("/batches/{request}", post = own_created)]
    pub struct Created {
        pub request: String,
    }

    #[route("/secret/{request}", post = own_secret)]
    pub struct Secret {
        pub request: String,
    }
}

#[cfg(feature = "json")]
#[crate::routes(api = OwnApiRoot)]
mod own_json_api {
    #[route("/v1")]
    pub struct OwnApiRoot;

    #[route("/v1/forecast", get = own_forecast)]
    pub struct ApiForecast;

    #[route("/v1/batches/{request}", post = own_api_created)]
    pub struct ApiCreated {
        pub request: String,
    }
}

#[cfg(feature = "json")]
#[derive(serde::Serialize, crate::ToJson)]
struct OwnStarted {
    ok: bool,
}

#[cfg(feature = "json")]
async fn own_started() -> Result<crate::JsonResponse, JsonError> {
    Ok(crate::Json(OwnStarted { ok: true }).with_status(StatusCode::ACCEPTED))
}

#[cfg(feature = "json")]
async fn own_forecast() -> Result<crate::JsonResponse, JsonError> {
    let problem = crate::json::Raw::new(r#"{"error":"No capacity forecast yet"}"#)?;
    Err(crate::Json(problem).with_status(StatusCode::SERVICE_UNAVAILABLE).into())
}

#[cfg(feature = "json")]
async fn own_session() -> Result<crate::JsonResponse, JsonError> {
    let token = SetCookie::try_new("session", "abc")?;
    Ok(crate::Json(OwnStarted { ok: true }).with_cookie(token).with_cookie(SetCookie::remove("old")))
}

/// A refusal in the app's own shape, taken with `?` from a helper (#584).
#[cfg(feature = "json")]
fn own_batch(request: &str) -> Result<crate::JsonResponse, JsonError> {
    let refused =
        |status, error| crate::json::Raw::new(format!(r#"{{"error":"{error}"}}"#)).map(|e| crate::Json(e).with_status(status));
    if request.trim() == "-" {
        Err(refused(StatusCode::BAD_REQUEST, "requestId is required")?)?;
    }
    if request == "boom" {
        return Err(Error::new("the store is down").into());
    }
    if request == "gone" {
        Err(refused(StatusCode::GONE, "batch is closed")?.with_cookie(SetCookie::remove("batch")))?;
    }
    Ok(crate::Json(OwnStarted { ok: true }).with_status(StatusCode::CREATED))
}

#[cfg(feature = "json")]
async fn own_created(crate::Params(at): crate::Params<own_json_url::Created>) -> Result<crate::JsonResponse, JsonError> {
    own_batch(&at.request)
}

#[cfg(feature = "json")]
async fn own_secret(crate::Params(at): crate::Params<own_json_url::Secret>) -> NoStore<Result<crate::JsonResponse, JsonError>> {
    NoStore(own_batch(&at.request))
}

/// An API's own error shape, which Corten's failures take and the app's refusals do not.
#[cfg(feature = "json")]
#[derive(crate::ToJson)]
struct OwnShape {
    error: String,
}

#[cfg(feature = "json")]
async fn own_api_created(crate::Params(at): crate::Params<own_json_api::ApiCreated>) -> Result<crate::JsonResponse, JsonError> {
    own_batch(&at.request)
}

#[cfg(feature = "json")]
async fn own_held() -> crate::JsonResult<crate::json::Raw> {
    Ok(crate::Json(crate::json::Raw::new(r#"{"rows":[1,2]}"#)?))
}

#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_answer_has_a_status_and_cookies_of_its_own() {
    let router = App::new(own_json_url::router())
        .api(|routes| own_json_api::api(routes).errors(|_, message| OwnShape { error: format!("shaped: {message}") }))
        .router();
    let (status, headers, body) = call_with(router.clone(), "POST", "/started", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::ACCEPTED, r#"{"ok":true}"#));
    assert_eq!(headers["content-type"], "application/json");
    // The app's own 503 reaches the client as written, in a routes module and under an API.
    for uri in ["/forecast", "/v1/forecast"] {
        let (status, headers, body) = call_with(router.clone(), "GET", uri, None, Some("text/html")).await;
        assert_eq!((status, &body[..]), (StatusCode::SERVICE_UNAVAILABLE, r#"{"error":"No capacity forecast yet"}"#), "{uri}");
        assert_eq!(headers["content-type"], "application/json");
    }
    let (status, headers, body) = call_with(router.clone(), "POST", "/session", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, r#"{"ok":true}"#));
    let cookies: Vec<_> = headers.get_all("set-cookie").iter().map(|v| v.to_str().unwrap()).collect();
    assert_eq!(
        cookies,
        ["session=abc; Path=/; SameSite=Lax; HttpOnly; Secure", "old=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure"]
    );
    assert!(headers["cache-control"].to_str().unwrap().contains("private"));
    let (status, _, body) = call_with(router.clone(), "GET", "/held", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, r#"{"rows":[1,2]}"#));
    // A refusal in the app's own shape, `Err(answer)?`, reaches the client as written: not
    // Problem Details, and with what the answer set.
    for prefix in ["", "/v1"] {
        let (status, _, body) = call_with(router.clone(), "POST", &format!("{prefix}/batches/b7"), None, None).await;
        assert_eq!((status, &body[..]), (StatusCode::CREATED, r#"{"ok":true}"#), "{prefix}");
        let (status, headers, body) =
            call_with(router.clone(), "POST", &format!("{prefix}/batches/-"), None, Some("text/html")).await;
        assert_eq!((status, &body[..]), (StatusCode::BAD_REQUEST, r#"{"error":"requestId is required"}"#), "{prefix}");
        assert_eq!(headers["content-type"], "application/json");
        let (status, headers, body) = call_with(router.clone(), "POST", &format!("{prefix}/batches/gone"), None, None).await;
        assert_eq!((status, &body[..]), (StatusCode::GONE, r#"{"error":"batch is closed"}"#), "{prefix}");
        assert_eq!(headers["set-cookie"], "batch=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure");
    }
    // Corten's failure takes the API's shape; the app's refusal beside it does not.
    let (status, _, body) = call_with(router.clone(), "POST", "/v1/batches/boom", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::INTERNAL_SERVER_ERROR, r#"{"error":"shaped: Internal Server Error"}"#));
    let (status, _, body) = call_with(router.clone(), "POST", "/v1/batches/-", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::BAD_REQUEST, r#"{"error":"requestId is required"}"#));
    // NoStore holds for the app's refusal too.
    let (status, headers, body) = call_with(router, "POST", "/secret/-", None, None).await;
    assert_eq!(
        (status, &body[..], headers["cache-control"].to_str().unwrap()),
        (StatusCode::BAD_REQUEST, r#"{"error":"requestId is required"}"#, "private, no-store")
    );
}

#[cfg(feature = "json")]
#[test]
fn a_json_answer_keeps_its_cookies_out_of_debug() {
    let answer = crate::Json(OwnStarted { ok: true }).with_cookie(SetCookie::new("session", "s3cret"));
    let shown = format!("{:?}", JsonError::from(answer.with_status(StatusCode::UNAUTHORIZED)));
    assert!(shown.contains("401") && !shown.contains("s3cret"), "{shown}");
}

#[cfg(feature = "json")]
#[test]
fn a_json_error_stays_under_clippys_large_error_limit() {
    // clippy's `result_large_err` refuses an `Err` of 128 bytes or more by default.
    assert!(std::mem::size_of::<JsonError>() < 128, "{}", std::mem::size_of::<JsonError>());
}

#[cfg(feature = "json")]
#[test]
fn a_json_refusal_is_an_error_status() {
    let accepted = || crate::Json(OwnStarted { ok: true }).with_status(StatusCode::ACCEPTED);
    // A debug build panics; a release build answers a failure, never a 2xx as written.
    let panicked = std::panic::catch_unwind(|| JsonError::refusal(accepted(), true)).unwrap_err();
    assert!(panicked.downcast_ref::<String>().is_some_and(|m| m.contains("refuses with a 4xx or 5xx")));
    assert_eq!(JsonError::refusal(accepted(), false).into_response().status(), StatusCode::INTERNAL_SERVER_ERROR);
    let refused = crate::Json(OwnStarted { ok: false }).with_status(StatusCode::CONFLICT);
    assert_eq!(JsonError::refusal(refused, true).into_response().status(), StatusCode::CONFLICT);
}

#[cfg(feature = "json")]
#[test]
fn a_held_document_is_written_as_it_is_inside_another_value() {
    use crate::json::ToJson;
    #[derive(crate::ToJson)]
    struct Page {
        id: u32,
        rows: crate::json::Raw,
    }
    let doc = crate::json::Raw::new(r#"{"rows":[1,2]}"#).unwrap();
    assert_eq!(vec![doc.clone(), doc.clone()].to_json(), r#"[{"rows":[1,2]},{"rows":[1,2]}]"#);
    assert_eq!(Page { id: 7, rows: doc }.to_json(), r#"{"id":7,"rows":{"rows":[1,2]}}"#);
}

#[cfg(feature = "json")]
#[test]
fn a_held_document_that_is_not_one_json_value_is_an_error() {
    use crate::json::Raw;
    for text in ["{\"rows\": [1,", "", "{} {}", "nul", "\u{feff}{}"] {
        let error = Raw::new(text).unwrap_err();
        assert!(error.to_string().starts_with("not one JSON value: "), "{text:?}: {error}");
    }
    // A string in another encoding (Windows-1252's é) is not JSON, though the parser skips it.
    let error = Raw::new(&b"{\"name\":\"caf\xE9\"}"[..]).unwrap_err();
    assert!(error.to_string().starts_with("not one JSON value: not UTF-8"), "{error}");
    assert_eq!(Raw::new(" [1] ").unwrap().as_bytes(), b" [1] ");
}

#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_handler_question_marks_field_errors_into_a_422_with_the_fields() {
    let router = App::new(Routes::new()).api(checked_api::api).router();
    let (status, _, body) = call_with(router.clone(), "POST", "/checked/2", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "2000"));
    let (status, headers, body) = call_with(router.clone(), "POST", "/checked/0", None, Some("text/html")).await;
    assert_eq!(
        (status, headers["content-type"].to_str().unwrap()),
        (StatusCode::UNPROCESSABLE_ENTITY, "application/problem+json")
    );
    assert_eq!(
        body,
        r#"{"title":"Unprocessable Entity","status":422,"detail":"email: Enter a number above zero.","fields":{"email":"Enter a number above zero."}}"#
    );
    // Any other error is still a 500, whose message a client does not see.
    let (status, _, body) = call_with(router, "POST", "/checked/4294968", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::INTERNAL_SERVER_ERROR, r#"{"title":"Internal Server Error","status":500}"#));
    // An API with its own error shape writes the 500 in it; the fields keep Corten's shape.
    let shaped = App::new(Routes::new())
        .api(|api| {
            checked_api::api(api).errors(|status, message| ShapedError {
                r#type: "error",
                error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
            })
        })
        .router();
    let (_, _, body) = call_with(shaped.clone(), "POST", "/checked/4294968", None, None).await;
    assert_eq!(body, r#"{"type":"error","error":{"code":500,"message":"Internal Server Error"}}"#);
    let (status, _, body) = call_with(shaped, "POST", "/checked/0", None, None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body.ends_with(r#""fields":{"email":"Enter a number above zero."}}"#), "{body}");
}

#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_body_that_does_not_parse_is_a_json_400() {
    let router = App::new(Routes::new())
        .api::<ApiRoot>(|api| {
            api.route::<ApiItems>(crate::Methods::writes(crate::router::post(
                |crate::Json(v): crate::Json<serde_json::Value>| async move { v.to_string() },
            )))
        })
        .router();
    let req = Request::post("/api/items").header("content-type", "application/json").body(Body::from("{nope")).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(
        body.starts_with(r#"{"title":"Bad Request","status":400,"detail":"Failed to parse the request body as JSON"#),
        "{body}"
    );
}
