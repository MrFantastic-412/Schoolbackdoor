import { Response } from 'express';
import { db } from '../db/database.js';
import { presenceService, OnlinePresenceSummary } from '../services/presenceService.js';

interface SseConnectionEntry {
  res: Response;
  userId: string;
  clientId?: string;
  isAuthenticated: boolean;
}

class SSEManager {
  private userConnections = new Map<string, Set<SseConnectionEntry>>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastBroadcastedCount: number | null = null;
  private lastBroadcastAt = 0;

  constructor() {
    // Send periodic heartbeats every 25 seconds to keep HTTP connections alive through proxies
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 25000);
    this.heartbeatInterval.unref();
  }

  /**
   * Registers a client SSE connection for a user (optionally tied to a unique tab clientId)
   */
  addClient(userId: string, res: Response, options?: { clientId?: string; isAuthenticated?: boolean; userAgent?: string }) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const entry: SseConnectionEntry = {
      res,
      userId,
      clientId: options?.clientId,
      isAuthenticated: Boolean(options?.isAuthenticated),
    };

    if (!this.userConnections.has(userId)) {
      this.userConnections.set(userId, new Set());
    }
    this.userConnections.get(userId)!.add(entry);

    // Initial greeting / connection acknowledgment
    res.write(`: connected at ${new Date().toISOString()}\n\n`);

    // Record shared presence if authenticated and clientId provided
    if (entry.isAuthenticated && entry.clientId) {
      try {
        const summary = presenceService.recordHeartbeat(userId, entry.clientId, options?.userAgent);
        this.broadcastPresenceUpdate(summary);
      } catch {
        // Ignore transient presence errors during socket setup
      }
    }

    // Send initial presence count immediately on connect
    try {
      const summary = presenceService.getOnlineSummary();
      res.write(`event: presence:count\ndata: ${JSON.stringify(summary)}\n\n`);
    } catch {
      // ignore
    }

    // Cleanup on client disconnect
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      const connections = this.userConnections.get(userId);
      if (connections) {
        connections.delete(entry);
        if (connections.size === 0) {
          this.userConnections.delete(userId);
        }
      }
      if (entry.isAuthenticated && entry.clientId) {
        try {
          const summary = presenceService.removeClientPresence(userId, entry.clientId);
          this.broadcastPresenceUpdate(summary);
        } catch {
          // ignore
        }
      }
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);
  }

  /**
   * Broadcasts live presence count to connected streams when changed (throttled to avoid fanout storms)
   */
  broadcastPresenceUpdate(summary?: OnlinePresenceSummary, force = false) {
    const currentSummary = summary || presenceService.getOnlineSummary();
    const now = Date.now();

    if (!force && this.lastBroadcastedCount === currentSummary.onlineCount && now - this.lastBroadcastAt < 15000) {
      return;
    }

    this.lastBroadcastedCount = currentSummary.onlineCount;
    this.lastBroadcastAt = now;

    const payload = `event: presence:count\ndata: ${JSON.stringify(currentSummary)}\n\n`;
    for (const [userId, connections] of this.userConnections.entries()) {
      for (const entry of connections) {
        try {
          entry.res.write(payload);
        } catch {
          connections.delete(entry);
        }
      }
      if (connections.size === 0) {
        this.userConnections.delete(userId);
      }
    }
  }

  /**
   * Alias / Dispatches an event to a specific user
   */
  sendToUser(userId: string, eventName: string, data: any) {
    this.broadcastToUser(userId, eventName, data);
  }

  /**
   * Broadcasts an event to all active connected SSE clients
   */
  broadcast(eventName: string, data: any) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [userId, connections] of this.userConnections.entries()) {
      for (const entry of connections) {
        try {
          entry.res.write(payload);
        } catch {
          connections.delete(entry);
        }
      }
      if (connections.size === 0) {
        this.userConnections.delete(userId);
      }
    }
  }

  /**
   * Dispatches an event to a specific user
   */
  broadcastToUser(userId: string, eventName: string, data: any) {
    const connections = this.userConnections.get(userId);
    if (!connections || connections.size === 0) return;

    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const entry of connections) {
      try {
        entry.res.write(payload);
      } catch (err) {
        console.warn(`[SSE] Failed writing to user ${userId}:`, err);
      }
    }
  }

  /**
   * Dispatches an event to multiple specific users
   */
  broadcastToUsers(userIds: string[], eventName: string, data: any) {
    for (const uid of userIds) {
      this.broadcastToUser(uid, eventName, data);
    }
  }

  /**
   * Dispatches an event to all participants of a chat
   */
  broadcastToChatParticipants(chatId: string, eventName: string, data: any, excludeUserId?: string) {
    try {
      const participants = db.prepare(`
        SELECT user_id FROM chat_participants WHERE chat_id = ?
      `).all(chatId) as Array<{ user_id: string }>;

      for (const p of participants) {
        if (!excludeUserId || p.user_id !== excludeUserId) {
          this.broadcastToUser(p.user_id, eventName, data);
        }
      }
    } catch (err) {
      console.warn(`[SSE] Failed broadcasting to chat participants for ${chatId}:`, err);
    }
  }

  /**
   * Sends heartbeat ping comment to keep all client connections active and refreshes authenticated presence
   */
  private sendHeartbeat() {
    const heartbeatEntries: Array<{ userId: string; clientId: string }> = [];
    for (const [userId, connections] of this.userConnections.entries()) {
      for (const entry of connections) {
        try {
          entry.res.write(': ping\n\n');
          if (entry.isAuthenticated && entry.clientId) {
            heartbeatEntries.push({ userId, clientId: entry.clientId });
          }
        } catch {
          connections.delete(entry);
        }
      }
      if (connections.size === 0) {
        this.userConnections.delete(userId);
      }
    }
    if (heartbeatEntries.length > 0) {
      try {
        presenceService.recordBatchHeartbeats(heartbeatEntries);
      } catch {
        // Non-critical heartbeat batch refresh
      }
    }
  }

  /**
   * Gets the total active connected unique users count
   */
  getConnectedUserCount(): number {
    return this.userConnections.size;
  }

  /**
   * Gets total active SSE socket connections across all tabs/devices
   */
  getTotalConnectionCount(): number {
    let total = 0;
    for (const conns of this.userConnections.values()) {
      total += conns.size;
    }
    return total;
  }

  /**
   * Gracefully closes all SSE connections on server shutdown
   */
  closeAllClients() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const connections of this.userConnections.values()) {
      for (const entry of connections) {
        try {
          entry.res.end();
        } catch {
          // ignore
        }
      }
    }
    this.userConnections.clear();
  }
}

export const sseManager = new SSEManager();
