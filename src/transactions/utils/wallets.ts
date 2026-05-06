export type WalletInfo = {
  name: string;
  type: 'INTERNAL' | 'EXCHANGE' | 'EXTERNAL';
};

export const INTERNAL_WALLETS = new Map<string, WalletInfo>(
  Object.entries({
    '0x353527391365b7589503ecffcafdfbaff0a24d1b': {
      name: '3blocks Multisig',
      type: 'INTERNAL',
    },
    '0x124f9ad7b44c661b45543da7c00ec9455dda555d': {
      name: 'Florian Signer',
      type: 'INTERNAL',
    },
    '0xe04bc94fe6205b33feb845a430d4146711b00915': {
      name: 'Lars Signer',
      type: 'INTERNAL',
    },
    '0xbdccfb001bc777eb93268b16b130d7a17cf579de': {
      name: 'Dario Signer',
      type: 'INTERNAL',
    },
    '0xd1a37ea8720ebe16b12d8acb40f419811119abad': {
      name: 'Treasury',
      type: 'INTERNAL',
    },
    '0x8f0121e22d5cd7d310e90ff2fc29097260143262': {
      name: 'Pecunity Developer Acc',
      type: 'INTERNAL',
    },
    '0xeabaafacaebfd256f07448799c79b3e80771c811': {
      name: 'Pecunity Marketing',
      type: 'INTERNAL',
    },
    '0xfe262bce7ba8dc98b8e79d25bcac88d2df8346bd': {
      name: 'Pecunity Airdrop',
      type: 'INTERNAL',
    },
    '0x56b2cc86a6d1da4bc5567b4925dbeb8d746e5e86': {
      name: 'Pecunity Team',
      type: 'INTERNAL',
    },
    '0xf3ee8dc145a50d85e473ac604b28b9d31fc214c8': {
      name: 'Marketing Lars',
      type: 'INTERNAL',
    },
    '0x4f7b204684ee671f9ac5b1467b00badcc24c14d2': {
      name: 'Pecunity Team App Account',
      type: 'INTERNAL',
    },
    binance_wallet: {
      name: 'Binance',
      type: 'EXCHANGE',
    },
    '0xd4fa4ee93d7d27c1c4be36bfba67183dd4320123': {
      name: 'Pecunity Deployer',
      type: 'INTERNAL',
    },
  }),
);

export function getWalletInfo(addr?: string | null): WalletInfo | null {
  if (!addr) return null;

  const key = addr.toLowerCase();
  return INTERNAL_WALLETS.get(key) || null;
}

const PSEUDO_INTERNAL: Record<string, string> = {
  binance_wallet: 'Binance',
  '3blocks_bank': '3blocks Bankkonto',
};

export function isInternalAddress(addr?: string | null) {
  const key = addr?.toLowerCase() ?? '';
  return getWalletInfo(addr)?.type === 'INTERNAL' || key in PSEUDO_INTERNAL;
}

export function getWalletName(addr?: string | null) {
  const key = addr?.toLowerCase() ?? '';
  return getWalletInfo(addr)?.name ?? PSEUDO_INTERNAL[key] ?? null;
}
