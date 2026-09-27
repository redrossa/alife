# Storage helper image for `loop-ext4-volume-v1`: mkfs/dumpe2fs to provision
# and inspect backing images (unprivileged), losetup/blkid for the explicitly
# authorized privileged attach helper, and tar for stopped-world capture. It
# never runs agent code.
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache e2fsprogs e2fsprogs-extra tar coreutils losetup blkid \
 && mkdir -p /usr/share/alife \
 && apk info -v | sort > /usr/share/alife/inventory.txt
