import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AdminTableColumn, AdminTableComponent } from '../ui/table.component';
import { formatUGX } from '../core/formatting/currency';

interface InvoiceRow {
  readonly reference: string;
  readonly restaurant: string;
  readonly amount: string;
}

/**
 * Receivables — subscription invoices (spec §8).
 *
 * Manual mark-paid is the SOLE write. Nothing here moves money: Dinify is a software
 * vendor, not a payment institution, and the non-custodial rule is the binding
 * constraint on every financial surface in this product.
 */
@Component({
  selector: 'app-receivables-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminTableComponent],
  template: `
    <header>
      <h1 class="text-admin-page text-ink">Receivables</h1>
      <p class="mt-0.5 text-admin-body text-ink-muted">Subscription invoices and their state.</p>
    </header>

    <app-admin-table
      caption="Subscription invoices"
      [columns]="columns"
      [rows]="rows"
      empty="No invoices yet."
      emptyHint="Invoices appear once subscriptions exist. The receivables seam
                 (has_outstanding_receivables) is wired in the same PR that makes an invoice
                 capable of becoming overdue — spec §8, step 7."
    />
  `,
})
export class ReceivablesPage {
  protected readonly rows: readonly InvoiceRow[] = [];
  protected readonly columns: readonly AdminTableColumn<InvoiceRow>[] = [
    { key: 'reference', header: 'Invoice', value: (row) => row.reference },
    { key: 'restaurant', header: 'Restaurant', value: (row) => row.restaurant },
    // Numeric: right-aligned and set in tabular numerals, per §16.
    { key: 'amount', header: 'Amount', numeric: true, value: (row) => formatUGX(row.amount) },
  ];
}

@Component({
  selector: 'app-invoice-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="space-y-3">
      <a routerLink="/receivables" class="text-admin-meta text-ink-muted hover:text-ink"
        >&larr; Receivables</a
      >
      <div>
        <h1 class="text-admin-page text-ink">Invoice</h1>
        <p class="mt-0.5 text-admin-meta text-ink-subtle tabular-figures">{{ invoiceId() }}</p>
      </div>
    </header>

    <section class="rounded-lg bg-surface p-6 ring-1 ring-line">
      <p class="max-w-prose text-admin-body text-ink-muted">
        Will show one invoice, its payments, and the manual mark-paid action — a consequential
        write, so it stays visibly pending until the server has committed and audited it.
      </p>
      <p class="mt-3 text-admin-meta text-ink-subtle">Spec §8 — arrives with step 7.</p>
    </section>
  `,
})
export class InvoicePage {
  readonly invoiceId = input.required<string>();
}
