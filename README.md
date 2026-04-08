# Wallet Accounting

Internes Buchhaltungs-Tool für alle Krypto-Wallets und den Binance-Account von 3blocks. Erfasst alle Transaktionen automatisch, klassifiziert sie (Eingang, Ausgang, Swap, interne Umbuchung) und ermöglicht die Abfrage des Saldos zu jedem beliebigen Zeitpunkt.

## Funktionsumfang

- Automatischer täglicher Sync aller On-Chain-Wallets (Polygon, BSC, Base, Arbitrum) via Alchemy
- Automatischer Sync des Binance-Accounts (Deposits, Withdrawals, Spot-Trades)
- Historische Preisermittlung in USD und EUR via CoinGecko
- Klassifizierung jeder Transaktion: `PAYMENT_IN`, `PAYMENT_OUT`, `INTERNAL`, `SWAP`
- Saldo-Abfrage pro Wallet und Asset zu jedem Datum
- Manueller Import via CSV als Fallback

## Voraussetzungen

- Node.js >= 18
- PostgreSQL
- Alchemy API Key (ein Key deckt alle 4 Netzwerke ab)
- Binance API Key mit Lesezugriff (sobald vorhanden)

## Setup

```bash
npm install
```

`.env` befüllen (Vorlage siehe unten), dann:

```bash
npx prisma migrate dev
npm run start:dev
```

## Umgebungsvariablen

```env
# Datenbank
DATABASE_URL="postgresql://user:pass@localhost:5432/wallet_accounting"

# Alchemy — ein Key für alle Netzwerke (Polygon, BSC, Base, Arbitrum)
ALCHEMY_API_KEY=""

# Binance — nur Lesezugriff benötigt (Spot + Transfers)
BINANCE_API_KEY=""
BINANCE_SECRET_KEY=""

# Kommagetrennte Spot-Trading-Pairs die gesynct werden
# Alle Pairs die jemals gehandelt wurden müssen hier stehen
BINANCE_SPOT_PAIRS="ETHUSDT,BNBUSDT,BTCUSDT,USDCUSDT,MATICUSDT,ARBUSDT"

# CoinGecko Demo-Key (optional, erhöht Rate-Limit)
# Kostenlos registrieren: https://www.coingecko.com/en/api/pricing
COINGECKO_API_KEY=""
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
| `POST` | `/transactions/import` | CSV-Datei importieren |

**Verfügbare `kind`-Filter:** `PAYMENT_IN`, `PAYMENT_OUT`, `INTERNAL`, `SWAP`

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

## CSV-Import

Als Alternative zum automatischen Sync kann eine CSV-Datei hochgeladen werden. Das Format:

```
date,wallet_address,source_type,direction,asset,amount,fee,fee_asset,price_usd,value_usd,price_eur,value_eur,network,from_address,to_address,tx_hash,operation,note
```

`source_type` beginnt mit `TYPE_BINANCE` für Binance-Einträge, sonst z.B. `TYPE_POLYGON`.

## Hinweise

- Gas-Gebühren für On-Chain-Transaktionen werden aktuell nicht erfasst (stehen auf 0). Das lässt sich mit `eth_getTransactionReceipt` nachrüsten.
- Für Stablecoins (USDT, USDC, etc.) wird 1 USD / 0.92 EUR als Näherungswert verwendet.
- Neue Token-Symbole ohne CoinGecko-Mapping werden mit Preis 0 gespeichert und in den Logs gewarnt. Mapping in `src/price/price.service.ts` erweitern.
