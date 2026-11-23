//! The matching rules Corten relies on, checked against matchit itself, not a second matcher.
//! Keep these observations with the exact dependency pin (docs/design.md#choice-matchit).

#[test]
fn parameters_are_nonempty_and_suffixes_are_matched() {
    for (route, path, value) in [
        ("/items/{id}/edit", "/items/7/edit", Some("7")),
        ("/items/{id}/edit", "/items//edit", None),
        ("/items/{id}/", "/items//", None),
        ("/items/{id}", "/items/", None),
        ("/items/{id}.json", "/items/7.json", Some("7")),
        ("/items/{id}.json", "/items/.json", None),
        ("/items/{id}.json", "/items/7", None),
        ("/items/{id}.json/edit", "/items/7.json/edit", Some("7")),
        ("/items/{id}.json/edit", "/items/.json/edit", None),
    ] {
        let mut router = matchit::Router::new();
        router.insert(route, ()).unwrap();
        assert_eq!(router.at(path).ok().and_then(|found| found.params.get("id")), value, "{route}: {path}");
    }
}

/// The rules the routing guide states, as matchit answers them: a catch-all is the nonempty rest
/// of the path and may hold empty segments, a trailing slash and case are compared as written,
/// `%2F` stays in its segment undecoded, and a path an empty parameter does not match falls back
/// to a catch-all.
#[test]
fn catch_alls_slashes_and_escapes_match_as_the_guide_says() {
    let mut router = matchit::Router::new();
    for route in ["/items", "/items/{id}", "/items/{id}/edit", "/shelves/{id}/", "/files/{*rest}"] {
        router.insert(route, route).unwrap();
    }
    let mut with_rest = router.clone();
    with_rest.insert("/{*rest}", "/{*rest}").unwrap();
    let found = |router: &matchit::Router<&'static str>, path: &str| {
        router.at(path).ok().map(|found| {
            let value = found.params.get("id").or_else(|| found.params.get("rest")).map(str::to_owned);
            (*found.value, value)
        })
    };
    let some = |route: &'static str, value: &str| Some((route, Some(value.to_owned())));
    for (path, alone, beside_rest) in [
        // A catch-all's value is nonempty but may have empty segments.
        ("/files/a//b", some("/files/{*rest}", "a//b"), some("/files/{*rest}", "a//b")),
        ("/files/a/", some("/files/{*rest}", "a/"), some("/files/{*rest}", "a/")),
        ("/files/", None, some("/{*rest}", "files/")),
        ("/files", None, some("/{*rest}", "files")),
        ("/", None, None),
        // The guide's example: an empty parameter does not match, so the catch-all answers.
        ("/items//edit", None, some("/{*rest}", "items//edit")),
        ("/shelves//", None, some("/{*rest}", "shelves//")),
        ("/items/7/edit", some("/items/{id}/edit", "7"), some("/items/{id}/edit", "7")),
        // A trailing slash is its own path, and case is compared as written.
        ("/items/", None, some("/{*rest}", "items/")),
        ("/items/7/", None, some("/{*rest}", "items/7/")),
        ("/shelves/7", None, some("/{*rest}", "shelves/7")),
        ("/Items/7", None, some("/{*rest}", "Items/7")),
        ("/items", Some(("/items", None)), Some(("/items", None))),
        // An escaped slash is one segment's text, not decoded before matching.
        ("/items/%2F", some("/items/{id}", "%2F"), some("/items/{id}", "%2F")),
        ("/items/a%2Fb/edit", some("/items/{id}/edit", "a%2Fb"), some("/items/{id}/edit", "a%2Fb")),
    ] {
        assert_eq!(found(&router, path), alone, "{path} without a catch-all at the root");
        assert_eq!(found(&with_rest, path), beside_rest, "{path} beside /{{*rest}}");
    }
}

