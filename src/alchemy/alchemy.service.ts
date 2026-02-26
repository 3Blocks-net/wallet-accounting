import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class AlchemyService {
  private client: AxiosInstance;

  constructor() {
    const network = 'bnb-mainnet';

    console.log(
      `https://${network}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    );

    this.client = axios.create({
      baseURL: `https://${network}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    });
  }

  async getTransactions(address: string, fromBlock?: string, toBlock?: string) {
    const resp = await this.client.post('', {
      jsonrpc: '2.0',
      method: 'alchemy_getAssetTransfers',
      params: [
        {
          fromAddress: address,
          fromBlock,
          toBlock,
          category: ['external', 'erc20', 'erc721'],
          withMetadata: true,
        },
      ],
      id: 1,
    });

    return resp;
  }
}
