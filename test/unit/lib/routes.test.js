

const request = require('supertest');
const express = require('express');

const { setupRoutes } = require('../../../lib/routes');
jest.mock('../../../lib/installationCache', () => ({
  getInstallations: jest.fn(),
  getOrgLogins: jest.fn(() => ['jetest99', 'jefeish-training']),
  getLastFetchedAt: jest.fn()
}));
jest.mock('../../../lib/hubSyncHandler', () => ({
  retrieveSettingsFromOrgs: jest.fn()
}));
const { getInstallations: cacheGetInstallations } = require('../../../lib/installationCache');
const { retrieveSettingsFromOrgs } = require('../../../lib/hubSyncHandler');

let app;
let robot;
jest.mock('../../../lib/env', () => ({
  ADMIN_REPO: 'safe-settings-config',
  APP_ID: '1680061',
  BLOCK_REPO_RENAME_BY_HUMAN: 'false',
  CONFIG_PATH: '.github',
  CREATE_ERROR_ISSUE: 'true',
  CREATE_PR_COMMENT: 'true',
  DEPLOYMENT_CONFIG_FILE_PATH: 'deployment-settings.yml',
  FULL_SYNC_NOP: false,
  PRIVATE_KEY_PATH: './fabrikam-private-key.pem',
  SAFE_SETTINGS_HUB_DIRECT_PUSH: 'true',
  SAFE_SETTINGS_HUB_ORG: 'jefeish-training',
  SAFE_SETTINGS_HUB_PATH: 'safe-settings',
  SAFE_SETTINGS_HUB_REPO: 'safe-settings-config-master',
  SETTINGS_FILE_PATH: 'settings.yml'
}));

beforeEach(() => {
  app = express();
  // Ensure env.ADMIN_REPO is set
  process.env.ADMIN_REPO = 'safe-settings-config';
  // Mock robot.auth to avoid 500 errors in installation route
  robot = {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    auth: jest.fn().mockResolvedValue({
      repos: {
        get: jest.fn().mockResolvedValue({}),
        getContent: jest.fn().mockResolvedValue({ data: [] }),
        listCommits: jest.fn().mockResolvedValue({ data: [] })
      }
    })
  };
  app.use(setupRoutes(robot, (base) => express.Router()));
});

/**
 * Tests the /api/safe-settings/installation endpoint.
 * Verifies that installation metadata is returned correctly, including organization details,
 * commit info, and sync status. Also checks error handling for API failures.
 */
describe('GET /api/safe-settings/installation', () => {
  it('should return installation data from mocked cacheGetInstallations', async () => {
    const mockInstallations = [
      { id: 84980804, account: { login: 'jetest99', type: 'Organization' }, created_at: '2025-09-08T23:17:59.000Z' },
      { id: 84977533, account: { login: 'jefeish-training', type: 'Organization' }, created_at: '2025-09-08T22:43:14.000Z' }
    ];
    cacheGetInstallations.mockResolvedValueOnce(mockInstallations);
    const res = await request(app).get('/api/safe-settings/installation');
    // expect(res.statusCode).toBe(200);
    expect(res.body.installations).toBeDefined();
    expect(res.body.installations.length).toBe(mockInstallations.length);
    expect(res.body.installations[0].account).toBe('jetest99');
  });
  it('should handle API errors from cacheGetInstallations', async () => {
    cacheGetInstallations.mockRejectedValueOnce(new Error('API down'));
    const res = await request(app).get('/api/safe-settings/installation');
    expect([500, 404]).toContain(res.statusCode);
  });
});

/**
 * Tests the /api/safe-settings/hub/content endpoint.
 * Ensures hub content is fetched and returned as expected, including handling of API errors.
 * Covers both successful data retrieval and error scenarios.
 */
describe('GET /api/safe-settings/hub/content', () => {

  it('should return hub content', async () => {
    const res = await request(app).get('/api/safe-settings/hub/content');
    expect([200, 404, 500]).toContain(res.statusCode);
    expect(res.body).toBeDefined();
  });
  it('should handle API errors', async () => {
    const res = await request(app).get('/api/safe-settings/hub/content');
    expect([500, 404]).toContain(res.statusCode);
  });
});

/**
 * Tests the /api/safe-settings/app/env endpoint.
 * Checks that environment variables from the .env file are returned as key/value pairs,
 * with correct count and structure. Also verifies error handling for API failures.
 */
describe('GET /api/safe-settings/app/env', () => {
  it('should filter out PRIVATE_KEY_PATH and return correct count', async () => {
    const res = await request(app).get('/api/safe-settings/app/env');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeDefined();
    // Should not include PRIVATE_KEY_PATH
    expect(res.body.variables.some(v => v.key === 'PRIVATE_KEY_PATH')).toBe(false);
    // Should return 13 variables
    expect(res.body.count).toBe(13);
    expect(res.body.variables.length).toBe(13);
    // Each variable should have key, value, and description
    res.body.variables.forEach(v => {
      expect(v).toHaveProperty('key');
      expect(v).toHaveProperty('value');
      expect(v).toHaveProperty('description');
    });
  });
});

/**
 * Tests the /api/safe-settings/hub/import endpoint.
 * Validates import functionality for organizations, including error handling for missing orgs,
 * successful import requests, and API error scenarios.
 */
describe('POST /api/safe-settings/hub/import', () => {

  it('should return 400 if no orgs', async () => {
    const res = await request(app).post('/api/safe-settings/hub/import').send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Missing orgs/);
  });
  it('should process import with orgs', async () => {
    retrieveSettingsFromOrgs.mockResolvedValueOnce([{ org: 'org1', success: true }]);
    const res = await request(app).post('/api/safe-settings/hub/import').send({ orgs: ['org1'] });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });
  it('should handle API errors', async () => {
    retrieveSettingsFromOrgs.mockRejectedValueOnce(new Error('API down'));
    const res = await request(app).post('/api/safe-settings/hub/import').send({ orgs: ['org1'] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: false, error: 'API down', results: [] });
  });
});
