use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    thread,
    time::{Duration, Instant},
};

use gachasimulate_config::compile_snapshot;
use gachasimulate_desktop_contract::{SimulationStage, WorkerSimulationEvent, WorkerSimulationJob};
use gachasimulate_gsr::{analyze_gsr_file, GsrFileWriter};
use gachasimulate_runtime::simulate_to_writer;
use gachasimulate_types::{
    CancelToken, GsrError, GsrHeaderMeta, GsrWriteSummary, ResultChunk, ResultChunkWriter,
    MAX_ANALYSIS_JSON_BYTES,
};

use crate::transport::{bounded_json, read_line, EVENT_LIMIT, JOB_LIMIT};

pub fn worker_main() -> ExitCode {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let result = match args.as_slice() {
        [simulate] if simulate == "simulate" => {
            let result = simulate_job();
            if let Err(message) = &result {
                // JSON escaping can expand a message. Fall back to a short event
                // if the compiler's diagnostic exceeds the protocol line limit.
                let event = WorkerSimulationEvent::Error {
                    message: message.clone(),
                };
                if emit(&event).is_err() {
                    let _ = emit(&WorkerSimulationEvent::Error {
                        message: "Simulation failed while reporting its diagnostic".into(),
                    });
                }
            }
            return if result.is_ok() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            };
        }
        [analyze, input, path] if analyze == "analyze" && input == "--input" => {
            analyze_job(&PathBuf::from(path))
        }
        _ => Err("Usage: gachasimulate-worker simulate | analyze --input <path>".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn emit(event: &WorkerSimulationEvent) -> io::Result<()> {
    let bytes = bounded_json(event, EVENT_LIMIT)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&bytes)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn simulate_job() -> Result<(), String> {
    let bytes = read_line(&mut io::stdin().lock(), JOB_LIMIT)
        .map_err(|error| error.to_string())?
        .ok_or("Missing simulation job")?;
    let cancel = CancelToken::new();
    let watcher = cancel.clone();
    thread::Builder::new()
        .name("worker-stdin".into())
        .spawn(move || {
            // The global stdin buffer retains bytes read past the first line.
            let _ = io::stdin().lock().skip_until(b'\n');
            watcher.cancel();
        })
        .map_err(|error| error.to_string())?;
    let job: WorkerSimulationJob =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    drop(bytes);
    emit(&WorkerSimulationEvent::Started).map_err(|error| error.to_string())?;
    let program = compile_snapshot(&job.snapshot, &job.termination_file, &job.result_item)
        .map_err(|error| format!("Configuration compile failed: {error}"))?;
    check_cancel(&cancel).map_err(|error| error.to_string())?;
    let options = job.options.into();
    let meta =
        GsrHeaderMeta::from_program(&program, &options).map_err(|error| error.to_string())?;

    let path = Path::new(&job.temp_output_path);
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let writer = SavingWriter {
        writer: GsrFileWriter::create(path, &meta).map_err(|error| error.to_string())?,
        cancel: cancel.clone(),
    };
    emit(&WorkerSimulationEvent::Stage {
        stage: SimulationStage::Simulating,
    })
    .map_err(|error| error.to_string())?;

    let mut last_report = None::<Instant>;
    let mut progress_error = None;
    let result = simulate_to_writer(&program, &options, &cancel, writer, |progress| {
        if progress.completed_runs == progress.total_runs
            || last_report.is_none_or(|time| time.elapsed() >= Duration::from_millis(50))
        {
            last_report = Some(Instant::now());
            if let Err(error) = emit(&WorkerSimulationEvent::Progress {
                completed_runs: progress.completed_runs,
                total_runs: progress.total_runs,
            }) {
                progress_error = Some(error);
                cancel.cancel();
            }
        }
    });
    if let Some(error) = progress_error {
        return Err(error.to_string());
    }
    let summary = result.map_err(|error| error.to_string())?;
    check_cancel(&cancel).map_err(|error| error.to_string())?;
    emit(&WorkerSimulationEvent::Completed {
        total_runs: summary.total_runs,
        total_result: summary.total_result.to_string(),
        chunks_written: summary.chunks_written,
        file_size: summary.file_size,
    })
    .map_err(|error| error.to_string())
}

fn check_cancel(cancel: &CancelToken) -> io::Result<()> {
    if cancel.is_cancelled() {
        Err(io::Error::other("Simulation cancelled"))
    } else {
        Ok(())
    }
}

struct SavingWriter {
    writer: GsrFileWriter,
    cancel: CancelToken,
}

impl ResultChunkWriter for SavingWriter {
    fn metadata(&self) -> &GsrHeaderMeta {
        self.writer.metadata()
    }

    fn write_chunk(&mut self, chunk: &ResultChunk) -> Result<(), GsrError> {
        self.writer.write_chunk(chunk)
    }

    fn finish(self) -> Result<GsrWriteSummary, GsrError> {
        check_cancel(&self.cancel)?;
        emit(&WorkerSimulationEvent::Stage {
            stage: SimulationStage::Saving,
        })?;
        check_cancel(&self.cancel)?;
        // finish consumes the writer, flushes its buffer, and closes the file.
        self.writer.finish()
    }
}

fn analyze_job(path: &Path) -> Result<(), String> {
    let analysis = analyze_gsr_file(path).map_err(|error| format!("Analysis failed: {error}"))?;
    analysis
        .validate()
        .map_err(|error| format!("Invalid analysis: {error}"))?;
    let bytes =
        bounded_json(&analysis, MAX_ANALYSIS_JSON_BYTES).map_err(|error| error.to_string())?;
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(&bytes)
        .and_then(|()| stdout.write_all(b"\n"))
        .and_then(|()| stdout.flush())
        .map_err(|error| error.to_string())
}
