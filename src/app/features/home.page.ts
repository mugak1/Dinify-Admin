import { ChangeDetectionStrategy, Component } from '@angular/core';

import { AdminTableColumn, AdminTableComponent } from '../ui/table.component';

/** Shape of a needs-attention item, so the column definitions are honest. */
interface AttentionItem {
  readonly restaurant: string;
  readonly condition: string;
  readonly since: string;
}

/**
 * Home — AN OPERATOR INBOX, NOT A DASHBOARD (spec §11).
 *
 * `/` is a needs-attention list. The operator does not open this tool to admire
 * metrics; they open it because something needs doing, so the first screen names what
 * that is. Every condition is COMPUTABLE from existing lifecycle, receivables,
 * support and delegation state — there is no event bus and none is needed, which is
 * what makes this shippable incrementally as each source becomes available (§15,
 * step 9).
 *
 * Metrics and charts come LAST, and only when a chart answers an operational question
 * that a number cannot.
 */
@Component({
  selector: 'app-home-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminTableComponent],
  template: `
    <header>
      <h1 class="text-admin-page text-ink">Home</h1>
      <p class="mt-0.5 text-admin-body text-ink-muted">What needs your attention.</p>
    </header>

    <app-admin-table
      caption="Items needing attention"
      [columns]="columns"
      [rows]="items"
      empty="Nothing needs your attention."
      emptyHint="Items appear here when a restaurant has outstanding go-live blockers, an owner
                 invitation is near expiry or expired, an invoice is overdue, a support issue has
                 been open past its threshold, an emergency freeze is unresolved, or a delegated
                 session is still open."
    />

    <p class="text-admin-meta text-ink-subtle">
      Scaffold — the needs-attention conditions arrive with the sources that produce them
      (spec §15, step 9).
    </p>
  `,
})
export class HomePage {
  protected readonly items: readonly AttentionItem[] = [];

  protected readonly columns: readonly AdminTableColumn<AttentionItem>[] = [
    { key: 'restaurant', header: 'Restaurant', value: (row) => row.restaurant },
    { key: 'condition', header: 'Condition', value: (row) => row.condition },
    { key: 'since', header: 'Since', value: (row) => row.since },
  ];
}
