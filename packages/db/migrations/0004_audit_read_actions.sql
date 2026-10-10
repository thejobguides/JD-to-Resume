-- Audited READS by admins carry no human reason. The rule "admin actions need a reason" already exempted *.view and
-- e-mail reveals, but not the other automatic read records (user.timeline_view and every *.export: audit, usage,
-- coupon codes, saved content), so those requests failed with a 500 instead of being logged. Writes still need one.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_admin_reason CHECK (
  actor_type <> 'admin'
  OR action LIKE '%.view' OR action LIKE '%\_view' OR action LIKE '%.export' OR action LIKE '%\_export'
  OR action LIKE '%reveal%' OR action LIKE 'admin.login%'
  OR reason IS NOT NULL
);
