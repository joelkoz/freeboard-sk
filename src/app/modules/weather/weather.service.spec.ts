import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';

import { WeatherService, OceanCurrentSample } from './weather.service';
import { SignalKClient } from 'signalk-client-angular';

const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';

const POINTS_A = [
  { latitude: 25.1, longitude: -80.2 },
  { latitude: 25.2, longitude: -80.3 }
];
const POINTS_B = [
  { latitude: 30.1, longitude: -70.2 },
  { latitude: 30.2, longitude: -70.3 }
];

const OK_RESPONSE = [
  {
    latitude: 25.1,
    longitude: -80.2,
    current: { ocean_current_velocity: 0.5, ocean_current_direction: 90 }
  },
  {
    latitude: 25.2,
    longitude: -80.3,
    current: { ocean_current_velocity: 0.7, ocean_current_direction: 120 }
  }
];

const isMarine = (url: string) => url.startsWith(MARINE_URL);

describe('WeatherService ocean-current caching (#522)', () => {
  let service: WeatherService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        WeatherService,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SignalKClient, useValue: {} }
      ]
    });
    service = TestBed.inject(WeatherService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('serves a repeated viewport from cache instead of re-hitting Open-Meteo', () => {
    service.getOceanCurrentSamples(POINTS_A).subscribe();
    httpMock.expectOne((r) => isMarine(r.url)).flush(OK_RESPONSE);

    let cached: OceanCurrentSample[] | undefined;
    service.getOceanCurrentSamples(POINTS_A).subscribe((s) => (cached = s));

    // The second identical request must NOT reach the network.
    httpMock.expectNone((r) => isMarine(r.url));
    expect(cached).toEqual([
      { latitude: 25.1, longitude: -80.2, velocity: 0.5, direction: 90 },
      { latitude: 25.2, longitude: -80.3, velocity: 0.7, direction: 120 }
    ]);
  });

  it('fetches again for a different viewport (cache is keyed per request)', () => {
    service.getOceanCurrentSamples(POINTS_A).subscribe();
    httpMock.expectOne((r) => isMarine(r.url)).flush(OK_RESPONSE);

    service.getOceanCurrentSamples(POINTS_B).subscribe();
    httpMock.expectOne((r) => isMarine(r.url)).flush([]);
  });

  it('does not cache an empty/rate-limited response — it stays retryable', () => {
    let first: OceanCurrentSample[] | undefined;
    service.getOceanCurrentSamples(POINTS_A).subscribe((s) => (first = s));
    // Open-Meteo returns an error body when the hourly quota is exceeded.
    httpMock
      .expectOne((r) => isMarine(r.url))
      .flush({ error: true, reason: 'Hourly API request limit exceeded.' });
    expect(first).toEqual([]);

    // A subsequent request for the same viewport must retry, not serve [].
    service.getOceanCurrentSamples(POINTS_A).subscribe();
    httpMock.expectOne((r) => isMarine(r.url)).flush(OK_RESPONSE);
  });
});
