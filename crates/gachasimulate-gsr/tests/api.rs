use std::io::Cursor;

use gachasimulate_gsr::{
    analyze_gsr_file, analyze_gsr_reader, GsrError, GsrFileWriter, GsrReader, ResultChunkWriter,
};
use gachasimulate_types::fixtures::known_results;

fn accepts_chunk_writer<W: ResultChunkWriter>() {}

#[test]
fn result_io_entry_points_use_the_shared_contract() {
    accepts_chunk_writer::<GsrFileWriter>();
    let fixture = known_results();
    assert!(matches!(
        GsrFileWriter::create("example.gsr", &fixture.meta),
        Err(GsrError::NotImplemented)
    ));
    assert!(matches!(
        GsrReader::open("example.gsr"),
        Err(GsrError::NotImplemented)
    ));
    assert!(matches!(
        analyze_gsr_file("example.gsr"),
        Err(GsrError::NotImplemented)
    ));
    assert!(matches!(
        GsrReader::new(Cursor::new([])),
        Err(GsrError::NotImplemented)
    ));
    assert!(matches!(
        analyze_gsr_reader(Cursor::new([])),
        Err(GsrError::NotImplemented)
    ));
}
