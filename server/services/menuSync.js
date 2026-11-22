import { PosIntegrationError } from '../adapters/pos/PosAdapter.js';

/**
 * Menu synchronisation.
 *
 * Polls the POS adapter and keeps a local snapshot so the kiosk can render
 * instantly and survive a brief POS outage. Polling (rather than push) is
 * deliberate for the PoC: every till system can be polled, while very few can
 * push, so this is the integration that actually works at a client site.
 *
 * Three rules this service exists to enforce:
 *   1. The POS snapshot is authoritative for price and availability. Kiosk
 *      overlays add photos and descriptions and can hide an item, but can
 *      never change what something costs or whether it is in stock.
 *   2. A cached menu is always labelled with its age. The UI shows a stale
 *      badge rather than pretending old prices are current.
 *   3. When the menu version changes, every open quote priced against the old
 *      version is invalidated, so a cart cannot be paid at a stale total.
 */
export class MenuSyncService {
  constructor({ adapter, kioskStore, storeId, logger, intervalSeconds = 30, staleAfterSeconds = 120 }) {
    this.adapter = adapter;
    this.kioskStore = kioskStore;
    this.storeId = storeId;
    this.logger = logger;
    this.intervalSeconds = intervalSeconds;
    this.staleAfterSeconds = staleAfterSeconds;
    this.timer = null;
    this.lastMenuVersion = null;
    this.inFlight = null;
  }

  start() {
    if (this.timer) return;
    // Fire once immediately so a freshly booted kiosk is not blank, then poll.
    this.syncNow().catch(() => {});
    this.timer = setInterval(() => {
      this.syncNow().catch(() => {});
    }, this.intervalSeconds * 1000);
    // Never hold the process open just for polling.
    this.timer.unref?.();
    this.logger?.info?.('menusync.started', { storeId: this.storeId, intervalSeconds: this.intervalSeconds });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Fetch and cache the menu. Overlapping calls share one in-flight request so
   * a burst of kiosk page loads cannot stampede the POS.
   */
  async syncNow() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#doSync().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async #doSync() {
    const started = process.hrtime.bigint();
    try {
      const menu = await this.adapter.getMenu();
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;

      this.kioskStore.saveMenuCache(this.storeId, menu);
      this.kioskStore.recordSyncAttempt(this.storeId, { success: true, latencyMs });

      if (this.lastMenuVersion && this.lastMenuVersion !== menu.menuVersion) {
        const invalidated = this.kioskStore.invalidateQuotesForMenuChange(this.storeId, menu.menuVersion);
        this.kioskStore.logEvent({
          storeId: this.storeId,
          eventType: 'menu.version_changed',
          message: 'POS menu changed; open quotes invalidated.',
          payload: { from: this.lastMenuVersion, to: menu.menuVersion, invalidatedQuotes: invalidated },
        });
        this.logger?.info?.('menusync.version_changed', {
          from: this.lastMenuVersion, to: menu.menuVersion, invalidatedQuotes: invalidated,
        });
      }
      this.lastMenuVersion = menu.menuVersion;

      this.#auditMappings(menu);
      return { ok: true, menuVersion: menu.menuVersion, latencyMs };
    } catch (error) {
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      this.kioskStore.recordSyncAttempt(this.storeId, { success: false, latencyMs, error: error.message });
      this.kioskStore.logEvent({
        storeId: this.storeId,
        level: 'error',
        eventType: 'menu.sync_failed',
        message: error.message,
        payload: { code: error.code ?? 'unknown' },
      });
      this.logger?.warn?.('menusync.failed', { message: error.message, code: error.code });
      return { ok: false, error: error.message, latencyMs };
    }
  }

