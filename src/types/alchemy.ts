// Root JSON-RPC response
export interface TransfersRpcResponse {
  jsonrpc: string;
  id: string;
  result: TransfersResult;
}

// Result wrapper
export interface TransfersResult {
  transfers: Transfer[];
  pageKey: string;
}

// Individual transfer entry
export interface Transfer {
  blockNum: string; // hex string
  uniqueId: string;
  hash: string;
  from: string;
  to: string;
  value: number; // parsed decimal value
  erc721TokenId: string | null;
  erc1155Metadata: unknown | null;
  tokenId: string | null;
  asset: string; // e.g. "ETH"
  category: 'external' | string; // can be expanded if needed
  rawContract: RawContract;
}

// Raw contract details
export interface RawContract {
  value: string; // hex string
  address: string | null;
  decimal: string; // hex string
}
