// src/transactions/utils/wallets.ts
export const INTERNAL_WALLETS = new Set<string>(
  [
    '0x353527391365b7589503eCfFcafDFBAFf0a24D1B', // 3blocks multisig[file:3]
    '0xd1a37EA8720EBe16B12D8acB40F419811119aBAd', // treasury[file:5]
    '0x56B2cC86A6d1Da4Bc5567B4925dbeb8d746e5E86', // multisig[file:6]
    '0xfE262BcE7ba8Dc98B8e79d25bCAC88D2df8346BD', // airdrop[file:4]
    '0xeabaAFACAeBfD256f07448799C79B3E80771C811', // marketing[file:7]
  ].map((a) => a.toLowerCase()),
);

export function isInternalAddress(addr?: string | null) {
  if (!addr) return false;
  return INTERNAL_WALLETS.has(addr.toLowerCase());
}
