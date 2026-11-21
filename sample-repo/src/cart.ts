import { checkout } from "./checkout";
import type { Card, CartLine, Receipt } from "./types";

export class Cart {
  private lines: CartLine[] = [];

  add(line: CartLine): void {
    const existing = this.lines.find((item) => item.sku === line.sku);
    if (existing) {
      existing.qty += line.qty;
      return;
    }
    this.lines.push({ ...line });
  }

  clear(): void {
    this.lines = [];
  }

  submit(card: Card, guest: boolean): Receipt {
    return checkout(this.lines, card, guest);
  }
}
