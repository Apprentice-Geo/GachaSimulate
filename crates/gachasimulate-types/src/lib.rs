//! Contracts shared by the compiler, simulator, and result I/O.

mod analysis;
mod config;
mod program;
mod result;
mod simulation;

#[cfg(test)]
mod tests;

#[cfg(any(test, feature = "fixtures"))]
pub mod fixtures;

pub use analysis::*;
pub use config::*;
pub use program::*;
pub use result::*;
pub use simulation::*;

fn is_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}
