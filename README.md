# 3blocks Wallet Accounting Backend

API und Datenquelle für das interne 3blocks Wallet Accounting. Das Backend erfasst On-Chain- und Binance-Transaktionen automatisch, klassifiziert sie (`PAYMENT_IN`, `PAYMENT_OUT`, `SWAP`, `INTERNAL`) und berechnet historische Salden zu beliebigen Stichtagen.

Das Frontend liegt im separaten Repo `accounting-3blocks-net`. Frontend und Backend bleiben getrennte Repositories und getrennt deploybar. Deployment-Details stehen in `docs/DEPLOYMENT.md`; Swagger/OpenAPI-Details in `docs/OPENAPI.md`.

## Funktionsumfang

- Automatischer täglicher Sync aller On-Chain-Wallets (Polygon, BSC, Base, Arbitrum) via Moralis
- Gas-Fees werden automatisch pro Transaktion berechnet (`receipt_gas_used × gas_price`)
- Automatischer Sync des Binance-Accounts (Deposits, Withdrawals, Spot-Trades)
- Historische Preisermittlung in USD und EUR via Alchemy Token Prices API
- Klassifizierung jeder Transaktion: `PAYMENT_IN`, `PAYMENT_OUT`, `INTERNAL`, `SWAP`
- Manuelle Nachkorrektur von Transaktionen per API
- Saldo-Abfrage pro Wallet und Asset zu jedem Datum

## Voraussetzungen

- Node.js >= 18
- PostgreSQL
- Moralis API Key (Pro Plan — für On-Chain Wallet History)
- Alchemy API Key (Growth Plan+ — nur für Token Prices, nicht für Transfers)
- Binance API Key mit Lesezugriff

## Setup

```bash
npm install
```

`.env` befüllen (Vorlage siehe unten), dann:

```bash
npx prisma migrate dev
npm run start:dev
```

Lokale API:

```txt
http://localhost:3000
```

Swagger/OpenAPI:

```txt
http://localhost:3000/swagger
http://localhost:3000/swagger-json
```

## Umgebungsvariablen

```env
# Datenbank
DATABASE_URL="postgresql://user:pass@localhost:5432/wallet_accounting"

# Alchemy — nur für Token Prices API (Growth Plan+), nicht für Transfers
ALCHEMY_API_KEY=""

# Moralis — On-Chain Wallet History für alle EVM-Chains (Pro Plan erforderlich)
# Registrieren: https://moralis.io
MORALIS_API_KEY=""

# Binance — nur Lesezugriff benötigt (Spot + Transfers)
BINANCE_API_KEY=""
BINANCE_SECRET_KEY=""

# Kommagetrennte Spot-Trading-Pairs die gesynct werden
# Alle Pairs die jemals gehandelt wurden müssen hier stehen
BINANCE_SPOT_PAIRS="ETHUSDT,BNBUSDT,BTCUSDT,USDCUSDT,MATICUSDT,ARBUSDT"

# EUR/USD-Näherungswert (Alchemy liefert nur USD)
EUR_USD_RATE="0.92"
```

## API-Endpunkte

### Sync

| Methode | Pfad | Beschreibung |
|---|---|---|
| `POST` | `/sync/trigger` | Manuellen Sync starten (alle Wallets + Binance) |

Der automatische Sync läuft täglich um **02:00 Uhr**.

### Transaktionen

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/transactions` | Alle Transaktionen (optional: `?kind=SWAP`) |
| `GET` | `/transactions/:txId` | Einzelne Transaktion mit allen Transfers |
| `PATCH` | `/transactions/:txId` | Transaktion nachkorrigieren |

**Verfügbare `kind`-Filter:** `PAYMENT_IN`, `PAYMENT_OUT`, `INTERNAL`, `SWAP`

**PATCH — editierbare Felder** (alle optional):

```json
{
  "kind": "PAYMENT_OUT",
  "note": "Gehalt März",
  "feeAsset": "BNB",
  "feeAmount": "0.0012",
  "feePayerAddress": "0x...",
  "feePayer": "3blocks Multisig",
  "priceUsd": "580",
  "valueUsd": "0.696",
  "priceEur": "534",
  "valueEur": "0.640"
}
```

### Portfolio / Saldo

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/portfolio/balances?date=2025-12-31` | Saldo aller Wallets zum Stichtag |

## Transaktionstypen

| Kind | Bedeutung |
|---|---|
| `PAYMENT_IN` | Eingang von einer externen Adresse |
| `PAYMENT_OUT` | Ausgang zu einer externen Adresse |
| `INTERNAL` | Umbuchung zwischen eigenen Wallets (kein realer Zu-/Abgang) |
| `SWAP` | Token gegen anderen Token getauscht (DEX oder Binance Spot) |

## Wallets

Die Wallet-Adressen und ihre Namen sind in `src/transactions/utils/wallets.ts` hinterlegt. Neue Wallets dort eintragen — sie werden beim nächsten Sync automatisch berücksichtigt.

## Hinweise

- Für Stablecoins (USDT, USDC, etc.) wird 1 USD / `EUR_USD_RATE` EUR als Näherungswert verwendet.
- Neue Token-Symbole ohne Alchemy-Preis-Mapping werden mit Preis 0 gespeichert und in den Logs gewarnt. Als Spam markierte Token können über `/spam-tokens` verwaltet werden.
- Nach dem ersten Start mit einem neuen `MORALIS_API_KEY` werden alle Transaktionen ab Firmengründung (Mai 2025) nachgeladen.
