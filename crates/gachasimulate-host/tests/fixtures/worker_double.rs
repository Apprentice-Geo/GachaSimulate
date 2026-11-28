use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::Path,
    process::ExitCode,
    thread,
    time::{Duration, Instant},
};

fn wait_for(path: &Path) {
    let start = Instant::now();
    while !path.exists() {
        assert!(start.elapsed() < Duration::from_secs(20));
        thread::sleep(Duration::from_millis(10));
    }
}

fn emit(event: &str) {
    println!("{event}");
    io::stdout().flush().unwrap();
}

fn main() -> ExitCode {
    let exe = env::current_exe().unwrap();
    let root = exe.parent().unwrap();
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args[0] == "analyze" {
        let input = Path::new(&args[2]);
        if input.file_name().unwrap() == "blocked.gsr" {
            fs::write(root.join("analyzing"), b"").unwrap();
            wait_for(&root.join("release-analyzer"));
        }
        print!(
            "{}",
            include_str!("../../../gachasimulate-types/fixtures/known-analysis.json")
                .replace(['\r', '\n'], "")
        );
        println!();
        return ExitCode::SUCCESS;
    }

    let mode = fs::read_to_string(root.join("mode")).unwrap();
    let mut stdin = io::stdin().lock();
    stdin.skip_until(b'\n').unwrap();
    let temp = fs::read_dir(root.join("results"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".tmp-")
        })
        .unwrap();
    let complete = matches!(mode.as_str(), "success" | "late-error" | "bad-metadata");
    if complete {
        fs::write(
            &temp,
            include_bytes!("../../../gachasimulate-gsr/fixtures/known-results.gsr"),
        )
        .unwrap();
    } else {
        fs::write(&temp, b"partial output").unwrap();
    }

    emit(r#"{"type":"started"}"#);
    emit(r#"{"type":"stage","stage":"simulating"}"#);
    if complete {
        emit(r#"{"type":"progress","completedRuns":3,"totalRuns":3}"#);
        emit(r#"{"type":"stage","stage":"saving"}"#);
        let size = fs::metadata(&temp).unwrap().len();
        let total = if mode == "bad-metadata" { 19 } else { 18 };
        emit(&format!(
            r#"{{"type":"completed","totalRuns":3,"totalResult":"{total}","chunksWritten":2,"fileSize":{size}}}"#
        ));
    }

    fs::write(root.join("ready"), b"").unwrap();
    match mode.as_str() {
        "hang" => {
            stdin.skip_until(b'\n').unwrap();
            emit(r#"{"type":"progress","completedRuns":1,"totalRuns":3}"#);
            wait_for(&root.join("release"));
        }
        "cancel" => {
            stdin.skip_until(b'\n').unwrap();
        }
        "late-error" | "write-error" => wait_for(&root.join("release")),
        "success" | "bad-metadata" => return ExitCode::SUCCESS,
        _ => panic!("Unknown test mode"),
    }
    if mode == "write-error" {
        emit(r#"{"type":"error","message":"simulated disk full"}"#);
    }
    ExitCode::FAILURE
}
