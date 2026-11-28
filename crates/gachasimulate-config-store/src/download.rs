use std::io::{self, Read};
use std::time::{Duration, Instant, SystemTime};

use gachasimulate_desktop_contract::DesktopError;
use ureq::http::{header, Response, StatusCode};
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
use url::Url;

use crate::repository_error;

pub const OFFICIAL_CONFIG_INDEX_URL: &str =
    "https://raw.githubusercontent.com/Apprentice-Geo/GachaSimulate-Configs/main/dist/index.json";
pub const CONFIG_INDEX_DOWNLOAD_LIMIT: usize = 1024 * 1024;
pub const CONFIG_ZIP_DOWNLOAD_LIMIT: usize = 8 * 1024 * 1024;
pub const CONFIG_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
pub const CONFIG_REDIRECT_LIMIT: usize = 5;
pub const CONFIG_RETRY_AFTER_LIMIT: Duration = Duration::from_secs(30);

pub trait ConfigDownloader: Send + Sync {
    fn download(&self, url: &str, limit: usize) -> Result<Vec<u8>, DesktopError>;

    fn download_resolved(
        &self,
        url: &str,
        limit: usize,
        _same_origin_redirects: bool,
    ) -> Result<(Vec<u8>, String), DesktopError> {
        self.download(url, limit)
            .map(|bytes| (bytes, url.to_owned()))
    }
}

pub struct HttpsConfigDownloader {
    agent: ureq::Agent,
}

impl HttpsConfigDownloader {
    pub fn new() -> Self {
        let agent = ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .http_status_as_error(false)
            .tls_config(
                TlsConfig::builder()
                    .provider(TlsProvider::NativeTls)
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .new_agent();
        Self { agent }
    }
}

impl Default for HttpsConfigDownloader {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigDownloader for HttpsConfigDownloader {
    fn download(&self, url: &str, limit: usize) -> Result<Vec<u8>, DesktopError> {
        self.download_resolved(url, limit, false)
            .map(|(bytes, _)| bytes)
    }

    fn download_resolved(
        &self,
        url: &str,
        limit: usize,
        same_origin_redirects: bool,
    ) -> Result<(Vec<u8>, String), DesktopError> {
        download_with(
            url,
            limit,
            same_origin_redirects,
            |url, remaining| {
                self.agent
                    .get(url.as_str())
                    .config()
                    .timeout_global(Some(remaining))
                    .build()
                    .call()
                    .map(|response| response.map(|body| body.into_reader()))
                    .map_err(|error| {
                        repository_error(format!("configuration download failed: {error}"))
                    })
            },
            Instant::now,
            SystemTime::now,
            std::thread::sleep,
        )
    }
}

pub(crate) fn https_url(value: &str) -> Result<Url, DesktopError> {
    let url = Url::parse(value)
        .map_err(|error| repository_error(format!("invalid configuration URL: {error}")))?;
    if url.scheme() != "https" {
        return Err(repository_error("configuration downloads require HTTPS"));
    }
    Ok(url)
}

pub(crate) fn check_size(bytes: &[u8], limit: usize) -> Result<(), DesktopError> {
    if bytes.len() > limit {
        return Err(repository_error(format!(
            "configuration download exceeds {limit} bytes"
        )));
    }
    Ok(())
}

fn download_with<R: Read>(
    url: &str,
    limit: usize,
    same_origin_redirects: bool,
    request: impl Fn(&Url, Duration) -> Result<Response<R>, DesktopError>,
    monotonic_now: impl Fn() -> Instant,
    wall_now: impl Fn() -> SystemTime,
    sleep: impl Fn(Duration),
) -> Result<(Vec<u8>, String), DesktopError> {
    let deadline = monotonic_now() + CONFIG_DOWNLOAD_TIMEOUT;
    let mut url = https_url(url)?;
    let origin = url.origin();
    let mut redirects = 0;
    let mut retried = false;
    loop {
        let response = request(&url, time_remaining(deadline, &monotonic_now)?);
        time_remaining(deadline, &monotonic_now)?;
        let response = response?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    repository_error("configuration redirect is missing a valid Location")
                })?;
            if redirects >= CONFIG_REDIRECT_LIMIT {
                return Err(repository_error(
                    "configuration download exceeded 5 redirects",
                ));
            }
            url = url.join(location).map_err(|error| {
                repository_error(format!("invalid configuration redirect: {error}"))
            })?;
            if url.scheme() != "https" {
                return Err(repository_error("configuration redirect must use HTTPS"));
            }
            if same_origin_redirects && url.origin() != origin {
                return Err(repository_error(
                    "configuration redirect must stay on the package origin",
                ));
            }
            redirects += 1;
        } else if status == StatusCode::TOO_MANY_REQUESTS && !retried {
            let delay = retry_after(
                response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok()),
                wall_now(),
            );
            if delay > CONFIG_RETRY_AFTER_LIMIT {
                return Err(repository_error(
                    "configuration download returned HTTP 429; Retry-After exceeds 30 seconds",
                ));
            }
            if delay >= time_remaining(deadline, &monotonic_now)? {
                return Err(repository_error(
                    "configuration download timed out before HTTP 429 retry",
                ));
            }
            retried = true;
            drop(response);
            sleep(delay);
        } else if status.is_success() {
            let bytes =
                read_up_to_deadline(response.into_body(), limit as u64, deadline, &monotonic_now)?;
            check_size(&bytes, limit)?;
            return Ok((bytes, url.into()));
        } else {
            return Err(repository_error(format!(
                "configuration download returned HTTP {}",
                status.as_u16()
            )));
        }
    }
}

fn time_remaining(deadline: Instant, now: &impl Fn() -> Instant) -> Result<Duration, DesktopError> {
    deadline
        .checked_duration_since(now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| repository_error("configuration download timed out"))
}

fn read_up_to_deadline(
    reader: impl Read,
    limit: u64,
    deadline: Instant,
    now: &impl Fn() -> Instant,
) -> Result<Vec<u8>, DesktopError> {
    let mut reader = reader.take(limit.saturating_add(1));
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        time_remaining(deadline, now)?;
        let count = reader.read(&mut buffer);
        time_remaining(deadline, now)?;
        match count {
            Ok(0) => return Ok(bytes),
            Ok(count) => bytes.extend_from_slice(&buffer[..count]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(repository_error(format!(
                    "could not read configuration download: {error}"
                )));
            }
        }
    }
}

fn retry_after(value: Option<&str>, now: SystemTime) -> Duration {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Duration::from_secs(1);
    };
    if value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Duration::from_secs(value.parse().unwrap_or(u64::MAX));
    }
    httpdate::parse_http_date(value)
        .map(|date| date.duration_since(now).unwrap_or_default())
        .unwrap_or(Duration::from_secs(1))
}

/// Reads at most one byte past the limit so the caller can distinguish EOF
/// at the limit from a body that exceeds it.
pub(crate) fn read_up_to(reader: impl Read, limit: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
#[path = "../tests/support/download_http.rs"]
mod tests;
