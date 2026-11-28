use super::*;

/// Each `with_cookie` adds one `Set-Cookie`, in order, with the safe flags.
#[tokio::test]
async fn with_cookie_sets_each_cookie_in_order() {
    let routes = Table::new().route(
        "/",
        get(|req: Req| async move {
            Ok::<_, Error>(
                req.redirect::<ForOne>(&Done)?.with_cookie(SetCookie::new("a", "1")).with_cookie(SetCookie::remove("b")),
            )
        }),
    );
    let res = app(routes, None).oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    let cookies: Vec<_> = res.headers().get_all(header::SET_COOKIE).iter().map(|c| c.to_str().unwrap()).collect();
    assert_eq!(cookies, ["a=1; Path=/; SameSite=Lax; HttpOnly; Secure", "b=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure"]);
}

/// Bytes as the app names their type: private by default, and a year in any cache when the URL
/// names the content (`Public::immutable`), cookies or not, unless a caller was read.
#[tokio::test]
async fn media_is_sent_as_its_type_and_kept_only_when_its_url_names_its_content() {
    let png: &'static [u8] = b"\x89PNG\r\n\x1a\n";
    let routes = Table::new()
        .route("/fresh", get(move || async move { crate::Media::new("image/png", png) }))
        .route("/kept", get(move || async move { Public::immutable(crate::Media::new("image/png", png)) }))
        .route("/gone", get(|| async { Public::immutable(Err::<crate::Media, _>(Error::not_found())) }));
    let router = app(routes, None);
    let res = router.clone().oneshot(Request::get("/kept").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    assert_eq!(res.into_body().collect().await.unwrap().to_bytes(), png);
    assert_eq!(cache_control(&router, "/fresh", &[]).await, "private, no-cache");
    assert_eq!(cache_control(&router, "/kept", &[]).await, "public, max-age=31536000, immutable");
    let res =
        router.clone().oneshot(Request::get("/kept").header("cookie", "session=1").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
    assert!(
        res.headers().get(header::VARY).is_none_or(|vary| !vary.to_str().unwrap().contains("cookie")),
        "the URL alone says what it is"
    );
    assert_eq!(cache_control(&router, "/gone", &[]).await, "private, no-cache", "a failure is never kept");
}

/// A download names its file on a private answer, and is compressed as any text is; a public
/// one keeps the name too.
#[tokio::test]
async fn a_download_names_its_file_and_stays_private() {
    let csv = "id,name\n7,Pikachu\n".repeat(200);
    let routes = Table::new()
        .route("/export", get(move || async move { crate::Media::new("text/csv", csv).attachment("Pokémon.csv") }))
        .route(
            "/slip",
            get(move || async move {
                Public::immutable(crate::Media::new("application/pdf", &b"%PDF-1.7"[..]).attachment("x").inline("slip.pdf"))
            }),
        );
    let router = app(routes, None);
    let res = router
        .clone()
        .oneshot(Request::get("/export").header("accept-encoding", "gzip").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        res.headers()[header::CONTENT_DISPOSITION],
        "attachment; filename=\"Pok_mon.csv\"; filename*=UTF-8''Pok%C3%A9mon.csv"
    );
    assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache");
    #[cfg(feature = "compress")]
    assert_eq!(res.headers()[header::CONTENT_ENCODING], "gzip");
    let res = router.oneshot(Request::get("/slip").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.headers()[header::CONTENT_DISPOSITION], "inline; filename=\"slip.pdf\"", "the last one given");
    assert_eq!(res.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
}

/// A streamed download (`Media::stream`) is `Media` in every header, sends its length only when
/// it knows it, is compressed a chunk at a time when its type is text, gets no `ETag`, and a
/// `HEAD` never pulls it (#1001).
#[tokio::test]
async fn a_streamed_download_is_media_sent_as_it_is_made() {
    use futures_util::StreamExt;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let row = |i: usize| format!("{i},Pikachu\n").repeat(100);
    let csv: String = (0..4).map(row).collect();
    let length = csv.len() as u64;
    let pulled = Arc::new(AtomicUsize::new(0));
    let rows = move |pulled: Arc<AtomicUsize>| {
        futures_util::stream::iter(0..4).map(move |i| {
            pulled.fetch_add(1, Ordering::SeqCst);
            Ok::<_, std::io::Error>(crate::http::Bytes::from(row(i)))
        })
    };
    let (export, sized) = (pulled.clone(), pulled.clone());
    let routes = Table::new()
        .route(
            "/export",
            get(move || {
                let pulled = export.clone();
                async move { crate::Media::stream("text/csv", rows(pulled)).attachment("Pokémon.csv") }
            }),
        )
        .route(
            "/sized",
            get(move || {
                let pulled = sized.clone();
                async move { crate::Media::stream_sized("text/csv", length, rows(pulled)) }
            }),
        )
        .route(
            "/empty",
            get(|| async {
                crate::Media::stream("text/csv", futures_util::stream::empty::<Result<crate::http::Bytes, std::io::Error>>())
            }),
        )
        .route(
            "/empty-sized",
            get(|| async {
                crate::Media::stream_sized(
                    "text/csv",
                    0,
                    futures_util::stream::empty::<Result<crate::http::Bytes, std::io::Error>>(),
                )
            }),
        )
        .route(
            "/small",
            get(|| async {
                let rows = futures_util::stream::iter(
                    ["a,1\n", "b,2\n"].map(|row| Ok::<_, std::io::Error>(crate::http::Bytes::from(row))),
                );
                crate::Media::stream_sized("text/csv", 8, rows)
            }),
        )
        .route(
            "/picture",
            get(|| async {
                let png =
                    futures_util::stream::once(async { Ok::<_, std::io::Error>(crate::http::Bytes::from(vec![7u8; 4096])) });
                Public::new(Duration::from_secs(60), crate::Media::stream("image/png", png))
            }),
        );
    let router = app(routes, None);
    let get_with = |path: &str, encoding: Option<&str>| {
        let mut req = Request::get(path);
        if let Some(encoding) = encoding {
            req = req.header("accept-encoding", encoding);
        }
        let router = router.clone();
        let req = req.body(Body::empty()).unwrap();
        async move {
            let (parts, body) = router.oneshot(req).await.unwrap().into_parts();
            (parts.status, parts.headers, body.collect().await.unwrap().to_bytes())
        }
    };

    let (status, headers, body) = get_with("/export", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/csv");
    assert_eq!(headers[header::CONTENT_DISPOSITION], "attachment; filename=\"Pok_mon.csv\"; filename*=UTF-8''Pok%C3%A9mon.csv");
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert!(!headers.contains_key(header::CONTENT_LENGTH) && !headers.contains_key(header::ETAG), "{headers:?}");
    assert_eq!(body, csv.as_bytes());

    let (_, headers, body) = get_with("/sized", None).await;
    assert_eq!(headers[header::CONTENT_LENGTH], length.to_string());
    assert!(!headers.contains_key(header::ETAG));
    assert_eq!(body, csv.as_bytes());

    let (status, _, body) = get_with("/empty", None).await;
    assert_eq!((status, body.len()), (StatusCode::OK, 0));

    // A HEAD gets the headers, the length when it is known, and never pulls the stream.
    pulled.store(0, Ordering::SeqCst);
    let res = router.clone().oneshot(Request::head("/sized").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.headers()[header::CONTENT_LENGTH], length.to_string());
    assert!(res.into_body().collect().await.unwrap().to_bytes().is_empty());
    assert_eq!(pulled.load(Ordering::SeqCst), 0, "a HEAD never pulls the stream");

    let (_, headers, body) = get_with("/picture", Some("zstd")).await;
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60");
    assert!(!headers.contains_key(header::CONTENT_ENCODING), "an image is sent as it is: {headers:?}");
    assert_eq!(body.len(), 4096);

    #[cfg(feature = "compress")]
    {
        use std::io::Read;
        // Decoded by readers that check for the coding's end: a body without zstd's frame end or
        // gzip's trailer is an error, not a short file.
        let decoded = |coding: &str, body: &[u8]| -> std::io::Result<Vec<u8>> {
            let mut out = Vec::new();
            match coding {
                "zstd" => zstd::stream::read::Decoder::new(body)?.read_to_end(&mut out)?,
                _ => flate2::read::GzDecoder::new(body).read_to_end(&mut out)?,
            };
            Ok(out)
        };
        for coding in ["zstd", "gzip"] {
            let accept = if coding == "gzip" { "gzip".to_owned() } else { format!("gzip, {coding}") };
            for path in ["/export", "/sized"] {
                let (_, headers, body) = get_with(path, Some(&accept)).await;
                assert_eq!(headers[header::CONTENT_ENCODING], coding, "{path}");
                assert_eq!(headers[header::VARY], "accept-encoding");
                assert!(!headers.contains_key(header::CONTENT_LENGTH), "the length is the uncompressed one: {path}");
                assert!(body.len() < csv.len() / 10, "{path}: {} of {}", body.len(), csv.len());
                assert_eq!(decoded(coding, &body).unwrap(), csv.as_bytes(), "{coding} {path}");
            }
            // An empty stream is a whole, empty frame; one that says it is empty is sent as it is.
            let (_, headers, body) = get_with("/empty", Some(coding)).await;
            assert_eq!(headers[header::CONTENT_ENCODING], coding);
            assert_eq!(decoded(coding, &body).unwrap(), b"", "{coding}");
            let (_, headers, body) = get_with("/empty-sized", Some(coding)).await;
            assert!(!headers.contains_key(header::CONTENT_ENCODING) && body.is_empty(), "{headers:?}");
            assert_eq!(headers[header::CONTENT_LENGTH], "0");
            // One whose length is too small to be worth compressing keeps it, as a buffered body does.
            let (_, headers, body) = get_with("/small", Some(coding)).await;
            assert!(!headers.contains_key(header::CONTENT_ENCODING), "{headers:?}");
            assert_eq!((headers[header::CONTENT_LENGTH].to_str().unwrap(), &body[..]), ("8", &b"a,1\nb,2\n"[..]));
            assert_eq!(headers[header::VARY], "accept-encoding");
        }
        // A client that takes brotli and gzip, as WebKit asks, gets gzip, where a buffered body
        // would be brotli: the stream's own coding, not the page's.
        for path in ["/export", "/sized"] {
            let (_, headers, body) = get_with(path, Some("gzip, deflate, br")).await;
            assert_eq!(headers[header::CONTENT_ENCODING], "gzip", "{path}");
            assert_eq!(decoded("gzip", &body).unwrap(), csv.as_bytes(), "{path}");
        }
        // A client that takes only brotli gets it as it is, with its length: a stream is never
        // brotli (`compress::StreamCoder`).
        let (_, headers, body) = get_with("/sized", Some("br")).await;
        assert!(!headers.contains_key(header::CONTENT_ENCODING));
        assert_eq!(headers[header::CONTENT_LENGTH], length.to_string());
        assert_eq!(body, csv.as_bytes());
    }
}

/// Over a socket, a body read as it arrives (`pieces_up_to`, #1003): the handler has its first
/// piece before the client has sent the rest, and a client that sends the whole body before it
/// reads, as a browser does, reads the 413 of one over the limit, whether it sent its length or
/// sent it chunked, rather than a closed connection.
#[tokio::test]
async fn a_body_read_as_it_arrives_is_read_before_it_ends_and_refused_where_a_browser_reads_it() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const MAX: usize = 1 << 20;
    let (first, mut got_first) = tokio::sync::mpsc::unbounded_channel::<usize>();
    let routes = Table::new().route(
        "/up",
        crate::router::put(move |request: crate::http::Request| {
            let first = first.clone();
            async move {
                let mut pieces = crate::extract::pieces_up_to(request.into_body(), MAX);
                let mut stored = 0;
                while let Some(piece) = pieces.chunk().await? {
                    if stored == 0 {
                        let _ = first.send(piece.len());
                    }
                    stored += piece.len();
                }
                Ok::<_, Error>(stored.to_string())
            }
        }),
    );
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, App::new(Routes::from(routes)), async {
        let _ = stopped.await;
    }));
    let answer = |mut stream: tokio::net::TcpStream| async move {
        let mut read = Vec::new();
        stream.read_to_end(&mut read).await.expect("the answer, not a reset connection");
        String::from_utf8_lossy(&read).into_owned()
    };

    // Half the body, then the rest only once the handler has a piece of it.
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let head = format!("PUT /up HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\ncontent-length: {MAX}\r\n\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(&vec![7u8; MAX / 2]).await.unwrap();
    let piece = tokio::time::timeout(Duration::from_secs(10), got_first.recv()).await.expect("a piece before the end");
    assert!(piece.is_some_and(|len| len > 0 && len <= MAX / 2));
    stream.write_all(&vec![7u8; MAX / 2]).await.unwrap();
    let got = answer(stream).await;
    assert!(got.starts_with("HTTP/1.1 200") && got.ends_with(&MAX.to_string()), "{got}");

    // Over the limit, with its length (a byte over, and 8 MiB over) and chunked: all of it sent
    // before the answer is read.
    for over in [1, 8 << 20] {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let len = MAX + over;
        let head = format!("PUT /up HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\ncontent-length: {len}\r\n\r\n");
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(&vec![7u8; len]).await.unwrap();
        let got = answer(stream).await;
        assert!(got.starts_with("HTTP/1.1 413"), "{over} over, with its length: {got}");
    }
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"PUT /up HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\ntransfer-encoding: chunked\r\n\r\n")
        .await
        .unwrap();
    let piece = vec![7u8; 64 << 10];
    for _ in 0..(2 * MAX / piece.len()) {
        stream.write_all(format!("{:x}\r\n", piece.len()).as_bytes()).await.unwrap();
        stream.write_all(&piece).await.unwrap();
        stream.write_all(b"\r\n").await.unwrap();
    }
    stream.write_all(b"0\r\n\r\n").await.unwrap();
    let got = answer(stream).await;
    assert!(got.starts_with("HTTP/1.1 413"), "chunked: {got}");

    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// Over a socket, what a handler is told of its request's body, for each way an HTTP/1.1 request
/// says it has none or may have one (#2172). A request with no body (no length, a length of zero,
/// one with `Expect: 100-continue`, one that asks to switch protocols) has ended when the handler
/// has it: its length is zero, reading it gives nothing, a limit of no bytes holds it, and no
/// `100 Continue` is sent for it. One sent chunked has not ended and has no length until it is
/// read, with data, with none, or with trailers alone, which the handler still reads. The body of
/// a request without one holds nothing: hyper's box holds a value of no size, and Corten's own
/// connection gives `Body::empty()`. Neither allocates. A request with a body holds its stream.
/// An HTTP/1.0 request with a length, a protocol switch and a `CONNECT` go to hyper.
#[tokio::test]
async fn a_request_without_a_body_has_ended_when_its_handler_has_it_and_a_chunked_one_has_not() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn told(request: Request<Body>) -> String {
        use http_body::Body as _;
        use http_body_util::BodyExt as _;
        let switches = request.extensions().get::<hyper::upgrade::OnUpgrade>().is_some();
        let mut body = request.into_body();
        let (ended, length, whole) = (body.is_end_stream(), body.size_hint().exact(), body.is_whole());
        // A box of a value with no size is not allocated.
        let keeps = if body.boxed_size() == 0 { "nothing" } else { "a stream" };
        let said = format!("ended {ended}, length {length:?}, whole {whole}, {body:?}, keeps {keeps}, switches {switches}");
        let (mut data, mut trailers) = (0, Vec::new());
        while let Some(frame) = body.frame().await {
            match frame.expect("a body that arrived").into_data() {
                Ok(bytes) => data += bytes.len(),
                Err(frame) => trailers.extend(frame.trailers_ref().expect("trailers").keys().map(|name| name.to_string())),
            }
        }
        format!("{said}; read {data} and {trailers:?}")
    }
    // A `2xx` to a `CONNECT` has no body to say it in, so this one is refused.
    async fn refused(request: Request<Body>) -> (StatusCode, String) {
        (StatusCode::FORBIDDEN, told(request).await)
    }
    async fn within_none(request: Request<Body>) -> Result<String, Error> {
        Ok(format!("{:?}", crate::extract::bytes_up_to(request.into_body(), 0).await?.map(|bytes| bytes.len())))
    }
    let routes = Table::new()
        .route("/told", crate::router::any(told))
        .route("/none", crate::router::any(within_none))
        .route("/refused", crate::router::any(refused))
        .route("/text", crate::router::post(|text: String| async move { format!("{text:?}") }));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, App::new(Routes::from(routes)), async {
        let _ = stopped.await;
    }));
    // Everything the server sends for what `sent` asks, until it closes the connection.
    let answer = |sent: String| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(sent.as_bytes()).await.unwrap();
        let mut read = Vec::new();
        stream.read_to_end(&mut read).await.expect("the answer, not a reset connection");
        String::from_utf8_lossy(&read).into_owned()
    };
    let ask = |method: &'static str, path: &'static str, lines: &'static str, body: &'static str| {
        answer(format!("{method} {path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n{lines}\r\n{body}"))
    };

    const HYPER_ENDED: &str = "ended true, length Some(0), whole false, Body(..), keeps nothing, switches false; read 0 and []";
    const OWN_ENDED: &str = "ended true, length Some(0), whole true, Body(empty), keeps nothing, switches false; read 0 and []";
    let own = crate::app::Connections::default().own;
    let ended = |stays_on_own| if own && stays_on_own { OWN_ENDED } else { HYPER_ENDED };
    // Content-Length and Expect hand the connection to hyper, whatever their values.
    for (method, lines, stays_on_own) in [
        ("GET", "", true),
        ("POST", "content-length: 0\r\n", false),
        ("POST", "content-length: 0\r\nexpect: 100-continue\r\n", false),
        ("DELETE", "", true),
    ] {
        let got = ask(method, "/told", lines, "").await;
        assert!(got.starts_with("HTTP/1.1 200") && got.ends_with(ended(stays_on_own)), "{method} with {lines:?}: {got}");
        let got = ask(method, "/none", lines, "").await;
        assert!(got.starts_with("HTTP/1.1 200") && got.ends_with("Some(0)"), "{method} with {lines:?}, no byte allowed: {got}");
    }
    let got = ask("POST", "/text", "content-type: text/plain\r\ncontent-length: 0\r\n", "").await;
    assert!(got.starts_with("HTTP/1.1 200") && got.ends_with("\"\""), "read whole by an extractor: {got}");
    // A request that asks to switch protocols has no body either, and still brings what switches.
    let got =
        answer("GET /told HTTP/1.1\r\nhost: localhost\r\nconnection: close, Upgrade\r\nupgrade: websocket\r\n\r\n".into()).await;
    let switching = HYPER_ENDED.replace("switches false", "switches true");
    assert!(got.starts_with("HTTP/1.1 200") && got.ends_with(&switching), "{got}");
    // So does a `CONNECT`.
    let got = ask("CONNECT", "/refused", "", "").await;
    assert!(got.starts_with("HTTP/1.1 403") && got.ends_with(&switching), "{got}");
    // Without a length or a request to keep the connection, HTTP/1.0 stays on Corten's own.
    let got = answer("GET /told HTTP/1.0\r\nhost: localhost\r\n\r\n".into()).await;
    assert!(got.starts_with("HTTP/1.0 200") && got.ends_with(ended(true)), "{got}");
    // The connection goes on to its next request.
    let got = answer(
        "GET /told HTTP/1.1\r\nhost: localhost\r\n\r\nGET /told HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n".into(),
    )
    .await;
    assert_eq!(got.matches("HTTP/1.1 200").count(), 2, "{got}");
    assert_eq!(got.matches(ended(true)).count(), 2, "{got}");

    // Chunked, the end of the body is in the body: nothing is known of it until it is read.
    const OPEN: &str = "ended false, length None, whole false, Body(..), keeps a stream, switches false; read";
    for (body, read) in [
        ("0\r\n\r\n", "0 and []"),
        ("0\r\nx-sum: 1\r\n\r\n", "0 and [\"x-sum\"]"),
        ("2\r\nhi\r\n0\r\n\r\n", "2 and []"),
        ("2\r\nhi\r\n0\r\nx-sum: 1\r\n\r\n", "2 and [\"x-sum\"]"),
    ] {
        let got = ask("POST", "/told", "transfer-encoding: chunked\r\n", body).await;
        assert!(got.starts_with("HTTP/1.1 200") && got.ends_with(&format!("{OPEN} {read}")), "{body:?}: {got}");
    }
    let got = ask("POST", "/none", "transfer-encoding: chunked\r\n", "0\r\n\r\n").await;
    assert!(got.starts_with("HTTP/1.1 200") && got.ends_with("Some(0)"), "chunked with no data, no byte allowed: {got}");
    // With a length that is not zero, the body is still to come.
    let got = ask("POST", "/told", "content-length: 2\r\n", "hi").await;
    let sized = "ended false, length Some(2), whole false, Body(..), keeps a stream, switches false; read 2 and []";
    assert!(got.starts_with("HTTP/1.1 200") && got.ends_with(sized), "{got}");
    let got = ask("POST", "/told", "content-length: 2\r\nexpect: 100-continue\r\n", "hi").await;
    assert!(got.starts_with("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200") && got.ends_with(sized), "{got}");
    let got = answer("POST /told HTTP/1.0\r\nhost: localhost\r\ncontent-length: 2\r\n\r\nhi".into()).await;
    assert!(got.starts_with("HTTP/1.0 200") && got.ends_with(sized), "{got}");
    // A length on a request that asks to switch protocols is a body to read, like any other.
    let got = ask("POST", "/told", "connection: Upgrade\r\nupgrade: websocket\r\ncontent-length: 2\r\n", "hi").await;
    assert!(got.starts_with("HTTP/1.1 200") && got.ends_with(&sized.replace("switches false", "switches true")), "{got}");

    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// At a route's deadline, over a socket, a request with no body is the server's 503 though its
