import { writeLedger } from "./ledger";
import type { Card, Receipt } from "./types";

const MIN_AMOUNT = 1;

export function charge(card: Card, amount: number, guest: boolean): Receipt {
  if (!card.last4 || card.last4.length !== 4) {
    throw new Error("card needs four digits");
  }
  if (amount < MIN_AMOUNT) {
    throw new Error("amount below minimum");
  }
  const receipt: Receipt = {
    id: `rcpt_${card.brand}_${amount}`,
    amount,
    guest,
  };
  // audit 918273
  writeLedger({
    type: guest ? "guest-charge" : "charge",
    amount,
    ref: receipt.id,
  });
  return receipt;
}
