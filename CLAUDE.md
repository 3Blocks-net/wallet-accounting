# CLAUDE.md — Wallet Accounting Backend

## Zweck

Internes Buchhaltungs-Tool für alle Krypto-Wallets und den Binance-Account von 3blocks (gegründet Mai 2025). Erfasst Transaktionen on-chain (Alchemy) und auf Binance automatisch, klassifiziert sie (PAYMENT_IN / PAYMENT_OUT / SWAP / INTERNAL) und berechnet historische Salden zu beliebigen Stichtagen.

---

## Tech-Stack

- **NestJS 11** + TypeScript
- **Prisma 6** + PostgreSQL
- **Alchemy API** — On-Chain-Transfers (polygon-mainnet, bnb-mainnet, base-mainnet, arb-mainnet)
- **Alchemy Token Prices API v1** — historische Tagespreise (Growth Plan+ erforderlich)
- **Etherscan API V2** — Gas-Fees und interne Transfers (ein Key für alle EVM-Chains)
- **Binance REST API** — Deposits, Withdrawals, Spot-Trades
- **`@nestjs/schedule`** — Cronjob täglich 02:00

---

## Modulstruktur

```
src/
  app.module.ts                   Root-Modul (ConfigModule global)
  prisma/
    prisma.service.ts             PrismaClient-Wrapper
    prisma.module.ts
  transactions/
    transactions.service.ts       transformRawData(), findAll(), findByTxId()
    transactions.controller.ts    GET /transactions, GET /transactions/:txId, POST /transactions/import
    types/index.ts                RawRow, AggregatedTx
    utils/wallets.ts              INTERNAL_WALLETS, isInternalAddress(), getWalletName()
  portfolio/
    portfolio.service.ts          calculateBalances(date)
    portfolio.controller.ts       GET /portfolio/balances?date=YYYY-MM-DD
  alchemy/
    alchemy.service.ts            getTransfers(), getLatestBlock(), getBlockTimestamp()
  block-explorer/
    block-explorer.service.ts     getTransactionFees(), getInternalTransfers()
    block-explorer.module.ts
  binance/
    binance.service.ts            syncAll() → Deposits, Withdrawals, Spot-Trades
  price/
    price.service.ts              getPriceByAddress(), getPrice()
    price.module.ts
  sync/
    sync.service.ts               sync() — Orchestrierung aller Quellen
    sync.controller.ts            POST /sync/trigger
    sync.module.ts                ScheduleModule.forRoot() hier registriert
```

---

## Datenmodell (Prisma)

```
Transaction
  txId            String  @id          tx-Hash oder synthetische ID (BINANCE:...)
  date            DateTime
  sourceType      String               TYPE_POLYGON | TYPE_BSC | TYPE_BASE | TYPE_ARBITRUM
                                       | TYPE_BINANCE_DEPOSIT | TYPE_BINANCE_WITHDRAWAL
                                       | TYPE_BINANCE_TRADE
  kind            String               PAYMENT_IN | PAYMENT_OUT | INTERNAL | SWAP
  network         String               BSC | POLYGON | BASE | ARBITRUM | BINANCE
  feeAsset        String?
  feeAmount       String?
  priceUsd        String?              Preis des Fee-Assets in USD
  valueUsd        String?              Wert der Gebühr in USD
  priceEur        String?
  valueEur        String?
  feePayerAddress String?
  feePayer        String?              lesbarer Name aus wallets.ts
  note            String?
  transfers       Transfer[]

Transfer
  id            String  @id @default(cuid())
  asset         String
  amount        String
  from          String                 Adresse oder 'BINANCE_WALLET'
  sender        String?                lesbarer Name
  to            String
  receiver      String?
  direction     String                 IN | OUT
  operation     String?                ERC20_TRANSFER | INTERNAL_TRANSFER | NATIVE_TRANSFER
  note          String?
  priceUsd      String
  valueUsd      String
  priceEur      String
  valueEur      String
  transactionId String → Transaction
  @@unique([transactionId, asset, amount, from, to])

SyncState
  id           String   @id @default(cuid())
  source       String   @unique     z.B. 'ALCHEMY:BSC:0x123...' | 'BINANCE'
  lastBlock    String?              letzter verarbeiteter Block (hex)
  lastSyncedAt DateTime @updatedAt
```

