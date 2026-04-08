# CLAUDE.md — Wallet Accounting

## Zweck

Internes Buchhaltungs-Tool für alle Krypto-Wallets und den Binance-Account von 3blocks (gegründet Mai 2025). Erfasst Transaktionen automatisch, klassifiziert sie und berechnet Salden zu beliebigen Stichtagen.

## Tech-Stack

- NestJS 11 + TypeScript
- Prisma 6 + PostgreSQL
- Alchemy API (On-Chain-Daten)
- Binance REST API (Exchange-Daten)
- CoinGecko API (historische Preise)
- `@nestjs/schedule` 6 (Cronjob)

## Modulstruktur

```
src/
  app.module.ts              Root-Modul
  prisma/                    PrismaService + PrismaModule
  transactions/              Kern-Logik: Import, Klassifizierung, Persistenz
    transactions.service.ts  transformRawData(), findAll(), findByTxId()
    transactions.controller.ts  POST /import, GET /, GET /:txId
    types/index.ts           RawRow, AggregatedTx
    utils/wallets.ts         INTERNAL_WALLETS Map, isInternalAddress()
  portfolio/                 Saldoberechnung
    portfolio.service.ts     calculateBalances(date)
    portfolio.controller.ts  GET /portfolio/balances?date=
  alchemy/                   Alchemy API Client
    alchemy.service.ts       getTransfers(), getLatestBlock()
  binance/                   Binance API Client
    binance.service.ts       syncAll() → Deposits, Withdrawals, Spot-Trades
  price/                     CoinGecko Preisabfragen
    price.service.ts         getPrice(symbol, date) → {usd, eur}
  sync/                      Orchestrierung + Cronjob
    sync.service.ts          sync() → ruft Alchemy + Binance + Prices auf
    sync.controller.ts       POST /sync/trigger
    sync.module.ts           ScheduleModule.forRoot() hier registriert
```

## Datenmodell (Prisma)

```
Transaction
  txId         String  @id        (tx-Hash oder synthetische ID)
  date         DateTime
  sourceType   String             (TYPE_POLYGON, TYPE_BSC, TYPE_BASE, TYPE_ARBITRUM, TYPE_BINANCE_*)
  kind         String             (PAYMENT_IN | PAYMENT_OUT | INTERNAL | SWAP)
  network      String
  feeAsset     String?
  feeAmount    String?
  priceUsd/Eur String?            (Preis des Fee-Assets)
  valueUsd/Eur String?            (Wert der Gebühr)
  feePayerAddress/feePayer String?
  note         String?
  transfers    Transfer[]

Transfer
  id           String  @id @default(cuid())
  asset        String
  amount       String
  from         String             (Adresse oder 'BINANCE_WALLET')
  sender       String?            (lesbarer Name aus wallets.ts)
  to           String
  receiver     String?
  direction    String             (IN | OUT)
  operation    String?
  priceUsd/Eur String
  valueUsd/Eur String
  transactionId → Transaction
  @@unique([transactionId, asset, amount, from, to])

SyncState
  source       String  @unique    (z.B. 'POLYGON:0x123...' oder 'BINANCE')
  lastBlock    String?            (letzter verarbeiteter Block, hex)
  lastSyncedAt DateTime @updatedAt
```

## Kern-Konzept: RawRow → AggregatedTx → DB

Alle Datenquellen (CSV, Alchemy, Binance) werden in `RawRow[]` normalisiert. `TransactionsService.transformRawData()` gruppiert Rows nach `tx_hash` zu `AggregatedTx`, klassifiziert und speichert.

```
RawRow (eine Zeile = eine Seite einer Bewegung)
  → groupBy(tx_hash)
  → AggregatedTx mit transfers[]
  → Klassifizierung (siehe unten)
  → prisma.transaction.createMany (skipDuplicates)
  → prisma.transfer.createMany (skipDuplicates)
```

Duplikate sind sicher: unique constraint `[transactionId, asset, amount, from, to]` auf Transfer + `@id` auf Transaction verhindern doppelte Einträge auch bei mehrfachem Sync.

## Klassifizierungslogik (`transactions.service.ts`)

```
outgoing = transfers wo isInternalAddress(from)
incoming = transfers wo isInternalAddress(to)

SWAP      → tokenOut && tokenIn && verschiedene Assets
INTERNAL  → tokenOut && tokenIn && gleiche Assets
PAYMENT_OUT → nur tokenOut (interne Adresse sendet an extern)
PAYMENT_IN  → nur tokenIn  (extern sendet an interne Adresse)
```

`isInternalAddress()` gibt `true` für alle Adressen in `INTERNAL_WALLETS` mit `type === 'INTERNAL'` und für `'BINANCE_WALLET'`.

