# Use the three-part version from https://github.com/aws/aws-emulator/releases (versions.json lists
# a fourth component, e.g. 1.0.385.1, that the package file names do not carry).
ARG AWS_EMULATOR_VERSION=1.0.610

FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal@sha256:158a9044f9dc0777f098b76c8b54346f6ed4560b9a6a416dec7a5ba3bc483af4 AS base

FROM base AS verified
ARG AWS_EMULATOR_VERSION
ARG TARGETARCH
# This base image ships gnupg2-minimal (no gpg-agent, no gpgv), so `gpg --import` as written in the
# user guide fails here. Dearmor the key into a keyring file and verify against that instead.
# VALIDSIG's last field is the primary-key fingerprint of the key that made the signature.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    url="https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/aws-emulator-${AWS_EMULATOR_VERSION}-1-${arch}.rpm"; \
    curl -fsSL --retry 3 -o /tmp/aws-emulator.rpm "$url"; \
    curl -fsSL --retry 3 -o /tmp/aws-emulator.rpm.sig "$url.sig"; \
    curl -fsSL --retry 3 -o /tmp/aws-publishing.asc https://downloads.aws.com/keys/gpg/current.asc; \
    export GNUPGHOME=/tmp/gnupg; mkdir -m 700 "$GNUPGHOME"; \
    gpg --batch --no-autostart --dearmor < /tmp/aws-publishing.asc > /tmp/aws-publishing.gpg; \
    gpg --batch --no-autostart --no-default-keyring --keyring /tmp/aws-publishing.gpg \
        --status-fd 1 --verify /tmp/aws-emulator.rpm.sig /tmp/aws-emulator.rpm \
        > /tmp/verify.status 2> /tmp/verify.log \
      || { cat /tmp/verify.log /tmp/verify.status >&2; exit 1; }; \
    grep -Eq '^\[GNUPG:\] VALIDSIG .* 98BCF336A3BE53B734E967C52E5BF49BD940F624$' /tmp/verify.status \
      || { echo "package is not signed by the pinned AWS publishing key" >&2; cat /tmp/verify.status >&2; exit 1; }

FROM base
RUN --mount=type=bind,from=verified,source=/tmp/aws-emulator.rpm,target=/tmp/aws-emulator.rpm \
    rpm -i /tmp/aws-emulator.rpm && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator \
    EMULATOR_TELEMETRY=off
EXPOSE 9297
# -b 0.0.0.0 so Docker can forward the port.
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0", "--telemetry", "off"]
