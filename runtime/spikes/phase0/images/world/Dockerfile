# Phase 0 probe world image. Not the Phase 2 world image: the inventory here is
# only what the probes need (shell, coreutils, Python, SQLite, procps).
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 sqlite3 procps util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 agent \
 && useradd -u 1000 -g 1000 -M -d /world -s /bin/sh agent