/// handler read the body, which had ended and so had nothing to wait for; a chunked request whose
/// client sent its head and no more is the client's 408, since its handler waits for the body
/// (#1061, #2172).
#[tokio::test(start_paused = true)]
async fn the_deadline_of_a_request_without_a_body_is_the_servers_and_of_a_chunked_one_not_yet_sent_the_clients() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn reads_then_waits(request: Request<Body>) -> Result<&'static str, Error> {
        crate::extract::bytes_up_to(request.into_body(), 1024).await?;
        tokio::time::sleep(Duration::from_secs(60)).await;
        Ok("late")
    }
    let routes = Table::new().route("/slow", crate::router::any(reads_then_waits));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, App::new(Routes::from(routes)), async {
        let _ = stopped.await;
    }));
    for (method, lines, body, status) in [
        ("GET", "", "", "503"),
        ("POST", "content-length: 0\r\n", "", "503"),
        ("POST", "transfer-encoding: chunked\r\n", "0\r\n\r\n", "503"),
        ("POST", "transfer-encoding: chunked\r\n", "", "408"),
        ("POST", "content-length: 2\r\n", "h", "408"),
    ] {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let sent = format!("{method} /slow HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n{lines}\r\n{body}");
        let began = tokio::time::Instant::now();
        stream.write_all(sent.as_bytes()).await.unwrap();
        let mut read = Vec::new();
        stream.read_to_end(&mut read).await.expect("the answer, then the connection closed, not reset");
        let got = String::from_utf8_lossy(&read);
        assert!(got.starts_with(&format!("HTTP/1.1 {status}")), "{method} with {lines:?} and {body:?}: {got}");
        assert_eq!(began.elapsed(), Duration::from_secs(30), "{method} with {lines:?} and {body:?}: at the default deadline");
    }
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// What a large upload read as it arrives (`pieces_up_to`) costs the server: `UPLOAD_MIB` (1024)
/// over a socket as fast as the client sends, each piece dropped as a store would take it. Prints
/// the time and the process's peak resident memory before and after (`VmHWM`, Linux). In release:
/// `cargo test --release -p corten-run --all-features --lib -- --ignored what_a_large_upload_costs --nocapture`
/// (#1003).
#[tokio::test]
#[ignore]
async fn what_a_large_upload_costs() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mib: usize = std::env::var("UPLOAD_MIB").ok().and_then(|n| n.parse().ok()).unwrap_or(1024);
    let peak = || {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find(|l| l.starts_with("VmHWM:"))
                    .map(|l| l.split_whitespace().nth(1).unwrap_or("0").parse::<u64>().unwrap_or(0) / 1024)
            })
            .unwrap_or(0)
    };
    let routes = Table::new().route(
        "/up",
        crate::router::put(|request: crate::http::Request| async move {
            let mut pieces = crate::extract::pieces_up_to(request.into_body(), usize::MAX);
            let (mut stored, mut largest) = (0usize, 0usize);
            while let Some(piece) = pieces.chunk().await? {
                stored += piece.len();
                largest = largest.max(piece.len());
            }
            Ok::<_, Error>(format!("{stored} {largest}"))
        }),
    );
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(routes)).deadline(None);
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let before = peak();
    let started = std::time::Instant::now();
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let len = mib << 20;
    let head = format!("PUT /up HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\ncontent-length: {len}\r\n\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    let piece = vec![7u8; 256 << 10];
    for _ in 0..len / piece.len() {
        stream.write_all(&piece).await.unwrap();
    }
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    let last = answer.lines().last().unwrap_or_default().to_owned();
    println!(
        "{mib} MiB up in {:?}: stored and largest piece {last}; peak resident {} MiB (before the request {before} MiB)",
        started.elapsed(),
        peak()
    );
    assert!(last.starts_with(&len.to_string()), "{answer}");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// On an app with no deadline, over a socket, a body trickled in a byte every 100 ms, each byte
/// well within the read's idle time (here 500 ms), is answered the 408 once it falls the idle time
/// behind the minimum rate, about half a second in, and the connection is closed after it: the
/// route's deadline is not what bounds it (#1074).
#[tokio::test]
async fn a_body_trickled_in_on_a_route_with_no_deadline_is_a_408() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let routes = Table::new().route(
        "/up",
        crate::router::put(|request: crate::http::Request| async move {
            let mut pieces = crate::extract::pieces_up_to(request.into_body(), usize::MAX).idle(Duration::from_millis(500));
            let mut stored = 0;
            while let Some(piece) = pieces.chunk().await? {
                stored += piece.len();
            }
            Ok::<_, Error>(stored.to_string())
        }),
    );
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(routes)).deadline(None);
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (mut from, mut to) = stream.into_split();
    let started = std::time::Instant::now();
    to.write_all(b"PUT /up HTTP/1.1\r\nhost: localhost\r\ncontent-length: 10000\r\n\r\n").await.unwrap();
    let trickle = tokio::spawn(async move {
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if to.write_all(b"x").await.is_err() {
                break;
            }
        }
    });
    let mut read = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(10), from.read_to_end(&mut read)).await;
    closed.expect("the connection closed after the answer").expect("the answer, not a reset connection");
    let took = started.elapsed();
    let got = String::from_utf8_lossy(&read);
    assert!(got.starts_with("HTTP/1.1 408"), "{got}");
    assert!(took < Duration::from_secs(5), "answered in {took:?}");
    trickle.abort();
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// What a large download costs the server, streamed (`Media::stream`) and held (`Media::new`):
/// `DOWNLOAD_MIB` (512) of generated bytes over a socket, read as fast as the client can. Prints
/// the time to the first body bytes, the time to the last, and the process's peak resident memory
/// after each (`VmHWM`, Linux), so run the streamed one first, each in its own process. In release:
/// `DOWNLOAD=stream cargo test --release -p corten-run --all-features --lib -- --ignored what_a_large_download_costs --nocapture`
/// and again with `DOWNLOAD=held` (#1001).
#[tokio::test]
#[ignore]
async fn what_a_large_download_costs() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mib: usize = std::env::var("DOWNLOAD_MIB").ok().and_then(|n| n.parse().ok()).unwrap_or(512);
    let held = std::env::var("DOWNLOAD").is_ok_and(|kind| kind == "held");
    let peak = || {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find(|l| l.starts_with("VmHWM:"))
                    .map(|l| l.split_whitespace().nth(1).unwrap_or("0").parse::<u64>().unwrap_or(0) / 1024)
            })
            .unwrap_or(0)
    };
    // 64 KiB chunks of CSV-like text, made as they are asked for.
    let chunk = |i: usize| crate::http::Bytes::from(format!("{i:>10},Pikachu,Base Set,Near Mint,1999\n").repeat(64 * 1024 / 46));
    let chunks = mib * 1024 * 1024 / chunk(0).len();
    let routes = Table::new().route(
        "/export",
        get(move || async move {
            if held {
                let mut all = Vec::new();
                for i in 0..chunks {
                    all.extend_from_slice(&chunk(i));
                }
                crate::Media::new("application/octet-stream", all)
            } else {
                crate::Media::stream(
                    "application/octet-stream",
                    futures_util::stream::iter((0..chunks).map(move |i| Ok::<_, std::io::Error>(chunk(i)))),
                )
            }
        }),
    );
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, App::new(Routes::from(routes)), async {
        let _ = stopped.await;
    }));
    let before = peak();
    let started = std::time::Instant::now();
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream.write_all(b"GET /export HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    let (mut got, mut first, mut buf) = (0usize, None, vec![0u8; 256 * 1024]);
    loop {
        let read = stream.read(&mut buf).await.unwrap();
        if read == 0 {
            break;
        }
        got += read;
        // The head is a few hundred bytes; past it, body bytes have arrived.
        if first.is_none() && got > 1024 {
            first = Some(started.elapsed());
        }
    }
    let total = started.elapsed();
    println!(
        "{} {mib} MiB: first body bytes {:?}, all {:?}, {got} bytes; peak resident {} MiB (before the request {before} MiB)",
        if held { "held" } else { "stream" },
        first.unwrap(),
        total,
        peak()
    );
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// Over a socket: the first chunk of a streamed download reaches the client before the rest is
/// made, a client that stops reading stops the stream being pulled, one that leaves drops it,
/// and a stream that fails after it began, or does not keep its length, ends the connection
/// without the body's end (#1001).
#[tokio::test]
async fn a_streamed_download_is_pulled_as_the_client_reads_and_dropped_when_it_leaves() {
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    fn then(error: Option<&'static str>) -> impl futures_util::Stream<Item = Result<crate::http::Bytes, &'static str>> + Send {
        futures_util::stream::unfold(0, move |step| async move {
            match step {
                0 => Some((Ok(crate::http::Bytes::from_static(b"abc")), 1)),
                1 => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    error.map(|error| (Err(error), 2))
                }
                _ => None,
            }
        })
    }
    let go = Arc::new(tokio::sync::Notify::new());
    let made = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicBool::new(false));
    let routes = {
        let (go, made, dropped) = (go.clone(), made.clone(), dropped.clone());
        Table::new()
            // "first", then the rest only once the test says so.
            .route(
                "/paced",
                get(move || {
                    let go = go.clone();
                    async move {
                        let chunks = futures_util::stream::unfold(0, move |step| {
                            let go = go.clone();
                            async move {
                                match step {
                                    0 => Some((Ok::<_, std::io::Error>(crate::http::Bytes::from_static(b"first")), 1)),
                                    1 => {
                                        go.notified().await;
                                        Some((Ok(crate::http::Bytes::from_static(b"rest")), 2))
                                    }
                                    _ => None,
                                }
                            }
                        });
                        crate::Media::stream("application/octet-stream", chunks)
                    }
                }),
            )
            // No end: 64 KiB at a time, counted, with a guard that says when it is dropped.
            .route(
                "/endless",
                get(move || {
                    let (made, guard) = (made.clone(), Dropped(dropped.clone()));
                    async move {
                        let chunk = crate::http::Bytes::from(vec![b'x'; 64 * 1024]);
                        crate::Media::stream(
                            "application/octet-stream",
                            futures_util::stream::repeat_with(move || {
                                let _ = &guard;
                                made.fetch_add(chunk.len() as u64, Ordering::SeqCst);
                                Ok::<_, std::io::Error>(chunk.clone())
                            }),
                        )
                    }
                }),
            )
            // A chunk, then, a moment later (so the chunk is sent), a failure or the stream's end.
            .route(
                "/broken",
                get(|| async { crate::Media::stream("application/octet-stream", then(Some("the store went away"))) }),
            )
            .route("/short", get(|| async { crate::Media::stream_sized("application/octet-stream", 10, then(None)) }))
            .route(
                "/long",
                get(|| async {
                    // The second a moment after the first, so the first is sent.
                    let chunks = futures_util::stream::iter(["abc", "def"]).then(|part| async move {
                        if part == "def" {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        Ok::<_, &str>(crate::http::Bytes::from(part))
                    });
                    crate::Media::stream_sized("application/octet-stream", 5, chunks)
                }),
            )
            // Text, so compressed: a failure after compressed bytes ends it the same way.
            .route("/broken-text", get(|| async { crate::Media::stream("text/csv", then(Some("the store went away"))) }))
    };
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, App::new(Routes::from(routes)), async {
        let _ = stopped.await;
    }));
    let request_with = |path: &'static str, headers: &'static str| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(format!("GET {path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n{headers}\r\n").as_bytes())
            .await
            .unwrap();
        stream
    };
    let request = |path: &'static str| request_with(path, "");
    let read_all = |mut stream: tokio::net::TcpStream| async move {
        let mut answer = Vec::new();
        let _ =
            tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut answer)).await.expect("the server closes it");
        String::from_utf8_lossy(&answer).into_owned()
    };

    // The first chunk arrives while the stream is still waiting to make the rest.
    let mut paced = request("/paced").await;
    let mut seen = Vec::new();
    let mut buf = [0u8; 1024];
    tokio::time::timeout(Duration::from_secs(5), async {
        while !String::from_utf8_lossy(&seen).contains("first") {
            let read = paced.read(&mut buf).await.unwrap();
            assert!(read > 0, "closed before the first chunk");
            seen.extend_from_slice(&buf[..read]);
        }
    })
    .await
    .expect("the first chunk arrives before the rest is made");
    go.notify_one();
    let rest = read_all(paced).await;
    assert!(rest.contains("rest") && rest.ends_with("0\r\n\r\n"), "then the rest and the body's end: {rest}");

    // A client that does not read: the stream is pulled until the buffers fill, then not at all.
    let stalled = request("/endless").await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let filled = made.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(made.load(Ordering::SeqCst), filled, "no more is made while nothing is read");
    assert!(filled < 64 << 20, "only what the buffers hold: {filled} bytes");
    assert!(!dropped.load(Ordering::SeqCst));
    // Gone: the stream is dropped, and with it what made it.
    drop(stalled);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !dropped.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the stream is dropped when its client leaves");

    // After the headers, a failure or a broken length ends the connection without the body's end.
    let broken = read_all(request("/broken").await).await;
    assert!(broken.starts_with("HTTP/1.1 200 ") && broken.contains("abc"), "{broken}");
    assert!(!broken.ends_with("0\r\n\r\n"), "no end of the body: {broken}");
    let short = read_all(request("/short").await).await;
    assert!(short.contains("content-length: 10") && short.ends_with("\r\n\r\nabc"), "{short}");
    // One that makes more than it said sends what fits and ends there.
    let long = read_all(request("/long").await).await;
    assert!(long.contains("content-length: 5") && long.ends_with("\r\n\r\nabc"), "{long}");
    #[cfg(feature = "compress")]
    for (coding, accept) in [("zstd", "accept-encoding: zstd\r\n"), ("gzip", "accept-encoding: gzip\r\n")] {
        use std::io::Read;
        let mut stream = request_with("/broken-text", accept).await;
        let mut raw = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut raw)).await.expect("the server closes it");
        let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("a head") + 4;
        let head = String::from_utf8_lossy(&raw[..head_end]);
        assert!(head.starts_with("HTTP/1.1 200 ") && head.contains(&format!("content-encoding: {coding}")), "{head}");
        assert!(head.contains("transfer-encoding: chunked") && !raw.ends_with(b"0\r\n\r\n"), "no end of the body: {head}");
        // The chunks that arrived hold no coding end either, so a decoder that checks for one
        // sees a cut-off file, not a whole one.
        let (mut body, mut at) = (Vec::new(), head_end);
        while let Some(line) = raw.get(at..).and_then(|rest| rest.windows(2).position(|w| w == b"\r\n")) {
            let size = usize::from_str_radix(std::str::from_utf8(&raw[at..at + line]).unwrap(), 16).unwrap();
            let start = at + line + 2;
            if size == 0 || start + size > raw.len() {
                break;
            }
            body.extend_from_slice(&raw[start..start + size]);
            at = start + size + 2;
        }
        assert!(!body.is_empty(), "{coding}: compressed bytes were sent before the failure");
        let mut out = Vec::new();
        let decoded = match coding {
            "zstd" => zstd::stream::read::Decoder::new(&body[..]).unwrap().read_to_end(&mut out),
            _ => flate2::read::GzDecoder::new(&body[..]).read_to_end(&mut out),
        };
        assert!(decoded.is_err(), "{coding}: a failed stream does not end its coding: {out:?}");
    }

    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// A relayed answer goes through the whole app uncompressed, a page-sized body and an event stream
