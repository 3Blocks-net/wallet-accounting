import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SpamToken } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type SpamStatus = 'SPAM' | 'WHITELISTED';

const NETWORK_TO_ALCHEMY: Record<string, string> = {
  POLYGON: 'polygon-mainnet',
  BSC: 'bnb-mainnet',
  BASE: 'base-mainnet',
  ARBITRUM: 'arb-mainnet',
};

export interface TokenIdentifier {
  network: string;
  asset: string;
  tokenAddress?: string | null;
}

@Injectable()
export class SpamTokenService {
  private readonly logger = new Logger(SpamTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Gibt alle SpamTokens zurück, optional gefiltert nach Status.
   */
  findAll(status?: SpamStatus): Promise<SpamToken[]> {
    return this.prisma.spamToken.findMany({
      where: status ? { status } : undefined,
      orderBy: { firstSeenAt: 'desc' },
    });
  }

  /**
   * Gibt alle als SPAM markierten tokenKeys zurück.
   * Format: "bnb-mainnet:0x..." für ERC20, "SYMBOL:ETH" für native Coins.
   * Wird von TransactionsService und PortfolioService für Filterung genutzt.
   */
  async getSpamKeys(): Promise<Set<string>> {
    const entries = await this.prisma.spamToken.findMany({
      where: { status: 'SPAM' },
      select: { tokenKey: true },
    });
    return new Set(entries.map((e) => e.tokenKey));
  }

  findOne(id: string): Promise<SpamToken | null> {
    return this.prisma.spamToken.findUnique({ where: { id } });
  }

  /**
   * Gibt den Status eines Tokens zurück — null wenn noch unbekannt.
   */
  async getStatus(tokenKey: string): Promise<SpamStatus | null> {
    const entry = await this.prisma.spamToken.findUnique({
      where: { tokenKey },
      select: { status: true },
    });
    return (entry?.status as SpamStatus) ?? null;
  }

  /**
   * Markiert einen Token als SPAM.
   * Wird vom PriceService aufgerufen wenn kein Preis gefunden.
   * Lässt WHITELISTED-Einträge unverändert — niemals automatisch zurücksetzen.
   */
  async markAsSpam(
    tokenKey: string,
    meta: { symbol?: string; network?: string; contractAddress?: string },
  ): Promise<void> {
    const existing = await this.prisma.spamToken.findUnique({
      where: { tokenKey },
      select: { status: true },
    });

    if (!existing) {
      await this.prisma.spamToken.create({
        data: {
          tokenKey,
          status: 'SPAM',
          symbol: meta.symbol,
          network: meta.network,
          contractAddress: meta.contractAddress,
        },
      });
      this.logger.warn(
        `Neuer Spam-Token erkannt: ${meta.symbol ?? tokenKey}` +
          (meta.network ? ` (${meta.network})` : ''),
      );
    }
    // WHITELISTED → stillschweigend ignorieren
  }

  /**
   * Nutzer bestätigt: Token ist legitim.
   * Verhindert automatisches Re-Marking durch den PriceService.
   */
  async whitelist(id: string, note?: string): Promise<SpamToken> {
    const token = await this.prisma.spamToken.findUnique({ where: { id } });
    if (!token) throw new NotFoundException(`SpamToken ${id} nicht gefunden`);

    const updated = await this.prisma.spamToken.update({
      where: { id },
      data: { status: 'WHITELISTED', note: note ?? token.note },
    });
    this.logger.log(`Token whitelisted: ${token.tokenKey} (${token.symbol ?? '?'})`);
    return updated;
  }

  /**
   * Nutzer setzt Token manuell zurück auf SPAM.
   */
  async remark(id: string): Promise<SpamToken> {
    const token = await this.prisma.spamToken.findUnique({ where: { id } });
    if (!token) throw new NotFoundException(`SpamToken ${id} nicht gefunden`);

    const updated = await this.prisma.spamToken.update({
      where: { id },
      data: { status: 'SPAM' },
    });
    this.logger.log(`Token zurück auf SPAM: ${token.tokenKey} (${token.symbol ?? '?'})`);
    return updated;
  }

  /**
   * Token hat nachträglich einen Preis bekommen → aus Spam-Liste entfernen.
   */
  async removeIfSpam(tokenKey: string): Promise<void> {
    await this.prisma.spamToken.deleteMany({
      where: { tokenKey, status: 'SPAM' },
    });
  }

  /**
   * Setzt den Status eines Tokens via Transfer-Identität (network + asset
   * + optional tokenAddress). Upsert: legt Record an, falls nicht existent.
   * Wird vom Frontend aus den Transfer-Detail-Aktionen aufgerufen.
   */
  async setStatusByToken(
    input: TokenIdentifier,
    status: SpamStatus,
    note?: string,
  ): Promise<SpamToken> {
    const tokenKey = this.resolveTokenKey(input);
    const meta = this.buildMeta(input);

    const result = await this.prisma.spamToken.upsert({
      where: { tokenKey },
      update: { status, ...(note !== undefined ? { note } : {}) },
      create: {
        tokenKey,
        status,
        symbol: meta.symbol,
        network: meta.network,
        contractAddress: meta.contractAddress,
        note: note ?? null,
      },
    });

    this.logger.log(
      `Token-Status manuell gesetzt: ${tokenKey} → ${status}` +
        (input.asset ? ` (${input.asset})` : ''),
    );
    return result;
  }

  private resolveTokenKey(input: TokenIdentifier): string {
    if (input.tokenAddress) {
      const alchemyNet =
        NETWORK_TO_ALCHEMY[input.network?.toUpperCase()] ?? input.network;
      return `${alchemyNet}:${input.tokenAddress.toLowerCase()}`;
    }
    return `SYMBOL:${input.asset?.toUpperCase() ?? ''}`;
  }

  private buildMeta(input: TokenIdentifier) {
    if (input.tokenAddress) {
      return {
        symbol: input.asset || null,
        network: NETWORK_TO_ALCHEMY[input.network?.toUpperCase()] ?? input.network,
        contractAddress: input.tokenAddress.toLowerCase(),
      };
    }
    return {
      symbol: input.asset?.toUpperCase() ?? null,
      network: null,
      contractAddress: null,
    };
  }
}
