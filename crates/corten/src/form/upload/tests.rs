use futures_util::StreamExt;

use super::*;
use crate::form::Errors;
use axum::body::Body;

#[derive(corten_macros::Fields, Debug, PartialEq)]
struct Listing {
    title: String,
    price: Option<u32>,
    #[serde(default)]
    tags: Vec<String>,
    photos: Files,
}

/// A file input in a group: named `proof.scan`, and never a text field.
#[derive(corten_macros::Fields, Debug, PartialEq, Default)]
struct Proof {
    scan: Files,
}

#[derive(corten_macros::Fields, Debug, PartialEq)]
struct Claim {
    title: String,
    #[fields(group)]
    #[serde(default)]
    proof: Proof,
}

const BOUNDARY: &str = "----corten7MA4YWxkTrZu0gW";

/// A part: its name, file name, content type and content.
type Part<'a> = (&'a str, Option<&'a str>, Option<&'a str>, &'a [u8]);

/// A body as a browser writes it.
fn body(parts: &[Part<'_>]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, filename, content_type, content) in parts {
        out.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"").as_bytes());
        if let Some(filename) = filename {
            out.extend_from_slice(format!("; filename=\"{filename}\"").as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        if let Some(content_type) = content_type {
            out.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(content);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    out
}

/// The request for `bytes`, arriving in pieces of `size`.
fn request(bytes: &[u8], size: usize) -> Request {
    let pieces: Vec<Result<Bytes, std::io::Error>> = bytes.chunks(size.max(1)).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
    Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(futures_util::stream::iter(pieces)))
        .unwrap()
}

/// The request for `bytes`, arriving in pieces whose sizes cycle through `sizes`.
fn request_in(bytes: &[u8], sizes: &[usize]) -> Request {
    let mut pieces: Vec<Result<Bytes, std::io::Error>> = Vec::new();
    let (mut at, mut next) = (0, sizes.iter().cycle());
    while at < bytes.len() {
        let end = (at + next.next().unwrap()).min(bytes.len());
        pieces.push(Ok(Bytes::copy_from_slice(&bytes[at..end])));
        at = end;
    }
    Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(futures_util::stream::iter(pieces)))
        .unwrap()
}

/// What a handler reads: each file's field, name, type and content, then the fields.
async fn read(req: Request, limit: Option<usize>) -> crate::Result<(Vec<(String, String, String, Vec<u8>)>, Listing)> {
    let mut upload = Upload::<Listing>::from_request(req, &()).await.map_err(|_| Error::new("rejected"))?;
    if let Some(limit) = limit {
        upload.limit(limit);
    }
    let mut files = Vec::new();
    while let Some(mut file) = upload.next_file().await? {
        let mut content = Vec::new();
        while let Some(piece) = file.chunk().await? {
            content.extend_from_slice(&piece);
        }
        files.push((file.field().to_string(), file.filename().to_string(), file.content_type().to_string(), content));
    }
    Ok((files, upload.fields().await?))
}

fn status(error: Error) -> StatusCode {
    error.into_response().status()
}

#[tokio::test]
async fn files_and_fields_read_whatever_the_pieces() {
    // A boundary-like run inside a file, and CRLFs, are the file's.
    let photo: &[u8] = b"\x89PNG\r\n\r\n--not the boundary\r\n----corten7MA4YWxkTrZu0g\r\nend";
    let bytes = body(&[
        ("title", None, None, "Charizard ✨".as_bytes()),
        ("photos", Some("front.png"), Some("image/png"), photo),
        ("tags", None, None, b"holo"),
        ("photos", Some("C:\\Users\\me\\back.jpg"), Some("image/jpeg"), b""),
        ("tags", None, None, b"1st"),
        ("price", None, None, b""),
    ]);
    for size in 1..=bytes.len() {
        let (files, listing) = read(request(&bytes, size), None).await.unwrap_or_else(|e| panic!("pieces of {size}: {e:?}"));
        assert_eq!(
            files,
            vec![
                ("photos".into(), "front.png".into(), "image/png".into(), photo.to_vec()),
                ("photos".into(), "back.jpg".into(), "image/jpeg".into(), Vec::new()),
            ],
            "pieces of {size}"
        );
        assert_eq!(
            listing,
            Listing { title: "Charizard ✨".into(), price: None, tags: vec!["holo".into(), "1st".into()], photos: Files },
            "pieces of {size}"
        );
    }
}

/// Pieces of mixed sizes, small ones joined in reused room and large ones on their own, read the
/// same as even ones.
#[tokio::test]
async fn files_and_fields_read_whatever_mix_of_piece_sizes() {
    let photo: Vec<u8> = (0..6000u32)
        .flat_map(|i| match i % 7 {
            0 => b"\r\n".to_vec(),
            1 => format!("\r\n--{}", &BOUNDARY[..BOUNDARY.len() - 1]).into_bytes(),
            _ => vec![b'a' + (i % 20) as u8],
        })
        .collect();
    let bytes = body(&[
        ("title", None, None, "Charizard ✨".as_bytes()),
        ("photos", Some("front.png"), Some("image/png"), photo.as_slice()),
        ("tags", None, None, b"holo"),
    ]);
    let sizes = [1, 2, 1500, 3, 1024, 1023, 7, 4096, 1];
    for start in 0..sizes.len() {
        let sizes = [&sizes[start..], &sizes[..start]].concat();
        let (files, listing) = read(request_in(&bytes, &sizes), None).await.unwrap_or_else(|e| panic!("sizes {sizes:?}: {e:?}"));
        assert_eq!(files, vec![("photos".into(), "front.png".into(), "image/png".into(), photo.clone())], "sizes {sizes:?}");
        assert_eq!(listing.title, "Charizard ✨", "sizes {sizes:?}");
        assert_eq!(listing.tags, vec!["holo".to_string()], "sizes {sizes:?}");
        // Kept whole with `bytes_up_to`, the pieces in order.
        let mut upload = Upload::<Listing>::from_request(request_in(&bytes, &sizes), &()).await.unwrap();
        let mut file = upload.next_file().await.unwrap().unwrap();
        let kept = file.bytes_up_to(photo.len()).await.unwrap_or_else(|e| panic!("sizes {sizes:?}: {e:?}"));
        assert_eq!(kept.as_deref(), Some(&photo[..]), "sizes {sizes:?}");
        assert_eq!(upload.fields().await.unwrap().title, "Charizard ✨", "sizes {sizes:?}");
    }
}

/// A file of one piece of 1 KiB or more and then pieces of a byte is kept whole, in order.
#[tokio::test]
async fn a_large_piece_then_small_ones_are_all_kept() {
    let photo: Vec<u8> = (0..1100u32).map(|i| b'a' + (i % 26) as u8).collect();
    let bytes = body(&[("photos", Some("front.png"), Some("image/png"), photo.as_slice()), ("title", None, None, b"Mew")]);
    let at = bytes.windows(photo.len()).position(|w| w == photo).unwrap();
    let sizes: Vec<usize> = [at, 1024].into_iter().chain(std::iter::repeat_n(1, bytes.len())).collect();
    let mut upload = Upload::<Listing>::from_request(request_in(&bytes, &sizes), &()).await.unwrap();
    let mut file = upload.next_file().await.unwrap().unwrap();
    assert_eq!(file.bytes_up_to(photo.len()).await.unwrap().as_deref(), Some(&photo[..]));
}

