# World image for the `shell-body-v5` body (plan §7.2). Its tools and their
# documentation are environmental content: a changed inventory is a changed
# world, recorded by the resulting image ID, which configurations pin.
#
# tini is the fixed entrypoint: as PID 1 it keeps the world available and
# reaps orphaned processes (Phase 2 jobs spike, J12).
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 sqlite3 procps tini util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 agent \
 && useradd -u 1000 -g 1000 -M -d /world -s /bin/sh agent \
 && mkdir -m 0755 /world \
 && mkdir -p /usr/share/alife \
 && dpkg-query -W -f '${Package}\t${Version}\t${Architecture}\n' | sort > /usr/share/alife/inventory.tsv
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
