
# Docker Build and Test Debugging Runbook

This document summarizes the Docker experiments done for this repo and converts them into a repeatable workflow for debugging local image builds and GHCR images.

## Goals

- Build and test the app image from local source.
- Compare behavior with the published image from GHCR.
- Quickly diagnose common failures (container startup, shell access, port exposure, env setup).

## What We Learned From The Experiments

- The image is Alpine-based, so use /bin/sh, not /bin/bash.
- Use docker rm (or docker container rm) to remove containers. Commands like docker delete, docker destroy, or docker remove do not exist.
- To pass host binding correctly, use HOST=0.0.0.0 (equal sign), not HOST:0.0.0.0.
- Port mapping is required for host access: -p 3000:3000.
- Supplying .env values is required for realistic startup testing.
- Testing both local and GHCR images with the same runtime flags makes behavior comparisons easier.

## Prerequisites

- Docker is installed and running.
- A valid .env file exists at repo root.
- You are in repo root.

## 1) Build And Test Local Image

Build the local image:

```bash
docker build -t safe-settings:local .
```

The image also includes the one-shot full-sync entrypoint. To preview a sync
without applying settings or starting the webhook server:

```bash
docker run --rm --env-file ./.env --env FULL_SYNC_NOP=true \
	safe-settings:local npm run full-sync
```

Run container in foreground with explicit runtime env and port mapping:

```bash
docker run --name safe-settings-local \
	--env-file ./.env \
	--env NODE_ENV=development \
	--env HOST=0.0.0.0 \
	-p 3000:3000 \
	-it safe-settings:local
```

If startup fails, inspect logs:

```bash
docker logs safe-settings-local
```

Shell into running container for investigation:

```bash
docker exec -it safe-settings-local /bin/sh
```

Clean up:

```bash
docker rm -f safe-settings-local
```

## 2) Pull And Test GHCR Image

Pull published image:

```bash
docker pull ghcr.io/github/safe-settings:2.1.19
```

Run with the same env and port flags used for local testing:

```bash
docker run --name safe-settings-ghcr \
	--env-file ./.env \
	--env NODE_ENV=development \
	--env HOST=0.0.0.0 \
	-p 3000:3000 \
	-it ghcr.io/github/safe-settings:2.1.19
```

Inspect logs:

```bash
docker logs safe-settings-ghcr
```

Debug inside container:

```bash
docker exec -it safe-settings-ghcr /bin/sh
```

Clean up:

```bash
docker rm -f safe-settings-ghcr
```

## 3) Fast Differential Debug (Local vs GHCR)

Use this when one image works and the other does not.

1. Run both images with identical flags (env, HOST, port mapping).
2. Compare startup logs side-by-side.
3. Compare environment inside each container:

```bash
docker exec -it safe-settings-local /bin/sh -c 'env | sort'
docker exec -it safe-settings-ghcr /bin/sh -c 'env | sort'
```

4. Confirm app process is listening on expected port inside container:

```bash
docker exec -it safe-settings-local /bin/sh -c 'netstat -lntp 2>/dev/null || ss -lntp'
docker exec -it safe-settings-ghcr /bin/sh -c 'netstat -lntp 2>/dev/null || ss -lntp'
```

5. Validate host reachability:

```bash
curl -i http://localhost:3000/
```

## 4) Common Failure Patterns And Fixes

Symptom: container exits immediately.
Likely causes:
- Missing required variables in .env.
- Invalid app credentials.
Checks:
- docker logs <container-name>
- Confirm .env has required app settings.

Symptom: cannot connect from host to localhost:3000.
Likely causes:
- Missing -p 3000:3000.
- App not binding to all interfaces.
Checks:
- Ensure HOST=0.0.0.0 is set.
- Ensure port mapping is present.

Symptom: cannot shell into container with bash.
Likely cause:
- Alpine image does not include bash.
Fix:
- Use /bin/sh.

Symptom: name conflict when re-running tests.
Likely cause:
- Old container still exists.
Fix:
- docker rm -f <container-name>

## 5) Minimal Known-Good Commands

Local:

```bash
docker build -t safe-settings:local . && \
docker run --rm --name safe-settings-local \
	--env-file ./.env \
	--env NODE_ENV=development \
	--env HOST=0.0.0.0 \
	-p 3000:3000 \
	-it safe-settings:local
```

GHCR:

```bash
docker pull ghcr.io/github/safe-settings:2.1.19 && \
docker run --rm --name safe-settings-ghcr \
	--env-file ./.env \
	--env NODE_ENV=development \
	--env HOST=0.0.0.0 \
	-p 3000:3000 \
	-it ghcr.io/github/safe-settings:2.1.19
```
