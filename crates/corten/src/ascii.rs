//! Byte-level pieces the HTML and JSON writers share: testing text for a byte to escape sixteen
//! bytes at a time, integer digits two at a time, and a hash's hex digits. Safe Rust, no
//! dependencies.

const ONES: u64 = u64::from_ne_bytes([1; 8]);
const HIGH: u64 = ONES << 7;

/// Nonzero exactly when some byte of `x` is below `n` (n at most 128).
#[inline(always)]
fn below(x: u64, n: u8) -> u64 {
    x.wrapping_sub(ONES * n as u64) & !x & HIGH
}

/// Nonzero exactly when some byte of `x` is `b`.
#[inline(always)]
fn has(x: u64, b: u8) -> u64 {
    below(x ^ (ONES * b as u64), 1)
}

/// The bytes a writer escapes, with the two tests for them: of eight bytes held in a word, for
/// text shorter than sixteen, and of sixteen bytes.
pub(crate) trait Set {
    /// Some byte of `x` may be in the set: each of its bytes is found, and another may be, which
    /// then only costs the caller its byte-exact path.
    fn word(x: u64) -> bool;

    /// Some byte of `block` is in the set, and no other byte counts. Each is written with every
    /// compare in a variable of its own and every byte tested, with no early exit: the form the
    /// compiler makes one vector compare of all sixteen bytes from, for each (read in the
    /// machine code of x86-64, whose every target has SSE2, and of aarch64; on a target where it
    /// does not, the test is the same sixteen bytes one by one, and as right).
    fn block(block: &[u8; 16]) -> bool;
}

/// What HTML escapes in text and in a quoted attribute value: `&`, `'`, `<`, `>` and `"`.
pub(crate) struct Html;

impl Set for Html {
    /// `| 5` turns `"` (0x22) and `&` (0x26) into `'` (0x27), and `| 2` turns `<` (0x3c) into `>`
    /// (0x3e), so two tests find all five. The first finds `#` (0x23) too, which is written as
    /// it is.
    #[inline(always)]
    fn word(x: u64) -> bool {
        (has(x | (ONES * 5), b'\'') | has(x | (ONES * 2), b'>')) != 0
    }

    /// `| 1` turns `&` into `'` and no other byte, so with `"` apart the five are found and
    /// `#` is not.
    #[inline(always)]
    fn block(block: &[u8; 16]) -> bool {
        let (mut amp, mut angle, mut quote) = (false, false, false);
        for &b in block {
            amp |= b | 1 == b'\'';
            angle |= b | 2 == b'>';
            quote |= b == b'"';
        }
        amp | angle | quote
    }
}

/// What JSON escapes in a string: a control character, `"` and `\`.
#[cfg(feature = "json")]
pub(crate) struct Json;

#[cfg(feature = "json")]
impl Set for Json {
    #[inline(always)]
    fn word(x: u64) -> bool {
        (below(x, 0x20) | has(x, b'"') | has(x, b'\\')) != 0
    }

    #[inline(always)]
    fn block(block: &[u8; 16]) -> bool {
        let (mut control, mut quote, mut slash) = (false, false, false);
        for &b in block {
            control |= b < 0x20;
            quote |= b == b'"';
            slash |= b == b'\\';
        }
        control | quote | slash
    }
}

#[inline(always)]
fn word(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("eight bytes"))
}

#[inline(always)]
fn half(bytes: &[u8]) -> u64 {
    u32::from_le_bytes(bytes.try_into().expect("four bytes")) as u64
}

/// Whether `bytes` has a byte of the set `S`. Text of sixteen bytes or more is tested sixteen at a
/// time ([`Set::block`], so only the set's own bytes are found), and shorter text in one or two
/// words ([`Set::word`]). The last (or only) bytes are read overlapping, so no length loops over
/// single bytes. A string shorter than four is padded with spaces, which neither set has.
#[inline(always)]
pub(crate) fn any<S: Set>(bytes: &[u8]) -> bool {
    let n = bytes.len();
    if n >= 16 {
        let mut rest = bytes;
        while let Some((block, after)) = rest.split_first_chunk::<16>() {
            if S::block(block) {
                return true;
            }
            rest = after;
        }
        !rest.is_empty() && bytes.last_chunk::<16>().is_some_and(S::block)
    } else if n >= 8 {
        S::word(word(&bytes[..8])) | S::word(word(&bytes[n - 8..]))
    } else if n >= 4 {
        S::word(half(&bytes[..4]) | half(&bytes[n - 4..]) << 32)
    } else if n > 0 {
        S::word(bytes[0] as u64 | (bytes[n / 2] as u64) << 8 | (bytes[n - 1] as u64) << 16 | (ONES * b' ' as u64) << 24)
    } else {
        false
    }
}

pub(crate) const PAIRS: &[u8; 200] = b"0001020304050607080910111213141516171819\
    2021222324252627282930313233343536373839\
    4041424344454647484950515253545556575859\
    6061626364656667686970717273747576777879\
    8081828384858687888990919293949596979899";

/// `PAIRS` as text, for a writer that appends to a `String`.
const PAIRS_TEXT: &str = match std::str::from_utf8(PAIRS) {
    Ok(text) => text,
    Err(_) => panic!("PAIRS is ASCII digits"),
};

