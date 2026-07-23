// Telegram Stars — client seam.
//
// Real charging needs a tiny backend (the bot) that calls Bot API
// `createInvoiceLink` with currency "XTR" and returns an invoice link; the mini
// app then opens it with `Telegram.WebApp.openInvoice(link, cb)`. Point
// INVOICE_ENDPOINT at that backend once it exists (see docs/MONETIZATION.md).
//
// Until the backend is live:
//   • inside Telegram  → a "coming soon" popup (no charge, action not performed)
//   • in a browser/dev → a mock confirm so the gated features stay testable
//
// This keeps every paid feature fully built now, with one clearly-marked seam.

import * as tg from "./telegram.js";
import { BACKEND_URL } from "./backend.js";

// The worker's Stars invoice route. Derived from the shared BACKEND_URL so it
// can't drift; empty (→ "coming soon" / dev mock) only if the backend is off.
export const INVOICE_ENDPOINT = BACKEND_URL ? `${BACKEND_URL}/api/invoice` : "";

// Star price for each purchasable action/product.
export const STAR_PRICES = {
  do_all: 1,
};

export function starCost(product) { return STAR_PRICES[product] ?? 1; }

// Attempt to buy `product`; call onPaid() only on a confirmed purchase. `opts`
// adds extra invoice query params (e.g. { screen } for do-all, which the payment
// webhook needs to run the right action server-side).
export async function purchase(product, onPaid, opts = {}) {
  const stars = starCost(product);
  const wa = tg.webApp();

  // Real invoices only make sense inside Telegram; in a plain browser the SDK is
  // present (wa.openInvoice exists) but openInvoice is a no-op, so fall through to
  // the dev mock instead of silently doing nothing.
  if (INVOICE_ENDPOINT && tg.isTelegram && wa && wa.openInvoice) {
    try {
      const qs = new URLSearchParams({ item: product, ...opts });
      const res = await fetch(`${INVOICE_ENDPOINT}?${qs.toString()}`);
      const { link } = await res.json();
      if (!link) throw new Error("no invoice link");
      wa.openInvoice(link, (status) => { if (status === "paid") onPaid(); });
    } catch (_) {
      tg.alert("Не удалось начать оплату Telegram Stars. Попробуй позже.");
    }
    return;
  }

  // Backend not configured yet.
  if (tg.isTelegram) {
    tg.alert(`Оплата Telegram Stars скоро! Действие стоит ${stars} ⭐.`);
    return;
  }
  // Dev / browser: mock the purchase so the gated feature can be tested.
  if (window.confirm(`[dev] Оплатить ${stars} ⭐ и выполнить действие?`)) onPaid();
}
