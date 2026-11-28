#[test]
fn the_macro_marks_only_lost_whole_patches() {
    // proc_macro needs the compiler's token stream, so exercise the expansion from this target.
    for (markup, expected, actual, ()) in corten_macros::__whole_patch_cases!() {
        match expected {
            Some(fragment) => assert!(actual.is_some_and(|why| why.contains(fragment)), "{markup}: {actual:?}"),
            None => assert_eq!(actual, None, "{markup}"),
        }
    }
}