---

## Kern-Pipeline: RawRow → AggregatedTx → DB

Alle Datenquellen (Alchemy, Binance, CSV-Import) normalisieren ihre Daten zu `RawRow[]`. `TransactionsService.transformRawData()` verarbeitet sie dann einheitlich:

```
RawRow[]  (eine Zeile = eine Seite einer Bewegung)
  → groupBy(tx_hash)             — tx_hash leer bei Binance → buildBinanceId()
  → AggregatedTx mit transfers[]
  → Klassifizierung (KIND)
  → prisma.transaction.createMany({ skipDuplicates: true })
  → prisma.transfer.createMany({ skipDuplicates: true })
```

**Duplikat-Sicherheit:** `@id` auf Transaction + `@@unique([transactionId, asset, amount, from, to])` auf Transfer → beliebig oft sync-bar ohne doppelte Einträge.

### RawRow-Felder

```typescript
type RawRow = {
  date: string;           // ISO 8601
  wallet_address: string;
  source_type: string;    // TYPE_BSC, TYPE_BINANCE_DEPOSIT, ...
  direction: 'IN' | 'OUT';
  asset: string;
  amount: string;
  fee: string;
  fee_asset: string;
  price_usd: string;
  value_usd: string;
  price_eur: string;
  value_eur: string;
  network: string;
  from_address: string;
  to_address: string;
  tx_hash: string;
  operation: string;
  note: string;
};
```

---

## Klassifizierungslogik (`transactions.service.ts`)

```
outgoing = transfers wo isInternalAddress(from)
incoming = transfers wo isInternalAddress(to)

SWAP        → tokenOut && tokenIn && verschiedene Assets
INTERNAL    → tokenOut && tokenIn && gleiche Assets
PAYMENT_OUT → nur tokenOut
PAYMENT_IN  → nur tokenIn
```

`isInternalAddress()` gibt `true` für alle Einträge in `INTERNAL_WALLETS` mit `type === 'INTERNAL'` und für `'BINANCE_WALLET'`.

---

## Eigene Wallets (`src/transactions/utils/wallets.ts`)

`INTERNAL_WALLETS: Map<string, WalletInfo>` — Adressen immer **lowercase**.

| Adresse | Name | Typ |
|---------|------|-----|
| `0x353527…` | 3blocks Multisig | INTERNAL |
| `0x124f9a…` | Florian Signer | INTERNAL |
| `0xe04bc9…` | Lars Signer | INTERNAL |
| `0xbdccfb…` | Dario Signer | INTERNAL |
| `0xd1a37e…` | Treasury | INTERNAL |
| `0xd4fa4e…` | Pecunity Deployer | INTERNAL |
| `0x8f0121…` | Pecunity Developer Acc | INTERNAL |
| `0xeabaaf…` | Pecunity Marketing | INTERNAL |
| `0xfe262b…` | Pecunity Airdrop | INTERNAL |
| `0x56b2cc…` | Pecunity Team | INTERNAL |
| `0xf3ee8d…` | Marketing Lars | INTERNAL |
| `0x4f7b20…` | Pecunity Team App Account | INTERNAL |
| `binance_wallet` | Binance | EXCHANGE |

Typ `EXCHANGE` → wird im SyncService für On-Chain-Sync übersprungen (hat eigene Binance-Logik).

---

## Alchemy (`src/alchemy/alchemy.service.ts`)

**Netzwerke:** `POLYGON` → `polygon-mainnet`, `BSC` → `bnb-mainnet`, `BASE` → `base-mainnet`, `ARBITRUM` → `arb-mainnet`

**Methoden:**
- `getTransfers(network, address, 'from'|'to', fromBlock)` — paginiert via `pageKey`, Kategorien: `external` + `erc20` (+ `internal` nur für POLYGON)
- `getLatestBlock(network)` — für SyncState-Update
- `getBlockTimestamp(network, blockHex)` — gecacht, Fallback wenn `metadata.blockTimestamp` fehlt

**Native Token pro Netzwerk:** `POLYGON→MATIC`, `BSC→BNB`, `BASE→ETH`, `ARBITRUM→ETH`

