-- run_events and audit_records are append-only (PRD §12.2): reject UPDATE, DELETE and TRUNCATE at the database.
CREATE FUNCTION nexus_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER run_events_append_only BEFORE UPDATE OR DELETE ON "run_events"
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER run_events_no_truncate BEFORE TRUNCATE ON "run_events"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_records_append_only BEFORE UPDATE OR DELETE ON "audit_records"
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_records_no_truncate BEFORE TRUNCATE ON "audit_records"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_forbid_mutation();
