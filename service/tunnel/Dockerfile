FROM debian:bookworm-slim
ARG TUNNEL_UID=10001
ARG TUNNEL_GID=10001
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && test "$TUNNEL_UID" -gt 0 && test "$TUNNEL_GID" -gt 0 \
    && (getent group "$TUNNEL_GID" >/dev/null || groupadd --gid "$TUNNEL_GID" tunnel) \
    && useradd --uid "$TUNNEL_UID" --gid "$TUNNEL_GID" \
         --create-home --home-dir /home/tunnel --shell /usr/sbin/nologin tunnel \
    && mkdir -p /run/ssh \
    && ssh -V
USER tunnel
WORKDIR /home/tunnel
# Keys and known_hosts are bind mounts at runtime, never build inputs.
