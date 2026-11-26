-- ZCode 规范会话库（~/.zcode/cli/db/db.sqlite）里与来源锚相关的五张表和索引。
-- 2026-11-26 从本机库的 sqlite_master 原样导出（只有结构，没有数据）：
-- 锚适配器（src/tools/anchor-zcode.ts）的契约用例按它建临时库，结构变了用例会先红。

CREATE TABLE session (
        id text primary key,
        project_id text not null,
        workspace_id text,
        parent_id text,
        slug text not null,
        directory text not null,
        path text,
        title text not null,
        version text not null,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        revert text,
        permission text,
        time_created integer not null,
        time_updated integer not null,
        time_compacting integer,
        time_archived integer
      , task_type text not null default 'interactive', title_source text not null default 'first_input'
        check(title_source in ('default', 'first_input', 'generated', 'custom')), title_message_id text, time_title_updated integer, trace_id text, time_deleted integer, last_outcome text);
CREATE TABLE message (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      , sequence integer);
CREATE TABLE part (
        id text primary key,
        message_id text not null references message(id) on delete cascade,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      , sequence integer);
CREATE TABLE tool_usage (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        tool_call_id text not null,
        tool_name text not null,
        side_effect_scope text,
        read_only integer check(read_only in (0, 1)),
        destructive integer check(destructive in (0, 1)),
        approval_status text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_output_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_output_ms integer,
        exit_code integer,
        output_bytes integer not null default 0,
        stdout_bytes integer not null default 0,
        stderr_bytes integer not null default 0,
        truncated integer not null default 0 check(truncated in (0, 1)),
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        error_type text,
        error_code text,
        error_message text
      );
CREATE TABLE session_runtime_presence (
        session_id text not null,
        owner_id text not null,
        process_id integer not null,
        primary key(session_id, owner_id)
      );
CREATE INDEX message_session_sequence_idx
        on message(session_id, sequence, time_created, id);
CREATE INDEX message_session_time_created_id_idx
        on message(session_id, time_created, id);
CREATE INDEX part_message_id_id_idx on part(message_id, id);
CREATE INDEX part_message_sequence_idx
        on part(message_id, sequence, time_created, id);
CREATE INDEX part_session_idx on part(session_id);
CREATE INDEX part_session_message_sequence_idx
        on part(session_id, message_id, sequence);
CREATE INDEX session_parent_idx on session(parent_id);
CREATE INDEX session_project_idx on session(project_id);
CREATE INDEX session_task_type_idx on session(task_type);
CREATE INDEX session_trace_idx on session(trace_id);
CREATE INDEX session_workspace_idx on session(workspace_id);
CREATE UNIQUE INDEX tool_usage_session_tool_call_idx
        on tool_usage(session_id, tool_call_id);
CREATE INDEX tool_usage_session_turn_idx
        on tool_usage(session_id, turn_id);
CREATE INDEX tool_usage_started_tool_idx
        on tool_usage(started_at, tool_name)
