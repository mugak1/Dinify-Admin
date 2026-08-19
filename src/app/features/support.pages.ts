import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AdminTableColumn, AdminTableComponent } from '../ui/table.component';

interface IssueRow {
  readonly reference: string;
  readonly restaurant: string;
  readonly status: string;
}

/**
 * Support — the issue inbox across every restaurant (spec §9).
 *
 * A global destination rather than a restaurant-detail tab because triage is
 * cross-tenant work: the operator asks "what is open" before asking "at whom".
 * The per-restaurant slice still exists, inside the restaurant.
 */
@Component({
  selector: 'app-support-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminTableComponent],
  template: `
    <header>
      <h1 class="text-admin-page text-ink">Support</h1>
      <p class="mt-0.5 text-admin-body text-ink-muted">Open issues across every restaurant.</p>
    </header>

    <app-admin-table
      caption="Support issues"
      [columns]="columns"
      [rows]="rows"
      empty="No open support issues."
      emptyHint="Triage is being rebuilt natively on the admin plane — the old customer-plane
                 endpoints were deleted in Phase 0.5 PR-A, because a role string was their only
                 gate. Spec §15, step 6."
    />
  `,
})
export class SupportPage {
  protected readonly rows: readonly IssueRow[] = [];
  protected readonly columns: readonly AdminTableColumn<IssueRow>[] = [
    { key: 'reference', header: 'Reference', value: (row) => row.reference },
    { key: 'restaurant', header: 'Restaurant', value: (row) => row.restaurant },
    { key: 'status', header: 'Status', value: (row) => row.status },
  ];
}

@Component({
  selector: 'app-support-issue-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="space-y-3">
      <a routerLink="/support" class="text-admin-meta text-ink-muted hover:text-ink"
        >&larr; Support</a
      >
      <div>
        <h1 class="text-admin-page text-ink">Issue</h1>
        <p class="mt-0.5 text-admin-meta text-ink-subtle tabular-figures">{{ issueId() }}</p>
      </div>
    </header>

    <section class="rounded-lg bg-surface p-6 ring-1 ring-line">
      <p class="max-w-prose text-admin-body text-ink-muted">
        Will show one issue in full — reporter, restaurant, category, impact, the conversation,
        and the actions available on it.
      </p>
      <p class="mt-3 text-admin-meta text-ink-subtle">Spec §15 — arrives with step 6.</p>
    </section>
  `,
})
export class SupportIssuePage {
  readonly issueId = input.required<string>();
}