/// A small file that came in one piece is copied out of it, so keeping it does not hold the
/// buffer it was cut from (in a server, hyper's read buffer, up to about 408 KiB).
#[tokio::test]
async fn a_small_file_in_one_piece_does_not_hold_the_piece_it_came_in() {
    let photo: Vec<u8> = (0..2048u32).map(|i| b'a' + (i % 26) as u8).collect();
    let passed_over = vec![b'x'; 300 << 10];
    let whole = Bytes::from(body(&[
        ("photos", Some("front.png"), Some("image/png"), photo.as_slice()),
        ("photos", Some("big.png"), Some("image/png"), passed_over.as_slice()),
        ("title", None, None, b"Mew"),
    ]));
    let req = Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(futures_util::stream::iter([Ok::<_, std::io::Error>(whole)])))
        .unwrap();
    let mut upload = Upload::<Listing>::from_request(req, &()).await.unwrap();
    let mut file = upload.next_file().await.unwrap().unwrap();
    let kept = file.bytes_up_to(photo.len()).await.unwrap().unwrap();
    drop(file);
    drop(upload);
    // Held alone, its buffer is its own: no larger than the file.
    let held = kept.try_into_mut().expect("nothing else holds the kept file's buffer");
    assert_eq!(&held[..], &photo[..]);
    assert!(held.capacity() < 2 * photo.len(), "a 2 KiB file holds {} bytes", held.capacity());
}

#[tokio::test]
async fn an_empty_file_input_sends_no_file_and_fields_read_past_files() {
    let bytes = body(&[
        ("photos", Some(""), Some("application/octet-stream"), b""),
        ("photos", Some("a.png"), None, b"abc"),
        ("title", None, None, b"Pikachu"),
        ("price", None, None, b"12"),
    ]);
    // The handler takes no file: `fields` reads past it.
    let upload = Upload::<Listing>::from_request(request(&bytes, 7), &()).await.ok().unwrap();
    let listing = upload.fields().await.unwrap();
    assert_eq!(listing, Listing { title: "Pikachu".into(), price: Some(12), tags: vec![], photos: Files });
    for size in 1..=bytes.len() {
        let (files, _) = read(request(&bytes, size), None).await.unwrap_or_else(|e| panic!("pieces of {size}: {e:?}"));
        let expected = vec![("photos".into(), "a.png".into(), "application/octet-stream".into(), b"abc".to_vec())];
        assert_eq!(files, expected, "pieces of {size}");
    }
}

/// A part with bytes is a file even with an empty file name (a client may send none): it is
/// handed out whole, with an empty name, wherever the pieces split it, even when its bytes begin
/// with all of the delimiter that would end it but its last byte.
#[tokio::test]
async fn a_part_with_bytes_and_no_file_name_is_a_file() {
    let bytes = body(&[
        ("photos", Some(""), Some("image/png"), b"\r\n------corten7MA4YWxkTrZu0g\r\n"),
        ("photos", Some(""), None, b""),
        ("title", None, None, b"Eevee"),
    ]);
    for size in 1..=bytes.len() {
        let (files, listing) = read(request(&bytes, size), None).await.unwrap_or_else(|e| panic!("pieces of {size}: {e:?}"));
        assert_eq!(
            files,
            vec![("photos".into(), String::new(), "image/png".into(), b"\r\n------corten7MA4YWxkTrZu0g\r\n".to_vec())],
            "pieces of {size}"
        );
        assert_eq!(listing.title, "Eevee", "pieces of {size}");
    }
}

#[tokio::test]
async fn a_file_over_its_limit_is_none_and_the_form_still_reads() {
    let bytes = body(&[("photos", Some("big.png"), Some("image/png"), &[7u8; 5000]), ("title", None, None, b"Mew")]);
    let mut upload = Upload::<Listing>::from_request(request(&bytes, 512), &()).await.ok().unwrap();
    let f = Listing::FIELDS;
    let mut errors = Errors::new();
    while let Some(mut file) = upload.next_file().await.unwrap() {
        assert!(file.is(f.photos));
        if file.bytes_up_to(4096).await.unwrap().is_none() {
            errors.add(f.photos, "Each photo can be up to 4 KB.");
        }
    }
    assert_eq!(upload.fields().await.unwrap().title, "Mew");
    assert_eq!(errors.get(f.photos), Some("Each photo can be up to 4 KB."));
    let mut upload = Upload::<Listing>::from_request(request(&bytes, 512), &()).await.ok().unwrap();
    let mut file = upload.next_file().await.unwrap().unwrap();
    assert_eq!(file.bytes_up_to(5000).await.unwrap().map(|b| b.len()), Some(5000));
}

#[tokio::test]
async fn a_file_input_in_a_group_is_named_under_the_group() {
    let f = Claim::FIELDS;
    assert_eq!(f.proof.scan.to_string(), "proof.scan");
    let bytes = body(&[("title", None, None, b"Damaged"), ("proof.scan", Some("dent.jpg"), Some("image/jpeg"), b"jpg")]);
    let mut upload = Upload::<Claim>::from_request(request(&bytes, 9), &()).await.ok().unwrap();
    let mut file = upload.next_file().await.unwrap().unwrap();
    assert!(file.is(f.proof.scan));
    assert_eq!(file.bytes_up_to(16).await.unwrap().as_deref(), Some(&b"jpg"[..]));
    assert!(upload.next_file().await.unwrap().is_none());
    assert_eq!(upload.fields().await.unwrap(), Claim { title: "Damaged".into(), proof: Proof { scan: Files } });
}

