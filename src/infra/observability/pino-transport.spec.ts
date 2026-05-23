import { buildPinoTransport } from './pino-transport';

const ORIGINAL = {
  NODE_ENV: process.env.NODE_ENV,
  LOKI_URL: process.env.LOKI_URL,
  LOKI_USERNAME: process.env.LOKI_USERNAME,
  LOKI_TOKEN: process.env.LOKI_TOKEN,
};

function restore(): void {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('buildPinoTransport', () => {
  afterEach(restore);

  it('returns pino-pretty only when not prod and no Loki', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.LOKI_URL;

    const result = buildPinoTransport();

    expect(result?.targets).toHaveLength(1);
    expect(result?.targets[0].target).toBe('pino-pretty');
  });

  it('returns undefined when prod and no Loki (pino default stdout JSON)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOKI_URL;

    const result = buildPinoTransport();

    // No transport = pino's default stdout JSON path — fastest, no
    // worker thread spawned.
    expect(result).toBeUndefined();
  });

  it('adds pino-loki when LOKI_URL is set (production)', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOKI_URL = 'https://logs-prod-x.grafana.net';
    process.env.LOKI_USERNAME = '12345';
    process.env.LOKI_TOKEN = 'glc_secret';

    const result = buildPinoTransport();

    expect(result?.targets).toHaveLength(1);
    const loki = result?.targets[0];
    expect(loki?.target).toBe('pino-loki');
    expect(loki?.options).toMatchObject({
      host: 'https://logs-prod-x.grafana.net',
      basicAuth: { username: '12345', password: 'glc_secret' },
      labels: { app: 'chopnow-api', env: 'production' },
      batching: true,
    });
  });

  it('adds BOTH pino-pretty and pino-loki when dev + Loki configured', () => {
    process.env.NODE_ENV = 'development';
    process.env.LOKI_URL = 'https://logs-prod-x.grafana.net';
    process.env.LOKI_USERNAME = '12345';
    process.env.LOKI_TOKEN = 'glc_secret';

    const result = buildPinoTransport();

    expect(result?.targets).toHaveLength(2);
    expect(result?.targets.map((t) => t.target).sort()).toEqual(['pino-loki', 'pino-pretty']);
  });

  it('treats empty LOKI_URL the same as unset', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOKI_URL = '';

    const result = buildPinoTransport();

    expect(result).toBeUndefined();
  });
});