**Asset-Normalisierung** (in `sync.service.ts`): `WBNB→BNB`, `WETH→ETH`, `WMATIC→MATIC`, `WPOL→POL`

---

## BlockExplorer (`src/block-explorer/block-explorer.service.ts`)

Verwendet **Etherscan API V2** — eine URL für alle Chains, ein API-Key.

```
https://api.etherscan.io/v2/api?chainid={chainId}&module=account&...&apikey={ETHERSCAN_API_KEY}
```

| Netzwerk | chainId |
|----------|---------|
| POLYGON | 137 |
| BSC | 56 |
| BASE | 8453 |
| ARBITRUM | 42161 |

**Methoden:**
- `getTransactionFees(network, address, startBlock)` → `Map<txHash, FeeRecord>` — Fee = gasUsed × gasPrice / 1e18 (präzise via BigInt)
- `getInternalTransfers(network, address, startBlock)` → native Coin-Transfers via Smart Contracts (BSC, BASE, ARBITRUM — POLYGON läuft über Alchemy)

Paginierung: 10.000 Einträge pro Seite, `page=1,2,...` bis Seite < offset.

---

## PriceService (`src/price/price.service.ts`)

**Zwei Lookup-Modi:**

### 1. ERC20 on-chain — `getPriceByAddress(network, contractAddress, symbol, date)`
- Cache-Key: `{network}:{contractAddress}:{YYYY-MM-DD}`
- Schritt 1: `POST /prices/v1/{key}/tokens/by-address` → aktuellen Preis + Token-Symbol auflösen
- Schritt 2: `GET /prices/v1/{key}/tokens/historical?symbol=…&interval=1d` → gesamte History, in address-basierten Cache-Key schreiben
- Kein Preis → `spamTokens`-Set, Preis = 0, Warn-Log

### 2. Native Coins & Binance — `getPrice(symbol, date)`
- Cache-Key: `SYMBOL:{symbol}:{YYYY-MM-DD}`
- Direkt: `GET /prices/v1/{key}/tokens/historical?symbol=…&interval=1d`
- Kein Preis → `spamTokens`-Set, Preis = 0, Warn-Log

**Gemeinsame Eigenschaften:**
- Preishistorie ab `2025-04-01` (Firmengründung)
- Bulk-Fetch: pro Token nur **ein** API-Call, alle Tageskurse gecacht
- EUR = USD × `EUR_USD_RATE` (Alchemy liefert nur USD)
- Stablecoins (USDT, USDC, BUSD, DAI, FDUSD, …): fest 1.00 USD / `EUR_USD_RATE` EUR
- Intraday-Fallback: nächstliegender früherer Tagespreis
- Netzwerkfehler → Token bleibt aus `fetchedTokens`, Retry beim nächsten Sync

---

## SyncService (`src/sync/sync.service.ts`)

**Cronjob:** `0 2 * * *` (täglich 02:00 Uhr)
**Manuell:** `POST /sync/trigger` → `{ synced: number }`
**Guard:** `this.running` — verhindert parallele Syncs

**Ablauf pro Sync:**
```
für jede INTERNAL-Wallet × jedes Netzwerk (POLYGON, BSC, BASE, ARBITRUM):
  parallel:
    1. Alchemy outgoing transfers
    2. Alchemy incoming transfers
    3. Etherscan V2 Fee-Map (Fees [network] address)
  optional (BSC, BASE, ARBITRUM):
    4. Etherscan V2 interne Transfers
  SyncState.lastBlock aktualisieren

Binance:
  syncAll(lastSyncedAt) → Deposits + Withdrawals + Spot-Trades
  SyncState für 'BINANCE' aktualisieren

alle RawRows → transactionsService.transformRawData()
```

**SyncState-Keys:**
- On-Chain: `ALCHEMY:{NETWORK}:{address}` (lastBlock = hex)
- Explorer internal: `EXPLORER:{NETWORK}:{address}` (lastBlock = hex)
- Binance: `BINANCE` (lastSyncedAt = Timestamp)

---

## Binance (`src/binance/binance.service.ts`)

