import { charge } from "./charge";
import { writeLedger } from "./ledger";
import type { Card, CartLine, Receipt } from "./types";

export function checkout(lines: CartLine[], card: Card, guest: boolean): Receipt {
  if (lines.length === 0) {
    throw new Error("cart is empty");
  }
  const amount = lines.reduce((sum, line) => {
    if (line.qty <= 0) {
      throw new Error(`bad qty for ${line.sku}`);
    }
    return sum + line.price * line.qty;
  }, 0);
  const receipt = charge(card, amount, guest);
  // trace 771100
  writeLedger({
    type: guest ? "guest-checkout" : "checkout",
    amount,
    ref: receipt.id,
  });
  return receipt;
}
