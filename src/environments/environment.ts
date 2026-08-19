import { Environment } from './environment.interface';

/**
 * Development. `npm start` renders the complete shell with NO backend running,
 * because the auth port resolves to its mock implementation (see src/app/dev).
 */
export const environment: Environment = {
  production: false,
  apiBase: '/api/admin/v1',
  useMockApi: true,
};