- HMAC-SHA256 Signierung aller Requests
- Paginierung in **89-Tage-Chunks** (API-Limit: 90 Tage)
- Initialer Sync ab `2025-05-01`
- **Deposits:** `GET /sapi/v1/capital/deposit/hisrec` — nur `status === 1`
- **Withdrawals:** `GET /sapi/v1/capital/withdraw/history` — nur `status === 6`
- **Spot-Trades:** `GET /api/v3/myTrades` — erfordert Symbol-Liste in `BINANCE_SPOT_PAIRS`
- Spot-Trades → zwei RawRows mit `tx_hash = BINANCE_TRADE:{id}` → werden zu **SWAP** aggregiert
- Preise via `priceService.getPrice(symbol, date)`

`BINANCE_SPOT_PAIRS` muss alle je gehandelten Pairs enthalten (Binance API liefert keine Gesamtliste).

---

## Portfolio (`src/portfolio/portfolio.service.ts`)

`calculateBalances(date: string)` — iteriert alle Transfers bis zum Stichtag:
- `isInternalAddress(from)` → Betrag abziehen
- `isInternalAddress(to)` → Betrag addieren

Response: `Record<walletAddress, Record<assetSymbol, number>>`

---

## Environment Variables (`.env`)

```bash
DATABASE_URL="postgresql://..."

ALCHEMY_API_KEY=""         # Für Transfers (v2) UND Token Prices (Growth Plan+)

BINANCE_API_KEY=""
BINANCE_SECRET_KEY=""
BINANCE_SPOT_PAIRS=""      # Kommagetrennt, z.B. "ETHUSDT,BNBUSDT,BTCUSDT"

ETHERSCAN_API_KEY=""       # Etherscan V2 — ein Key für Polygon/BSC/Base/Arbitrum
                           # Registrieren: https://etherscan.io/myapikey

EUR_USD_RATE="0.92"        # Näherungswert, da Alchemy nur USD liefert
```

---

## Häufige Aufgaben

**Neue Wallet tracken:**
1. Adresse (lowercase) in `src/transactions/utils/wallets.ts` → `INTERNAL_WALLETS` eintragen
2. `POST /sync/trigger` — synct ab Block 0 (kein SyncState vorhanden)

**Neues Binance Trading Pair:**
1. `BINANCE_SPOT_PAIRS` in `.env` ergänzen
2. `POST /sync/trigger`

**Neues Token automatisch:**
Kein Konfigurationsaufwand nötig. Bei ERC20 wird Kontraktadresse + Netzwerk verwendet; bei Binance/nativen Coins das Symbol. Erscheint im Log "potenzieller Spam" wenn kein Alchemy-Preis vorhanden.

**Stablecoin ohne Alchemy-Support:**
Symbol in `STABLECOINS`-Set in `price.service.ts` eintragen → fest 1.00 USD.

**Prisma Schema ändern:**
```bash
npx prisma migrate dev --name beschreibung
```

**Vollständiger Re-Sync einer Wallet** (z.B. nach Schema-Änderung):
```sql
DELETE FROM "SyncState" WHERE source LIKE '%{address}%';
```
Dann `POST /sync/trigger`.

---

## Bekannte Einschränkungen / TODOs

- **Gas-Fees on-chain = 0** — Alchemy liefert keine `gasUsed`/`gasPrice` in `alchemy_getAssetTransfers`. Etherscan V2 `txlist` wird parallel abgefragt, deckt aber nur Transaktionen ab wo wir `from` sind.
- **EUR/USD-Rate statisch** — `EUR_USD_RATE` in `.env` muss manuell aktualisiert werden. Gilt für alle Assets einheitlich; kein historischer Tageskurs.
- **Stablecoin EUR-Rate** — USDT/USDC etc. haben immer `0.92` EUR, unabhängig vom tatsächlichen EUR/USD-Kurs des jeweiligen Tages.
- **Binance-Kommissionen in BNB** — wenn `commissionAsset` weder base noch quote ist (z.B. BNB-Rabatt-Kommissionen), werden diese ignoriert.
- **Kein Retry** bei transienten API-Fehlern (Alchemy, Etherscan, Binance). Nächster Sync versucht es erneut.
- **Alchemy Prices nur USD** — kein historischer EUR/USD-Wechselkurs; EUR ist immer eine Näherung.
- **Token Prices API** erfordert Alchemy Growth Plan+ — bei Free Tier schlägt `fetchHistoryByAddress` fehl, Tokens bleiben auf Preis 0.
