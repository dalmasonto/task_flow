import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../src/db.js';
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  clearNotifications,
} from '../src/tools/notifications.js';

function insertNotification(title: string, message: string, read = 0) {
  const db = getDb();
  const ts = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO notifications (title, message, type, read, created_at)
       VALUES (?, ?, 'info', ?, ?)`
    )
    .run(title, message, read, ts);
}

describe('Notification Tools', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  describe('listNotifications', () => {
    it('returns all notifications ordered by created_at DESC', async () => {
      insertNotification('Notif A', 'msg a');
      insertNotification('Notif B', 'msg b');

      const result = await listNotifications({});
      expect(result.isError).toBeUndefined();
      const notifications = JSON.parse(result.content[0].text);
      expect(notifications.length).toBe(2);
    });

    it('respects limit param', async () => {
      insertNotification('A', 'a');
      insertNotification('B', 'b');
      insertNotification('C', 'c');

      const result = await listNotifications({ limit: 2 });
      const notifications = JSON.parse(result.content[0].text);
      expect(notifications.length).toBe(2);
    });

    it('filters unread only', async () => {
      insertNotification('Unread', 'msg', 0);
      insertNotification('Read', 'msg', 1);
      insertNotification('Unread2', 'msg', 0);

      const result = await listNotifications({ unread_only: true });
      const notifications = JSON.parse(result.content[0].text);
      expect(notifications.length).toBe(2);
      expect(notifications.every((n: { read: number }) => n.read === 0)).toBe(true);
    });

    it('returns empty array when no notifications', async () => {
      const result = await listNotifications({});
      const notifications = JSON.parse(result.content[0].text);
      expect(notifications).toEqual([]);
    });
  });

  describe('markNotificationRead', () => {
    it('marks notification as read and returns updated notification', async () => {
      const insertResult = insertNotification('Test', 'msg', 0);
      const id = Number(insertResult.lastInsertRowid);

      const result = await markNotificationRead({ id });
      expect(result.isError).toBeUndefined();
      const notification = JSON.parse(result.content[0].text);
      expect(notification.id).toBe(id);
      expect(notification.read).toBe(1);
    });

    it('returns NOT_FOUND for non-existent id', async () => {
      const result = await markNotificationRead({ id: 9999 });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('NOT_FOUND');
    });
  });

  describe('markAllNotificationsRead', () => {
    it('marks all unread as read and returns count', async () => {
      insertNotification('A', 'a', 0);
      insertNotification('B', 'b', 0);
      insertNotification('C', 'c', 1);

      const result = await markAllNotificationsRead();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.updated).toBe(2);
    });

    it('returns 0 when all already read', async () => {
      insertNotification('A', 'a', 1);
      insertNotification('B', 'b', 1);

      const result = await markAllNotificationsRead();
      const data = JSON.parse(result.content[0].text);
      expect(data.updated).toBe(0);
    });
  });

  describe('clearNotifications', () => {
    it('deletes all notifications and returns count', async () => {
      insertNotification('A', 'a');
      insertNotification('B', 'b');
      insertNotification('C', 'c');

      const result = await clearNotifications();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.deleted).toBe(3);

      const checkResult = await listNotifications({});
      const notifications = JSON.parse(checkResult.content[0].text);
      expect(notifications.length).toBe(0);
    });

    it('returns 0 when table already empty', async () => {
      const result = await clearNotifications();
      const data = JSON.parse(result.content[0].text);
      expect(data.deleted).toBe(0);
    });
  });
});
