use gachasimulate_gsr::{
    analyze_gsr_file, analyze_gsr_reader, GsrError, GsrReader, GSR_CHUNK_HEADER_BYTES,
    GSR_HEADER_BYTES, GSR_RECORD_BYTES, GSR_TRAILER_BYTES, MAX_CHUNK_RECORDS, MAX_REASONS,
    MAX_RUNS, MAX_STRING_BYTES,
};

use super::{fs, TempFile, KNOWN};

const ID: usize = GSR_HEADER_BYTES as usize;
const NAME: usize = ID + "score".len();
const FIRST_REASON_LEN: usize = NAME + "积分".len();
const FIRST_REASON: usize = FIRST_REASON_LEN + 4;
const FIRST_CHUNK: usize = FIRST_REASON_LEN + 12 + "alphabetagamma".len();
const FIRST_RECORD: usize = FIRST_CHUNK + GSR_CHUNK_HEADER_BYTES as usize;
const SECOND_CHUNK: usize = FIRST_RECORD + 2 * GSR_RECORD_BYTES as usize;
const TRAILER: usize = KNOWN.len() - GSR_TRAILER_BYTES as usize;

fn corrupt(offset: usize, replacement: &[u8]) -> Vec<u8> {
    let mut bytes = KNOWN.to_vec();
    bytes[offset..offset + replacement.len()].copy_from_slice(replacement);
    bytes
}

#[test]
fn rejects_invalid_fixed_header_fields() {
    assert!(matches!(
        GsrReader::new(corrupt(0, b"bad!").as_slice()),
        Err(GsrError::InvalidMagic { found }) if found == *b"bad!"
    ));
    assert!(matches!(
        GsrReader::new(corrupt(4, &2u32.to_le_bytes()).as_slice()),
        Err(GsrError::UnsupportedVersion { found: 2 })
    ));
    for (offset, value) in [(8, 96u32), (12, 1), (44, 1)] {
        let bytes = corrupt(offset, &value.to_le_bytes());
        assert!(matches!(
            GsrReader::new(bytes.as_slice()),
            Err(GsrError::InvalidHeader { .. })
        ));
    }
    for (offset, width) in [(16, 8), (32, 4), (36, 4), (40, 4), (FIRST_REASON_LEN, 4)] {
        let bytes = corrupt(offset, &0u64.to_le_bytes()[..width]);
        assert!(matches!(
            GsrReader::new(bytes.as_slice()),
            Err(GsrError::InvalidHeader { .. })
        ));
    }
    let bytes = corrupt(16, &(MAX_RUNS + 1).to_le_bytes());
    assert!(matches!(
        GsrReader::new(bytes.as_slice()),
        Err(GsrError::LimitExceeded {
            field: "total runs",
            limit: MAX_RUNS
        })
    ));
    let bytes = corrupt(32, &(MAX_REASONS as u32 + 1).to_le_bytes());
    assert!(matches!(
        GsrReader::new(bytes.as_slice()),
        Err(GsrError::LimitExceeded { field: "reason count", limit }) if limit == MAX_REASONS as u64
    ));
    for offset in [36, 40, FIRST_REASON_LEN] {
        let bytes = corrupt(offset, &(MAX_STRING_BYTES as u32 + 1).to_le_bytes());
        assert!(matches!(
            GsrReader::new(bytes.as_slice()),
            Err(GsrError::LimitExceeded { limit, .. }) if limit == MAX_STRING_BYTES as u64
        ));
    }
}

#[test]
fn rejects_invalid_header_strings() {
    for (offset, expected_field) in [
        (ID, "result item ID"),
        (NAME, "result item name"),
        (FIRST_REASON, "reason"),
    ] {
        assert!(matches!(
            GsrReader::new(corrupt(offset, &[0xff]).as_slice()),
            Err(GsrError::InvalidUtf8 { field }) if field == expected_field
        ));
    }
    for (offset, replacement) in [
        (ID, b"1core".as_slice()),
        (ID, b"sc-re"),
        (FIRST_REASON, b"zebra"),
        (FIRST_REASON, b"beta "),
    ] {
        let mut bytes = corrupt(offset, replacement);
        if replacement == b"beta " {
            // Make the first reason "beta", identical to the second.
            bytes.remove(FIRST_REASON + 4);
            bytes[FIRST_REASON_LEN..FIRST_REASON].copy_from_slice(&4u32.to_le_bytes());
        }
        assert!(matches!(
            GsrReader::new(bytes.as_slice()),
            Err(GsrError::InvalidHeader { .. })
        ));
    }
}

