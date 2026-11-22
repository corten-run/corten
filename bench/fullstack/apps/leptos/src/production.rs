use std::{env, net::Ipv6Addr, sync::Arc};

use axum::{
    extract::{Request, State},
    http::{header, uri::Authority, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

#[derive(Clone)]
pub struct Hosts(Arc<[Authority]>);

impl Hosts {
    pub fn configured() -> Self {
        let mut values: Vec<Authority> = match env::var("HOSTS") {
            Ok(configured) => configured.split(',').map(|value| authority(value.trim()).expect("invalid HOSTS entry")).collect(),
            Err(env::VarError::NotPresent) => Vec::new(),
            Err(env::VarError::NotUnicode(_)) => panic!("HOSTS must contain valid HTTP authorities"),
        };
        // An explicit loopback entry replaces that host's implicit any-port entry.
        for local in ["localhost", "127.0.0.1", "[::1]"] {
            if !values.iter().any(|value| same_host(value.host(), local)) {
                values.push(authority(local).unwrap());
            }
        }
        Self(values.into())
    }

    fn allows(&self, requested: &Authority) -> bool {
        self.0.iter().any(|allowed| {
            same_host(allowed.host(), requested.host())
                && allowed.port_u16().is_none_or(|port| Some(port) == requested.port_u16())
        })
    }
}

fn ipv6_host(host: &str) -> Option<Ipv6Addr> {
    host.strip_prefix('[')?.strip_suffix(']')?.parse().ok()
}

fn same_host(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b) || ipv6_host(a).is_some_and(|addr| ipv6_host(b) == Some(addr))
}

fn authority(value: &str) -> Option<Authority> {
    let authority: Authority = value.parse().ok()?;
    let host = authority.host();
    let valid_host = if host.starts_with('[') {
        ipv6_host(host).is_some()
    } else {
        host.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    };
    // A URI authority may contain userinfo and may parse with an unusable port.
    // Do not let either compare equal to a bare configured hostname.
    (valid_host && !value.contains('@') && (value == host || authority.port_u16().is_some_and(|port| port != 0)))
        .then_some(authority)
}

pub async fn check_host(State(hosts): State<Hosts>, request: Request, next: Next) -> Response {
    let mut headers = request.headers().get_all(header::HOST).iter();
    let target = request.uri().authority();
    let allowed = match headers.next() {
        Some(host) if headers.next().is_none() => host
            .to_str()
            .ok()
            .and_then(authority)
            .is_some_and(|host| target.is_none_or(|target| target == &host) && hosts.allows(&host)),
        None => target.is_some_and(|target| authority(target.as_str()).is_some_and(|host| hosts.allows(&host))),
        _ => false,
    };
    if allowed {
        next.run(request).await
    } else {
        (StatusCode::BAD_REQUEST, "Unrecognized Host").into_response()
    }
}

pub async fn health() -> impl IntoResponse {
    ([(header::CACHE_CONTROL, "no-store")], "ok\n")
}
