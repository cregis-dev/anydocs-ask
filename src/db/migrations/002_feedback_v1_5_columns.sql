-- ============================================================================
-- 002_feedback_v1_5_columns.sql — feedback table extensions for v1.5 loop
-- ============================================================================
-- Mirrors ARCHITECTURE.md §15.2.1 + RFC docs/rfcs/0001-feedback-loop-v0.2.md §4.4.
-- 0.2.0-alpha.0 — purely additive. Consumers (reranker / diagnose) arrive in 0.3;
-- 0.2 only fills these columns when feedback.enabled = true (PRD §11.4 #6).
--
-- All ADD COLUMN form, no data backfill needed:
--   - signal_source NOT NULL DEFAULT 'explicit' — pre-existing rows came in
--     through /v1/ask/feedback (β-channel), so 'explicit' is the correct
--     historical interpretation.
--   - The other four are nullable; null = "not yet relevant for this row".
-- ============================================================================

ALTER TABLE feedback ADD COLUMN signal_source   TEXT NOT NULL DEFAULT 'explicit';
-- 'explicit' (β) | 'implicit' (γ) | 'curated' (审核通过后新增的衍生行)

ALTER TABLE feedback ADD COLUMN reviewed_at     INTEGER;
-- unix ms; set by `feedback import` when a row is moved to approved/rejected

ALTER TABLE feedback ADD COLUMN review_decision TEXT;
-- NULL | 'approved' | 'rejected'

ALTER TABLE feedback ADD COLUMN session_id      TEXT;
-- γ 关联键；同 session 5min 内重问检测的主键。null 对 β 行无意义。

ALTER TABLE feedback ADD COLUMN cluster_id      TEXT;
-- RFC §4.4: 同簇关联 'curated' 行与原始 β/γ 行。format: <YYYY>-W<II>-<NNN>

CREATE INDEX idx_feedback_session       ON feedback(session_id);
CREATE INDEX idx_feedback_cluster       ON feedback(cluster_id);
CREATE INDEX idx_feedback_signal_source ON feedback(signal_source);
