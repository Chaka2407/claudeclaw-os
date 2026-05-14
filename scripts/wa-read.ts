#!/usr/bin/env tsx
/**
 * CLI helper to read WhatsApp messages from the database.
 * Handles DB initialization and decryption so agents can call this standalone.
 *
 * Usage:
 *   npx tsx scripts/wa-read.ts recent [minutes=5]    -- recent incoming messages
 *   npx tsx scripts/wa-read.ts contacts [limit=20]   -- list known contacts
 *   npx tsx scripts/wa-read.ts chat <chatId> [limit=10] -- messages from a specific chat
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');

// Read encryption key from .env without dotenv
function readKeyFromEnv(): string {
  const envPath = path.join(PROJECT_ROOT, '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^DB_ENCRYPTION_KEY=(.+)/);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
  return '';
}

const db = new Database(DB_PATH, { readonly: true });

function getEncryptionKey(): Buffer {
  const hex = readKeyFromEnv();
  if (!hex) throw new Error('DB_ENCRYPTION_KEY not set in .env');
  return Buffer.from(hex, 'hex');
}

function decryptField(ciphertext: string): string {
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) return ciphertext;
    const [ivHex, authTagHex, dataHex] = parts;
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return ciphertext;
  }
}

const [,, command, ...args] = process.argv;

switch (command) {
  case 'recent': {
    const minutes = parseInt(args[0] || '5', 10);
    const cutoff = Math.floor(Date.now() / 1000) - minutes * 60;
    const rows = db.prepare(
      `SELECT id, chat_id, contact_name, body, timestamp, is_from_me
       FROM wa_messages
       WHERE is_from_me = 0 AND timestamp > ?
       ORDER BY timestamp DESC`
    ).all(cutoff) as Array<{ id: number; chat_id: string; contact_name: string; body: string; timestamp: number; is_from_me: number }>;

    if (rows.length === 0) {
      console.log(JSON.stringify({ count: 0, messages: [] }));
    } else {
      const messages = rows.map(r => ({
        id: r.id,
        chat_id: r.chat_id,
        contact_name: r.contact_name,
        body: decryptField(r.body),
        timestamp: r.timestamp,
        time: new Date(r.timestamp * 1000).toISOString(),
      }));
      console.log(JSON.stringify({ count: messages.length, messages }, null, 2));
    }
    break;
  }

  case 'contacts': {
    const limit = parseInt(args[0] || '20', 10);
    const rows = db.prepare(
      `SELECT chat_id, contact_name, MAX(timestamp) as last_seen
       FROM wa_messages
       WHERE is_from_me = 0
       GROUP BY chat_id
       ORDER BY last_seen DESC
       LIMIT ?`
    ).all(limit) as Array<{ chat_id: string; contact_name: string; last_seen: number }>;

    console.log(JSON.stringify(rows.map(r => ({
      chat_id: r.chat_id,
      contact_name: r.contact_name,
      last_seen: new Date(r.last_seen * 1000).toISOString(),
    })), null, 2));
    break;
  }

  case 'chat': {
    const chatId = args[0];
    if (!chatId) { console.error('Usage: wa-read.ts chat <chatId> [limit]'); process.exit(1); }
    const limit = parseInt(args[1] || '10', 10);
    const rows = db.prepare(
      `SELECT id, chat_id, contact_name, body, timestamp, is_from_me
       FROM wa_messages WHERE chat_id = ?
       ORDER BY timestamp DESC LIMIT ?`
    ).all(chatId, limit) as Array<{ id: number; chat_id: string; contact_name: string; body: string; timestamp: number; is_from_me: number }>;

    const messages = rows.map(r => ({
      id: r.id,
      contact_name: r.contact_name,
      body: decryptField(r.body),
      timestamp: r.timestamp,
      time: new Date(r.timestamp * 1000).toISOString(),
      from_me: r.is_from_me === 1,
    }));
    console.log(JSON.stringify(messages, null, 2));
    break;
  }

  default:
    console.error('Usage: wa-read.ts <recent|contacts|chat> [args]');
    process.exit(1);
}

db.close();