#[tokio::test]
async fn the_body_limit_is_a_413_and_the_default_is_2_mib() {
    let bytes = body(&[("photos", Some("big.png"), None, &[0u8; 3000]), ("title", None, None, b"Mew")]);
    assert_eq!(status(read(request(&bytes, 1000), Some(2048)).await.unwrap_err()), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(read(request(&bytes, 1000), Some(4096)).await.is_ok());
    let big = body(&[("photos", Some("big.png"), None, &vec![0u8; DEFAULT_LIMIT]), ("title", None, None, b"Mew")]);
    assert_eq!(status(read(request(&big, 64 << 10), None).await.unwrap_err()), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn a_body_over_its_limit_is_too_large_on_every_read_and_read_to_its_end() {
    let bytes = body(&[("photos", Some("big.png"), None, &[0u8; 3000]), ("title", None, None, b"Mew")]);
    let seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = seen.clone();
    // Counted as the server reads each piece.
    let pieces = futures_util::stream::iter(bytes.chunks(500).map(Bytes::copy_from_slice).collect::<Vec<_>>()).map(move |c| {
        counted.fetch_add(c.len(), std::sync::atomic::Ordering::Relaxed);
        Ok::<_, std::io::Error>(c)
    });
    let req = Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(pieces))
        .unwrap();
    let mut upload = Upload::<Listing>::from_request(req, &()).await.unwrap();
    upload.limit(1024);
    let mut file = upload.next_file().await.unwrap().unwrap();
    assert!(matches!(file.bytes_up_to(5000).await, Err(UploadError::TooLarge { limit: 1024 })));
    // The browser sent the rest, which was read past, so it can read the answer.
    assert_eq!(seen.load(std::sync::atomic::Ordering::Relaxed), bytes.len());
    assert!(matches!(upload.next_file().await, Err(UploadError::TooLarge { .. })));
    assert!(matches!(upload.fields().await, Err(UploadError::TooLarge { .. })));
}

#[tokio::test]
async fn a_file_over_its_own_limit_is_none_however_far_over_and_the_fields_are_still_read() {
    // Just over, and far over the body's limit: the same answer, so the form can say why.
    for size in [9 << 10, 1 << 20] {
        let photo = vec![0u8; size];
        let bytes = body(&[("photos", Some("big.png"), None, &photo), ("title", None, None, b"Mew")]);
        let mut upload = Upload::<Listing>::from_request(request(&bytes, 4096), &()).await.unwrap();
        upload.limit(16 << 10);
        let mut file = upload.next_file().await.unwrap().unwrap();
        assert_eq!(file.bytes_up_to(8 << 10).await.unwrap(), None, "{size}");
        assert_eq!(upload.fields().await.unwrap().title, "Mew", "{size}");
    }
    // What is kept still counts: two files each under their own limit, over the body's together.
    let bytes = body(&[("photos", Some("a.png"), None, &[0u8; 700]), ("photos", Some("b.png"), None, &[0u8; 700])]);
    let mut upload = Upload::<Listing>::from_request(request(&bytes, 256), &()).await.unwrap();
    upload.limit(1024);
    assert!(upload.next_file().await.unwrap().unwrap().bytes_up_to(800).await.unwrap().is_some());
    let mut second = upload.next_file().await.unwrap().unwrap();
    assert!(matches!(second.bytes_up_to(800).await, Err(UploadError::TooLarge { limit: 1024 })));

    // Several over their own limit, whatever the pieces: each byte read past is counted once.
    let photo = [3u8; 11_000];
    let parts: Vec<Part<'_>> = std::iter::once(("title", None, None, &b"Mew"[..]))
        .chain((0..3).map(|_| ("photos", Some("p.png"), None, &photo[..])))
        .collect();
    let bytes = body(&parts);
    for size in [1, 7, 1000, 4096, 10_999, 16_384] {
        let mut upload = Upload::<Listing>::from_request(request(&bytes, size), &()).await.unwrap();
        upload.limit(12_000);
        let mut over = 0;
        while let Some(mut file) = upload.next_file().await.unwrap_or_else(|e| panic!("pieces of {size}: {e:?}")) {
            over += usize::from(file.bytes_up_to(10_000).await.unwrap_or_else(|e| panic!("pieces of {size}: {e:?}")).is_none());
        }
        assert_eq!((over, upload.fields().await.unwrap().title), (3, "Mew".to_string()), "pieces of {size}");
    }

    // A file passed over unread is not kept either.
    let bytes = body(&[("photos", Some("big.png"), None, &[0u8; 100_000]), ("title", None, None, b"Mew")]);
    let mut upload = Upload::<Listing>::from_request(request(&bytes, 4096), &()).await.unwrap();
    upload.limit(16 << 10);
    assert!(upload.next_file().await.unwrap().is_some());
    assert_eq!(upload.fields().await.unwrap().title, "Mew");
}

#[tokio::test]
async fn a_file_over_its_own_limit_is_none_whatever_piece_crosses_it() {
    // The piece that crosses `max` may carry much more of the file than the body's limit has room
    // for: what is past `max` is read past, so it does not count.
    let photo = vec![1u8; 300_000];
    let bytes = body(&[("photos", Some("p.png"), None, &photo), ("title", None, None, b"Mew")]);
    for (max, limit) in [(10_000, 10_300), (10_000, 12_000), (100_000, 140_000)] {
        for size in [1, 100, 4096, 128 << 10, bytes.len()] {
            let mut upload = Upload::<Listing>::from_request(request(&bytes, size), &()).await.unwrap();
            upload.limit(limit);
            let mut file = upload.next_file().await.unwrap().unwrap();
            assert_eq!(file.bytes_up_to(max).await.unwrap(), None, "max {max}, limit {limit}, pieces of {size}");
            assert_eq!(upload.fields().await.unwrap().title, "Mew", "max {max}, limit {limit}, pieces of {size}");
        }
    }
}

#[tokio::test]
async fn a_file_over_its_own_limit_needs_room_for_its_max_however_the_body_is_split() {
    // Going over its `max`, a file needs room for `max` in the body's limit, whatever piece crosses
    // it: so a request with room for `max` more gets the file's `None`, and one without gets
    // `TooLarge`, the same however the network split the body.
    let bytes = body(&[
        ("photos", Some("a.png"), None, &[0u8; 1500]),
        ("photos", Some("b.png"), None, &[0u8; 1000]),
        ("title", None, None, b"Mew"),
    ]);
    for (max, limit, room) in [(500, 2400, true), (800, 2000, false)] {
        for size in [1, 7, 100, 999, 4096, bytes.len()] {
            let mut upload = Upload::<Listing>::from_request(request(&bytes, size), &()).await.unwrap();
            upload.limit(limit);
            let kept = upload.next_file().await.unwrap().unwrap().bytes_up_to(1600).await.unwrap().map(|b| b.len());
            assert_eq!(kept, Some(1500), "pieces of {size}");
            let mut second = upload.next_file().await.unwrap().unwrap();
            let over = second.bytes_up_to(max).await;
            if room {
                assert_eq!(over.unwrap(), None, "max {max}, pieces of {size}");
                assert_eq!(upload.fields().await.unwrap().title, "Mew", "pieces of {size}");
            } else {
                assert!(matches!(over, Err(UploadError::TooLarge { limit: 2000 })), "max {max}, pieces of {size}: {over:?}");
            }
        }
    }
}

#[tokio::test]
async fn a_file_over_its_own_limit_counts_nothing_once_it_is_given_up() {
    // Given up on, the file is let go: what the request keeps after it has the whole limit, so a
    // field that fits the limit on its own is read, however the body was split.
    let file = [3u8; 2000];
    let title = [b'a'; 700];
    let bytes = body(&[("photos", Some("a.png"), None, &file), ("title", None, None, &title)]);
    for size in [1, 64, 999, 4096, bytes.len()] {
        let mut upload = Upload::<Listing>::from_request(request(&bytes, size), &()).await.unwrap();
        upload.limit(1000);
        let mut file = upload.next_file().await.unwrap().unwrap();
        assert_eq!(file.bytes_up_to(800).await.unwrap(), None, "pieces of {size}");
        assert_eq!(upload.fields().await.unwrap().title.len(), 700, "pieces of {size}");
    }
}

#[tokio::test]
async fn what_is_read_past_is_counted_once_so_what_is_kept_after_it_still_counts() {
    // Two files read past (one passed over, one over its `max`), then a field over the limit on its
    // own: read past more than once, the field would fit.
    let big = [5u8; 100_000];
    let title = [b'a'; 1500];
    let bytes =
        body(&[("photos", Some("a.png"), None, &big), ("photos", Some("b.png"), None, &big), ("title", None, None, &title)]);
    for size in [1, 64, 1000, 4096, 65_536, bytes.len()] {
        let mut upload = Upload::<Listing>::from_request(request(&bytes, size), &()).await.unwrap();
        upload.limit(1024);
        assert!(upload.next_file().await.unwrap().is_some(), "pieces of {size}");
        let mut second = upload.next_file().await.unwrap().unwrap();
        assert_eq!(second.bytes_up_to(100).await.unwrap(), None, "pieces of {size}");
        let fields = upload.fields().await;
        assert!(matches!(fields, Err(UploadError::TooLarge { limit: 1024 })), "pieces of {size}: {fields:?}");
    }
}

/// A request for a form whose one file is `mib` MiB of zeros, sent a MiB at a time without being
/// held, then a title.
fn streamed(mib: usize) -> Request {
    streamed_counting(mib, std::sync::Arc::default())
}

/// [`streamed`], adding to `sent` each byte the server takes of it.
fn streamed_counting(mib: usize, sent: std::sync::Arc<std::sync::atomic::AtomicUsize>) -> Request {
    let head = format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"photos\"; filename=\"p.png\"\r\n\r\n");
    let tail = format!("\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nMew\r\n--{BOUNDARY}--\r\n");
    let zeros = Bytes::from(vec![0u8; 1 << 20]);
    let pieces = std::iter::once(Bytes::from(head))
        .chain(std::iter::repeat_n(zeros, mib))
        .chain(std::iter::once(Bytes::from(tail)))
        .map(move |piece| {
            sent.fetch_add(piece.len(), std::sync::atomic::Ordering::Relaxed);
            Ok::<_, std::io::Error>(piece)
        });
    Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(futures_util::stream::iter(pieces)))
        .unwrap()
}

