import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * The root. Deliberately nothing but an outlet: the authenticated frame lives in
 * `ShellComponent`, and `/login` renders outside it, so neither has to opt out of
 * chrome the other needs.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class AppComponent {}