/// alike, so a long model stream holds no compression context (#205).
#[cfg(feature = "compress")]
#[tokio::test]
async fn a_relay_is_not_compressed_by_the_app() {
    fn upstream(content_type: &'static str, body: Body) -> crate::Relay {
        let mut headers = http::HeaderMap::new();
        headers.insert("content-type", content_type.parse().unwrap());
        crate::Relay::new(StatusCode::OK, headers, body)
    }
    let page = "<p>relayed</p>".repeat(300);
    let events = "event: delta\ndata: {\"text\":\"hello\"}\n\n".repeat(100);
    let (p, e, own) = (page.clone(), events.clone(), page.clone());
    let router = App::new(Routes::from(
        Table::new()
            .route("/own", get(move || async move { ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], own) }))
            .route("/page", get(move || async move { upstream("text/html; charset=utf-8", Body::from(p)) }))
            .route(
                "/stream",
                get(move || async move {
                    let chunk = Ok::<_, std::convert::Infallible>(bytes::Bytes::from(e));
                    upstream("text/event-stream", Body::from_stream(futures_util::stream::iter([chunk])))
                }),
            ),
    ))
    .router();
    for (path, sent) in [("/page", &page), ("/stream", &events)] {
        let req = Request::get(path).header("accept-encoding", "zstd, br, gzip").body(Body::empty()).unwrap();
        let res = router.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{path}");
        assert!(
            !res.headers().contains_key("content-encoding") && !res.headers().contains_key("vary"),
            "{path}: {:?}",
            res.headers()
        );
        let body = crate::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], sent.as_bytes(), "{path}");
    }
    // The same body as the app's own answer is compressed, so the app does compress.
    let req = Request::get("/own").header("accept-encoding", "zstd, br, gzip").body(Body::empty()).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.headers()["content-encoding"], "zstd");
}