#[tokio::test]
async fn a_body_is_read_no_further_than_64_mib_past_its_limit_whatever_is_read_past() {
    // A file passed over, 60 MiB: read past within the cap, so the form is read.
    let mut upload = Upload::<Listing>::from_request(streamed(60), &()).await.unwrap();
    assert!(upload.next_file().await.unwrap().is_some());
    assert_eq!(upload.fields().await.unwrap().title, "Mew");
    // 80 MiB past a 1 KiB limit: refused at the cap, though the request kept almost nothing, and
    // read no further than a MiB (a piece) past it.
    let sent = std::sync::Arc::<std::sync::atomic::AtomicUsize>::default();
    let mut upload = Upload::<Listing>::from_request(streamed_counting(80, sent.clone()), &()).await.unwrap();
    upload.limit(1024);
    assert!(upload.next_file().await.unwrap().is_some());
    assert!(matches!(upload.fields().await, Err(UploadError::TooLarge { limit: 1024 })));
    let sent = sent.load(std::sync::atomic::Ordering::Relaxed);
    assert!((64 << 20..=(66 << 20)).contains(&sent), "{sent} bytes read");
    // A file the handler keeps, refused at the limit: the rest is read past to let the browser see
    // the answer, but no further than 64 MiB.
    let sent = std::sync::Arc::<std::sync::atomic::AtomicUsize>::default();
    let mut upload = Upload::<Listing>::from_request(streamed_counting(80, sent.clone()), &()).await.unwrap();
    upload.limit(1024);
    let mut file = upload.next_file().await.unwrap().unwrap();
    let kept = async {
        while file.chunk().await?.is_some() {}
        Ok::<_, UploadError>(())
    };
    assert!(matches!(kept.await, Err(UploadError::TooLarge { limit: 1024 })));
    let sent = sent.load(std::sync::atomic::Ordering::Relaxed);
    assert!((64 << 20..=(66 << 20)).contains(&sent), "{sent} bytes read after a refusal");
}

#[tokio::test]
async fn parts_headers_count_toward_the_limit() {
    // Many empty files: no file has a byte, so only their headers and delimiters fill the body.
    let parts: Vec<Part<'_>> = (0..200).map(|_| ("photos", Some("e.png"), None, &b""[..])).collect();
    let bytes = body(&parts);
    assert!(bytes.len() > 10 * 1024);
    for size in [1, 100, 4096, bytes.len()] {
        let mut upload = Upload::<Listing>::from_request(request(&bytes, size), &()).await.unwrap();
        upload.limit(1024);
        let read = async {
            while upload.next_file().await?.is_some() {}
            upload.fields().await
        };
        assert!(matches!(read.await, Err(UploadError::TooLarge { limit: 1024 })), "pieces of {size}");
    }
}

#[tokio::test]
async fn a_read_past_given_up_hands_out_nothing_more() {
    // `bytes_up_to` cancelled while it reads past its file: the file's next piece is not handed out
    // as if it were not counted.
    let photo = vec![2u8; 200_000];
    let bytes = body(&[("photos", Some("p.png"), None, &photo)]);
    let (head, rest) = (Bytes::copy_from_slice(&bytes[..4000]), Bytes::copy_from_slice(&bytes[4000..]));
    let later = async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        Ok(rest)
    };
    let pieces = futures_util::stream::iter([Ok::<_, std::io::Error>(head)]).chain(futures_util::stream::once(later));
    let req = Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(pieces))
        .unwrap();
    let mut upload = Upload::<Listing>::from_request(req, &()).await.unwrap();
    upload.limit(1024);
    let mut file = upload.next_file().await.unwrap().unwrap();
    assert!(tokio::time::timeout(std::time::Duration::from_millis(50), file.bytes_up_to(100)).await.is_err());
    let mut handed = 0;
    let end = loop {
        match file.chunk().await {
            Ok(Some(piece)) => handed += piece.len(),
            other => break other,
        }
    };
    assert!(handed <= 1024 && matches!(end, Err(UploadError::TooLarge { limit: 1024 })), "{handed} {end:?}");
}

#[tokio::test]
async fn a_body_given_up_on_while_it_is_read_past_is_not_read_past_again() {
    // Pieces that keep coming, slowly: the read past is cancelled, and a read after it reads none.
    let seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = seen.clone();
    let first = body(&[("title", None, None, &[b'a'; 4000])]);
    let pieces = futures_util::stream::iter([Ok::<_, std::io::Error>(Bytes::from(first))]).chain(futures_util::stream::unfold(
        counted,
        |counted| async move {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            counted.fetch_add(1000, std::sync::atomic::Ordering::Relaxed);
            Some((Ok(Bytes::from(vec![b'a'; 1000])), counted))
        },
    ));
    let req = Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(pieces))
        .unwrap();
    let mut upload = Upload::<Listing>::from_request(req, &()).await.unwrap();
    upload.limit(1024);
    assert!(tokio::time::timeout(std::time::Duration::from_millis(50), upload.next_file()).await.is_err());
    let before = seen.load(std::sync::atomic::Ordering::Relaxed);
    // At once: a read past begun again would take minutes on this body.
    let again = tokio::time::timeout(std::time::Duration::from_secs(1), upload.next_file()).await.expect("refused at once");
    assert!(matches!(again, Err(UploadError::TooLarge { limit: 1024 })));
    assert_eq!(seen.load(std::sync::atomic::Ordering::Relaxed), before, "refused at once, not read past again");
}

