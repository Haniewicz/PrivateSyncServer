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
- `POST /api/v1/vaults/:vaultId/sync-batches/:batchId/chunked-upload`
- `PUT /api/v1/vaults/:vaultId/sync-batches/:batchId/chunked-upload/:uploadId/chunks/:chunkIndex`
- `POST /api/v1/vaults/:vaultId/sync-batches/:batchId/chunked-upload/:uploadId/finish`
- `POST /api/v1/vaults/:vaultId/sync-batches/:batchId/commit`
- `GET /api/v1/vaults/:vaultId/files/download?path=note.md`
- `GET /api/v1/vaults/:vaultId/files/history?path=note.md`
- `GET /api/v1/vaults/:vaultId/requests`
- `POST /api/v1/vaults/:vaultId/requests/:requestId/resolve`

WebSocket działa pod `/api/v1/events?token=DEVICE_TOKEN` i służy tylko do eventów.

## Jak działa backend i jak oszacować VPS

Ten backend jest prywatnym serwerem synchronizacji vaultów Obsidiana. Nie renderuje stron i nie wykonuje ciężkiej logiki UI. Jego główne zadania to przyjmowanie zmian z pluginów, zapisywanie metadanych w SQLite, zapisywanie treści plików jako bloby na dysku, tworzenie globalnych rewizji vaulta oraz informowanie innych urządzeń przez WebSocket, że powinny pobrać zmiany przez API.

### Model pracy

- Serwer działa jako pojedyncza aplikacja Node.js/TypeScript oparta o Fastify.
- Baza metadanych to lokalny plik SQLite: `data/server.sqlite`.
- Treść plików jest trzymana poza bazą w katalogu blobów: `data/blobs`.
- Pliki są identyfikowane po SHA-256 treści, więc ta sama zawartość nie musi być zapisywana drugi raz.
- WebSocket nie przesyła plików. Służy tylko do krótkich eventów, np. `vault_changed`, `request_created`, `conflict_created`.
- Realne operacje synchronizacji idą przez HTTP API.
- Każde urządzenie ma osobny `device_token`.
- Upload zmian odbywa się batchami:
  - plugin tworzy batch z listą operacji,
  - wysyła treści zmienionych plików do staging area,
  - prosi serwer o commit batcha,
  - serwer waliduje batch i dopiero wtedy publikuje nową globalną rewizję vaulta.
- Jeśli batch jest przerwany w połowie, niedokończone pliki stagingowe nie stają się aktualnym stanem vaulta.
- Duże uploady mogą być wysyłane w chunkach. Serwer zapisuje części w `data/staging`, składa finalny blob na dysku i weryfikuje hash oraz rozmiar przed oznaczeniem pliku jako staged.
- Download pliku obsługuje nagłówek `Range`, więc klient może pobierać duże pliki fragmentami.
- Serwer wykrywa konflikty przez porównanie `base_revision_id` z aktualną rewizją pliku na serwerze.
- Serwer wykrywa potencjalnie niebezpieczne operacje, np. masowe usuwanie, i zatrzymuje batch do decyzji użytkownika.

### Co obciąża serwer

Najważniejsze źródła obciążenia:

- upload i download plików,
- zapis/odczyt blobów z dysku,
- zapis/odczyt części uploadu w `data/staging` dla dużych plików,
- obliczanie SHA-256 uploadowanych treści,
- transakcje SQLite podczas commitowania batchy,
- liczba jednocześnie podłączonych urządzeń WebSocket,
- liczba plików i rewizji w vaultcie,
- rozmiar historii wersji,
- częstotliwość zmian lokalnych na urządzeniach.

Node.js nie powinien być głównym ograniczeniem dla małego prywatnego wdrożenia. Wąskim gardłem szybciej będzie dysk VPS, przepustowość sieci, rozmiar uploadów/downloadów i liczba zapisów do SQLite.

### Charakterystyka ruchu

Typowy sync jednego urządzenia wygląda tak:

