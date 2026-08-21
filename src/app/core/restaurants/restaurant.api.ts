import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

import { DirectoryQuery, RestaurantDetail, RestaurantDirectoryPage } from './restaurant.model';

/**
 * The restaurant READ port — two routes, and nothing else.
 *
 * The second seam in this application that talks to a server, and it is shaped like
 * the first (`ADMIN_AUTH`) on purpose. A port plus a token is what keeps `npm start`
 * reviewable with no backend running: `src/app/dev` implements this interface, and
 * everything above it — the directory page, the workspace store, the states, the
 * formatting — is the same code in both modes. What gets reviewed is the real flow.
 *
 * IT IS DELIBERATELY NOT A GENERAL `ApiService`. A port names what it can reach, so
 * the set of endpoints this repo can call stays enumerable; a generic client that
 * takes a URL makes every future screen free to invent its own contract.
 *
 * STEP 1 IS A READ SLICE. There is no write here and there must not be one until the
 * step that owns it lands — the lifecycle transition is Step 4, and it needs the
 * elevation dialog, a preflight and a written reason, none of which exist yet.
 */
export interface RestaurantApi {
  /** The directory page for `query`. Only `KNOWN_PARAMS` are ever sent. */
  list(query: DirectoryQuery): Observable<RestaurantDirectoryPage>;

  /** One restaurant: the workspace header and Overview. 404 when missing or deleted. */
  detail(id: string): Observable<RestaurantDetail>;
}

export const RESTAURANT_API = new InjectionToken<RestaurantApi>('RESTAURANT_API');
