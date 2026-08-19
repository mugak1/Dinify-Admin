import { ChangeDetectionStrategy, Component } from '@angular/core';

import { AdminTableColumn, AdminTableComponent } from '../ui/table.component';

interface ActivityRow {
  readonly when: string;
  readonly actor: string;
  readonly action: string;
  readonly resource: string;
}

/**
 * Activity — the read-only audit view (spec §12).
 *
 * `AdminAuditLog` is synchronous, transactional, redacted and attribution-aware. If
 * the only way to read it is `psql`, most of that value is unrealised — and "why is
 * this restaurant suspended?" and "what did I change yesterday?" are questions a solo
 * operator asks often.
 *
 * Presented as NARRATIVE rather than a raw table: timestamp, actor, the action in
 * plain language, and the affected resource; expanding a row reveals request ID,
 * delegation ID, before/after state, source IP and result, with redaction intact.
 * READ-ONLY — no writes, no deletion, no export in Phase 1.
 */
@Component({
  selector: 'app-activity-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminTableComponent],
  template: `
    <header>
      <h1 class="text-admin-page text-ink">Activity</h1>
      <p class="mt-0.5 text-admin-body text-ink-muted">
        Every control-plane and delegated action, in the order it happened.
      </p>
    </header>

    <app-admin-table
      caption="Audit trail"
      [columns]="columns"
      [rows]="rows"
      empty="No activity recorded yet."
      emptyHint="Entries appear as soon as anything is done on this plane — a sign-in, a
                 lifecycle transition, a delegation. Spec §12, step 8."
    />
  `,
})
export class ActivityPage {
  protected readonly rows: readonly ActivityRow[] = [];
  protected readonly columns: readonly AdminTableColumn<ActivityRow>[] = [
    { key: 'when', header: 'When', value: (row) => row.when },
    { key: 'actor', header: 'Actor', value: (row) => row.actor },
    { key: 'action', header: 'Action', value: (row) => row.action },
    { key: 'resource', header: 'Resource', value: (row) => row.resource },
  ];
}
