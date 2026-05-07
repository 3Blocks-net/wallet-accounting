# Deployment

Frontend and backend are deployed as separate Docker images behind Traefik.

## Services

| Service | Domain | Container/Image | Port in container |
|---|---|---|---|
| Frontend | `accounting.3blocks.net` | `ghcr.io/3blocks-net/accounting.3blocks.net:latest` | `3000` |
| Backend API | `api.accounting.3blocks.net` | `ghcr.io/3blocks-net/api.accounting.3blocks.net:latest` | `3000` |
| PostgreSQL | internal only | `postgres:17.6-bookworm` | `5432` |

## Server layout

The production server uses Docker Compose projects for each app:

```txt
/root/docker/accounting/
  accounting-3blocks-net/
    docker-compose.yml
  api-accounting-3blocks-net/
    docker-compose.yml
    .env
```

The Docker networks `web` and `backend` are external networks shared with Traefik and the API/database stack.

## Traefik

- Frontend route: `Host(accounting.3blocks.net)`
- API route: `Host(api.accounting.3blocks.net)`
- Swagger route: `Host(api.accounting.3blocks.net) && PathPrefix(/swagger)`
- TLS is handled by Traefik/Let's Encrypt.
- Frontend and Swagger are protected by Basic Auth in the current deployment.

## Deploy flow

1. Build and publish a new image to GHCR.
2. SSH into the server.
3. Pull the new image and recreate the affected Compose project:

```bash
cd /root/docker/accounting/api-accounting-3blocks-net
docker compose pull
docker compose up -d
```

Frontend equivalent:

```bash
cd /root/docker/accounting/accounting-3blocks-net
docker compose pull
docker compose up -d
```

## Checks

```bash
docker ps
docker logs --tail=100 api-accounting-3blocks-net
docker logs --tail=100 postgres-accounting
```

## Data

PostgreSQL data is stored in the named Docker volume `api-accounting-3blocks-pgdata`.
Do not remove or recreate this volume during normal deployments.
