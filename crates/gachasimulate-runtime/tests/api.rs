use gachasimulate_runtime::{
    run_single_deterministic, simulate_to_writer, CancelToken, SimulationError, SimulationOptions,
};
use gachasimulate_types::{
    fixtures::{deterministic_program, MemoryChunkWriter},
    GsrHeaderMeta,
};

#[test]
fn simulation_entry_points_accept_shared_types_and_a_writer() {
    let program = deterministic_program();
    let options = SimulationOptions {
        total_runs: 3,
        seed: -5,
        threads: 2,
        chunk_size: Some(1),
        max_in_flight_chunks: Some(2),
    };
    let meta = GsrHeaderMeta::from_program(&program, &options).unwrap();
    assert!(matches!(
        run_single_deterministic(&program, options.seed, 0),
        Err(SimulationError::NotImplemented)
    ));
    let mut chunks = Vec::new();
    let writer = MemoryChunkWriter::new(&meta, &mut chunks);
    assert!(matches!(
        simulate_to_writer(&program, &options, &CancelToken::new(), writer, |_| {}),
        Err(SimulationError::NotImplemented)
    ));
    assert!(chunks.is_empty());
}
