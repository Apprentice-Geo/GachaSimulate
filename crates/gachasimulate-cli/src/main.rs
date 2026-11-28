use std::{env, fs, path::PathBuf, process::ExitCode, time::Instant};

use gachasimulate_cli::{
    allocate_sibling_temp_path, commit_temp_file, load_directory_snapshot,
    load_package_zip_snapshot, paths_refer_to_same_file, read_bounded_archive,
};
use gachasimulate_config::compile_snapshot;
use gachasimulate_gsr::{analyze_gsr_file, GsrFileWriter, GsrHeaderMeta};
use gachasimulate_runtime::{simulate_to_writer, CancelToken, SimulationOptions};

fn main() -> ExitCode {
    match run(env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    let Some(command) = args.first().map(String::as_str) else {
        return Err("usage: gachasimulate-cli <simulate|analyze> [options]".to_string());
    };
    match command {
        "simulate" => run_simulate(&args[1..]),
        "analyze" => run_analyze(&args[1..]),
        other => Err(format!("unknown subcommand `{other}`")),
    }
}

fn run_simulate(args: &[String]) -> Result<(), String> {
    let mut config_dir: Option<PathBuf> = None;
    let mut package_zip: Option<(String, PathBuf)> = None;
    let mut termination_file = String::from("termination.yaml");
    let mut result_item = String::from("draw_count");
    let mut runs: u64 = 10_000;
    let mut seed: i64 = 123;
    let mut threads: usize = 1;
    let mut output: Option<PathBuf> = None;
    let mut report_timing = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--config-dir" => {
                i += 1;
                config_dir = Some(PathBuf::from(arg_value(args, i, "--config-dir")?));
            }
            "--package-zip" => {
                let id = arg_value(args, i + 1, "--package-zip <id> <path>")?.to_string();
                let path = PathBuf::from(arg_value(args, i + 2, "--package-zip <id> <path>")?);
                package_zip = Some((id, path));
                i += 2;
            }
            "--termination" => {
                i += 1;
                termination_file = arg_value(args, i, "--termination")?.to_string();
            }
            "--result-item" => {
                i += 1;
                result_item = arg_value(args, i, "--result-item")?.to_string();
            }
            "--runs" => {
                i += 1;
                runs = arg_value(args, i, "--runs")?
                    .parse()
                    .map_err(|_| "invalid --runs value".to_string())?;
            }
            "--seed" => {
                i += 1;
                seed = arg_value(args, i, "--seed")?
                    .parse()
                    .map_err(|_| "invalid --seed value".to_string())?;
            }
            "--threads" => {
                i += 1;
                threads = arg_value(args, i, "--threads")?
                    .parse()
                    .map_err(|_| "invalid --threads value".to_string())?;
            }
            "--output" => {
                i += 1;
                output = Some(PathBuf::from(arg_value(args, i, "--output")?));
            }
            "--timing" => {
                report_timing = true;
            }
            other => return Err(format!("unknown argument `{other}`")),
        }
        i += 1;
    }

    let output = output.ok_or_else(|| "--output is required".to_string())?;
    let snapshot = if let Some((id, zip_path)) = package_zip {
        let bytes = read_bounded_archive(&zip_path)?;
        load_package_zip_snapshot(&id, &bytes)?.1
    } else if let Some(dir) = config_dir {
        load_directory_snapshot(&dir)?
    } else {
        return Err("either --config-dir or --package-zip is required".to_string());
    };

    let program = compile_snapshot(&snapshot, &termination_file, &result_item)
        .map_err(|error| format!("compile failed: {error}"))?;
    let options = SimulationOptions {
        total_runs: runs,
        seed,
        threads,
        chunk_size: None,
        max_in_flight_chunks: None,
    };
    let meta = GsrHeaderMeta::from_program(&program, &options)
        .map_err(|error| format!("header metadata error: {error}"))?;

    // Write to a sibling temporary file so any validation/runtime failure
    // leaves an existing output file untouched.
    let temp_output = allocate_sibling_temp_path(&output, "gsr")?;
    let started = Instant::now();
    let writer = GsrFileWriter::create(&temp_output, &meta).map_err(|error| {
        let _ = fs::remove_file(&temp_output);
        format!("failed to create GSR: {error}")
    })?;
    let summary = match simulate_to_writer(&program, &options, &CancelToken::new(), writer, |_| {})
    {
        Ok(summary) => summary,
        Err(error) => {
            let _ = fs::remove_file(&temp_output);
            return Err(format!("simulation failed: {error}"));
        }
    };
    commit_temp_file(&temp_output, &output)?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;

    if report_timing {
        println!(
            "{{\"elapsed_ms\":{elapsed_ms:.6},\"total_runs\":{},\"total_result\":{},\"chunks_written\":{},\"file_size\":{}}}",
            summary.total_runs, summary.total_result, summary.chunks_written, summary.file_size
        );
    }
    Ok(())
}

fn run_analyze(args: &[String]) -> Result<(), String> {
    let mut input: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut report_timing = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--input" => {
                i += 1;
                input = Some(PathBuf::from(arg_value(args, i, "--input")?));
            }
            "--output" => {
                i += 1;
                output = Some(PathBuf::from(arg_value(args, i, "--output")?));
            }
            "--timing" => {
                report_timing = true;
            }
            other => return Err(format!("unknown argument `{other}`")),
        }
        i += 1;
    }

    let input = input.ok_or_else(|| "--input is required".to_string())?;
    if let Some(output_path) = &output {
        if paths_refer_to_same_file(&input, output_path)? {
            return Err("--output must not refer to the same file as --input".to_string());
        }
    }

    let started = Instant::now();
    let analysis = analyze_gsr_file(&input).map_err(|error| format!("analysis failed: {error}"))?;
    let json = serde_json::to_string(&analysis)
        .map_err(|error| format!("failed to serialize analysis: {error}"))?;
    if let Some(output_path) = &output {
        let temp_output = allocate_sibling_temp_path(output_path, "analysis")?;
        fs::write(&temp_output, format!("{json}\n")).map_err(|error| {
            let _ = fs::remove_file(&temp_output);
            format!("failed to write {}: {error}", temp_output.display())
        })?;
        commit_temp_file(&temp_output, output_path)?;
    } else if !report_timing {
        println!("{json}");
    }
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    if report_timing {
        println!(
            "{{\"elapsed_ms\":{elapsed_ms:.6},\"json_bytes\":{},\"total_runs\":\"{}\",\"total_result\":\"{}\"}}",
            json.len(),
            analysis.totals.runs,
            analysis.totals.result
        );
    }
    Ok(())
}

fn arg_value<'a>(args: &'a [String], index: usize, flag: &str) -> Result<&'a str, String> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| format!("missing value for {flag}"))
}
