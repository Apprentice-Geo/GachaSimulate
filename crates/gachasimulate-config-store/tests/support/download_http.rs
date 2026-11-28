use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::io::{self, Cursor};

use super::*;

const INDEX: &str = "https://example.test/dist/index.json";

type Reply = Response<Cursor<Vec<u8>>>;

fn reply(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Reply {
    let mut builder = Response::builder().status(status);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Cursor::new(body.to_vec())).unwrap()
}

#[derive(Default)]
struct Http {
    replies: RefCell<VecDeque<Reply>>,
    urls: RefCell<Vec<String>>,
    waits: RefCell<Vec<Duration>>,
}

impl Http {
    fn new(replies: impl IntoIterator<Item = Reply>) -> Self {
        Self {
            replies: RefCell::new(replies.into_iter().collect()),
            ..Self::default()
        }
    }

    fn download(&self, url: &str, limit: usize) -> Result<Vec<u8>, DesktopError> {
        download_with(
            url,
            limit,
            |url| {
                self.urls.borrow_mut().push(url.to_string());
                Ok(self
                    .replies
                    .borrow_mut()
                    .pop_front()
                    .expect("unexpected HTTP request"))
            },
            || SystemTime::UNIX_EPOCH + Duration::from_secs(1_000),
            |duration| self.waits.borrow_mut().push(duration),
        )
    }
}

#[test]
fn rejects_initial_http_and_redirect_downgrades_before_requesting_them() {
    let http = Http::default();
    assert!(http
        .download("http://example.test/", 8)
        .unwrap_err()
        .message
        .contains("HTTPS"));
    assert!(http.urls.borrow().is_empty());
    let http = Http::new([reply(302, &[("location", "http://example.test/")], b"")]);
    assert!(http
        .download(INDEX, 8)
        .unwrap_err()
        .message
        .contains("HTTPS"));
    assert_eq!(&*http.urls.borrow(), &[INDEX]);
    assert!(HttpsConfigDownloader::new()
        .download("http://example.test/", 1)
        .is_err());
}

#[test]
fn accepts_five_relative_redirects_and_rejects_a_sixth() {
    let redirect = || reply(307, &[("location", "../other/index.json")], b"");
    let responses = std::iter::repeat_with(redirect).take(CONFIG_REDIRECT_LIMIT);
    let http = Http::new(responses.chain([reply(200, &[], b"index")]));
    assert_eq!(http.download(INDEX, 5).unwrap(), b"index");
    let urls = http.urls.borrow();
    assert_eq!(urls.len(), 6);
    assert_eq!(urls[1], "https://example.test/other/index.json");

    let http = Http::new(std::iter::repeat_with(redirect).take(CONFIG_REDIRECT_LIMIT + 1));
    assert!(http
        .download(INDEX, 5)
        .unwrap_err()
        .message
        .contains("exceeded 5 redirects"));
    assert_eq!(http.urls.borrow().len(), 6);

    let http = Http::new([reply(302, &[], b"")]);
    assert!(http
        .download(INDEX, 5)
        .unwrap_err()
        .message
        .contains("Location"));
}

#[test]
fn applies_retry_after_in_seconds_or_dates_and_retries_at_most_once() {
    let date =
        |seconds| httpdate::fmt_http_date(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds));
    for (header, expected) in [
        ("30", 30),
        (&date(1_030), 30),
        (&date(999), 0),
        ("garbage", 1),
    ] {
        let http = Http::new([
            reply(429, &[("retry-after", header)], b"ignored"),
            reply(200, &[], b"ok"),
        ]);
        assert_eq!(http.download(INDEX, 2).unwrap(), b"ok");
        assert_eq!(&*http.urls.borrow(), &[INDEX, INDEX]);
        assert_eq!(&*http.waits.borrow(), &[Duration::from_secs(expected)]);
    }
    for header in ["31", &date(1_031), "9999999999999999999999999999999"] {
        let http = Http::new([reply(429, &[("retry-after", header)], b"")]);
        assert!(http
            .download(INDEX, 2)
            .unwrap_err()
            .message
            .contains("exceeds 30 seconds"));
        assert_eq!(http.urls.borrow().len(), 1);
        assert!(http.waits.borrow().is_empty());
    }
    let rate_limited = || reply(429, &[("retry-after", "0")], b"");
    let http = Http::new([
        rate_limited(),
        reply(301, &[("location", "next")], b""),
        rate_limited(),
    ]);
    assert!(http
        .download(INDEX, 2)
        .unwrap_err()
        .message
        .contains("HTTP 429"));
    assert_eq!(http.urls.borrow().len(), 3);
    assert_eq!(&*http.waits.borrow(), &[Duration::ZERO]);
}

#[test]
fn rejects_non_success_and_bounds_body_reads_to_limit_plus_one() {
    let http = Http::new([reply(404, &[], b"not found")]);
    assert!(http
        .download(INDEX, 2)
        .unwrap_err()
        .message
        .contains("HTTP 404"));

    struct EndlessBody<'a>(&'a Cell<usize>);
    impl Read for EndlessBody<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            buffer.fill(0);
            self.0.set(self.0.get() + buffer.len());
            Ok(buffer.len())
        }
    }
    let read = Cell::new(0);
    let error = download_with(
        INDEX,
        16,
        |_| Ok(Response::new(EndlessBody(&read))),
        SystemTime::now,
        |_| panic!("unexpected retry"),
    )
    .unwrap_err();
    assert!(error.message.contains("exceeds 16 bytes"));
    assert_eq!(read.get(), 17);
}
