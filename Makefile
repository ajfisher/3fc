.PHONY: help clean build test deploy install backlog-validate backlog-export backlog-sync-dry backlog-sync

BACKLOG_FILE ?= docs/backlog/backlog.json
REPO ?=

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Backlog targets:"
	@echo "  make backlog-validate                   Validate backlog JSON"
	@echo "  make backlog-export                     Generate docs/backlog/backlog.md from backlog JSON"
	@echo "  make backlog-sync-dry REPO=owner/repo  Print GitHub issue sync actions"
	@echo "  make backlog-sync REPO=owner/repo      Create labels/milestones/issues in GitHub"

clean:
	@echo "Not implemented yet"

build:
	@echo "Not implemented yet"

test:
	@echo "Not implemented yet"

deploy:
	@if [ -z "$(ENV)" ] || { [ "$(ENV)" != "qa" ] && [ "$(ENV)" != "prod" ]; }; then \
		echo "ENV must be set to qa or prod"; \
		exit 1; \
	fi
	@echo "Not implemented yet"

install:
	@echo "Not implemented yet"

backlog-validate:
	./scripts/github/validate_backlog.sh $(BACKLOG_FILE)

backlog-export:
	./scripts/github/export_backlog_markdown.sh $(BACKLOG_FILE)

backlog-sync-dry:
	@if [ -z "$(REPO)" ]; then \
		echo "REPO must be set (example: make backlog-sync-dry REPO=owner/repo)"; \
		exit 1; \
	fi
	./scripts/github/create_backlog_issues.sh --repo $(REPO) --backlog-file $(BACKLOG_FILE) --dry-run

backlog-sync:
	@if [ -z "$(REPO)" ]; then \
		echo "REPO must be set (example: make backlog-sync REPO=owner/repo)"; \
		exit 1; \
	fi
	./scripts/github/create_backlog_issues.sh --repo $(REPO) --backlog-file $(BACKLOG_FILE)