#[test]
fn rejects_invalid_chunk_ranges() {
    let bytes = corrupt(FIRST_CHUNK + 8, &0u64.to_le_bytes());
    assert!(matches!(
        analyze_gsr_reader(bytes.as_slice()),
        Err(GsrError::EmptyChunk { start_run: 0 })
    ));
    let bytes = corrupt(
        FIRST_CHUNK + 8,
        &(MAX_CHUNK_RECORDS as u64 + 1).to_le_bytes(),
    );
    assert!(matches!(
        analyze_gsr_reader(bytes.as_slice()),
        Err(GsrError::LimitExceeded { field: "chunk records", limit }) if limit == MAX_CHUNK_RECORDS as u64
    ));
    let bytes = corrupt(SECOND_CHUNK, &3u64.to_le_bytes());
    assert!(matches!(
        analyze_gsr_reader(bytes.as_slice()),
        Err(GsrError::OutOfOrderChunk {
            expected_start: 2,
            start_run: 3
        })
    ));
    let bytes = corrupt(SECOND_CHUNK, &1u64.to_le_bytes());
    assert!(matches!(
        analyze_gsr_reader(bytes.as_slice()),
        Err(GsrError::DuplicateChunk { start_run: 1 })
    ));
    let bytes = corrupt(SECOND_CHUNK + 8, &2u64.to_le_bytes());
    assert!(matches!(
        analyze_gsr_reader(bytes.as_slice()),
        Err(GsrError::LimitExceeded {
            field: "runs written",
            limit: 3
        })
    ));
}

#[test]
fn rejects_invalid_records() {
    let bytes = corrupt(FIRST_RECORD + 8, &3u32.to_le_bytes());
    assert!(matches!(
        analyze_gsr_reader(bytes.as_slice()),
        Err(GsrError::ReasonIndexOutOfBounds {
            run_index: 0,
            reason_index: 3,
            reason_count: 3
        })
    ));
    let bytes = corrupt(
        SECOND_CHUNK + GSR_CHUNK_HEADER_BYTES as usize,
        &u64::MAX.to_le_bytes(),
    );
    assert!(matches!(
        analyze_gsr_reader(bytes.as_slice()),
        Err(GsrError::ArithmeticOverflow {
            field: "total result"
        })
    ));
}

#[test]
fn rejects_truncation_at_every_byte() {
    for end in 0..KNOWN.len() {
        let section = match end {
            ..ID => "header",
            ID..NAME => "result item ID",
            NAME..FIRST_REASON_LEN => "result item name",
            FIRST_REASON_LEN..FIRST_CHUNK => {
                assert!(matches!(
                    analyze_gsr_reader(&KNOWN[..end]),
                    Err(GsrError::TruncatedData {
                        section: "reason" | "reason length"
                    })
                ));
                continue;
            }
            FIRST_CHUNK..FIRST_RECORD => "chunk header",
            FIRST_RECORD..SECOND_CHUNK => "chunk record",
            TRAILER.. => "trailer",
            _ if end < SECOND_CHUNK + GSR_CHUNK_HEADER_BYTES as usize => "chunk header",
            _ => "chunk record",
        };
        assert!(
            matches!(
                analyze_gsr_reader(&KNOWN[..end]),
                Err(GsrError::TruncatedData { section: field }) if field == section
            ),
            "unexpected result at byte {end}"
        );
    }
}

#[test]
fn validates_all_trailer_fields_only_after_the_last_chunk() {
    for (offset, message) in [
        (0, "total result mismatch"),
        (8, "chunk count mismatch"),
        (16, "file size mismatch"),
    ] {
        let bytes = corrupt(TRAILER + offset, &0u64.to_le_bytes());
        let mut reader = GsrReader::new(bytes.as_slice()).unwrap();
        assert!(reader.next_chunk().unwrap().is_some());
        assert!(reader.next_chunk().unwrap().is_some());
        assert!(matches!(
            reader.next_chunk(),
            Err(GsrError::InvalidTrailer { message: actual }) if actual == message
        ));
        assert!(reader.next_chunk().is_err());
        assert!(matches!(
            analyze_gsr_reader(bytes.as_slice()),
            Err(GsrError::InvalidTrailer { .. })
        ));
    }
}

#[test]
fn rejects_trailing_data_even_with_a_valid_trailer() {
    let bytes = [KNOWN, &[0]].concat();
    assert!(matches!(
        analyze_gsr_reader(bytes.as_slice()),
        Err(GsrError::TrailingData)
    ));
    let path = TempFile::new();
    fs::write(path.path(), bytes).unwrap();
    assert!(matches!(
        analyze_gsr_file(path.path()),
        Err(GsrError::TrailingData)
    ));
}
