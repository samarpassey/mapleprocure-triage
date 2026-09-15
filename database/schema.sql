-- Triage state: one row per tender reference, recording what was decided about a notice, which
-- MapleProcure source record the decision was based on, and the notice text the model read. The
-- text is kept because this table is the review queue: a person reviews a row where it sits.
--
-- Status lifecycle (design doc "Workflow States", amended in docs/DESIGN-AMENDMENTS.md A1–A3):
--
--   PENDING ──classify──▶ AUTO_MATCH | NOT_RELEVANT                  decided without a human
--      │                  NEEDS_REVIEW | NEEDS_REVIEW_CONTRADICTION   review queue
--      │                  CLASSIFICATION_FAILED                       review queue
--      │                              └──review──▶ HUMAN_APPROVED | HUMAN_REJECTED
--      └──recovery gives up──▶ PROCESSING_FAILED
--
-- `status` is where a row is now. `routed_status` is what routing decided, and is not changed by
-- review, so a human decision does not erase whether the row reached the queue as uncertain,
-- contradictory or failed. Every write goes through a statement in database/queries/.

CREATE TABLE triage_results (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tender_reference      text        NOT NULL,
    status                text        NOT NULL DEFAULT 'PENDING',
    routed_status         text,
    routing_rule          text,       -- id of the rule in config/routing-rules.json that fired

    -- The notice as the search returned it, at claim time.
    title                 text        NOT NULL,
    buyer_name            text,
    closing_date          timestamp,  -- the source carries no time zone; stored as published
    notice_url            text,       -- null on ~6% of notices; never constructed
    matched_concepts      text[]      NOT NULL,  -- search-profile concepts that retrieved it

    -- Exactly the notice text sent to the model, from the MapleProcure detail response.
    notice_text           text,

    -- Classification output.
    category              text,
    relevance             text,
    rationale             text,
    criteria              jsonb,
    model_confidence      numeric(4, 3),  -- a floor on automatic routes only; see route.js
    validation_errors     jsonb,          -- set exactly when the output failed the contract
    model_output_raw      text,           -- what came back, kept when it failed the contract

    -- Model and run metadata.
    model_name            text,
    prompt_version        text,
    rules_version         text,
    input_sha256          text,       -- sha256 of notice_text, computed by the statement that stores it
    workflow_version      text,
    execution_id          text        NOT NULL,  -- the n8n execution currently holding the claim
    attempts              smallint    NOT NULL DEFAULT 1,

    -- Provenance, from the envelope of the MapleProcure response the model read.
    source_file           text,
    source_as_of          timestamptz,
    source_last_modified  timestamptz,
    source_row_count      integer,
    source_notes          jsonb,

    -- Human decision. The decision itself is the status: HUMAN_APPROVED or HUMAN_REJECTED.
    reviewed_by           text,
    reviewed_at           timestamptz,
    review_note           text,

    notification_sent_at  timestamptz,
    claimed_at            timestamptz NOT NULL DEFAULT now(),
    classified_at         timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT triage_results_reference_key UNIQUE (tender_reference),

    CONSTRAINT status_known CHECK (status IN (
        'PENDING', 'AUTO_MATCH', 'NOT_RELEVANT', 'NEEDS_REVIEW', 'NEEDS_REVIEW_CONTRADICTION',
        'CLASSIFICATION_FAILED', 'HUMAN_APPROVED', 'HUMAN_REJECTED', 'PROCESSING_FAILED')),
    CONSTRAINT routed_status_known CHECK (routed_status IN (
        'AUTO_MATCH', 'NOT_RELEVANT', 'NEEDS_REVIEW', 'NEEDS_REVIEW_CONTRADICTION',
        'CLASSIFICATION_FAILED')),
    CONSTRAINT relevance_known CHECK (relevance IN ('match', 'uncertain', 'not_relevant')),
    CONSTRAINT confidence_in_range CHECK (model_confidence BETWEEN 0 AND 1),
    CONSTRAINT attempts_positive CHECK (attempts >= 1),

    -- A row has a routing decision exactly when it got past classification.
    CONSTRAINT routed_once_classified CHECK (
        (status IN ('PENDING', 'PROCESSING_FAILED')) = (routed_status IS NULL)),
    -- The current status is the routed one, or a human decision on a row routed to review.
    CONSTRAINT status_follows_routing CHECK (
        routed_status IS NULL
        OR status = routed_status
        OR (status IN ('HUMAN_APPROVED', 'HUMAN_REJECTED')
            AND routed_status IN ('NEEDS_REVIEW', 'NEEDS_REVIEW_CONTRADICTION',
                                  'CLASSIFICATION_FAILED'))),
    CONSTRAINT reviewed_exactly_when_decided CHECK (
        (status IN ('HUMAN_APPROVED', 'HUMAN_REJECTED'))
        = (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
    -- Invariant 5: nothing is routed without the source it was based on.
    CONSTRAINT routed_rows_have_provenance CHECK (
        routed_status IS NULL
        OR (source_file IS NOT NULL AND source_as_of IS NOT NULL
            AND source_last_modified IS NOT NULL AND source_row_count IS NOT NULL
            AND model_name IS NOT NULL AND prompt_version IS NOT NULL
            AND rules_version IS NOT NULL AND input_sha256 IS NOT NULL
            AND notice_text IS NOT NULL AND classified_at IS NOT NULL)),
    CONSTRAINT routed_rows_have_classification CHECK (
        routed_status IS NULL
        OR routed_status = 'CLASSIFICATION_FAILED'
        OR (category IS NOT NULL AND relevance IS NOT NULL AND rationale IS NOT NULL
            AND criteria IS NOT NULL AND model_confidence IS NOT NULL
            AND routing_rule IS NOT NULL)),
    CONSTRAINT errors_exactly_when_failed CHECK (
        COALESCE(routed_status = 'CLASSIFICATION_FAILED', false)
        = (validation_errors IS NOT NULL)),
    CONSTRAINT notified_only_when_relevant CHECK (
        notification_sent_at IS NULL OR status IN ('AUTO_MATCH', 'HUMAN_APPROVED'))
);

CREATE FUNCTION triage_results_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END
$$;

CREATE TRIGGER triage_results_touch BEFORE UPDATE ON triage_results
    FOR EACH ROW EXECUTE FUNCTION triage_results_touch();

-- One index per query the workflow runs. Each partial predicate is written to match its query's
-- WHERE clause textually; database/tests/05-indexes.sql fails if a query can no longer use it.

-- queries/recover.sql — PENDING rows whose claim has gone stale.
CREATE INDEX triage_results_pending_idx
    ON triage_results (claimed_at)
    WHERE status = 'PENDING';

-- queries/review-queue.sql — soonest-closing first, undated last.
CREATE INDEX triage_results_review_queue_idx
    ON triage_results (closing_date ASC NULLS LAST, classified_at)
    WHERE status IN ('NEEDS_REVIEW', 'NEEDS_REVIEW_CONTRADICTION', 'CLASSIFICATION_FAILED');

-- queries/metrics-counts.sql — routed rows in a classification window, answerable from the index.
CREATE INDEX triage_results_metrics_idx
    ON triage_results (classified_at) INCLUDE (routed_status, status)
    WHERE routed_status IS NOT NULL;