1. Plugin skanuje lokalne zmiany i buduje batch.
2. Plugin wysyła `POST /sync-batches` z metadanymi operacji.
3. Dla każdego zmienionego pliku plugin wysyła `POST /upload`.
4. Plugin wysyła `POST /commit`.
5. Serwer zapisuje rewizję globalną i rozsyła krótki event `vault_changed`.
6. Inne urządzenia robią `GET /changes?since=last_applied_revision`.
7. Jeśli potrzebują treści pliku, pobierają ją przez `GET /files/download`.

WebSockety utrzymują otwarte połączenia, ale w normalnej pracy generują bardzo mały ruch. Większy ruch pojawia się dopiero przy synchronizacji plików.

### Parametry potrzebne do dobrania VPS

Żeby ocenić minimalną specyfikację VPS, trzeba znać:

- liczba użytkowników,
- liczba urządzeń na użytkownika,
- ile urządzeń może synchronizować jednocześnie,
- rozmiar vaulta,
- liczba plików w vaultcie,
- średni rozmiar pliku,
- największy spodziewany plik,
- dzienna liczba zmian,
- ile danych dziennie będzie uploadowane,
- ile danych dziennie będzie pobierane przez inne urządzenia,
- czy synchronizowane będą głównie pliki Markdown, czy też dużo załączników,
- jak długo ma być trzymana historia wersji,
- czy VPS ma obsługiwać tylko API, czy także reverse proxy, TLS, backupy i monitoring.

Przykładowy opis do estymacji:

```text
Backend: Node.js/Fastify, SQLite, lokalny filesystem blob storage.
Rola: prywatny serwer synchronizacji Obsidiana.
Użytkownicy: X.
Urządzenia: Y na użytkownika.
Jednoczesne urządzenia online: Z.
Vault: N plików, łącznie S GB.
Największy plik: M MB.
Zmiany dziennie: C plików / D MB uploadu.
Historia: np. 100 wersji dla małych plików Markdown, ograniczona historia załączników.
Ruch: WebSocket tylko eventy, pliki przez HTTP upload/download.
Storage: SQLite dla metadanych, bloby na dysku po SHA-256.
Wymagania: prywatny sync, niska/średnia liczba użytkowników, ważniejsza niezawodność dysku i backup niż duża moc CPU.
```

### Orientacyjne klasy VPS

Dla jednej osoby i kilku urządzeń zwykle wystarczy mały VPS:

- 1 vCPU,
- 1-2 GB RAM,
- 20-40 GB SSD plus miejsce na historię i backupy,
- regularny backup katalogu `data/`.

Dla kilku osób albo dużego vaulta z załącznikami lepiej zacząć od:

- 2 vCPU,
- 2-4 GB RAM,
- 80+ GB SSD/NVMe,
- limit uploadu dopasowany do największych plików,
- automatyczne backupy SQLite i blob storage.

Dla większego użycia warto rozważyć:

- PostgreSQL zamiast SQLite,
- osobny object storage dla blobów,
- worker queue dla cięższych zadań,
- limity rate-limit i quota per użytkownik,
- metryki, log rotation i alerty.

### Ważne uwagi produkcyjne

- SQLite jest dobrym wyborem na prywatny MVP, ale przy wielu równoczesnych zapisach PostgreSQL będzie bezpieczniejszym kierunkiem.
- Katalog `data/` jest krytyczny: zawiera bazę metadanych i treści plików.
- Backup musi obejmować jednocześnie `data/server.sqlite` i `data/blobs`.
- Serwer powinien stać za reverse proxy z HTTPS, np. Caddy albo Nginx.
- Warto ograniczyć maksymalny rozmiar uploadu na reverse proxy zgodnie z `maxUploadSize`.
- WebSocket wymaga poprawnego proxy upgrade.
- Obecna wersja jest szkieletem MVP, nie gotowym hardened deploymentem.

## Komendy administracyjne

```bash
npm run syncctl -- setup --password "zmien-to-haslo"
npm run syncctl -- pairing-code create --ttl=10m
npm run syncctl -- initial-setup enable
```

To jest baza pod dalszy rozwój: staging batchy, globalne rewizje, historia plików, device tokeny, requesty decyzyjne i konflikty są już modelowane w bazie.
