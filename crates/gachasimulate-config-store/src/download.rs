use std::io::{self, Read};
use std::time::{Duration, SystemTime};

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
            .timeout_global(Some(CONFIG_DOWNLOAD_TIMEOUT))
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
        download_with(
            url,
            limit,
            |url| {
                self.agent
                    .get(url.as_str())
                    .call()
                    .map(|response| response.map(|body| body.into_reader()))
                    .map_err(|error| {
                        repository_error(format!("configuration download failed: {error}"))
                    })
            },
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
    request: impl Fn(&Url) -> Result<Response<R>, DesktopError>,
    now: impl Fn() -> SystemTime,
    sleep: impl Fn(Duration),
) -> Result<Vec<u8>, DesktopError> {
    let mut url = https_url(url)?;
    let mut redirects = 0;
    let mut retried = false;
    loop {
        let response = request(&url)?;
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
            redirects += 1;
        } else if status == StatusCode::TOO_MANY_REQUESTS && !retried {
            let delay = retry_after(
                response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok()),
                now(),
            );
            if delay > CONFIG_RETRY_AFTER_LIMIT {
                return Err(repository_error(
                    "configuration download returned HTTP 429; Retry-After exceeds 30 seconds",
                ));
            }
            retried = true;
            drop(response);
            sleep(delay);
        } else if status.is_success() {
            let bytes = read_up_to(response.into_body(), limit as u64).map_err(|error| {
                repository_error(format!("could not read configuration download: {error}"))
            })?;
            check_size(&bytes, limit)?;
            return Ok(bytes);
        } else {
            return Err(repository_error(format!(
                "configuration download returned HTTP {}",
                status.as_u16()
            )));
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