#[tokio::test]
async fn what_follows_a_file_read_past_still_counts() {
    // A field after a file over its own limit, in the same pieces: kept, so over the body's limit.
    let title = vec![b'a'; 50_000];
    let bytes = body(&[("photos", Some("p.png"), None, &[0u8; 200]), ("title", None, None, &title)]);
    for size in [64, 1000, bytes.len()] {
        let mut upload = Upload::<Listing>::from_request(request(&bytes, size), &()).await.unwrap();
        upload.limit(1024);
        let read = async {
            let skipped = upload.next_file().await?.expect("a file").bytes_up_to(100).await?;
            Ok::<_, UploadError>((skipped, upload.fields().await?))
        };
        assert!(matches!(read.await, Err(UploadError::TooLarge { limit: 1024 })), "pieces of {size}");
    }
    // A read past given up (a timeout) leaves the limit in force.
    let title = vec![b'a'; 200_000];
    let bytes = body(&[("photos", Some("p.png"), None, &[0u8; 4000]), ("title", None, None, &title)]);
    let (head, rest) = (Bytes::copy_from_slice(&bytes[..2000]), Bytes::copy_from_slice(&bytes[2000..]));
    let later = async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        Ok(rest)
    };
    let pieces = futures_util::stream::iter([Ok::<_, std::io::Error>(head)]).chain(futures_util::stream::once(later));
    let req = Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(pieces))
        .unwrap();
    let mut upload = Upload::<Listing>::from_request(req, &()).await.unwrap();
    upload.limit(1024);
    {
        let mut file = upload.next_file().await.unwrap().unwrap();
        assert!(tokio::time::timeout(std::time::Duration::from_millis(50), file.bytes_up_to(100)).await.is_err());
    }
    assert!(matches!(upload.fields().await, Err(UploadError::TooLarge { limit: 1024 })));
}

