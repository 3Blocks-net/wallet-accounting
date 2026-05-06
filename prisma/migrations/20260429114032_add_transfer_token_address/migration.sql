/*
  Warnings:

  - The primary key for the `Transaction` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `amount` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `asset` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `classification` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `from` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `gasFee` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `protocol` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `timestamp` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `to` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `txHash` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `walletId` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the `Wallet` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `date` to the `Transaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `kind` to the `Transaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `network` to the `Transaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sourceType` to the `Transaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `txId` to the `Transaction` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_walletId_fkey";

-- DropIndex
DROP INDEX "Transaction_txHash_idx";

-- DropIndex
DROP INDEX "Transaction_walletId_idx";

-- AlterTable
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_pkey",
DROP COLUMN "amount",
DROP COLUMN "asset",
DROP COLUMN "classification",
DROP COLUMN "createdAt",
DROP COLUMN "from",
DROP COLUMN "gasFee",
DROP COLUMN "id",
DROP COLUMN "protocol",
DROP COLUMN "timestamp",
DROP COLUMN "to",
DROP COLUMN "txHash",
DROP COLUMN "walletId",
ADD COLUMN     "date" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "feeAmount" TEXT,
ADD COLUMN     "feeAsset" TEXT,
ADD COLUMN     "feePayer" TEXT,
ADD COLUMN     "feePayerAddress" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL,
ADD COLUMN     "network" TEXT NOT NULL,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "priceEur" TEXT,
ADD COLUMN     "priceUsd" TEXT,
ADD COLUMN     "sourceType" TEXT NOT NULL,
ADD COLUMN     "txId" TEXT NOT NULL,
ADD COLUMN     "valueEur" TEXT,
ADD COLUMN     "valueUsd" TEXT,
ADD CONSTRAINT "Transaction_pkey" PRIMARY KEY ("txId");

-- DropTable
DROP TABLE "Wallet";

-- DropEnum
DROP TYPE "TransactionClassification";

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "lastBlock" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpamToken" (
    "id" TEXT NOT NULL,
    "tokenKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SPAM',
    "symbol" TEXT,
    "network" TEXT,
    "contractAddress" TEXT,
    "note" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpamToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "sender" TEXT,
    "to" TEXT NOT NULL,
    "receiver" TEXT,
    "direction" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "operation" TEXT,
    "note" TEXT,
    "priceUsd" TEXT NOT NULL,
    "valueUsd" TEXT NOT NULL,
    "priceEur" TEXT NOT NULL,
    "valueEur" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_source_key" ON "SyncState"("source");

-- CreateIndex
CREATE UNIQUE INDEX "SpamToken_tokenKey_key" ON "SpamToken"("tokenKey");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_transactionId_asset_amount_from_to_key" ON "Transfer"("transactionId", "asset", "amount", "from", "to");

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("txId") ON DELETE CASCADE ON UPDATE CASCADE;
