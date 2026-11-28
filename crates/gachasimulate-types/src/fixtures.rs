//! Contract inputs shared by the workspace's crate tests.

use crate::{
    Action, ActionRange, Comparison, CompiledProgram, ConditionNode, ConfigItem,
    ConfigPackageBytes, ConfigPackageFile, ConfigRepositoryIndex, ConfigSnapshot, GsrError,
    GsrHeaderMeta, GsrWriteSummary, Pool, PoolEntry, ResultChunk, ResultChunkWriter, ResultRecord,
    TerminationSource, CONFIG_FILE, MANIFEST_FILE, MAX_CHUNK_RECORDS,
};

/// Uses the same rules as the example package. Every run ends on the first
/// draw with score 3 and reason "done", irrespective of seed or run index.
pub fn deterministic_program() -> CompiledProgram {
    CompiledProgram {
        result_item: 0,
        items: vec![ConfigItem {
            id: "score".into(),
            name: "积分".into(),
        }],
        reasons: vec!["done".into()],
        actions: vec![
            Action::SetItem { item: 0, amount: 1 },
            Action::AddItem { item: 0, amount: 1 },
            Action::AddItem { item: 0, amount: 1 },
            Action::Terminate { reason: 0 },
        ],
        pools: vec![Pool {
            id: "main".into(),
            entries: ActionRange::new(0, 1),
        }],
        pool_entries: vec![PoolEntry {
            threshold: 1.0,
            actions: ActionRange::new(2, 1),
        }],
        rules: Vec::new(),
        condition_nodes: vec![ConditionNode::Check {
            item: 0,
            op: Comparison::Ge,
            value: 3,
            actions: ActionRange::new(3, 1),
        }],
        condition_children: Vec::new(),
        item_resolves: vec![None],
        initial: ActionRange::new(0, 1),
        every_draw: ActionRange::new(1, 1),
        termination_condition: 0,
    }
}

pub const DETERMINISTIC_RECORD: ResultRecord = ResultRecord {
    value: 3,
    reason_index: 0,
};

pub struct ResultFixture {
    pub meta: GsrHeaderMeta,
    pub chunks: Vec<ResultChunk>,
    pub analysis_json: &'static str,
}

pub fn known_results() -> ResultFixture {
    ResultFixture {
        meta: GsrHeaderMeta {
            total_runs: 3,
            seed: -5,
            result_item_id: "score".into(),
            result_item_name: "积分".into(),
            reasons: vec!["alpha".into(), "beta".into(), "gamma".into()],
        },
        chunks: vec![
            ResultChunk {
                start_run: 0,
                records: vec![
                    ResultRecord {
                        value: 10,
                        reason_index: 1,
                    },
                    ResultRecord {
                        value: 2,
                        reason_index: 2,
                    },
                ],
            },
            ResultChunk {
                start_run: 2,
                records: vec![ResultRecord {
                    value: 6,
                    reason_index: 0,
                }],
            },
        ],
        analysis_json: include_str!("../fixtures/known-analysis.json"),
    }
}

pub fn large_total_results() -> ResultFixture {
    ResultFixture {
        meta: GsrHeaderMeta {
            total_runs: 2,
            seed: 0,
            result_item_id: "score".into(),
            result_item_name: "积分".into(),
            reasons: vec!["done".into()],
        },
        chunks: vec![ResultChunk {
            start_run: 0,
            records: vec![
                ResultRecord {
                    value: 4_503_599_627_370_496,
                    reason_index: 0,
                },
                ResultRecord {
                    value: 4_503_599_627_370_497,
                    reason_index: 0,
                },
            ],
        }],
        analysis_json: include_str!("../fixtures/large-total-analysis.json"),
    }
}

/// The example index uses a syntactically valid placeholder digest.
pub const EXAMPLE_INDEX_JSON: &str = include_str!("../fixtures/index.json");

pub struct ConfigPackageFixture {
    pub snapshot: ConfigSnapshot,
    pub files: Vec<ConfigPackageFile>,
    pub file_bytes: Vec<ConfigPackageBytes>,
    pub index: ConfigRepositoryIndex,
}

