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
