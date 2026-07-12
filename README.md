# Private Sync Server

Private Sync Server is a self-hosted backend for synchronizing Obsidian vaults with the Private Sync plugin.

Obsidian plugin: https://github.com/Haniewicz/PrivateSyncPlugin

The server stores the logical state of vaults in SQLite and keeps file contents as blobs on disk. It does not keep a one-to-one browsable Obsidian vault directory. The local vault is reconstructed and updated by the plugin from revisions fetched through the API.

<details>
<summary>Polski</summary>

Private Sync Server to prywatny backend synchronizacji vaultow Obsidiana dla pluginu Private Sync.

Plugin Obsidiana: https://github.com/Haniewicz/PrivateSyncPlugin

Serwer przechowuje logiczny stan vaultow w SQLite oraz tresc plikow jako bloby na dysku. Nie przechowuje gotowego katalogu vaulta Obsidiana jeden do jednego. Lokalny vault jest odtwarzany i aktualizowany przez plugin na podstawie rewizji pobieranych z API.

</details>

## Wymagania

- Linux VPS albo inny host z Node.js.
- Node.js 22 LTS lub nowszy.
- `npm`.
- `git`.
- Reverse proxy z HTTPS, np. Caddy albo Nginx, jesli serwer ma byc dostepny z internetu.
- Staly katalog danych, np. `/var/lib/private-sync-server`.

## Szybki start developerski

```bash
git clone https://github.com/Haniewicz/PrivateSyncServer.git
cd PrivateSyncServer
npm install
npm run syncctl -- setup --password "zmien-to-haslo"
npm run dev
```

Domyslnie serwer slucha na `http://127.0.0.1:8787`, a dane trzyma w `data/server.sqlite` i `data/blobs`.

## Instalacja produkcyjna krok po kroku

Ponizszy przyklad instaluje serwer w `/opt/private-sync-server`, dane trzyma w `/var/lib/private-sync-server`, a proces uruchamia przez systemd.

### 1. Zainstaluj pakiety systemowe

Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates build-essential
```

Zainstaluj Node.js 22 LTS. Przyklad przez NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

### 2. Utworz uzytkownika i katalogi

```bash
sudo useradd --system --home /opt/private-sync-server --shell /usr/sbin/nologin private-sync
sudo mkdir -p /opt/private-sync-server
sudo mkdir -p /var/lib/private-sync-server
sudo chown -R private-sync:private-sync /opt/private-sync-server /var/lib/private-sync-server
```

### 3. Pobierz kod

```bash
sudo -u private-sync git clone https://github.com/Haniewicz/PrivateSyncServer.git /opt/private-sync-server
cd /opt/private-sync-server
sudo -u private-sync npm ci
sudo -u private-sync npm run build
```

### 4. Skonfiguruj haslo serwera

Haslo musi miec co najmniej 8 znakow.

```bash
cd /opt/private-sync-server
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- setup --password "wstaw-mocne-haslo"
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- config show
```

`setup` tworzy baze SQLite, ustawia haslo serwera i wlacza initial setup dla pierwszego zaufanego urzadzenia. Pierwsze urzadzenie moze sparowac sie bez akceptacji z innego urzadzenia. Kolejne urzadzenia wymagaja akceptacji albo recovery pairing code.

### 5. Dodaj plik environment

```bash
sudo tee /etc/private-sync-server.env >/dev/null <<'EOF'
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server
TRUST_PROXY=true
AUTH_RATE_LIMIT_MAX=10
AUTH_RATE_LIMIT_WINDOW_SECONDS=60
PAIRING_STATUS_RATE_LIMIT_MAX=30
PAIRING_STATUS_RATE_LIMIT_WINDOW_SECONDS=60
EOF
sudo chmod 600 /etc/private-sync-server.env
```

Najwazniejsze zmienne:

- `HOST` - adres nasluchiwania aplikacji, domyslnie `127.0.0.1`.
- `PORT` - port aplikacji, domyslnie `8787`.
- `PRIVATE_SYNC_DATA_DIR` - katalog danych, domyslnie `./data`.
- `DATABASE_PATH` - opcjonalna sciezka do SQLite, domyslnie `$PRIVATE_SYNC_DATA_DIR/server.sqlite`.
- `BLOB_DIR` - opcjonalny katalog blobow, domyslnie `$PRIVATE_SYNC_DATA_DIR/blobs`.
- `TRUST_PROXY` - ustaw `true`, gdy serwer stoi za reverse proxy.

### 6. Dodaj service systemd

```bash
sudo tee /etc/systemd/system/private-sync-server.service >/dev/null <<'EOF'
[Unit]
Description=Private Sync Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=private-sync
Group=private-sync
WorkingDirectory=/opt/private-sync-server
EnvironmentFile=/etc/private-sync-server.env
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/private-sync-server /opt/private-sync-server

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now private-sync-server.service
sudo systemctl status private-sync-server.service
```

### 7. Skonfiguruj HTTPS reverse proxy

Przyklad Caddy:

```caddyfile
sync.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Przyklad Nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name sync.example.com;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

WebSocket dziala pod `/api/v1/events?token=DEVICE_TOKEN`, dlatego reverse proxy musi obslugiwac upgrade HTTP.

### 8. Sprawdz instalacje

```bash
curl https://sync.example.com/api/v1/server-info
cd /opt/private-sync-server
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- password http-verify --url "https://sync.example.com"
```

W pluginie Obsidiana wpisz `Server URL` jako `https://sync.example.com`.

## Aktualizacja serwera

```bash
cd /opt/private-sync-server
sudo -u private-sync git pull --ff-only origin master
sudo -u private-sync npm ci
sudo -u private-sync npm run build
sudo systemctl restart private-sync-server.service
sudo systemctl status private-sync-server.service
curl https://sync.example.com/api/v1/server-info
```