pub fn config_package() -> ConfigPackageFixture {
    let manifest = include_str!("../fixtures/example/manifest.yaml");
    let config = include_str!("../fixtures/example/config.yaml");
    let termination = include_str!("../fixtures/example/termination.yaml");
    let snapshot = ConfigSnapshot {
        manifest_yaml: manifest.into(),
        config_yaml: config.into(),
        terminations: vec![TerminationSource {
            file: "termination.yaml".into(),
            content: termination.into(),
        }],
    };
    let file_bytes: Vec<_> = [
        (MANIFEST_FILE, manifest),
        (CONFIG_FILE, config),
        ("termination.yaml", termination),
    ]
    .into_iter()
    .map(|(path, content)| ConfigPackageBytes {
        path: path.into(),
        bytes: content.as_bytes().into(),
    })
    .collect();
    ConfigPackageFixture {
        snapshot,
        files: file_bytes
            .iter()
            .map(ConfigPackageBytes::metadata)
            .collect(),
        file_bytes,
        index: serde_json::from_str(EXAMPLE_INDEX_JSON).expect("valid example index"),
    }
}

/// Records accepted chunks in memory. The caller can inspect the output after
/// the writer is consumed. The returned summary always has file_size zero.
pub struct MemoryChunkWriter<'a> {
    meta: GsrHeaderMeta,
    chunks: &'a mut Vec<ResultChunk>,
    next_run: u64,
    total_result: u64,
    chunks_written: u64,
}

impl<'a> MemoryChunkWriter<'a> {
    pub fn new(meta: &GsrHeaderMeta, chunks: &'a mut Vec<ResultChunk>) -> Self {
        Self {
            meta: meta.clone(),
            chunks,
            next_run: 0,
            total_result: 0,
            chunks_written: 0,
        }
    }
}

impl ResultChunkWriter for MemoryChunkWriter<'_> {
    fn metadata(&self) -> &GsrHeaderMeta {
        &self.meta
    }

    fn write_chunk(&mut self, chunk: &ResultChunk) -> Result<(), GsrError> {
        if chunk.start_run < self.next_run {
            return Err(GsrError::DuplicateChunk {
                start_run: chunk.start_run,
            });
        }
        if chunk.start_run > self.next_run {
            return Err(GsrError::OutOfOrderChunk {
                expected_start: self.next_run,
                start_run: chunk.start_run,
            });
        }
        if chunk.records.is_empty() {
            return Err(GsrError::EmptyChunk {
                start_run: chunk.start_run,
            });
        }
        if chunk.records.len() > MAX_CHUNK_RECORDS {
            return Err(GsrError::LimitExceeded {
                field: "chunk records",
                limit: MAX_CHUNK_RECORDS as u64,
            });
        }
        let end = chunk
            .start_run
            .checked_add(chunk.records.len() as u64)
            .ok_or(GsrError::ArithmeticOverflow { field: "chunk end" })?;
        if end > self.meta.total_runs {
            return Err(GsrError::LimitExceeded {
                field: "runs written",
                limit: self.meta.total_runs,
            });
        }
        let mut total = self.total_result;
        for (offset, record) in chunk.records.iter().enumerate() {
            if record.reason_index as usize >= self.meta.reasons.len() {
                return Err(GsrError::ReasonIndexOutOfBounds {
                    run_index: chunk.start_run + offset as u64,
                    reason_index: record.reason_index,
                    reason_count: self.meta.reasons.len(),
                });
            }
            total = total
                .checked_add(record.value)
                .ok_or(GsrError::ArithmeticOverflow {
                    field: "total result",
                })?;
        }
        self.chunks.push(chunk.clone());
        self.next_run = end;
        self.total_result = total;
        self.chunks_written += 1;
        Ok(())
    }

    fn finish(self) -> Result<GsrWriteSummary, GsrError> {
        if self.next_run != self.meta.total_runs {
            return Err(GsrError::MissingChunk {
                expected_start: self.next_run,
            });
        }
        Ok(GsrWriteSummary {
            total_runs: self.meta.total_runs,
            total_result: self.total_result,
            chunks_written: self.chunks_written,
            file_size: 0,
        })
    }
}
