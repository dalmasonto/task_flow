import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../src/db.js';
import { getSetting, updateSetting } from '../src/tools/settings.js';

describe('Settings Tools', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  describe('getSetting', () => {
    it('returns default value when key is not set', async () => {
      const result = await getSetting({ key: 'timerBarDisplayMode' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.key).toBe('timerBarDisplayMode');
      expect(data.value).toBe('carousel');
    });

    it('returns default for notificationInterval', async () => {
      const result = await getSetting({ key: 'notificationInterval' });
      const data = JSON.parse(result.content[0].text);
      expect(data.value).toBe(30);
    });

    it('returns default for statusColors object', async () => {
      const result = await getSetting({ key: 'statusColors' });
      const data = JSON.parse(result.content[0].text);
      expect(data.value).toMatchObject({ not_started: '#484847' });
    });

    it('returns null value for unknown key with no default', async () => {
      const result = await getSetting({ key: 'nonExistentKey' });
      const data = JSON.parse(result.content[0].text);
      expect(data.key).toBe('nonExistentKey');
      expect(data.value).toBeNull();
    });

    it('returns stored value when key exists in db', async () => {
      const db = getDb();
      db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
        'timerBarDisplayMode',
        JSON.stringify('list')
      );

      const result = await getSetting({ key: 'timerBarDisplayMode' });
      const data = JSON.parse(result.content[0].text);
      expect(data.value).toBe('list');
    });
  });

  describe('updateSetting', () => {
    it('writes a string value and returns it', async () => {
      const result = await updateSetting({ key: 'operatorName', value: 'admin' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.key).toBe('operatorName');
      expect(data.value).toBe('admin');
    });

    it('writes a number value', async () => {
      const result = await updateSetting({ key: 'glowIntensity', value: 75 });
      const data = JSON.parse(result.content[0].text);
      expect(data.value).toBe(75);
    });

    it('writes an object value', async () => {
      const colors = { not_started: '#000000', done: '#ffffff' };
      const result = await updateSetting({ key: 'statusColors', value: colors });
      const data = JSON.parse(result.content[0].text);
      expect(data.value).toEqual(colors);
    });

    it('get_setting reads back updated value', async () => {
      await updateSetting({ key: 'timerBarDisplayMode', value: 'list' });
      const result = await getSetting({ key: 'timerBarDisplayMode' });
      const data = JSON.parse(result.content[0].text);
      expect(data.value).toBe('list');
    });

    it('update_setting replaces existing value', async () => {
      await updateSetting({ key: 'operatorName', value: 'user1' });
      await updateSetting({ key: 'operatorName', value: 'user2' });
      const result = await getSetting({ key: 'operatorName' });
      const data = JSON.parse(result.content[0].text);
      expect(data.value).toBe('user2');
    });

    it('logs activity when setting is saved', async () => {
      await updateSetting({ key: 'glowIntensity', value: 60 });
      const db = getDb();
      const log = db
        .prepare(`SELECT * FROM activity_logs WHERE action = 'settings_saved'`)
        .get() as { action: string; title: string } | undefined;
      expect(log).toBeDefined();
      expect(log?.action).toBe('settings_saved');
    });
  });
});
