# Private Sync Server

Pierwotna wersja serwera synchronizacji vaultów Obsidiana.

## Uruchomienie

```bash
npm install
npm run syncctl -- setup --password "zmien-to-haslo"
npm run dev
```

Domyślnie serwer słucha na `http://127.0.0.1:8787`, a dane trzyma w `data/server.sqlite` i `data/blobs`.

## Najważniejsze elementy MVP

- `GET /api/v1/server-info`
- `POST /api/v1/auth/login`
- `POST /api/v1/devices/request`
- `POST /api/v1/devices/approve`
- `POST /api/v1/devices/revoke`
- `GET /api/v1/vaults`
- `GET /api/v1/vaults/:vaultId/changes?since=0`
- `POST /api/v1/vaults/:vaultId/sync-batches`
- `POST /api/v1/vaults/:vaultId/sync-batches/:batchId/upload`
- `POST /api/v1/vaults/:vaultId/sync-batches/:batchId/commit`
- `GET /api/v1/vaults/:vaultId/files/download?path=note.md`
- `GET /api/v1/vaults/:vaultId/files/history?path=note.md`
- `GET /api/v1/vaults/:vaultId/requests`
- `POST /api/v1/vaults/:vaultId/requests/:requestId/resolve`

WebSocket działa pod `/api/v1/events?token=DEVICE_TOKEN` i służy tylko do eventów.

## Komendy administracyjne

```bash
npm run syncctl -- setup --password "zmien-to-haslo"
npm run syncctl -- pairing-code create --ttl=10m
npm run syncctl -- initial-setup enable
```

To jest baza pod dalszy rozwój: staging batchy, globalne rewizje, historia plików, device tokeny, requesty decyzyjne i konflikty są już modelowane w bazie.