#[tokio::test]
async fn fields_that_do_not_fit_are_a_422() {
    let bytes = body(&[("title", None, None, b"Mew"), ("price", None, None, b"lots")]);
    assert_eq!(status(read(request(&bytes, 64), None).await.unwrap_err()), StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn a_body_that_is_not_multipart_is_a_415_and_a_broken_one_a_400() {
    let req = Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from("title=Mew"))
        .unwrap();
    let rejected = Upload::<Listing>::from_request(req, &()).await.err().unwrap();
    assert_eq!(rejected.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

    let whole = body(&[("title", None, None, b"Mew")]);
    let broken: [&[u8]; 4] = [
        // Ends inside a part.
        &whole[..whole.len() - 12],
        // No closing boundary.
        &whole[..whole.len() - 4 - BOUNDARY.len() - 2],
        b"--no boundary here at all",
        // A part with no name.
        format!("--{BOUNDARY}\r\nContent-Disposition: form-data\r\n\r\nx\r\n--{BOUNDARY}--\r\n").leak().as_bytes(),
    ];
    for bytes in broken {
        let error = read(request(bytes, 5), None).await.unwrap_err();
        assert_eq!(status(error), StatusCode::BAD_REQUEST, "{}", String::from_utf8_lossy(bytes));
    }
}

#[test]
fn boundaries_and_parameters_read_as_written() {
    assert_eq!(boundary("multipart/form-data; boundary=abc"), Some("abc"));
    assert_eq!(boundary("Multipart/Form-Data; charset=utf-8; BOUNDARY=\"a b\""), Some("a b"));
    assert_eq!(boundary("multipart/mixed; boundary=abc"), None);
    assert_eq!(boundary("multipart/form-data"), None);
    assert_eq!(boundary(&format!("multipart/form-data; boundary={}", "x".repeat(71))), None);
    let head = parse_head(
        b"Content-Disposition: form-data; name=\"a%22b\"; filename=\"say \\\"hi\\\".txt\"\r\nContent-Type: text/plain",
    )
    .ok()
    .unwrap();
    assert_eq!(
        (head.name.as_str(), head.filename.as_deref(), head.content_type.as_deref()),
        ("a\"b", Some("say \"hi\".txt"), Some("text/plain"))
    );
    let head = parse_head(b"content-disposition: form-data; name=title").ok().unwrap();
    assert_eq!((head.name.as_str(), head.filename), ("title", None));
}

#[derive(crate::Route)]
#[route("/api")]
struct ImportRoot;

#[derive(crate::Route)]
#[route("/api/import")]
struct Import;

#[derive(crate::Route)]
#[route("/api/listings")]
struct Listings;

/// A file-only route's input, named by its one field.
#[derive(corten_macros::Fields)]
struct Export {
    file: Files,
}

/// A JSON route that takes one file and no text fields.
async fn import(mut upload: Upload<Export>) -> crate::Result<String> {
    let mut sizes = Vec::new();
    while let Some(mut file) = upload.next_file().await? {
        if file.is(Export::FIELDS.file) {
            sizes.push(file.bytes_up_to(16).await?.map_or(0, |b| b.len()));
        }
    }
    Ok(format!("{sizes:?}"))
}

/// A JSON route whose text fields must fit `Listing`.
async fn list(upload: Upload<Listing>) -> crate::Result<String> {
    Ok(upload.fields().await?.title)
}

/// An API's own failure shape, `{"error": ..}`.
#[cfg(feature = "json")]
#[derive(crate::ToJson)]
struct Refusal {
    error: String,
}

/// The status, content type and body an API under `/api` answers `req` with.
async fn api_call(errors: bool, req: Request) -> (StatusCode, String, String) {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let router = crate::App::new(crate::Routes::from(axum::Router::new()))
        .api::<ImportRoot>(|api| {
            let api = api
                .route::<Import>(crate::Methods::writes(axum::routing::post(import)))
                .route::<Listings>(crate::Methods::writes(axum::routing::post(list)));
            #[cfg(feature = "json")]
            let api = if errors { api.errors(|_, message| Refusal { error: message.to_string() }) } else { api };
            #[cfg(not(feature = "json"))]
            let _ = errors;
            api
        })
        .router();
    let res = router.oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let content_type = parts.headers.get(header::CONTENT_TYPE).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
    (parts.status, content_type, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
}

fn to_import(content_type: &str, bytes: Vec<u8>) -> Request {
    to("/api/import", content_type, bytes)
}

fn to(uri: &str, content_type: &str, bytes: Vec<u8>) -> Request {
    Request::builder().method("POST").uri(uri).header(header::CONTENT_TYPE, content_type).body(Body::from(bytes)).unwrap()
}

/// Under an API, `Upload` is taken as an argument and its refusals are the API's failures: a body
/// that is not multipart, one that breaks the format and one over the limit answer as Problem
/// Details, as a `Json<T>` that does not parse does, and so do fields that do not fit.
#[tokio::test]
async fn under_an_api_an_uploads_refusals_are_the_apis_failures() {
    let multipart = format!("multipart/form-data; boundary={BOUNDARY}");
    let (status, _, body) = api_call(false, to_import(&multipart, self::body(&[("file", Some("a.csv"), None, b"a,b")]))).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "[3]"), "the file is read by its input's name");
    let (status, content_type, body) = api_call(false, to_import("application/json", b"{}".to_vec())).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(content_type, "application/problem+json", "{body}");
    assert!(body.starts_with(r#"{"title":"Unsupported Media Type","status":415,"detail":"Upload requests must have"#), "{body}");
    let broken = format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.csv\"\r\n\r\na,b");
    let (status, content_type, body) = api_call(false, to_import(&multipart, broken.into_bytes())).await;
    assert_eq!((status, &content_type[..]), (StatusCode::BAD_REQUEST, "application/problem+json"), "{body}");
    assert!(body.contains("the multipart body is malformed"), "an UploadError the handler returns with ?: {body}");
    // A file over its own limit is read past, not kept, so it is not over the body's.
    let large = vec![b'x'; 3 << 20];
    let over = self::body(&[("file", Some("a.csv"), None, &large)]);
    let (status, _, body) = api_call(false, to_import(&multipart, over)).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "[0]"), "{body}");
    // Fields over the 2 MiB default are.
    let over = self::body(&[("title", None, None, &large)]);
    let (status, content_type, body) = api_call(false, to("/api/listings", &multipart, over)).await;
    assert_eq!((status, &content_type[..]), (StatusCode::PAYLOAD_TOO_LARGE, "application/problem+json"), "{body}");
    assert!(body.contains(r#""status":413"#), "over the 2 MiB default: {body}");
    let unfit = self::body(&[("title", None, None, b"Mew"), ("price", None, None, b"lots")]);
    let (status, content_type, body) = api_call(false, to("/api/listings", &multipart, unfit)).await;
    assert_eq!((status, &content_type[..]), (StatusCode::UNPROCESSABLE_ENTITY, "application/problem+json"), "{body}");
}

/// An API with an error shape of its own answers an upload's refusal in that shape.
#[cfg(feature = "json")]
#[tokio::test]
async fn an_apis_own_error_shape_holds_for_an_upload() {
    let (status, content_type, body) = api_call(true, to_import("text/csv", b"a,b".to_vec())).await;
    assert_eq!((status, &content_type[..]), (StatusCode::UNSUPPORTED_MEDIA_TYPE, "application/json"));
    assert!(body.starts_with(r#"{"error":"Upload requests must have"#), "{body}");
    // And the refusals the handler returns with `?`: malformed, over the limit, fields that do not fit.
    let multipart = format!("multipart/form-data; boundary={BOUNDARY}");
    let broken = format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.csv\"\r\n\r\na,b");
    let large = vec![b'x'; 3 << 20];
    let unfit = self::body(&[("title", None, None, b"Mew"), ("price", None, None, b"lots")]);
    for (req, expected) in [
        (to_import(&multipart, broken.into_bytes()), StatusCode::BAD_REQUEST),
        (to("/api/listings", &multipart, self::body(&[("title", None, None, &large)])), StatusCode::PAYLOAD_TOO_LARGE),
        (to("/api/listings", &multipart, unfit), StatusCode::UNPROCESSABLE_ENTITY),
    ] {
        let (status, content_type, body) = api_call(true, req).await;
        assert_eq!((status, &content_type[..]), (expected, "application/json"), "{body}");
        assert!(body.starts_with(r#"{"error":"#), "{body}");
    }
}

/// A part's headers past 8 KiB are refused however the body is split, and ones up to it are read.
#[tokio::test]
async fn headers_past_their_limit_are_refused_whatever_the_pieces() {
    // The headers' end (`\r\n\r\n`) `end` bytes after the delimiter line's own line break.
    let ending_at = |end: usize| {
        let mut bytes = format!("--{BOUNDARY}").into_bytes();
        let start = bytes.len();
        bytes.extend_from_slice(b"\r\nContent-Disposition: form-data; name=\"title\"\r\nX-Pad: ");
        let pad = end - (bytes.len() - start);
        bytes.resize(bytes.len() + pad, b'a');
        bytes.extend_from_slice(format!("\r\n\r\nMew\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"photos\"; filename=\"\"\r\n\r\n\r\n--{BOUNDARY}--\r\n").as_bytes());
        bytes
    };
    for size in [1, 2, 3, 4, 5, 7, 4096, usize::MAX] {
        for end in [HEAD_LIMIT + 1, 9000] {
            let error =
                read(request(&ending_at(end), size), None).await.err().unwrap_or_else(|| panic!("end {end}, pieces of {size}"));
            assert_eq!(status(error), StatusCode::BAD_REQUEST, "end {end}, pieces of {size}");
        }
        for end in [7000, HEAD_LIMIT] {
            let (_, listing) =
                read(request(&ending_at(end), size), None).await.unwrap_or_else(|e| panic!("end {end}, pieces of {size}: {e:?}"));
            assert_eq!(listing.title, "Mew", "end {end}, pieces of {size}");
        }
    }
}

/// A request whose body is `bytes` in pieces of `size`, each sent `apart` after the one before.
fn sent_slowly(
    bytes: &[u8],
    size: usize,
    apart: std::time::Duration,
    sent: std::sync::Arc<std::sync::atomic::AtomicUsize>,
) -> Request {
    let pieces: Vec<Bytes> = bytes.chunks(size).map(Bytes::copy_from_slice).collect();
    let pieces = futures_util::stream::iter(pieces).then(move |piece| {
        let sent = sent.clone();
        async move {
            tokio::time::sleep(apart).await;
            sent.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok::<_, std::io::Error>(piece)
        }
    });
    Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(pieces))
        .unwrap()
}

/// A request whose body is the first `sent` bytes of `bytes`, then nothing more.
fn stops_after(bytes: &[u8], sent: usize) -> Request {
    let first = futures_util::stream::iter([Ok::<_, std::io::Error>(Bytes::copy_from_slice(&bytes[..sent]))]);
    Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(first.chain(futures_util::stream::pending())))
        .unwrap()
}

/// A client that sends nothing for the idle time is a 408, while the handler reads a file, passes
/// one over or reads the fields, and at every read after; `idle` sets the time, and `None` waits as
/// long as the route's deadline lets it.
#[tokio::test(start_paused = true)]
async fn a_client_that_stops_sending_an_upload_is_a_408() {
    let photo = vec![1u8; 1000];
    let bytes = body(&[("photos", Some("p.png"), None, &photo), ("title", None, None, b"Mew")]);
    let in_the_file = bytes.iter().position(|&b| b == 1).unwrap() + 500;
    let in_the_title = bytes.len() - 10;
    let minute = std::time::Duration::from_secs(60);

    // Reading the file.
    let mut upload = Upload::<Listing>::from_request(stops_after(&bytes, in_the_file), &()).await.unwrap();
    let mut file = upload.next_file().await.unwrap().unwrap();
    assert_eq!(file.chunk().await.unwrap().map(|piece| piece.len()), Some(500));
    let started = tokio::time::Instant::now();
    let stalled = file.chunk().await.unwrap_err();
    assert_eq!(started.elapsed(), minute);
    assert_eq!(status(stalled.into()), StatusCode::REQUEST_TIMEOUT);
    assert!(matches!(file.chunk().await, Err(UploadError::Stalled)), "at every read after");
    assert!(matches!(upload.next_file().await, Err(UploadError::Stalled)));

    // Passing a file over.
    let mut upload = Upload::<Listing>::from_request(stops_after(&bytes, in_the_file), &()).await.unwrap();
    assert!(upload.next_file().await.unwrap().is_some());
    let started = tokio::time::Instant::now();
    assert!(matches!(upload.next_file().await, Err(UploadError::Stalled)));
    assert_eq!(started.elapsed(), minute);

    // Reading the fields, with an idle time of its own.
    let mut upload = Upload::<Listing>::from_request(stops_after(&bytes, in_the_title), &()).await.unwrap();
    upload.idle(std::time::Duration::from_secs(5));
    let started = tokio::time::Instant::now();
    assert!(matches!(upload.fields().await, Err(UploadError::Stalled)));
    assert_eq!(started.elapsed(), std::time::Duration::from_secs(5));

    // No idle time of its own.
    let mut upload = Upload::<Listing>::from_request(stops_after(&bytes, in_the_title), &()).await.unwrap();
    upload.idle(None);
    let waited = tokio::time::timeout(std::time::Duration::from_secs(3600), upload.fields()).await;
    assert!(waited.is_err(), "no idle time of its own");
}

/// The idle time holds piece by piece, not for the body in all: a client sending steadily, however
/// long it takes, is read to the end, and while a body over the limit is read past it reads the
/// 413; one that stops while it is read past is answered the 413 after the idle time.
#[tokio::test(start_paused = true)]
async fn an_upload_sent_steadily_is_never_cut_off_by_the_idle_time() {
    let half = std::time::Duration::from_secs(30);
    let photo = vec![1u8; 4000];
    let bytes = body(&[("photos", Some("p.png"), None, &photo), ("title", None, None, b"Mew")]);
    // About 40 pieces, 30 seconds apart: 20 minutes in all, each within the minute.
    let sent = std::sync::Arc::<std::sync::atomic::AtomicUsize>::default();
    let (files, listing) = read(sent_slowly(&bytes, 100, half, sent.clone()), None).await.unwrap();
    assert_eq!((files[0].3.len(), listing.title.as_str()), (4000, "Mew"));
    assert_eq!(sent.load(std::sync::atomic::Ordering::Relaxed), bytes.len().div_ceil(100));

    // Over its limit: read past to its end, piece by piece.
    let sent = std::sync::Arc::<std::sync::atomic::AtomicUsize>::default();
    let refused = read(sent_slowly(&bytes, 100, half, sent.clone()), Some(1024)).await.unwrap_err();
    assert_eq!(status(refused), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(sent.load(std::sync::atomic::Ordering::Relaxed), bytes.len().div_ceil(100), "read to its end");

    // Over its limit, then stopped: still the 413, after the idle time.
    let long = body(&[("title", None, None, &[b'a'; 4000])]);
    let mut upload = Upload::<Listing>::from_request(stops_after(&long, 3000), &()).await.unwrap();
    upload.limit(1024);
    let started = tokio::time::Instant::now();
    assert!(matches!(upload.fields().await, Err(UploadError::TooLarge { limit: 1024 })));
    assert_eq!(started.elapsed(), std::time::Duration::from_secs(60));
}

/// Pieces `apart` from each other, then nothing: how long `fields` takes to be `Stalled`.
async fn stalled_after(apart: u64, pieces: usize, idle: Option<u64>) -> std::time::Duration {
    let long = body(&[("title", None, None, &[b'a'; 4000])]);
    let chunks: Vec<Bytes> = long.chunks(100).take(pieces).map(Bytes::copy_from_slice).collect();
    let apart = std::time::Duration::from_secs(apart);
    let sent = futures_util::stream::iter(chunks).then(move |piece| async move {
        tokio::time::sleep(apart).await;
        Ok::<_, std::io::Error>(piece)
    });
    let req = Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(sent.chain(futures_util::stream::pending())))
        .unwrap();
    let mut upload = Upload::<Listing>::from_request(req, &()).await.unwrap();
    if let Some(idle) = idle {
        upload.idle(std::time::Duration::from_secs(idle));
    }
    let started = tokio::time::Instant::now();
    assert!(matches!(upload.fields().await, Err(UploadError::Stalled)));
    started.elapsed()
}

/// A stall after reads that waited is caught the idle time after the last piece, to the second:
/// the one timer an earlier read set is moved to the read that stalls, never early or late.
#[tokio::test(start_paused = true)]
async fn a_stall_after_reads_that_waited_comes_the_idle_time_after_the_last_piece() {
    for (apart, pieces) in [(30u64, 10usize), (59, 7), (1, 40), (45, 3), (0, 5)] {
        let took = stalled_after(apart, pieces, None).await;
        assert_eq!(took, std::time::Duration::from_secs(apart * pieces as u64 + 60), "{pieces} pieces {apart} s apart");
    }
    assert_eq!(stalled_after(7, 9, Some(10)).await, std::time::Duration::from_secs(7 * 9 + 10));
}

/// An idle time too long to add to the clock (`Duration::MAX`) waits as `None` does, for
/// `Upload` and `Pieces`, rather than panicking at the first read that waits.
#[tokio::test(start_paused = true)]
async fn an_idle_time_past_the_clock_never_gives_up() {
    let photo = vec![1u8; 1000];
    let bytes = body(&[("photos", Some("p.png"), None, &photo), ("title", None, None, b"Mew")]);
    let mut upload = Upload::<Listing>::from_request(stops_after(&bytes, bytes.len() - 10), &()).await.unwrap();
    upload.idle(std::time::Duration::MAX);
    let waited = tokio::time::timeout(std::time::Duration::from_secs(3600), upload.fields()).await;
    assert!(waited.is_err(), "still waiting after an hour");

    let stops = futures_util::stream::pending::<Result<Bytes, std::io::Error>>();
    let mut pieces = crate::extract::pieces_up_to(Body::from_stream(stops), 10).idle(std::time::Duration::MAX);
    let waited = tokio::time::timeout(std::time::Duration::from_secs(3600), pieces.chunk()).await;
    assert!(waited.is_err(), "still waiting after an hour");
}

/// Over a socket, a client that stops sending an upload is answered the 408 once the idle time
/// passes, and the connection is closed after it, with no `connection: close` asked for, so the
/// server holds nothing for that client (#1030).
#[tokio::test]
async fn a_stalled_upload_over_a_socket_is_a_408_and_its_connection_is_closed() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn title(mut upload: Upload<Listing>) -> crate::Result<String> {
        upload.idle(std::time::Duration::from_millis(200));
        Ok(upload.fields().await?.title)
    }
    let routes = axum::Router::new().route("/up", axum::routing::put(title));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = crate::App::new(crate::Routes::from(routes));
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let bytes = body(&[("title", None, None, &[b'a'; 4000])]);
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "PUT /up HTTP/1.1\r\nhost: localhost\r\ncontent-type: multipart/form-data; boundary={BOUNDARY}\r\ncontent-length: {}\r\n\r\n",
        bytes.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(&bytes[..1000]).await.unwrap();
    let mut read = Vec::new();
    let closed = tokio::time::timeout(std::time::Duration::from_secs(10), stream.read_to_end(&mut read)).await;
    closed.expect("the connection closed after the answer").expect("the answer, not a reset connection");
    let got = String::from_utf8_lossy(&read);
    assert!(got.starts_with("HTTP/1.1 408"), "{got}");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// Serves `app` over a socket, sends a head with `extra` headers and, `wait` later, `sent` bytes
/// of a body that says it is `len` bytes long, then nothing more, and reads what comes back until
/// the server closes the connection: the answer, and how long that took on the runtime's clock.
async fn stalled_over_a_socket(
    app: crate::App,
    path: &str,
    extra: &str,
    len: usize,
    (wait, sent): (std::time::Duration, &[u8]),
) -> (String, std::time::Duration) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "POST {path} HTTP/1.1\r\nhost: localhost\r\ncontent-type: multipart/form-data; boundary={BOUNDARY}\r\ncontent-length: {len}\r\n{extra}\r\n"
    );
    let began = tokio::time::Instant::now();
    stream.write_all(head.as_bytes()).await.unwrap();
    tokio::time::sleep(wait).await;
    stream.write_all(sent).await.unwrap();
    let mut read = Vec::new();
    stream.read_to_end(&mut read).await.expect("the answer, then the connection closed, not reset");
    let took = began.elapsed();
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
    (String::from_utf8_lossy(&read).into_owned(), took)
}

/// With the defaults (a 30 s deadline, a minute's idle time), a page upload whose client stops
/// sending is answered at the deadline as the client's: the error page at 408, not the server's
/// 503, and its connection is closed after it. So is a data client's, as Problem Details (#1061).
#[tokio::test(start_paused = true)]
async fn a_stalled_upload_at_the_default_deadline_is_the_clients_408() {
    async fn title(upload: Upload<Listing>) -> crate::Result<String> {
        Ok(upload.fields().await?.title)
    }
    let app = || crate::App::new(crate::Routes::from(axum::Router::new().route("/up", axum::routing::post(title))));
    let bytes = body(&[("title", None, None, &[b'a'; 4000])]);
    let (page, took) =
        stalled_over_a_socket(app(), "/up", "accept: text/html\r\n", bytes.len(), (std::time::Duration::ZERO, &bytes[..1000]))
            .await;
    assert!(page.starts_with("HTTP/1.1 408"), "{page}");
    assert!(page.contains("<!DOCTYPE html>") && page.contains("Not received"), "the error page: {page}");
    assert_eq!(took, std::time::Duration::from_secs(30), "at the default deadline");
    let (json, _) = stalled_over_a_socket(
        app(),
        "/up",
        "accept: application/json\r\n",
        bytes.len(),
        (std::time::Duration::ZERO, &bytes[..1000]),
    )
    .await;
    assert!(json.starts_with("HTTP/1.1 408"), "{json}");
    assert!(json.contains(r#""status":408"#), "{json}");
}

/// The deadline is still the server's 503 when the handler was not waiting for the body: one that
/// read all of it and then took too long, and one that never read it (#1061).
#[tokio::test(start_paused = true)]
async fn the_deadline_is_the_servers_503_when_the_handler_is_not_waiting_for_the_body() {
    async fn slow_after(upload: Upload<Listing>) -> crate::Result<String> {
        let title = upload.fields().await?.title;
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        Ok(title)
    }
    async fn never_reads(_upload: Upload<Listing>) -> &'static str {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        "late"
    }
    let routes =
        axum::Router::new().route("/after", axum::routing::post(slow_after)).route("/never", axum::routing::post(never_reads));
    let app = || crate::App::new(crate::Routes::from(routes.clone()));
    let bytes = body(&[("title", None, None, b"Lamp")]);
    let (after, took) = stalled_over_a_socket(
        app(),
        "/after",
        "accept: text/html\r\nconnection: close\r\n",
        bytes.len(),
        (std::time::Duration::ZERO, &bytes),
    )
    .await;
    assert!(after.starts_with("HTTP/1.1 503"), "{after}");
    assert_eq!(took, std::time::Duration::from_secs(30));
    let (never, _) =
        stalled_over_a_socket(app(), "/never", "accept: text/html\r\n", bytes.len(), (std::time::Duration::ZERO, &bytes[..10]))
            .await;
    assert!(never.starts_with("HTTP/1.1 503"), "{never}");
    // The body came 5 s late, so the handler waited for it then, and was slow after it: what it
    // waited for before is not the deadline's to count.
    let (late, _) = stalled_over_a_socket(
        app(),
        "/after",
        "accept: text/html\r\nconnection: close\r\n",
        bytes.len(),
        (std::time::Duration::from_secs(5), &bytes),
    )
    .await;
    assert!(late.starts_with("HTTP/1.1 503"), "{late}");
}

/// A body over the limit that is still being read past at the deadline is the 413 the read gives,
/// as it is when its client stops for the idle time there (#1061).
#[tokio::test(start_paused = true)]
async fn a_body_read_past_its_limit_at_the_deadline_is_the_413() {
    async fn small(mut upload: Upload<Listing>) -> crate::Result<String> {
        upload.limit(1024);
        Ok(upload.fields().await?.title)
    }
    let app = || crate::App::new(crate::Routes::from(axum::Router::new().route("/up", axum::routing::post(small))));
    let bytes = body(&[("title", None, None, &[b'a'; 4000])]);
    let (page, took) =
        stalled_over_a_socket(app(), "/up", "accept: text/html\r\n", bytes.len(), (std::time::Duration::ZERO, &bytes[..3000]))
            .await;
    assert!(page.starts_with("HTTP/1.1 413"), "{page}");
    assert_eq!(took, std::time::Duration::from_secs(30), "at the default deadline");
}

/// What reading an upload costs per piece of its body: `UPLOAD_READS` (200) reads of a form with
/// a 2 KiB file and a title, sent a byte at a time (each read is 2,259 pieces), the file
/// read with `bytes_up_to`. Counted under callgrind at two numbers of reads, the difference is the
/// cost of that many reads. `UPLOAD_IDLE=none` reads with no idle time. `UPLOAD_WAIT=1` makes the
/// reader wait for every piece, as it does for a client slower than the server, so each read
/// sets the idle timer; without it every piece has arrived already. Run in release:
/// `UPLOAD_READS=200 cargo test --release -p corten-run --all-features --lib -- --ignored what_reading_an_upload_costs`
/// (#1030).
#[test]
#[ignore]
fn what_reading_an_upload_costs() {
    let reads: usize = std::env::var("UPLOAD_READS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let idle = std::env::var("UPLOAD_IDLE").map_or(true, |idle| idle != "none");
    let wait = std::env::var("UPLOAD_WAIT").is_ok_and(|wait| wait == "1");
    let photo = vec![1u8; 2048];
    let bytes = body(&[("photos", Some("p.png"), None, &photo), ("title", None, None, b"Mew")]);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
    runtime.block_on(async {
        for _ in 0..reads {
            let req = if wait { waiting_for_each_byte(&bytes) } else { request(&bytes, 1) };
            let mut upload = Upload::<Listing>::from_request(req, &()).await.unwrap();
            if !idle {
                upload.idle(None);
            }
            let mut file = upload.next_file().await.unwrap().unwrap();
            let kept = file.bytes_up_to(4096).await.unwrap().unwrap();
            assert_eq!(std::hint::black_box(kept).len(), 2048);
            assert_eq!(upload.fields().await.unwrap().title, "Mew");
        }
    });
}

/// The request for `bytes` a byte at a time, each byte arriving after the reader has waited for it
/// (the stream is `Pending` once before each, waking its task at once).
fn waiting_for_each_byte(bytes: &[u8]) -> Request {
    let mut pieces = bytes.iter().map(|b| Bytes::copy_from_slice(&[*b])).collect::<Vec<_>>().into_iter();
    let mut wait = true;
    let stream = futures_util::stream::poll_fn(move |cx| {
        if wait {
            wait = false;
            cx.waker().wake_by_ref();
            return std::task::Poll::Pending;
        }
        wait = true;
        std::task::Poll::Ready(pieces.next().map(Ok::<_, std::io::Error>))
    });
    Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(stream))
        .unwrap()
}
