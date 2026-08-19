import { Provider } from '@angular/core';
import { Routes } from '@angular/router';

/**
 * The production stand-in for `dev-tools.ts`, swapped in by `fileReplacements`.
 *
 * It imports NOTHING from `src/app/dev`, which is the whole point: the mock transport
 * and the primitives gallery have no path into the production module graph, so their
 * absence does not depend on a runtime flag or on the bundler eliminating dead code.
 */
export const DEV_PROVIDERS: Provider[] = [];

export const DEV_ROUTES: Routes = [];