#[cfg(feature = "json")]
#[crate::routes]
mod half_url {
    #[route("/half/{status}", get = half)]
    pub struct Half {
        pub status: u16,
    }
}

/// A JSON route that answers `200` itself and passes anything else on, as a route moved off
/// another service a part at a time does.
#[cfg(feature = "json")]
async fn half(crate::Params(at): crate::Params<half_url::Half>) -> Result<crate::JsonResponse, crate::JsonError> {
    if at.status == 200 {
        return Ok(Json(Quote { id: 7, partner: "own" }).into());
    }
    let mut headers = http::HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    headers.insert("content-security-policy", "default-src 'self'".parse().unwrap());
    let body = format!(r#"{{"from":"upstream","pad":"{}"}}"#, "x".repeat(4000));
    let status = StatusCode::from_u16(at.status).unwrap();
    Ok(crate::Relay::new(status, headers, Body::from(body)).into())
}

/// A JSON route that passes some requests on answers the relay as a `JsonResponse`, and it stays
/// the upstream's answer whatever the client accepts: its failure body (never the JSON error or
/// the error page), its CSP, and not compressed; the route's own answer is still the app's (#541).
#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_route_passes_a_relay_on_as_the_upstream_gave_it() {
    let router = App::new(half_url::router()).error_page(test_error_page, ()).router();
    for accept in ACCEPTS {
        for status in [StatusCode::BAD_REQUEST, StatusCode::BAD_GATEWAY] {
            let mut req = Request::get(format!("/half/{}", status.as_u16())).header("accept-encoding", "zstd, br, gzip");
            if let Some(accept) = accept {
                req = req.header("accept", accept);
            }
            let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(res.status(), status, "{accept:?}");
            assert_eq!(res.headers()["content-type"], "application/json", "{accept:?}");
            assert_eq!(res.headers()["content-security-policy"], "default-src 'self'", "{accept:?}");
            assert!(!res.headers().contains_key("content-encoding"), "{accept:?}: {:?}", res.headers());
            let body = crate::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
            assert!(body.starts_with(br#"{"from":"upstream""#), "{accept:?} {status}");
        }
    }
    let (status, _, body) = call_with(router, "GET", "/half/200", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, r#"{"id":7,"partner":"own"}"#));
}

/// A relayed answer is passed on as the upstream gave it: its failure status and body, never the
/// error page or the JSON error, without the hop-by-hop headers.
#[tokio::test]
async fn a_relay_passes_the_upstreams_answer_on() {
    fn upstream(status: StatusCode) -> crate::Relay {
        let mut headers = http::HeaderMap::new();
        headers.insert("content-type", "text/plain".parse().unwrap());
        headers.insert("connection", "keep-alive, x-hop".parse().unwrap());
        headers.insert("x-hop", "1".parse().unwrap());
        headers.insert("keep-alive", "timeout=5".parse().unwrap());
        headers.insert("transfer-encoding", "chunked".parse().unwrap());
        headers.insert("x-upstream", "kept".parse().unwrap());
        crate::Relay::new(status, headers, Body::from("upstream says no"))
    }
    let router = App::new(Routes::from(Table::new().route("/relay", get(|| async { upstream(StatusCode::BAD_REQUEST) }))))
        .error_page(test_error_page, ())
        .api::<ApiRoot>(|api| api.route::<ApiItem>(crate::Methods::reads(get(|| async { upstream(StatusCode::BAD_GATEWAY) }))))
        .router();
    for (path, status, accept) in [
        ("/relay", StatusCode::BAD_REQUEST, Some("text/html")),
        ("/relay", StatusCode::BAD_REQUEST, Some("application/json")),
        ("/api/items/7", StatusCode::BAD_GATEWAY, None),
    ] {
        let (got, headers, body) = call_with(router.clone(), "GET", path, None, accept).await;
        assert_eq!((got, &body[..]), (status, "upstream says no"), "{path} {accept:?}");
        assert_eq!(headers["x-upstream"], "kept");
        for hop in ["connection", "x-hop", "keep-alive", "transfer-encoding"] {
            assert!(!headers.contains_key(hop), "{path}: {hop} is the upstream connection's, not ours");
        }
        assert!(headers.contains_key("x-content-type-options"), "the app's security headers still apply");
    }

    // A relayed page keeps the upstream's own CSP, which its scripts were written for; without one
    // the app's applies.
    let page = |csp: Option<&'static str>| {
        let mut headers = http::HeaderMap::new();
        headers.insert("content-type", "text/html".parse().unwrap());
        if let Some(csp) = csp {
            headers.insert("content-security-policy", csp.parse().unwrap());
        }
        crate::Relay::new(StatusCode::OK, headers, Body::from("<script nonce=upstream></script>"))
    };
    let router = App::new(Routes::from(
        Table::new()
            .route("/own", get(move || async move { page(Some("script-src 'nonce-upstream'")) }))
            .route("/none", get(move || async move { page(None) })),
    ))
    .router();
    let (_, headers, _) = call_with(router.clone(), "GET", "/own", None, Some("text/html")).await;
    assert_eq!(headers["content-security-policy"], "script-src 'nonce-upstream'");
    assert_eq!(headers["x-frame-options"], "DENY", "the app's other headers still apply");
    let (_, headers, _) = call_with(router, "GET", "/none", None, Some("text/html")).await;
    assert!(headers["content-security-policy"].to_str().unwrap().starts_with("default-src 'self'"));

    // An upstream's event stream reaches the client a piece at a time, not when it ends.
    let (send, receive) = tokio::sync::mpsc::channel::<Result<&'static str, std::io::Error>>(1);
    let stream = std::sync::Arc::new(std::sync::Mutex::new(Some(tokio_stream_of(receive))));
    let router = App::new(Routes::from(Table::new().route(
        "/events",
        get(move || {
            let body = Body::from_stream(stream.lock().unwrap().take().unwrap());
            async move {
                let mut headers = http::HeaderMap::new();
                headers.insert("content-type", "text/event-stream".parse().unwrap());
                crate::Relay::new(StatusCode::OK, headers, body)
            }
        }),
    )))
    .router();
    let res = router.oneshot(Request::get("/events").body(Body::empty()).unwrap()).await.unwrap();
    let mut body = res.into_body();
    send.send(Ok("data: one\n\n")).await.unwrap();
    let first = tokio::time::timeout(std::time::Duration::from_secs(2), body.frame()).await;
    let first = first.expect("the first event arrives while the stream is open").unwrap().unwrap();
    assert_eq!(first.into_data().unwrap(), "data: one\n\n");
    drop(send);
}

/// A stream of the pieces `receive` gets, until its sender is dropped.
fn tokio_stream_of<T>(receive: tokio::sync::mpsc::Receiver<T>) -> impl futures_util::Stream<Item = T> {
    futures_util::stream::unfold(receive, |mut receive| async move { receive.recv().await.map(|item| (item, receive)) })
}
