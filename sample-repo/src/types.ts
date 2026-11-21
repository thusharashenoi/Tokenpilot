export type Card = {
  last4: string;
  brand: string;
};

export type CartLine = {
  sku: string;
  name: string;
  price: number;
  qty: number;
};

export type Receipt = {
  id: string;
  amount: number;
  guest: boolean;
};

export type LedgerEntry = {
  type: string;
  amount: number;
  ref: string;
};
