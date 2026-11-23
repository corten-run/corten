//! The app's own glyphs, beside the kit's: each a constant made with `Glyph::new` or, for one a
//! design fills, `Glyph::filled`, so the copied `icon.rs` stays as the kit wrote it. The glyphs are
//! Lucide's (lucide-static 1.67.0, ISC; the license is in the kit's `icon.rs`).

use crate::ui::icon::Glyph;

/// `package`: a shipment.
pub const PACKAGE: Glyph = Glyph::new(
    r#"<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>"#,
);
/// `star`, filled: rated.
pub const STAR: Glyph = Glyph::filled(
    r#"<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>"#,
);