#[test]
fn overlapping_prefixes_and_suffixes_choose_the_longest() {
    for (routes, paths) in [
        (["/a{id}", "/ab{id}", "/abc"], [("/ax", "/a{id}", Some("x")), ("/abx", "/ab{id}", Some("x")), ("/abc", "/abc", None)]),
        (
            ["/{id}.gz", "/{id}.tar.gz", "/archive.tar.gz"],
            [
                ("/a.gz", "/{id}.gz", Some("a")),
                ("/a.tar.gz", "/{id}.tar.gz", Some("a")),
                ("/archive.tar.gz", "/archive.tar.gz", None),
            ],
        ),
    ] {
        for reverse in [false, true] {
            let mut router = matchit::Router::new();
            let mut routes = routes;
            if reverse {
                routes.reverse();
            }
            for route in routes {
                router.insert(route, route).unwrap();
            }
            for (path, route, value) in paths {
                let found = router.at(path).unwrap();
                assert_eq!((*found.value, found.params.get("id")), (route, value), "{path}, reverse={reverse}");
            }
        }
    }
}

#[test]
fn ambiguous_prefix_suffix_combinations_conflict_in_either_order() {
    for (a, b) in [
        ("/prefix{id}", "/{id}suffix"),
        ("/prefix{id}suffix", "/prefix{id}"),
        ("/prefix{id}suffix", "/pre{id}"),
        ("/prefix{id}suffix", "/prefixabc{id}"),
        ("/prefix{id}suffix", "/{id}suffix"),
        ("/prefix{id}suffix", "/other{id}suffix"),
        ("/prefix{id}suffix", "/prefix{id}other"),
        ("/{id}suffix", "/{*rest}"),
        ("/{id}", "/{other}"),
    ] {
        for (first, next) in [(a, b), (b, a)] {
            let mut router = matchit::Router::new();
            router.insert(first, ()).unwrap();
            assert_eq!(
                router.insert(next, ()),
                Err(matchit::InsertError::Conflict { with: first.into() }),
                "{first} beside {next}"
            );
        }
    }
}

/// A known limit of 0.9.2, which Corten's derived routes cannot reach (their parameters are whole
/// segments) but a hand-written `Route` with text before a parameter can: 0.9.2 refuses a
/// parameter route beside an earlier one with a parameter prefix, and accepts the same two in the
/// other order (0.8.6 accepts both orders). Neither path's segment is shared, so the refusal is
/// not an ambiguity (docs/design.md#choice-matchit).
#[test]
fn a_prefixed_parameter_conflicts_with_a_later_leading_parameter_in_one_order_only() {
    for (prefixed, leading, paths) in [
        ("/a{x}/{y}", "/{z}/b", [("/ax/c", "/a{x}/{y}"), ("/q/b", "/{z}/b"), ("/ax/b", "/a{x}/{y}")]),
        ("/a{x}", "/{z}/b", [("/ax", "/a{x}"), ("/q/b", "/{z}/b"), ("/ax/b", "/{z}/b")]),
        (
            "/shop{x}/desk",
            "/{slug}/more",
            [("/shopa/desk", "/shop{x}/desk"), ("/q/more", "/{slug}/more"), ("/shopa/more", "/{slug}/more")],
        ),
    ] {
        let mut refused = matchit::Router::new();
        refused.insert(prefixed, prefixed).unwrap();
        assert_eq!(
            refused.insert(leading, leading),
            Err(matchit::InsertError::Conflict { with: prefixed.into() }),
            "{leading} after {prefixed}"
        );
        let mut accepted = matchit::Router::new();
        accepted.insert(leading, leading).unwrap();
        accepted.insert(prefixed, prefixed).unwrap();
        for (path, route) in paths {
            assert_eq!(accepted.at(path).map(|found| *found.value), Ok(route), "{path}: {leading} before {prefixed}");
        }
    }
}

#[test]
fn nonconflicting_prefix_suffix_routes_and_an_empty_route_are_kept() {
    for routes in [
        ["/prefix{id}suffix", "/prefix{id}suffix/"],
        ["/f{id}o", "/f{id}o/{*rest}"],
        ["/f{id}o/{*rest}", "/f{id}o"],
        ["/{id}", "/{id}suffix"],
        ["{id}", "{id}suffix"],
        ["{id}/", "foo/"],
        ["", "/"],
        ["/", ""],
    ] {
        let mut router = matchit::Router::new();
        for route in routes {
            router.insert(route, route).unwrap();
        }
        // Supply a nonempty value for every parameter, and one segment for the catch-all.
        for route in routes {
            let path = route.replace("{id}", "7").replace("{*rest}", "a/b");
            assert_eq!(*router.at(&path).unwrap().value, route, "{routes:?}: {path}");
        }
    }
}
