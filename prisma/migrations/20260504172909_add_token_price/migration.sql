-- CreateTable
CREATE TABLE "TokenPrice" (
    "tokenKey" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "TokenPrice_pkey" PRIMARY KEY ("tokenKey","date")
);