/// The two digits of `n` (below 100), `"07"` for 7.
#[inline]
pub(crate) fn pair(n: u8) -> &'static str {
    let at = usize::from(n) * 2;
    &PAIRS_TEXT[at..at + 2]
}

/// The decimal digits of `n`, written at the end of `buf`, two per division.
#[inline]
pub(crate) fn digits(mut n: u64, buf: &mut [u8; 20]) -> &[u8] {
    let mut i = buf.len();
    while n >= 100 {
        let pair = (n % 100) as usize * 2;
        n /= 100;
        i -= 2;
        buf[i..i + 2].copy_from_slice(&PAIRS[pair..pair + 2]);
    }
    if n >= 10 {
        let pair = n as usize * 2;
        i -= 2;
        buf[i..i + 2].copy_from_slice(&PAIRS[pair..pair + 2]);
    } else {
        i -= 1;
        buf[i] = b'0' + n as u8;
    }
    &buf[i..]
}

/// `n` in 16 lowercase hex digits, as `{n:016x}` writes it, without the formatter: the shell key
/// (in the head and its header), a layout read's mark, a notice's page and the ETags.
#[inline]
pub(crate) fn hex(n: u64, buf: &mut [u8; 16]) -> &str {
    for (i, digit) in buf.iter_mut().enumerate() {
        *digit = b"0123456789abcdef"[(n >> (60 - 4 * i) & 0xf) as usize];
    }
    std::str::from_utf8(buf).expect("hex digits are ASCII")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A set's bytes, one by one: what both of its tests are held to.
    fn html(b: u8) -> bool {
        b"&'<>\"".contains(&b)
    }

    #[cfg(feature = "json")]
    fn json(b: u8) -> bool {
        b < 0x20 || b == b'"' || b == b'\\'
    }

    /// Every byte value at every place in sixteen bytes, and in a word: the sixteen-byte test
    /// finds the set and nothing else, and the word test the set and no more than it says.
    #[test]
    fn each_test_finds_its_set_at_every_place() {
        for b in 0..=255u8 {
            for at in 0..16 {
                let mut block = [b'a'; 16];
                block[at] = b;
                assert_eq!(Html::block(&block), html(b), "{b:#x} at {at}");
                #[cfg(feature = "json")]
                assert_eq!(Json::block(&block), json(b), "{b:#x} at {at}");
            }
            for at in 0..8 {
                let mut word = [b'a'; 8];
                word[at] = b;
                let word = u64::from_le_bytes(word);
                assert_eq!(Html::word(word), html(b) || b == b'#', "{b:#x} at {at}");
                #[cfg(feature = "json")]
                assert_eq!(Json::word(word), json(b), "{b:#x} at {at}");
            }
        }
        // Each byte of a block is tested, not only one: two of the set, and bytes above ASCII.
        assert!(Html::block(b"<aaaaaaaaaaaaaa>") && !Html::block(&[0xe9; 16]) && !Html::block(b"#%(;=?!$)*:@[]^~"));
        #[cfg(feature = "json")]
        assert!(Json::block(b"\"aaaaaaaaaaaaaa\\") && !Json::block(&[0xe9; 16]) && !Json::block(b"!#[]^~ '&<>/{}:,"));
    }

    /// `any` against the set's bytes one by one: every byte value at every place of every length
    /// to past four blocks, so each branch by length, the loop and the overlapping end are met.
    /// Text of sixteen bytes or more is exact; shorter HTML text may also stop at a `#`.
    #[test]
    fn any_finds_a_byte_of_the_set_at_every_position_and_length() {
        for len in 0..70 {
            let mut text = vec![b'a'; len];
            assert!(!any::<Html>(&text), "{len}");
            #[cfg(feature = "json")]
            assert!(!any::<Json>(&text), "{len}");
            for at in 0..len {
                for b in 0..=255u8 {
                    text[at] = b;
                    assert_eq!(any::<Html>(&text), html(b) || (len < 16 && b == b'#'), "{len} {at} {b:#x}");
                    #[cfg(feature = "json")]
                    assert_eq!(any::<Json>(&text), json(b), "{len} {at} {b:#x}");
                }
                text[at] = b'a';
            }
            // Bytes next to the escaped ones, and UTF-8, are not hits.
            let near = "%(;=?é日".repeat(len);
            assert!(!any::<Html>(&near.as_bytes()[..len.min(near.len())]), "{len}");
            #[cfg(feature = "json")]
            assert!(!any::<Json>("!#[]^~\u{7f}é".repeat(len).as_bytes()), "{len}");
        }
    }

    #[test]
    fn digits_match_display() {
        let mut buf = [0; 20];
        for n in (0..2000).chain([9_999, 10_000, 99_999, 123_456_789, u32::MAX as u64, u64::MAX - 1, u64::MAX]) {
            assert_eq!(digits(n, &mut buf), n.to_string().as_bytes());
        }
    }

    #[test]
    fn pairs_are_two_digits() {
        for n in 0..100u8 {
            assert_eq!(pair(n), format!("{n:02}"));
        }
    }

    #[test]
    fn hex_matches_display() {
        for n in (0..300).chain([0xabc_def0, u32::MAX as u64, 0x0123_4567_89ab_cdef, 0xfedc_ba98_7654_3210, u64::MAX]) {
            assert_eq!(hex(n, &mut [0; 16]), format!("{n:016x}"));
        }
    }
}
