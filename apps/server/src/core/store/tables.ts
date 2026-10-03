// Generated from schema.sql by pnpm db:types; a test fails if it differs.
export interface Tables {
  documents: {
    id: string;
    person_id: string;
    file_id: string;
    original_name: string;
    added_at: string;
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
}