Migracje SQLite sa wykonywane automatycznie przy starcie procesu.

## Backup i odtwarzanie

Backup musi obejmowac jednoczesnie:

- baze SQLite, domyslnie `/var/lib/private-sync-server/server.sqlite`,
- katalog blobow, domyslnie `/var/lib/private-sync-server/blobs`,
- katalog staging, jesli chcesz zachowac niedokonczone uploady, domyslnie `/var/lib/private-sync-server/staging`.

Najprostszy backup przy zatrzymanej usludze:

```bash
sudo systemctl stop private-sync-server.service
sudo tar -czf private-sync-backup-$(date +%F).tar.gz -C /var/lib private-sync-server
sudo systemctl start private-sync-server.service
```

Przy backupie online uzyj narzedzia obslugujacego spojny snapshot filesystemu albo SQLite backup API. Nie kopiuj samego katalogu `blobs` bez odpowiadajacej mu bazy SQLite.

## Komendy administracyjne

Uruchamiaj komendy z tym samym `PRIVATE_SYNC_DATA_DIR`, ktorego uzywa systemd:

```bash
cd /opt/private-sync-server

sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- config show
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- password verify
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- password reset
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- password reset --password "nowe-haslo"
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- password http-verify --url "https://sync.example.com"
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- pairing-code create --ttl=10m
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- initial-setup enable
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- initial-setup disable
```

`pairing-code create` tworzy jednorazowy recovery pairing code. Taki kod pozwala sparowac nowe urzadzenie bez akceptacji na innym urzadzeniu, ale nadal wymaga hasla serwera w pluginie.

`password reset` zmienia glowne haslo logowania do serwera. Nie uniewaznia istniejacych `device_token` i nie odzyskuje ani nie zmienia kluczy szyfrowania danych.

## API i funkcje

Najwazniejsze endpointy:

- `GET /api/v1/server-info`
- `POST /api/v1/auth/login`
- `POST /api/v1/devices/request`
- `POST /api/v1/devices/approve`
- `POST /api/v1/devices/revoke`
- `POST /api/v1/devices/restore`
- `POST /api/v1/devices/delete`
- `GET /api/v1/devices`
- `GET /api/v1/vaults`
- `POST /api/v1/vaults`
- `POST /api/v1/vaults/:vaultId/rename`
- `POST /api/v1/vaults/:vaultId/delete`
- `GET /api/v1/vaults/:vaultId/community-plugins`
- `PUT /api/v1/vaults/:vaultId/community-plugins`
- `POST /api/v1/vaults/:vaultId/connection-assessment`
- `POST /api/v1/vaults/:vaultId/sync-state`
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

Funkcje serwera:

- wiele server-vaultow,
- device tokens,
- recovery pairing code,
- batch upload i commit,
- chunked upload/download duzych plikow,
- globalne rewizje vaulta,
- historia plikow,
- konflikty i requesty decyzyjne,
- ocena bezpieczenstwa laczenia lokalnego vaulta z server-vaultem,
- katalog community pluginow i JSON-owych plikow ustawien,
- metadane klientowego szyfrowania i rotacji kluczy.

## Jak dziala backend

Serwer dziala jako pojedyncza aplikacja Node.js/Fastify.

- Baza metadanych to SQLite.
- Tresc plikow jest trzymana w katalogu blobow po SHA-256.
- WebSocket nie przesyla plikow. Sluzy tylko do eventow, np. `vault_changed`, `request_created`, `conflict_created`.
- Realne operacje synchronizacji ida przez HTTP API.
- Upload zmian odbywa sie batchami:
  - plugin tworzy batch z lista operacji,
  - wysyla tresci zmienionych plikow do staging area,
  - prosi serwer o commit batcha,
  - serwer waliduje batch i publikuje nowa globalna rewizje vaulta.
- Jesli batch jest przerwany w polowie, niedokonczone pliki stagingowe nie staja sie aktualnym stanem vaulta.
- Serwer wykrywa konflikty przez porownanie `base_revision_id` z aktualna rewizja pliku na serwerze.
- Serwer wykrywa potencjalnie niebezpieczne operacje, np. masowe usuwanie, i zatrzymuje batch do decyzji uzytkownika.

## Dobor VPS

Dla jednej osoby i kilku urzadzen zwykle wystarczy:

- 1 vCPU,
- 1-2 GB RAM,
- 20-40 GB SSD plus miejsce na historie i backupy,
- regularny backup katalogu danych.

Dla kilku osob albo duzego vaulta z zalacznikami lepiej zaczac od:

- 2 vCPU,
- 2-4 GB RAM,
- 80+ GB SSD/NVMe,
- limit uploadu dopasowany do najwiekszych plikow,
- automatyczne backupy SQLite i blob storage.

Przy wiekszym uzyciu warto rozwazyc PostgreSQL, object storage dla blobow, kolejke workerow, quota per uzytkownik, metryki i alerty.

## Diagnostyka

Logi systemd:

```bash
sudo journalctl -u private-sync-server.service -f
```

Jesli plugin zwraca `invalid_password`, sprawdz czy CLI i publiczny URL korzystaja z tej samej bazy:

```bash
cd /opt/private-sync-server
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- config show
curl https://sync.example.com/api/v1/server-info
sudo -u private-sync PRIVATE_SYNC_DATA_DIR=/var/lib/private-sync-server npm run syncctl -- password http-verify --url "https://sync.example.com"
```

Porownaj `instanceId` z `config show` i `/server-info`. Jesli jest rozny, CLI i publiczny URL trafiaja w inne instancje albo inne bazy.

Po `password reset` restart serwera nie jest wymagany, bo hash hasla jest czytany z bazy przy kazdym logowaniu.
