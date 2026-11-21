export function sampleTask(): string {
  const items = Array.from({ length: 24 }, (_, index) => ({
    sku: `SKU-${index + 1}`,
    name: `Line item ${index + 1}`,
    qty: (index % 4) + 1,
    price: Number((3 + index * 1.25).toFixed(2)),
  }));
  return [
    "Hey! I was wondering if you could please help me out with this.",
    "I need you to update the checkout flow so guests can pay without an account.",
    "Please don't change the public charge() signature, and never log the card number.",
    "Could you please look at who calls charge and keep the existing ledger write?",
    "",
    "Here is the current payload:",
    "",
    "```json",
    JSON.stringify({ items }, null, 2),
    "```",
    "",
    "Thanks so much!",
  ].join("\n");
}
