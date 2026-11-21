/** Report display labels are not necessarily Accounting API entity names. */
export function qboTransactionEntityType(label: string): string | null {
  const key = label.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const canonical: Record<string, string> = {
    invoice: 'Invoice', bill: 'Bill', billpayment: 'BillPayment',
    purchase: 'Purchase', expense: 'Purchase', cashexpense: 'Purchase',
    creditcardexpense: 'Purchase', check: 'Purchase',
    creditmemo: 'CreditMemo', deposit: 'Deposit', estimate: 'Estimate',
    journalentry: 'JournalEntry', payment: 'Payment', purchaseorder: 'PurchaseOrder',
    refundreceipt: 'RefundReceipt', salesreceipt: 'SalesReceipt',
    transfer: 'Transfer', vendorcredit: 'VendorCredit', timeactivity: 'TimeActivity',
    'billpayment(creditcard)': 'BillPayment',
  };
  return Object.hasOwn(canonical, key) ? canonical[key] : null;
}
