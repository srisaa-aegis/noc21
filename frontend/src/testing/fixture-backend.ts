/**
 * Kept for the existing specs: the fixture data and the fake backend now live
 * in `fake-api.ts` (route-shaped responses of the NOC backend built from the
 * demo seed data).
 */
import { EnvironmentProviders, Provider } from '@angular/core';
import { FIXTURES } from './fixture-index';
import { fixture, provideFakeApi, FakeApi } from './fake-api';

export { FIXTURES, fixture, FakeApi };

export function provideFixtureBackend(configure?: (api: FakeApi) => void): (Provider | EnvironmentProviders)[] {
  return provideFakeApi(configure);
}
