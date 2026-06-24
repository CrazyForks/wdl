use serde_json::json;

use crate::{AppState, LogLevel, SchedulerError, SchedulerResult, json_usize, log, now_ms};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct WorkflowTickSummary {
    pub(crate) dispatched: usize,
    pub(crate) completed: usize,
    pub(crate) failed: usize,
    pub(crate) suspended: usize,
    pub(crate) due_moved: usize,
    pub(crate) retention_cleaned: usize,
    pub(crate) do_alarm_due_moved: usize,
    pub(crate) do_alarm_dispatched: usize,
    pub(crate) do_alarm_delivered: usize,
    pub(crate) do_alarm_retried: usize,
    pub(crate) do_alarm_discarded: usize,
    pub(crate) do_alarm_skipped: usize,
}

impl WorkflowTickSummary {
    pub(crate) fn has_activity(self) -> bool {
        self.dispatched > 0
            || self.completed > 0
            || self.failed > 0
            || self.suspended > 0
            || self.due_moved > 0
            || self.retention_cleaned > 0
            || self.do_alarm_due_moved > 0
            || self.do_alarm_dispatched > 0
            || self.do_alarm_delivered > 0
            || self.do_alarm_retried > 0
            || self.do_alarm_discarded > 0
            || self.do_alarm_skipped > 0
    }
}

pub(crate) async fn workflows_tick(state: AppState) -> SchedulerResult<WorkflowTickSummary> {
    let Some(host) = state.config.workflows_host.clone() else {
        return Ok(WorkflowTickSummary::default());
    };
    let response = crate::post_remote_tick(
        &state,
        &host,
        state.config.workflows_port,
        "/internal/workflows/tick",
        "workflow-tick",
        "Workflow tick failed",
    )
    .await?;
    let status = response.status;
    let body = response.body;
    let duration_ms = now_ms() - response.started_at_ms;
    let summary = WorkflowTickSummary {
        dispatched: json_usize(body.get("dispatched")),
        completed: json_usize(body.get("completed")),
        failed: json_usize(body.get("failed")),
        suspended: json_usize(body.get("suspended")),
        due_moved: json_usize(body.get("dueMoved")),
        retention_cleaned: json_usize(body.get("retentionCleaned")),
        do_alarm_due_moved: json_usize(body.get("doAlarmDueMoved")),
        do_alarm_dispatched: json_usize(body.get("doAlarmDispatched")),
        do_alarm_delivered: json_usize(body.get("doAlarmDelivered")),
        do_alarm_retried: json_usize(body.get("doAlarmRetried")),
        do_alarm_discarded: json_usize(body.get("doAlarmDiscarded")),
        do_alarm_skipped: json_usize(body.get("doAlarmSkipped")),
    };
    let outcome = if status.is_success() { "ok" } else { "error" };
    log(
        &state,
        if summary.has_activity() || !status.is_success() {
            LogLevel::Info
        } else {
            LogLevel::Debug
        },
        "workflow_tick",
        json!({
            "request_id": response.request_id,
            "outcome": outcome,
            "status": status.as_u16(),
            "dispatched": summary.dispatched,
            "completed": summary.completed,
            "failed": summary.failed,
            "suspended": summary.suspended,
            "due_moved": summary.due_moved,
            "retention_cleaned": summary.retention_cleaned,
            "do_alarm_due_moved": summary.do_alarm_due_moved,
            "do_alarm_dispatched": summary.do_alarm_dispatched,
            "do_alarm_delivered": summary.do_alarm_delivered,
            "do_alarm_retried": summary.do_alarm_retried,
            "do_alarm_discarded": summary.do_alarm_discarded,
            "do_alarm_skipped": summary.do_alarm_skipped,
            "duration_ms": duration_ms,
        }),
    );
    if status.is_success() {
        return Ok(summary);
    }
    Err(SchedulerError::internal_error(format!(
        "Workflow tick returned {}: {}",
        status.as_u16(),
        response.text
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_tick_summary_marks_any_work_as_activity() {
        assert!(!WorkflowTickSummary::default().has_activity());
        assert!(
            WorkflowTickSummary {
                due_moved: 1,
                ..WorkflowTickSummary::default()
            }
            .has_activity()
        );
        assert!(
            WorkflowTickSummary {
                retention_cleaned: 1,
                ..WorkflowTickSummary::default()
            }
            .has_activity()
        );
        assert!(
            WorkflowTickSummary {
                dispatched: 1,
                ..WorkflowTickSummary::default()
            }
            .has_activity()
        );
    }
}
