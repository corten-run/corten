use super::*;
use crate::form::Errors;
use axum::body::Body;

#[derive(serde::Deserialize, corten_macros::Fields, Debug, PartialEq)]
struct Listing {
    title: String,
    price: Option<u32>,
    #[serde(default)]
    tags: Vec<String>,
    photos: Files,
}

/// A file input in a group: named `proof.scan`, and never a text field.
#[derive(serde::Deserialize, corten_macros::Fields, Debug, PartialEq, Default)]
struct Proof {
    scan: Files,
}

#[derive(serde::Deserialize, corten_macros::Fields, Debug, PartialEq)]
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
#[derive(serde::Deserialize, corten_macros::Fields)]
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
