# Tessera account and product-authorization service.
#
# The image contains no secrets: every credential arrives through the protected
# environment files described in deploy/README.md. Dependencies are installed
# from the pinned bun.lock at build time.
FROM oven/bun:1.4.2-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 tessera \
 && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/tessera --shell /usr/sbin/nologin tessera

WORKDIR /app

# Conservative default; the deployment sets NODE_ENV explicitly.
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

RUN chown -R tessera:tessera /app
USER tessera

EXPOSE 17436

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:17436/health/ready'); process.exit(response.ok ? 0 : 1)"]

CMD ["bun", "src/index.ts"]
