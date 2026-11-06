//! Events pushed from the core to whoever hosts it (Tauri window, test HTTP
//! server's SSE stream, CLI stdout). Job events always carry a full snapshot,
//! so a listener that misses one simply catches up with the next.

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::model::{EngineStatus, InstallStage, JobSnapshot, Settings};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
#[allow(clippy::large_enum_variant)]
pub enum CoreEvent {
    EngineProgress {
        component: String,
        stage: InstallStage,
        #[ts(type = "number")]
        downloaded: u64,
        #[ts(type = "number | null")]
        total: Option<u64>,
        message: Option<String>,
    },
    EngineStatus { status: EngineStatus },
    Job { job: JobSnapshot },
    JobRemoved { id: String },
    HistoryChanged,
    SettingsChanged { settings: Settings },
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<CoreEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1024);
        EventBus { tx }
    }

    pub fn emit(&self, event: CoreEvent) {
        // No subscribers is fine (CLI one-shot commands).
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.tx.subscribe()
    }
}
