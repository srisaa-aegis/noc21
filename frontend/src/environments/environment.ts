/**
 * Runtime configuration of the Angular app. The portal always talks to the NOC
 * backend (proxied to :3000 by `ng serve`, by the web server in production).
 */
export interface Environment {
  production: boolean;
  apiBaseUrl: string;
}

export const environment: Environment = {
  production: false,
  apiBaseUrl: '/api/v1',
};
