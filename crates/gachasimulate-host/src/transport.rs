use std::{
    io::{self, BufRead, Read, Write},
    process::Command,
    time::Duration,
};

use serde::Serialize;

// A valid configuration package permits up to 64 MiB of raw UTF-8 files;
// worst-case JSON escaping (\uXXXX) can expand raw bytes by 6x, plus envelope.
pub(crate) const JOB_LIMIT: usize = 385 * 1024 * 1024;
pub(crate) const EVENT_LIMIT: usize = 64 * 1024;
pub(crate) const STDERR_LIMIT: usize = 64 * 1024;
pub(crate) const PROCESS_POLL: Duration = Duration::from_millis(10);

pub(crate) fn worker_command(binary: &std::path::Path) -> Command {
    let mut command = Command::new(binary);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.stdin(std::process::Stdio::null());
    command
}

pub(crate) fn read_line(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    reader
        .take((limit + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.pop() != Some(b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Worker JSON line is unterminated or exceeds {limit} bytes"),
        ));
    }
    Ok(Some(bytes))
}

pub(crate) fn read_bounded(reader: impl Read, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Input exceeds {limit} bytes"),
        ));
    }
    Ok(bytes)
}

pub(crate) fn read_stderr(mut reader: impl Read) -> String {
    let mut bytes = Vec::new();
    let _ = reader
        .by_ref()
        .take(STDERR_LIMIT as u64)
        .read_to_end(&mut bytes);
    // Keep draining after the cap so a noisy process cannot block on stderr.
    let _ = io::copy(&mut reader, &mut io::sink());
    String::from_utf8_lossy(&bytes).trim().to_owned()
}

pub(crate) fn bounded_json(value: &impl Serialize, limit: usize) -> serde_json::Result<Vec<u8>> {
    struct Buffer {
        bytes: Vec<u8>,
        limit: usize,
    }

    impl Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > self.limit - self.bytes.len() {
                return Err(io::Error::other(format!(
                    "JSON exceeds {} bytes",
                    self.limit
                )));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    let mut buffer = Buffer {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut buffer, value)?;
    Ok(buffer.bytes)
}
