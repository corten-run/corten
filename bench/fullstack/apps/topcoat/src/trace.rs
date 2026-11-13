use topcoat::{
    context::Cx,
    router::{HeaderMap, HeaderValue, request},
};

/// An owned snapshot of one native HTTP request, never shared client defaults.
#[derive(Clone, Default)]
pub struct TraceContext {
    parent: Option<HeaderValue>,
    state: Option<HeaderValue>,
}

impl TraceContext {
    pub fn from_request(cx: &Cx) -> Self {
        Self::from_headers(request::original_headers(cx))
    }

    fn from_headers(headers: &HeaderMap) -> Self {
        let mut values = headers.get_all("traceparent").iter();
        let parent = values.next().and_then(|value| value.to_str().ok()).and_then(parent);
        let Some(parent) = parent.filter(|_| values.next().is_none()) else { return Self::default() };
        // HTTP list fields may span several lines. Preserve their bytes, including
        // obs-text; HeaderValue::to_str would silently lose an 8-bit tracestate.
        let mut state = Vec::new();
        for value in headers.get_all("tracestate") {
            if !state.is_empty() {
                state.push(b',');
            }
            state.extend_from_slice(value.as_bytes());
        }
        let state = if state.is_empty() || state.iter().any(|b| matches!(b, b'\r' | b'\n')) {
            None
        } else {
            HeaderValue::from_bytes(&state).ok()
        };
        Self { parent: Some(parent), state }
    }

    pub fn apply(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let Some(parent) = &self.parent else { return request };
        let request = request.header("traceparent", parent.clone());
        match &self.state {
            Some(state) => request.header("tracestate", state.clone()),
            None => request,
        }
    }
}

