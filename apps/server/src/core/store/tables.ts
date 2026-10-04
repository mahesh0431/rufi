// Generated from schema.sql by pnpm db:types; a test fails if it differs.
export interface Tables {
  chosen_conversations: {
    person_id: string;
    conversation_id: string;
  };
  conversations: {
    id: string;
    person_id: string;
    title: string | null;
    provider: string;
    model: string;
    thread_id: string | null;
    thread_provider: string | null;
    thread_model: string | null;
    thread_tools: string | null;
    revision: number;
    created_at: string;
  };
  documents: {
    id: string;
    person_id: string;
    file_id: string;
    original_name: string;
    added_at: string;
  };
  drafts: {
    person_id: string;
    conversation_id: string | null;
    text: string;
    revision: number;
    updated_at: string;
  };
  files: {
    id: string;
    size: number;
    media_type: string;
    created_at: string;
  };
  people: {
    id: string;
    display_name: string;
  };
  reports: {
    id: string;
    person_id: string;
    document_id: string;
    issuer: string | null;
    collected: string | null;
  };
  results: {
    id: string;
    person_id: string;
    report_id: string | null;
    test_name: string;
    value_text: string;
    comparator: string | null;
    value_number: number | null;
    unit: string | null;
    reference_range: string | null;
    flag_text: string | null;
    context_text: string | null;
    measured_at: string | null;
    entered_at: string;
    replaces_id: string | null;
    group_label: string | null;
  };
  settings: {
    key: string;
    value: string;
  };
  transcript_entries: {
    id: string;
    person_id: string;
    conversation_id: string;
    seq: number;
    turn_id: string | null;
    kind: string;
    text: string;
    activity: string | null;
    detail: string | null;
    status: string | null;
    agent_item_id: string | null;
    revision: number;
    created_at: string;
    updated_at: string;
  };
  turns: {
    id: string;
    person_id: string;
    conversation_id: string;
    agent_turn_id: string;
    model: string;
    status: string;
    end_reason: string | null;
    end_text: string | null;
    resets_at: string | null;
    started_at: string;
    ended_at: string | null;
  };
}
