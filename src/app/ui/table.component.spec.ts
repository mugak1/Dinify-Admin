import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AdminTableCellDirective, AdminTableColumn, AdminTableComponent } from './table.component';

interface Row {
  readonly name: string;
  readonly location: string | null;
  readonly issues: number;
  readonly flagged: boolean;
}

const ROWS: readonly Row[] = [
  { name: 'Kampala Bistro', location: 'Kololo', issues: 2, flagged: true },
  { name: 'Nile Grill', location: null, issues: 0, flagged: false },
  { name: 'Serena Terrace', location: 'Nakasero', issues: 11, flagged: false },
];

@Component({
  selector: 'app-table-host',
  imports: [AdminTableComponent, AdminTableCellDirective],
  template: `
    <app-admin-table
      caption="Test directory"
      [columns]="columns"
      [rows]="rows()"
      empty="Nothing here."
      emptyHint="A hint."
      (rowActivate)="activated.set($event)"
    >
      <ng-template [appAdminTableCell]="'name'" [appAdminTableCellOf]="rows()" let-row>
        <span data-name>{{ row.name }}</span>
        @if (row.location) {
          <span data-location>{{ row.location }}</span>
        }
        @if (row.flagged) {
          <span data-flag>FLAG</span>
        }
      </ng-template>
    </app-admin-table>
  `,
})
class TableHostComponent {
  readonly rows = signal<readonly Row[]>(ROWS);
  readonly activated = signal<Row | null>(null);

  readonly columns: readonly AdminTableColumn<Row>[] = [
    { key: 'name', header: 'Restaurant', cell: true },
    { key: 'location', header: 'Location', value: (row) => row.location ?? '—' },
    { key: 'issues', header: 'Open issues', value: (row) => String(row.issues), numeric: true },
  ];
}

describe('AdminTableComponent', () => {
  let fixture: ComponentFixture<TableHostComponent>;
  let host: TableHostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [TableHostComponent] }).compileComponents();
    fixture = TestBed.createComponent(TableHostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function rows(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('[data-row]'));
  }
  function cells(rowIndex: number): HTMLElement[] {
    return Array.from(rows()[rowIndex].querySelectorAll('td'));
  }

  it('renders a semantic table with a caption and column headers', () => {
    const table: HTMLElement = fixture.nativeElement.querySelector('table');
    expect(table).toBeTruthy();
    expect(fixture.nativeElement.querySelector('caption')?.textContent?.trim()).toBe(
      'Test directory',
    );
    expect(
      Array.from(fixture.nativeElement.querySelectorAll('th')).map((th) =>
        (th as HTMLElement).textContent?.trim(),
      ),
    ).toEqual(['Restaurant', 'Location', 'Open issues']);
    for (const th of Array.from(fixture.nativeElement.querySelectorAll('th'))) {
      expect((th as HTMLElement).getAttribute('scope')).toBe('col');
    }
  });

  it('renders text columns through their value function', () => {
    expect(cells(0)[1].textContent?.trim()).toBe('Kololo');
    // A null is the column's business, not the table's — it renders what it is given.
    expect(cells(1)[1].textContent?.trim()).toBe('—');
  });

  /**
   * The capability step 1 needed: a cell the PAGE draws. Without it the directory
   * cannot show a lifecycle pill or a two-line restaurant cell, and the alternative —
   * a second, nearly identical table primitive — is how a design system splits.
   */
  it('renders a template column from the projected cell template', () => {
    expect(cells(0)[0].querySelector('[data-name]')?.textContent?.trim()).toBe('Kampala Bistro');
    expect(cells(0)[0].querySelector('[data-location]')?.textContent?.trim()).toBe('Kololo');
    expect(cells(0)[0].querySelector('[data-flag]')).toBeTruthy();
  });

  it('gives each row its own template context rather than the first row repeatedly', () => {
    expect(cells(1)[0].querySelector('[data-name]')?.textContent?.trim()).toBe('Nile Grill');
    expect(cells(1)[0].querySelector('[data-location]')).toBeNull();
    expect(cells(1)[0].querySelector('[data-flag]')).toBeNull();
  });

  it('applies tabular numerals and right alignment to numeric columns only', () => {
    const numeric = cells(0)[2].getAttribute('class') ?? '';
    const text = cells(0)[1].getAttribute('class') ?? '';
    expect(numeric).toContain('tabular-figures');
    expect(numeric).toContain('text-right');
    expect(text).not.toContain('tabular-figures');
  });

  it('keeps rows at the 44px interactive target', () => {
    for (const row of rows()) expect(row.getAttribute('class')).toContain('h-row');
  });

  it('uses a roving tabindex so Tab moves past the table, not through it', () => {
    expect(rows().map((row) => row.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('activates a row on click', () => {
    rows()[2].click();
    expect(host.activated()?.name).toBe('Serena Terrace');
  });

  it('activates a row on Enter', () => {
    rows()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(host.activated()?.name).toBe('Nile Grill');
  });

  it('activates a row on Space', () => {
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(host.activated()?.name).toBe('Kampala Bistro');
  });

  it('moves the roving focus with Arrow, Home and End', () => {
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    expect(rows().map((row) => row.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);

    rows()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    fixture.detectChanges();
    expect(rows().map((row) => row.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);

    rows()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    fixture.detectChanges();
    expect(rows().map((row) => row.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('keeps a visible focus ring inside the row bounds', () => {
    for (const row of rows()) {
      expect(row.getAttribute('data-focus-ring')).toBe('self');
      expect(row.getAttribute('class')).toContain('focus:ring-admin-accent');
    }
  });

  it('renders the written empty state, spanning every column', () => {
    host.rows.set([]);
    fixture.detectChanges();

    const cell: HTMLElement = fixture.nativeElement.querySelector('tbody td');
    expect(cell.getAttribute('colspan')).toBe('3');
    expect(cell.textContent).toContain('Nothing here.');
    expect(cell.textContent).toContain('A hint.');
    expect(rows().length).toBe(0);
  });
});
