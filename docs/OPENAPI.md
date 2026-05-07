# OpenAPI / Swagger

The NestJS app exposes Swagger UI and the OpenAPI JSON document via `@nestjs/swagger`.

Local URLs:

```txt
http://localhost:3000/swagger
http://localhost:3000/swagger-json
```

Production URLs:

```txt
https://api.accounting.3blocks.net/swagger
https://api.accounting.3blocks.net/swagger-json
```

Production Swagger is protected by Traefik Basic Auth.

## Frontend type generation

The frontend repo contains a script that generates TypeScript types from this OpenAPI document:

```bash
cd ../accounting-3blocks-net
npm run generate:api
```

Default source is the local backend `http://localhost:3000/swagger-json`.
For another source:

```bash
OPENAPI_URL=https://api.accounting.3blocks.net/swagger-json npm run generate:api
```

## Quality note

The current OpenAPI document exists and is usable as a starting point. Some endpoints still use inline object return values or lack explicit response DTO classes. For higher-quality generated frontend types, prefer explicit DTO classes with `@ApiProperty()` and `@ApiResponse({ type: ... })` when endpoints change.
