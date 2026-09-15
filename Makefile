.PHONY: help db-apply db-test test workflow label

COMPOSE ?= docker compose
# No psql on the host: every SQL target runs the client inside the Postgres container.
PSQL = $(COMPOSE) exec -T postgres psql -U n8n -v ON_ERROR_STOP=1 --quiet

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

db-apply:  ## Apply database/schema.sql to the triage database
	$(PSQL) -d triage --single-transaction -f - < database/schema.sql

db-test:  ## SQL assertions against a scratch database on the running Postgres
	$(COMPOSE) exec -T postgres rm -rf /tmp/database
	$(COMPOSE) cp database postgres:/tmp/database
	@set -e; for f in database/tests/[0-9]*.sql; do \
		echo "== $$f"; \
		$(PSQL) -d postgres -c 'DROP DATABASE IF EXISTS triage_test' -c 'CREATE DATABASE triage_test'; \
		$(PSQL) -d triage_test --single-transaction -f /tmp/database/schema.sql; \
		$(PSQL) -d triage_test -f /tmp/$$f; \
	done
	$(PSQL) -d postgres -c 'DROP DATABASE triage_test'

test:  ## JavaScript module tests, Python tests, and the file-size cap
	node --test workflows/code/test/
	python3 -m unittest discover -s evaluation/tests -t .

workflow:  ## Generate workflows/procurement-triage.json from config/, the modules and the queries
	node workflows/build.js

label:  ## Label the evaluation set, one notice at a time, resumably
	python3 -m evaluation.label
