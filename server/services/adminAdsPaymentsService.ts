import { db, runInTransaction } from '../db/database.js';
import { cache } from '../utils/cache.js';
import { sanitizeInputText, sanitizeSafeUrl } from '../utils/security.js';
import { adminSecurityService } from './adminSecurityService.js';

export interface CreateAdInput {
  title: string;
  sponsorName: string;
  body: string;
  targetUrl?: string;
  imageUrl?: string;
  placement?: 'feed' | 'communities' | 'updates' | 'sidebar';
  targetArea?: string;
  status?: 'draft' | 'active' | 'paused' | 'ended';
  budgetNaira?: number;
  startsAt?: string;
  endsAt?: string;
}

function mapAdRow(r: any) {
  const impressions = Number(r.impressions_count || 0);
  const clicks = Number(r.clicks_count || 0);
  return {
    id: r.id,
    title: r.title,
    sponsorName: r.sponsor_name,
    body: r.body,
    targetUrl: r.target_url || undefined,
    imageUrl: r.image_url || undefined,
    placement: r.placement || 'feed',
    targetArea: r.target_area || 'all',
    status: r.status || 'active',
    budgetNaira: Number(r.budget_kobo || 0) / 100,
    impressionsCount: impressions,
    clicksCount: clicks,
    ctrPercent: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
    startsAt: r.starts_at || undefined,
    endsAt: r.ends_at || undefined,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const adminAdsPaymentsService = {
  // ============================================================
  // ADVERTISEMENTS & CAMPAIGNS (ADMIN CONTROL)
  // ============================================================
  listAdvertisements() {
    const rows = db.prepare('SELECT * FROM advertisements ORDER BY created_at DESC').all() as any[];
    return rows.map(mapAdRow);
  },

  getActiveAdvertisements(areaKey?: string, placement = 'feed') {
    const safeArea = String(areaKey || 'all').trim().toLowerCase();
    const safePlacement = ['feed', 'communities', 'updates', 'sidebar'].includes(placement) ? placement : 'feed';

    const rows = db.prepare(`
      SELECT *
      FROM advertisements
      WHERE status = 'active'
        AND placement = ?
        AND (target_area = 'all' OR LOWER(target_area) = ?)
        AND (starts_at IS NULL OR datetime(starts_at) <= CURRENT_TIMESTAMP)
        AND (ends_at IS NULL OR datetime(ends_at) >= CURRENT_TIMESTAMP)
      ORDER BY created_at DESC
      LIMIT 6
    `).all(safePlacement, safeArea) as any[];

    return rows.map(mapAdRow);
  },

  recordAdEvent(adId: string, eventType: 'impression' | 'click') {
    if (!adId || !['impression', 'click'].includes(eventType)) {
      throw new Error('Invalid advertisement event.');
    }
    const col = eventType === 'click' ? 'clicks_count' : 'impressions_count';
    const res = db
      .prepare(`UPDATE advertisements SET ${col} = COALESCE(${col}, 0) + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(adId);
    if (!res.changes) throw new Error('Advertisement not found.');
    cache.invalidatePrefix('admin:');
    const row = db.prepare('SELECT * FROM advertisements WHERE id = ?').get(adId) as any;
    return mapAdRow(row);
  },

  createAdvertisement(adminId: string, input: CreateAdInput) {
    const title = sanitizeInputText(input.title, 100);
    const sponsorName = sanitizeInputText(input.sponsorName, 80);
    const body = sanitizeInputText(input.body, 400);
    if (title.length < 3 || sponsorName.length < 2 || body.length < 5) {
      throw new Error('Advertisement title, sponsor name, and copy are required.');
    }

    const placement = ['feed', 'communities', 'updates', 'sidebar'].includes(String(input.placement || ''))
      ? (input.placement as CreateAdInput['placement'])!
      : 'feed';
    const status = ['draft', 'active', 'paused', 'ended'].includes(String(input.status || ''))
      ? (input.status as CreateAdInput['status'])!
      : 'active';
    const targetUrl = input.targetUrl?.trim() ? sanitizeSafeUrl(input.targetUrl.trim(), { allowRelative: true }) : null;
    const imageUrl = input.imageUrl?.trim() ? sanitizeSafeUrl(input.imageUrl.trim(), { allowRelative: true }) : null;
    const targetArea = sanitizeInputText(input.targetArea || 'all', 40) || 'all';
    const budgetKobo = Math.max(0, Math.round(Number(input.budgetNaira || 0) * 100));

    const id = `ad-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO advertisements (
        id, title, sponsor_name, body, target_url, image_url, placement, target_area,
        status, budget_kobo, starts_at, ends_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      title,
      sponsorName,
      body,
      targetUrl,
      imageUrl,
      placement,
      targetArea,
      status,
      budgetKobo,
      input.startsAt || null,
      input.endsAt || null,
      adminId
    );

    adminSecurityService.logAdminAction(adminId, 'CREATE_ADVERTISEMENT', 'advertisement', id, {
      title,
      sponsorName,
      placement,
      status,
    });
    cache.invalidatePrefix('admin:');
    const row = db.prepare('SELECT * FROM advertisements WHERE id = ?').get(id) as any;
    return mapAdRow(row);
  },

  updateAdvertisement(adminId: string, adId: string, patch: Partial<CreateAdInput>) {
    const existing = db.prepare('SELECT * FROM advertisements WHERE id = ?').get(adId) as any;
    if (!existing) throw new Error('Advertisement not found.');

    const nextTitle = patch.title !== undefined ? sanitizeInputText(patch.title, 100) : existing.title;
    const nextSponsor = patch.sponsorName !== undefined ? sanitizeInputText(patch.sponsorName, 80) : existing.sponsor_name;
    const nextBody = patch.body !== undefined ? sanitizeInputText(patch.body, 400) : existing.body;
    const nextStatus =
      patch.status && ['draft', 'active', 'paused', 'ended'].includes(patch.status) ? patch.status : existing.status;
    const nextPlacement =
      patch.placement && ['feed', 'communities', 'updates', 'sidebar'].includes(patch.placement)
        ? patch.placement
        : existing.placement;
    const nextArea = patch.targetArea !== undefined ? sanitizeInputText(patch.targetArea, 40) || 'all' : existing.target_area;
    const nextBudget =
      patch.budgetNaira !== undefined ? Math.max(0, Math.round(Number(patch.budgetNaira) * 100)) : existing.budget_kobo;
    const nextUrl =
      patch.targetUrl !== undefined
        ? patch.targetUrl.trim()
          ? sanitizeSafeUrl(patch.targetUrl.trim(), { allowRelative: true })
          : null
        : existing.target_url;

    db.prepare(`
      UPDATE advertisements
      SET title = ?, sponsor_name = ?, body = ?, status = ?, placement = ?,
          target_area = ?, budget_kobo = ?, target_url = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(nextTitle, nextSponsor, nextBody, nextStatus, nextPlacement, nextArea, nextBudget, nextUrl, adId);

    adminSecurityService.logAdminAction(adminId, 'UPDATE_ADVERTISEMENT', 'advertisement', adId, {
      status: nextStatus,
      placement: nextPlacement,
    });
    cache.invalidatePrefix('admin:');
    return mapAdRow(db.prepare('SELECT * FROM advertisements WHERE id = ?').get(adId) as any);
  },

  deleteAdvertisement(adminId: string, adId: string) {
    const existing = db.prepare('SELECT id, title FROM advertisements WHERE id = ?').get(adId) as any;
    if (!existing) throw new Error('Advertisement not found.');
    db.prepare('DELETE FROM advertisements WHERE id = ?').run(adId);
    adminSecurityService.logAdminAction(adminId, 'DELETE_ADVERTISEMENT', 'advertisement', adId, {
      title: existing.title,
    });
    cache.invalidatePrefix('admin:');
    return { success: true, id: adId };
  },

  // ============================================================
  // PAYMENT RECORDS & ACCOUNTING ARCHIVES (ADMIN ONLY)
  // Core student social features stay 100% free — no student paywalls.
  // ============================================================
  listPaymentRecords(filters: { status?: string; search?: string } = {}) {
    const whereParts: string[] = [];
    const params: any[] = [];
    if (filters.status && filters.status !== 'all') {
      whereParts.push('p.status = ?');
      params.push(filters.status);
    }
    if (filters.search?.trim()) {
      const q = `%${filters.search.trim().toLowerCase()}%`;
      whereParts.push(
        '(LOWER(p.reference) LIKE ? OR LOWER(COALESCE(p.payer_account_name, \'\')) LIKE ? OR LOWER(COALESCE(pr.handle, \'\')) LIKE ?)'
      );
      params.push(q, q, q);
    }
    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    const payments = db.prepare(`
      SELECT p.*, pr.name as user_name, pr.handle as user_handle
      FROM payments p
      LEFT JOIN user_profiles pr ON pr.user_id = p.user_id
      ${whereSql}
      ORDER BY p.created_at DESC
      LIMIT 100
    `).all(...params) as any[];

    const retained = db.prepare(`
      SELECT *
      FROM retained_accounting_records
      ORDER BY retained_at DESC
      LIMIT 100
    `).all() as any[];

    const totals = db.prepare(`
      SELECT COUNT(*) as total_count,
             COALESCE(SUM(CASE WHEN status = 'confirmed' THEN amount_kobo ELSE 0 END), 0) as confirmed_kobo,
             COALESCE(SUM(CASE WHEN status IN ('pending', 'awaiting_verification') THEN amount_kobo ELSE 0 END), 0) as pending_kobo
      FROM payments
    `).get() as any;

    return {
      records: payments.map((p) => ({
        id: p.id,
        userId: p.user_id,
        userName: p.user_name || 'Account',
        userHandle: p.user_handle || '@account',
        reference: p.reference,
        amountNaira: Number(p.amount_kobo || 0) / 100,
        currency: p.currency || 'NGN',
        purpose: p.purpose,
        status: p.status,
        channel: p.channel,
        payerBankName: p.payer_bank_name || undefined,
        payerAccountName: p.payer_account_name || undefined,
        proofNote: p.proof_note || undefined,
        verifiedBy: p.verified_by || undefined,
        verifiedAt: p.verified_at || undefined,
        paidAt: p.paid_at || undefined,
        createdAt: p.created_at,
      })),
      retainedArchives: retained.map((r) => ({
        id: r.id,
        paymentId: r.payment_id,
        reference: r.reference,
        amountNaira: Number(r.amount_kobo || 0) / 100,
        currency: r.currency || 'NGN',
        channel: r.channel,
        purpose: r.purpose,
        status: r.status,
        paidAt: r.paid_at,
        retentionUntil: r.retention_until,
        retainedAt: r.retained_at,
      })),
      summary: {
        totalRecords: Number(totals?.total_count || 0),
        confirmedNaira: Number(totals?.confirmed_kobo || 0) / 100,
        pendingNaira: Number(totals?.pending_kobo || 0) / 100,
        retainedCount: retained.length,
      },
    };
  },

  createPaymentRecord(
    adminId: string,
    input: {
      userId?: string;
      reference?: string;
      amountNaira: number;
      purpose?: 'subscription' | 'campus_trade_listing' | 'ticket';
      channel?: string;
      payerName?: string;
      payerBankName?: string;
      note?: string;
      status?: 'pending' | 'awaiting_verification' | 'confirmed';
    }
  ) {
    const amountNaira = Number(input.amountNaira);
    if (!Number.isFinite(amountNaira) || amountNaira <= 0) {
      throw new Error('Payment amount must be a positive number.');
    }
    const targetUserId = input.userId?.trim() || adminId;
    const userExists = db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
    if (!userExists) throw new Error('Referenced account not found.');

    const id = `pay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const reference =
      sanitizeInputText(input.reference, 60) || `SB-REC-${Date.now()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const purpose = ['subscription', 'campus_trade_listing', 'ticket'].includes(String(input.purpose || ''))
      ? input.purpose!
      : 'campus_trade_listing';
    const status = ['pending', 'awaiting_verification', 'confirmed'].includes(String(input.status || ''))
      ? input.status!
      : 'confirmed';
    const channel = sanitizeInputText(input.channel || 'moniepoint', 40) || 'moniepoint';
    const amountKobo = Math.round(amountNaira * 100);

    runInTransaction(() => {
      db.prepare(`
        INSERT INTO payments (
          id, user_id, reference, amount_kobo, currency, purpose, status, channel,
          payer_bank_name, payer_account_name, proof_note, verified_by, verified_at, paid_at
        ) VALUES (?, ?, ?, ?, 'NGN', ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'confirmed' THEN CURRENT_TIMESTAMP ELSE NULL END, CASE WHEN ? = 'confirmed' THEN CURRENT_TIMESTAMP ELSE NULL END)
      `).run(
        id,
        targetUserId,
        reference,
        amountKobo,
        purpose,
        status,
        channel,
        sanitizeInputText(input.payerBankName || '', 80) || null,
        sanitizeInputText(input.payerName || '', 80) || null,
        sanitizeInputText(input.note || '', 300) || null,
        status === 'confirmed' ? adminId : null,
        status,
        status
      );

      db.prepare(`
        INSERT INTO payment_audit_logs (
          id, payment_id, reference, actor_id, actor_role, event_type, previous_status, new_status, notes
        ) VALUES (?, ?, ?, ?, 'admin', 'ADMIN_RECORD_PAYMENT', NULL, ?, ?)
      `).run(
        `pal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        id,
        reference,
        adminId,
        status,
        sanitizeInputText(input.note || 'Admin recorded ledger entry', 200)
      );

      adminSecurityService.logAdminAction(adminId, 'CREATE_PAYMENT_RECORD', 'payment', id, {
        reference,
        amountNaira,
        purpose,
        status,
      });
    });

    cache.invalidatePrefix('admin:');
    return this.listPaymentRecords().records.find((r) => r.id === id)!;
  },

  updatePaymentRecordStatus(
    adminId: string,
    paymentId: string,
    status: 'pending' | 'awaiting_verification' | 'confirmed' | 'failed' | 'reversed' | 'refunded',
    notes?: string
  ) {
    const allowed = new Set(['pending', 'awaiting_verification', 'confirmed', 'failed', 'reversed', 'refunded']);
    if (!allowed.has(status)) {
      throw new Error('Invalid payment record status.');
    }
    const existing = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as any;
    if (!existing) throw new Error('Payment record not found.');

    runInTransaction(() => {
      db.prepare(`
        UPDATE payments
        SET status = ?,
            verified_by = CASE WHEN ? IN ('confirmed', 'reversed', 'refunded') THEN ? ELSE verified_by END,
            verified_at = CASE WHEN ? IN ('confirmed', 'reversed', 'refunded') THEN CURRENT_TIMESTAMP ELSE verified_at END,
            paid_at = CASE WHEN ? = 'confirmed' AND paid_at IS NULL THEN CURRENT_TIMESTAMP ELSE paid_at END,
            proof_note = COALESCE(?, proof_note)
        WHERE id = ?
      `).run(status, status, adminId, status, status, notes?.trim().slice(0, 300) || null, paymentId);

      db.prepare(`
        INSERT INTO payment_audit_logs (
          id, payment_id, reference, actor_id, actor_role, event_type, previous_status, new_status, notes
        ) VALUES (?, ?, ?, ?, 'admin', 'ADMIN_UPDATE_STATUS', ?, ?, ?)
      `).run(
        `pal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        paymentId,
        existing.reference,
        adminId,
        existing.status,
        status,
        notes?.trim().slice(0, 200) || null
      );

      adminSecurityService.logAdminAction(adminId, 'UPDATE_PAYMENT_RECORD', 'payment', paymentId, {
        previousStatus: existing.status,
        newStatus: status,
        reference: existing.reference,
      });
    });

    cache.invalidatePrefix('admin:');
    return this.listPaymentRecords().records.find((r) => r.id === paymentId)!;
  },
};
