//! Shared desktop commands, simulation events and host-to-worker payloads.
//!
//! Desktop payloads use camelCase. Analysis and the display fields retain
//! their published result and sidecar field names.

mod config;
mod results;
mod simulation;
mod state;
mod worker;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use config::*;
pub use gachasimulate_types::{Analysis, ConfigItem, ConfigSnapshot, TerminationSource, MAX_RUNS};
pub use results::*;
pub use simulation::*;
pub use state::*;
pub use worker::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopErrorCode {
    InvalidRequest,
    NotFound,
    Conflict,
    Cancelled,
    Io,
    Compile,
    Repository,
    Simulation,
    Analysis,
    Sidecar,
    CleanupBlocked,
    Internal,
    NotImplemented,
}

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[error("{message}")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopError {
    pub code: DesktopErrorCode,
    pub message: String,
}

impl DesktopError {
    pub fn new(code: DesktopErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn not_implemented() -> Self {
        Self::new(
            DesktopErrorCode::NotImplemented,
            "Desktop command is not implemented",
        )
    }

    pub(crate) fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(DesktopErrorCode::InvalidRequest, message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppLink {
    Project,
    Issues,
    License,
    Notices,
}