  /**
   * Integration health check on the ID mapping table. A mapping that points at
   * a product the POS no longer has is exactly the failure that makes a kiosk
   * order vanish into a client's till, so it is surfaced rather than ignored.
   */
  #auditMappings(menu) {
    const posIds = new Set(menu.products.map((p) => p.posProductId));
    for (const [localKey, posProductId] of this.kioskStore.getMappings(this.storeId)) {
      if (!posIds.has(posProductId)) {
        this.kioskStore.recordIntegrationIssue(
          this.storeId,
          'mapping_dangling',
          `Local key "${localKey}" maps to POS product "${posProductId}", which the POS no longer lists.`,
        );
      }
    }
  }

  /**
   * Resolve a product reference that may be either a POS product ID or a
   * kiosk-local key. Returns null and records an integration issue when
   * neither resolves, so an unmapped item is never silently ordered.
   */
  resolveProductRef(ref) {
    const cached = this.kioskStore.readMenuCache(this.storeId);
    const posIds = new Set((cached?.menu?.products ?? []).map((p) => p.posProductId));
    if (posIds.has(ref)) return ref;

    const mapped = this.kioskStore.resolveLocalKey(this.storeId, ref);
    if (mapped && posIds.has(mapped)) return mapped;
    if (mapped && !posIds.has(mapped)) {
      this.kioskStore.recordIntegrationIssue(
        this.storeId, 'mapping_dangling',
        `Local key "${ref}" maps to "${mapped}", which is not in the current POS menu.`,
      );
      return null;
    }
    this.kioskStore.recordIntegrationIssue(
      this.storeId, 'mapping_missing',
      `No POS product mapping exists for "${ref}".`,
    );
    return null;
  }

  /**
   * The menu the kiosk UI renders: POS data for anything authoritative, plus
   * kiosk overlays for presentation, plus explicit freshness metadata.
   */
  getKioskMenu() {
    const cached = this.kioskStore.readMenuCache(this.storeId);
    const syncState = this.kioskStore.getSyncState(this.storeId);

    if (!cached) {
      return {
        available: false,
        reason: 'no_menu_yet',
        sync: { ...syncState, stale: true, ageSeconds: null, healthy: false },
        categories: [],
        products: [],
      };
    }

    const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(cached.syncedAt).getTime()) / 1000));
    const stale = ageSeconds > this.staleAfterSeconds;
    const overlays = this.kioskStore.getOverlays(this.storeId);

    const products = cached.menu.products
      .map((product) => {
        const overlay = overlays.get(product.posProductId);
        return {
          // ---- authoritative, straight from the POS. Not overridable. ----
          posProductId: product.posProductId,
          sku: product.sku,
          categoryId: product.categoryId,
          nameEn: product.nameEn,
          nameAr: product.nameAr,
          priceMinor: product.priceMinor,
          taxRateBp: product.taxRateBp,
          available: product.available,
          modifierGroups: product.modifierGroups,

          // ---- kiosk presentation overlay: description, photo, extras ----
          descriptionEn: overlay?.descriptionEn ?? product.descriptionEn,
          descriptionAr: overlay?.descriptionAr ?? product.descriptionAr,
          imageUrl: overlay?.imageUrl ?? product.imageHint ?? '',
          allergensEn: overlay?.allergensEn ?? null,
          allergensAr: overlay?.allergensAr ?? null,
          calories: overlay?.calories ?? null,
          displayOrder: overlay?.displayOrder ?? product.displayOrder,
          hiddenByOverlay: overlay?.hidden === true,
        };
      })
      // An overlay may hide an item from the kiosk channel without touching
      // the POS catalog — a shop may not want to sell everything on a kiosk.
      .filter((product) => !product.hiddenByOverlay)
      .sort((a, b) => a.displayOrder - b.displayOrder || (a.nameEn < b.nameEn ? -1 : 1));

    return {
      available: true,
      currency: cached.menu.currency,
      menuVersion: cached.menuVersion,
      defaultTaxRateBp: cached.menu.defaultTaxRateBp,
      categories: [...cached.menu.categories].sort((a, b) => a.displayOrder - b.displayOrder),
      products,
      sync: {
        ...syncState,
        syncedAt: cached.syncedAt,
        ageSeconds,
        stale,
        healthy: (syncState?.consecutiveFailures ?? 0) === 0,
        intervalSeconds: this.intervalSeconds,
      },
    };
  }

  /** Is the POS currently reachable, and how fresh is what we are showing? */
  async healthSnapshot() {
    const adapterHealth = await this.adapter.health().catch((error) => ({
      healthy: false, latencyMs: 0, detail: error.message,
    }));
    const syncState = this.kioskStore.getSyncState(this.storeId);
    const cached = this.kioskStore.readMenuCache(this.storeId);
    const ageSeconds = cached
      ? Math.max(0, Math.round((Date.now() - new Date(cached.syncedAt).getTime()) / 1000))
      : null;
    return {
      pos: { ...adapterHealth, ...this.adapter.getMetrics?.() },
      menu: {
        cached: Boolean(cached),
        menuVersion: cached?.menuVersion ?? null,
        syncedAt: cached?.syncedAt ?? null,
        ageSeconds,
        stale: ageSeconds === null ? true : ageSeconds > this.staleAfterSeconds,
      },
      sync: syncState,
    };
  }
}

export { PosIntegrationError };
