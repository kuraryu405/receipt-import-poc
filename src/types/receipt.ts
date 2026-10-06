/**
 * レシートの共有型。
 * Gemini Structured Output の実行時検証後に利用する正規形。
 * 読み取れなかった値は null で表現する。
 */

export interface ReceiptItem {
  name: string | null;
  quantity: number | null;
  unitPrice: number | null;
  price: number | null;
}

export interface Receipt {
  merchant: string | null;
  date: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  paymentMethod: string | null;
  invoiceRegistrationNumber: string | null;
  items: ReceiptItem[];
}