## Wallets (`src/transactions/utils/wallets.ts`)

`INTERNAL_WALLETS` ist eine `Map<string, WalletInfo>`. Adressen sind **lowercase**. Typen:
- `INTERNAL` — eigene On-Chain-Wallets (werden für Klassifizierung verwendet)
- `EXCHANGE` — Binance (wird für Sync ausgelassen, hat eigene BinanceService-Logik)

Neue Wallet hinzufügen: Eintrag in `INTERNAL_WALLETS` ergänzen. Beim nächsten Sync wird sie automatisch erfasst (ab Block 0 falls kein SyncState vorhanden).

## Alchemy (`src/alchemy/alchemy.service.ts`)

Unterstützte Netzwerke: `POLYGON`, `BSC`, `BASE`, `ARBITRUM`

- `getTransfers(network, address, 'from'|'to', fromBlock)` — paginiert via `pageKey`
- `getLatestBlock(network)` — für SyncState-Update
- Kategorien: `external` (Native Token) + `erc20`
- Gebühren werden **nicht** abgerufen (stehen auf 0). Für genaue Gas-Kosten: `eth_getTransactionReceipt` pro tx nachrüsten.

## Binance (`src/binance/binance.service.ts`)

- HMAC-SHA256 Signierung aller Requests
- Paginierung in 89-Tage-Chunks (Binance-API-Limit: 90 Tage)
- Initialer Sync ab `2025-05-01` (Firmengründung)
- **Deposits:** `GET /sapi/v1/capital/deposit/hisrec`, nur `status === 1`
- **Withdrawals:** `GET /sapi/v1/capital/withdraw/history`, nur `status === 6`
- **Spot-Trades:** `GET /api/v3/myTrades`, erfordert Symbol-Liste in `BINANCE_SPOT_PAIRS`

Spot-Trades erzeugen **zwei RawRows** mit demselben `tx_hash = BINANCE_TRADE:{id}` → werden zu einem `SWAP` aggregiert.

`BINANCE_SPOT_PAIRS` muss alle je gehandelten Pairs enthalten — die Binance-API bietet keinen Endpunkt, der alle Trades ohne Symbolangabe zurückgibt.

## PriceService (`src/price/price.service.ts`)

- CoinGecko `/coins/{id}/history?date={DD-MM-YYYY}`
- In-Memory-Cache: Key = `SYMBOL:DD-MM-YYYY`
- 300ms Delay zwischen Requests (Free-Tier: ~30 req/min)
- Stablecoins (USDT, USDC, BUSD, DAI, …): hardcoded 1.00 USD / 0.92 EUR
- Neues Token: Eintrag in `COINGECKO_IDS` in `price.service.ts` ergänzen

## SyncService (`src/sync/sync.service.ts`)

- Cronjob: `0 2 * * *` (täglich 02:00)
- Manuell: `POST /sync/trigger`
- Guard: `this.running` verhindert parallele Syncs
- Für jedes Wallet × Netzwerk: outgoing + incoming parallel, dann `lastBlock` in SyncState speichern
- Binance-`lastSyncedAt` wird in `SyncState` mit `source = 'BINANCE'` gespeichert

## Portfolio (`src/portfolio/portfolio.service.ts`)

`calculateBalances(date)` iteriert alle Transactions bis zum Stichtag und summiert Transfers:
- `isInternalAddress(from)` → Betrag abziehen
- `isInternalAddress(to)` → Betrag addieren

Gibt `Record<walletAddress, Record<asset, number>>` zurück.

## Häufige Aufgaben

**Neue Wallet tracken:**
1. Adresse (lowercase) in `src/transactions/utils/wallets.ts` → `INTERNAL_WALLETS` eintragen
2. `POST /sync/trigger` — synct ab Block 0 (kein vorheriger SyncState)

**Neues Token-Symbol für Preise:**
1. CoinGecko-ID ermitteln (URL: `coingecko.com/en/coins/{id}`)
2. Eintrag in `COINGECKO_IDS` in `src/price/price.service.ts` ergänzen

**Neues Binance Trading Pair:**
1. `BINANCE_SPOT_PAIRS` in `.env` um das Symbol erweitern
2. `POST /sync/trigger` — holt alle historischen Trades für das neue Pair

**Prisma Schema ändern:**
```bash
npx prisma migrate dev --name beschreibung
```

## Bekannte Einschränkungen / TODOs

- Gas-Gebühren für On-Chain-Txs sind 0 (kein `eth_getTransactionReceipt`)
- EUR/USD-Rate für Stablecoins ist statisch (0.92), nicht historisch
- BNB-Kommissionen bei Binance-Trades (wenn `commissionAsset` weder base noch quote ist) werden ignoriert
- Kein Retry-Mechanismus bei transienten API-Fehlern
