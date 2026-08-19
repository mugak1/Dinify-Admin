import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/**
 * One column. `value` is a function rather than a key lookup on purpose: it keeps the
 * table honest under `strictTemplates` and `noPropertyAccessFromIndexSignature`, and
 * it is where a formatter (`formatUGX`, `formatEat`) is applied — so the table never
 * has to know what money or a timestamp is.
 */
export interface AdminTableColumn<T> {
  readonly key: string;
  readonly header: string;
  readonly value: (row: T) => string;
  /**
   * Right-aligns and applies TABULAR NUMERALS. Spec §16 asks for tabular numerals in
   * every numeric column: in a proportional font a column of figures does not align
   * on the digit, which defeats the point of putting money in a table at all.
   */
  readonly numeric?: boolean;
}

/**
 * The table. TABLES, NOT CARD GRIDS (spec §16).
 *
 * ── KEYBOARD ──────────────────────────────────────────────────────────────────────
 *
 * §16 asks for keyboard-first, not mouse-only. Rows use a ROVING TABINDEX: exactly
 * one row is tabbable at a time, so Tab moves past the table rather than through
 * every row of a long directory, and Up/Down/Home/End move within it. Enter and Space
 * activate. The focused row carries a visible ring — it opts out of the global
 * `:focus-visible` outline (`data-focus-ring="self"`) so the ring can sit inside the
 * row's own bounds instead of being clipped by the scroll container.
 *
 * ── EMPTY STATE ───────────────────────────────────────────────────────────────────
 *
 * `empty` is REQUIRED. An empty table with no explanation is the single most common
 * way an operator concludes a tool is broken; on a needs-attention surface, "nothing
 * here" and "failed to load" have opposite meanings and must never look alike.
 */
@Component({
  selector: 'app-admin-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="overflow-x-auto rounded-lg bg-surface ring-1 ring-line">
      <table class="w-full border-collapse text-admin-body">
        @if (caption(); as text) {
          <caption class="sr-only">{{ text }}</caption>
        }
        <thead>
          <tr class="border-b border-line bg-surface-sunken">
            @for (column of columns(); track column.key) {
              <th
                scope="col"
                class="px-3 py-2 text-admin-micro uppercase text-ink-subtle"
                [class.text-right]="column.numeric"
              >
                {{ column.header }}
              </th>
            }
          </tr>
        </thead>
        <tbody #body>
          @for (row of rows(); track $index) {
            <tr
              [tabindex]="$index === tabbableIndex() ? 0 : -1"
              data-focus-ring="self"
              data-row
              class="h-row cursor-default border-b border-line last:border-b-0
                     focus:outline-none focus:ring-2 focus:ring-inset focus:ring-admin-accent
                     hover:bg-surface-sunken"
              [class.bg-surface-sunken]="focusedIndex() === $index"
              (click)="activate($index)"
              (keydown)="onKeydown($event, $index)"
              (focus)="focusedIndex.set($index)"
            >
              @for (column of columns(); track column.key) {
                <td
                  class="px-3 py-2 align-middle"
                  [class.text-right]="column.numeric"
                  [class.tabular-figures]="column.numeric"
                >
                  {{ column.value(row) }}
                </td>
              }
            </tr>
          } @empty {
            <tr>
              <td [attr.colspan]="columns().length" class="px-3 py-8 text-center">
                <p class="text-admin-body text-ink-muted">{{ empty() }}</p>
                @if (emptyHint(); as hint) {
                  <p class="mt-1 text-admin-meta text-ink-subtle">{{ hint }}</p>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class AdminTableComponent<T> {
  readonly columns = input.required<readonly AdminTableColumn<T>[]>();
  readonly rows = input.required<readonly T[]>();
  /** What this table shows, for a screen reader. Not rendered visually. */
  readonly caption = input<string | null>(null);
  /** Required: "nothing here" and "failed to load" must never look the same. */
  readonly empty = input.required<string>();
  /** Optional second line — what would put something here. */
  readonly emptyHint = input<string | null>(null);

  readonly rowActivate = output<T>();

  protected readonly focusedIndex = signal(0);
  private readonly body = viewChild<ElementRef<HTMLElement>>('body');

  /** Roving tabindex: exactly one row is reachable with Tab. */
  protected readonly tabbableIndex = computed(() =>
    Math.min(this.focusedIndex(), Math.max(this.rows().length - 1, 0)),
  );

  protected activate(index: number): void {
    const row = this.rows()[index];
    if (row !== undefined) this.rowActivate.emit(row);
  }

  protected onKeydown(event: KeyboardEvent, index: number): void {
    const last = this.rows().length - 1;
    let next: number | null = null;

    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(index + 1, last);
        break;
      case 'ArrowUp':
        next = Math.max(index - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        this.activate(index);
        return;
      default:
        return;
    }

    event.preventDefault();
    this.focusedIndex.set(next);
    this.focusRow(next);
  }

  private focusRow(index: number): void {
    const rows = this.body()?.nativeElement.querySelectorAll<HTMLElement>('[data-row]');
    rows?.item(index)?.focus();
  }
}