// W3C known fields, matching the other marketplace adapters. Future versions
// retain the known fields as v00, without forwarding unknown extensions.
fn parent(value: &str) -> Option<HeaderValue> {
    let prefix = value.get(..55)?;
    let bytes = prefix.as_bytes();
    if !value.bytes().all(|b| (b'!'..=b'~').contains(&b) && b != b',')
        || &prefix[..2] == "ff"
        || (value.len() > 55 && (&prefix[..2] == "00" || value.as_bytes()[55] != b'-'))
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, b)| if [2, 35, 52].contains(&i) { *b == b'-' } else { b.is_ascii_digit() || (b'a'..=b'f').contains(b) })
        || bytes[3..35].iter().all(|b| *b == b'0')
        || bytes[36..52].iter().all(|b| *b == b'0')
    {
        return None;
    }
    if &prefix[..2] == "00" {
        return HeaderValue::from_str(prefix).ok();
    }
    // W3C 3.2.4: only the sampled bit is known when downgrading a future version.
    let sampled = u8::from_str_radix(&prefix[53..55], 16).ok()? & 1;
    HeaderValue::from_str(&format!("00{}0{sampled}", &prefix[2..53])).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use topcoat::router::{Body, Router, request::Request, route, to_bytes};

    const FIRST: &str = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-00";
    const SECOND: &str = "00-22222222222222222222222222222222-2222222222222222-01";

    #[test]
    fn future_versions_keep_only_the_sampled_flag() {
        for flags in ["80", "81", "fe", "ff"] {
            let sampled = if matches!(flags, "81" | "ff") { "01" } else { "00" };
            let expected = format!("{}{sampled}", &FIRST[..53]);
            assert_eq!(parent(&format!("01{}{flags}-future", &FIRST[2..53])).unwrap(), expected);
            let current = format!("{}{flags}", &FIRST[..53]);
            assert_eq!(parent(&current).unwrap(), current);
        }
    }

    #[test]
    fn validates_parent_and_preserves_http_state_bytes_without_crlf() {
        assert_eq!(parent(FIRST).unwrap(), FIRST);
        assert_eq!(parent(&format!("01{}-future", &FIRST[2..])).unwrap(), FIRST);
        for invalid in [
            String::new(),
            "bad".into(),
            FIRST.to_uppercase(),
            FIRST.replace("00-", "ff-"),
            FIRST.replace("0123456789abcdef0123456789abcdef", &"0".repeat(32)),
            FIRST.replace("-0123456789abcdef-", &format!("-{}-", "0".repeat(16))),
            format!("{FIRST}-extra"),
            FIRST.replace('-', "_"),
            format!("{FIRST}, {FIRST}"),
            "\u{e9}".repeat(30),
            format!("01{}-\r\ninjected", &FIRST[2..]),
        ] {
            assert!(parent(&invalid).is_none(), "{invalid:?}");
        }
        let mut headers = HeaderMap::new();
        headers.insert("tracestate", HeaderValue::from_bytes(b"vendor=\x80\x85\xa0\xe9\xff").unwrap());
        assert!(TraceContext::from_headers(&headers).state.is_none());
        headers.insert("traceparent", FIRST.parse().unwrap());
        headers.append("tracestate", "other=two".parse().unwrap());
        let trace = TraceContext::from_headers(&headers);
        assert_eq!(trace.state.as_ref().unwrap().as_bytes(), b"vendor=\x80\x85\xa0\xe9\xff,other=two");
        let client = reqwest::Client::new();
        headers.insert("traceparent", SECOND.parse().unwrap());
        let outbound = trace.apply(client.get("http://localhost/")).build().unwrap();
        assert_eq!(outbound.headers()["traceparent"], FIRST);
        assert_eq!(outbound.headers()["tracestate"].as_bytes(), b"vendor=\x80\x85\xa0\xe9\xff,other=two");
        assert!(!client.get("http://localhost/").build().unwrap().headers().contains_key("traceparent"));
        headers.append("traceparent", SECOND.parse().unwrap());
        let trace = TraceContext::from_headers(&headers);
        assert!(trace.parent.is_none() && trace.state.is_none());
        assert!(HeaderValue::from_bytes(b"vendor=ok\r\ninjected=yes").is_err());
    }

    struct Gates {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        source: crate::marketplace::source::Source,
    }

    #[route(GET "/trace")]
    async fn delayed(cx: &Cx) -> topcoat::Result<()> {
        let trace = TraceContext::from_request(cx);
        let gates = topcoat::context::request_context::<Arc<Gates>>(cx);
        if trace.parent.as_ref().is_some_and(|value| value == FIRST) {
            gates.entered.notify_one();
            gates.release.notified().await;
        }
        gates.source.get("item_1", &trace).await.map_err(topcoat::Error::msg)?;
        Ok(())
    }

    #[tokio::test]
    async fn native_context_retains_trace_before_delayed_source_send() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            time::Duration,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let thread = std::thread::spawn(move || {
            let mut heads = Vec::new();
            let until = std::time::Instant::now() + Duration::from_secs(20);
            while heads.len() < 4 {
                assert!(std::time::Instant::now() < until, "source requests did not arrive");
                let (mut socket, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    head.push(byte[0]);
                }
                heads.push(head);
                write!(socket, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            }
            heads
        });
        let gates = Arc::new(Gates {
            entered: Default::default(),
            release: Default::default(),
            source: crate::marketplace::source::Source::Api {
                client: reqwest::Client::new(),
                base: format!("http://{address}").parse().unwrap(),
            },
        });
        let router = Arc::new(Router::builder().route(delayed).build());
        let send = |parent: Option<&str>| {
            let mut request = Request::get("/trace");
            if let Some(parent) = parent {
                request = request.header("traceparent", parent).header("tracestate", "vendor=one");
            }
            let router = router.clone();
            let gates = gates.clone();
            async move {
                let response = router.handle_with(request.body(Body::empty()).unwrap(), (gates,)).await;
                assert_eq!(response.status(), 200);
                to_bytes(response.into_body(), usize::MAX).await.unwrap();
            }
        };
        let old = tokio::spawn(send(Some(FIRST)));
        tokio::time::timeout(Duration::from_secs(10), gates.entered.notified()).await.unwrap();
        send(Some(SECOND)).await;
        send(None).await;
        assert!(!old.is_finished());
        gates.release.notify_one();
        old.await.unwrap();
        send(None).await;
        let heads = thread.join().unwrap();
        for (head, expected) in heads.iter().zip([Some(SECOND), None, Some(FIRST), None]) {
            let head = String::from_utf8(head.clone()).unwrap();
            let actual = head.lines().find_map(|line| line.strip_prefix("traceparent: "));
            assert_eq!(actual, expected);
            assert_eq!(head.contains("tracestate: vendor=one"), expected.is_some());
        }
    }
}
