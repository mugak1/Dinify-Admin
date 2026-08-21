import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  TemplateRef,
  computed,
  contentChildren,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/** What a projected cell template is handed. `$implicit` is the row. */
export interface AdminTableCellContext<T> {
  readonly $implicit: T;
}

interface AdminTableColumnBase {
  readonly key: string;
  readonly header: string;
  /**
   * Right-aligns and applies TABULAR NUMERALS. Spec §16 asks for tabular numerals in
   * every numeric column: in a proportional font a column of figures does not align
   * on the digit, which defeats the point of putting money in a table at all.
   */
  readonly numeric?: boolean;
}

/**
 * A plain-text column. `value` is a function rather than a key lookup on purpose: it
 * keeps the table honest under `strictTemplates` and
 * `noPropertyAccessFromIndexSignature`, and it is where a formatter (`formatUGX`,
 * `formatEat`) is applied — so the table never has to know what money or a timestamp
 * is.
 */
export interface AdminTextColumn<T> extends AdminTableColumnBase {
  readonly value: (row: T) => string;
}

/**
 * A column rendered by a template the PAGE projects — see `AdminTableCellDirective`.
 *
 * `cell: true` is a discriminant, not a flag: it makes "this column is drawn
 * elsewhere" a type-level statement, so a column can never accidentally have both a
 * value function and a template, or neither.
 */
export interface AdminTemplateColumn extends AdminTableColumnBase {
  readonly cell: true;
}

export type AdminTableColumn<T> = AdminTextColumn<T> | AdminTemplateColumn;

/**
 * A cell template, matched to its column by KEY.
 *
 *     <ng-template [appAdminTableCell]="'name'" [appAdminTableCellOf]="rows()" let-row>
 *       <span>{{ row.name }}</span>
 *     </ng-template>
 *
 * ── WHY THE TABLE TAKES TEMPLATES AT ALL ──────────────────────────────────────────
 *
 * The directory needs a lifecycle pill and a two-line restaurant cell, and there are
 * only two clean ways to get there: teach the table about pills and secondary lines,
 * or let the page draw the cell. The first bakes a fixed vocabulary into a primitive
 * and has to be reopened for the next kind of cell; the second leaves the table
 * knowing only layout and interaction, which is what a primitive should know.
 *
 * SO THE DOMAIN STAYS IN THE PAGE. There is no `if (column.key === 'lifecycle')` and
 * no `row.is_test` anywhere in this file, and there must not be.
 *
 * ── WHY THERE ARE TWO INPUTS ──────────────────────────────────────────────────────
 *
 * `appAdminTableCellOf` is never read at runtime. It exists so TypeScript can INFER
 * `T` and, with the context guard below, type `let-row` as the row type instead of
 * `any` — the same trick `*ngFor="let item of items"` uses to type its own template
 * variable. Bind it to the same array the table receives. Without it `let-row` would
 * be implicitly `any`, and a rename in the model would silently produce blank cells
 * rather than a compile error.
 */
@Directive({ selector: 'ng-template[appAdminTableCell]' })
export class AdminTableCellDirective<T> {
  /** The `key` of the column this template draws. */
  readonly appAdminTableCell = input.required<string>();
  /** Type inference only — never read. See the class comment. */
  readonly appAdminTableCellOf = input<readonly T[]>([]);

  readonly template: TemplateRef<AdminTableCellContext<T>> = inject(TemplateRef);

  static ngTemplateContextGuard<T>(
    _directive: AdminTableCellDirective<T>,
    _context: unknown,
  ): _context is AdminTableCellContext<T> {
    return true;
  }
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
 * here" and "failed to load" have opposite meanings and must never look alike. It is
 * why this primitive has no "loading" mode: a page that owns a real distinction
 * between loading, failed and empty renders those itself, and a spinner inside the
 * empty slot would let all three collapse back into one.
 *
 * ── RICH CELLS ────────────────────────────────────────────────────────────────────
 *
 * A column is either text (`value`) or template-drawn (`cell: true` plus a projected
 * `appAdminTableCell` template). See `AdminTableCellDirective` for why.
 */
@Component({
  selector: 'app-admin-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
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
                  @if (cellTemplate(column); as template) {
                    <ng-container
                      [ngTemplateOutlet]="template"
                      [ngTemplateOutletContext]="{ $implicit: row }"
                    />
                  } @else {
                    {{ textOf(column, row) }}
                  }
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

  /**
   * The projected cell templates, by column key.
   *
   * `contentChildren` finds `<ng-template>` declarations in this component's content
   * even though the template below projects nothing — a directive on an `ng-template`
   * is instantiated at its declaration site, and the template itself renders only
   * where `ngTemplateOutlet` puts it.
   */
  private readonly cells = contentChildren(AdminTableCellDirective);

  private readonly cellsByKey = computed(() => {
    const map = new Map<string, TemplateRef<AdminTableCellContext<T>>>();
    for (const cell of this.cells()) map.set(cell.appAdminTableCell(), cell.template);
    return map;
  });

  /** Roving tabindex: exactly one row is reachable with Tab. */
  protected readonly tabbableIndex = computed(() =>
    Math.min(this.focusedIndex(), Math.max(this.rows().length - 1, 0)),
  );

  protected textOf(column: AdminTableColumn<T>, row: T): string {
    return 'value' in column ? column.value(row) : '';
  }

  protected cellTemplate(
    column: AdminTableColumn<T>,
  ): TemplateRef<AdminTableCellContext<T>> | null {
    if (!('cell' in column)) return null;
    return this.cellsByKey().get(column.key) ?? null;
  }

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
