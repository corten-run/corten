use std::net::Ipv6Addr;

use topcoat::{
    context::Cx,
    router::{Body, Layer, LayerFuture, Next, Path, StatusCode, header, request, response::Response},
};

const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

pub struct AllowedHosts(Vec<String>);

impl AllowedHosts {
    pub fn from_env() -> Self {
        match std::env::var("HOSTS") {
            Ok(value) => Self::new(&value),
            Err(std::env::VarError::NotPresent) => Self::new(""),
            Err(std::env::VarError::NotUnicode(_)) => panic!("HOSTS must be valid Unicode"),
        }
    }

    fn new(config: &str) -> Self {
        let hosts = config.split(',').map(str::trim).filter(|host| !host.is_empty());
        Self(
            hosts
                .map(|host| {
                    let ipv6 = host.strip_prefix('[').and_then(|host| host.strip_suffix(']'));
                    assert!(
                        ipv6.is_some_and(|host| host.parse::<Ipv6Addr>().is_ok())
                            || host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'),
                        "HOSTS must contain exact host names without ports"
                    );
                    host.to_owned()
                })
                .collect(),
        )
    }

    fn allows(&self, authority: &str) -> bool {
        let (host, port) = if authority.starts_with('[') {
            let Some(end) = authority.find(']') else { return false };
            authority.split_at(end + 1)
        } else {
            authority.split_at(authority.find(':').unwrap_or(authority.len()))
        };
        let valid_port = port.is_empty()
            || port
                .strip_prefix(':')
                .is_some_and(|p| p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u16>().is_ok_and(|n| n != 0));
        valid_port
            && LOOPBACK.into_iter().chain(self.0.iter().map(String::as_str)).any(|allowed| allowed.eq_ignore_ascii_case(host))
    }
}

impl Layer for AllowedHosts {
    fn path(&self) -> Option<&Path> {
        None
    }

    fn handle<'a>(&'a self, cx: &'a Cx, body: Body, next: Next<'a>) -> LayerFuture<'a> {
        let mut hosts = request::original_headers(cx).get_all(header::HOST).iter();
        let uri = request::uri(cx).authority().map(|value| value.as_str());
        let allowed = match (hosts.next(), hosts.next(), uri) {
            (Some(host), None, uri) => {
                host.to_str().is_ok_and(|host| uri.is_none_or(|uri| uri.eq_ignore_ascii_case(host)) && self.allows(host))
            }
            (None, None, Some(uri)) => self.allows(uri),
            _ => false,
        };
        if allowed {
            next.run(cx, body)
        } else {
            Box::pin(async {
                let mut response = Response::new(Body::empty());
                *response.status_mut() = StatusCode::MISDIRECTED_REQUEST;
                Ok(response)
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use topcoat::router::{Router, request::Request, route};

    #[route(GET "/")]
    async fn probe(cx: &Cx) -> topcoat::Result<&'static str> {
        Ok("ok")
    }

    #[tokio::test]
    async fn host_and_uri_authority_must_not_conflict() {
        let router = Router::builder().route(probe).layer(AllowedHosts::new("fsw-topcoat")).build();
        for (uri, hosts, expected) in [
            ("/", &["[::1]:8080"][..], 200),
            ("/", &["fsw-topcoat:8080"][..], 200),
            ("http://fsw-topcoat:8080/", &[][..], 200),
            ("http://fsw-topcoat:8080/", &["FSW-topcoat:8080"][..], 200),
            ("http://unrecognized.invalid/", &["localhost"][..], 421),
            ("http://localhost:8080/", &["localhost:8081"][..], 421),
            ("/", &["localhost", "localhost"][..], 421),
            ("/", &[][..], 421),
        ] {
            let mut request = Request::get(uri);
            for host in hosts {
                request = request.header(header::HOST, *host);
            }
            assert_eq!(router.handle(request.body(Body::empty()).unwrap()).await.status(), expected, "{uri} {hosts:?}");
        }
    }
}
