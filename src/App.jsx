import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Welcome from './pages/Welcome.jsx';
import Menu from './pages/Menu.jsx';
import CustomizeDrink from './pages/CustomizeDrink.jsx';
import Cart from './pages/Cart.jsx';
import Checkout from './pages/Checkout.jsx';
import Payment from './pages/Payment.jsx';
import Confirmation from './pages/Confirmation.jsx';
import IdleWarning from './components/IdleWarning.jsx';
import { api, ApiError, newClientRequestId } from './api.js';
import { dictionary } from '../shared/i18n.js';

const KIOSK_ID = 'kiosk-01';
const CART_STORAGE_KEY = 'bean-bloom-cart-v2';

/**
 * Kiosk application shell.
 *
 * Two rules shape everything here:
 *
 * 1. **The server owns the money.** The cart keeps a local unit price so the
 *    screen can respond instantly, but every total shown at cart and checkout
 *    comes from a POS quote. Where the two disagree, the quote wins.
 * 2. **The POS owns the catalog.** Products, prices, availability and modifier
 *    groups all arrive from `/api/kiosk/menu`. Nothing is hardcoded.
 */
/**
 * Development-only screen override: `?screen=menu`, `?lang=ar`.
 *
 * Styling the kiosk for three screen sizes means loading the same page
 * dozens of times; clicking through the flow each time is the slow part.
 * Stripped from production builds by `import.meta.env.DEV`, so a deployed
 * kiosk cannot be jumped past its own welcome screen with a query string.
 */
function devInitialPage() {
  if (!import.meta.env.DEV) return 'welcome';
  const screen = new URLSearchParams(window.location.search).get('screen');
  return ['welcome', 'menu', 'customize', 'cart', 'checkout'].includes(screen) ? screen : 'welcome';
}

export default function App() {
  const [lang, setLang] = useState(() => {
    if (import.meta.env.DEV) {
      const forced = new URLSearchParams(window.location.search).get('lang');
      if (forced === 'ar' || forced === 'en') return forced;
    }
    return localStorage.getItem('bean-bloom-lang') === 'ar' ? 'ar' : 'en';
  });
  const [page, setPage] = useState(devInitialPage);
  const [config, setConfig] = useState(null);
  const [menu, setMenu] = useState(null);
  const [menuError, setMenuError] = useState('');
  const [selected, setSelected] = useState(null);
  const [cart, setCart] = useState(loadCart);
  const [fulfillment, setFulfillment] = useState('takeaway');
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [order, setOrder] = useState(null);
  const [placing, setPlacing] = useState(false);
  const [orderError, setOrderError] = useState(null);

  const t = dictionary[lang];
  const currency = config?.currency ?? menu?.currency ?? 'ILS';

  // ---- language and direction -------------------------------------------
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    localStorage.setItem('bean-bloom-lang', lang);
  }, [lang]);

  useEffect(() => {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    } catch {
      // A full storage quota must not break ordering.
    }
  }, [cart]);

  // ---- config and menu ---------------------------------------------------
  const loadMenu = useCallback(async () => {
    try {
      const data = await api.menu();
      setMenu(data);
      setMenuError(data.available ? '' : 'unavailable');
    } catch (error) {
      setMenuError(error instanceof ApiError ? error.code || 'unavailable' : 'unavailable');
    }
  }, []);

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
    loadMenu();
    // Poll in step with the server's own sync so a price change on the till
    // reaches the screen without anyone touching the kiosk.
    const interval = setInterval(loadMenu, 15000);
    return () => clearInterval(interval);
  }, [loadMenu]);

  useEffect(() => {
    api.heartbeat(KIOSK_ID, 'phase2').catch(() => {});
    const interval = setInterval(() => api.heartbeat(KIOSK_ID, 'phase2').catch(() => {}), 60000);
    return () => clearInterval(interval);
  }, []);

  const products = menu?.products ?? [];
  const productsById = useMemo(
    () => new Map(products.map((p) => [p.posProductId, p])),
    [products],
  );

  // ---- cart --------------------------------------------------------------
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  /**
   * Drop anything the POS no longer sells. A cart that survived in
   * localStorage must never resurrect a delisted product.
   */
  useEffect(() => {
    if (!menu?.available || cart.length === 0) return;
    const live = cart.filter((item) => productsById.has(item.posProductId));
    if (live.length !== cart.length) setCart(live);
  }, [menu, productsById, cart]);

  const addToCart = useCallback((product, modifierIds, modifiers, quantity, unitPriceMinor) => {
    const key = `${product.posProductId}:${[...modifierIds].sort().join(',')}`;
    setCart((old) => {
      const existing = old.find((item) => item.key === key);
      if (existing) {
        return old.map((item) =>
          item.key === key ? { ...item, quantity: Math.min(item.quantity + quantity, 20) } : item);
      }
      return [...old, {
        key,
        posProductId: product.posProductId,
        nameEn: product.nameEn,
        nameAr: product.nameAr,
        imageUrl: product.imageUrl,
        modifierIds,
        modifiers,
        quantity,
        unitPriceMinor,
      }];
    });
    go('cart');
  }, []);

  const changeQuantity = useCallback((key, quantity) => {
    setCart((old) => old.map((item) => (item.key === key ? { ...item, quantity } : item)));
  }, []);

  const removeItem = useCallback((key) => {
    setCart((old) => old.filter((item) => item.key !== key));
  }, []);

  // ---- server-side quote -------------------------------------------------
  // Re-quote whenever the cart or the dine-in choice changes. The displayed
  // total is always the POS's, never a sum computed in the browser.
  const quoteSeq = useRef(0);
  useEffect(() => {
    if (cart.length === 0) {
      setQuote(null);
      setQuoteError(null);
      return undefined;
    }
    const seq = ++quoteSeq.current;
    const controller = new AbortController();
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.quote({
          kioskId: KIOSK_ID,
          cart: {
            fulfillment,
            lines: cart.map((item) => ({
              posProductId: item.posProductId,
              quantity: item.quantity,
              modifierIds: item.modifierIds,
            })),
          },
        }, controller.signal);
        if (seq !== quoteSeq.current) return;
        setQuote(result);
        setQuoteError(null);
      } catch (error) {
        if (seq !== quoteSeq.current || controller.signal.aborted) return;
        setQuote(null);
        setQuoteError(error instanceof ApiError ? error : new ApiError('offline'));
      } finally {
        if (seq === quoteSeq.current) setQuoting(false);
      }
    }, 180); // brief debounce so a quantity stepper does not spam the POS
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [cart, fulfillment]);

  // ---- placing the order -------------------------------------------------
  // One idempotency key per checkout attempt, generated when the customer
  // arrives at checkout and reused for every retry.
  const requestIdRef = useRef(null);

  /**
   * Move to payment. The order is NOT created here: it is created when the
   * payment is approved, with the payment attached, so an approval and an
   * order are made in one idempotent step on the server.
   */
  const goToPayment = useCallback(() => {
    if (!quote?.quoteId) return;
    // One idempotency key per checkout attempt, covering both the payment and
    // the order it produces.
    if (!requestIdRef.current) requestIdRef.current = newClientRequestId(KIOSK_ID);
    setOrderError(null);
    go('payment');
  }, [quote]);

  const handlePaid = useCallback((result, paymentSession) => {
    setOrder({ ...result, payment: paymentSession ?? null });
    setCart([]);
    requestIdRef.current = null;
    go('success');
  }, []);

  const handlePaymentAbandoned = useCallback(() => {
    // The customer backed out before paying. The cart stays, but the next
    // attempt is a new checkout and needs a fresh key.
    requestIdRef.current = null;
    go('cart');
  }, []);

  // ---- navigation and session reset -------------------------------------
  function go(next) {
    setPage(next);
    window.scrollTo(0, 0);
  }

  const resetSession = useCallback(() => {
    setCart([]);
    setSelected(null);
    setQuote(null);
    setQuoteError(null);
    setOrder(null);
    setOrderError(null);
    setFulfillment('takeaway');
    requestIdRef.current = null;
    setPage('welcome');
  }, []);

  const common = {
    t,
    lang,
    onLanguage: () => setLang((v) => (v === 'en' ? 'ar' : 'en')),
    currency,
    // From /api/kiosk/config, so rebranding is configuration, not a code edit.
    storeName: (lang === 'ar' ? config?.nameAr : config?.nameEn) || undefined,
  };
  const menuState = {
    products,
    categories: menu?.categories ?? [],
    stale: menu?.sync?.stale ?? false,
    offline: Boolean(menuError) || menu?.available === false,
    ageSeconds: menu?.sync?.ageSeconds ?? null,
  };

  // The idle timeout runs on every screen except the attract screen and the
  // confirmation, where there is nothing to abandon.
  // Never time out during payment: the customer may be reaching for a card,
  // and clearing the session mid-authorisation is exactly how a payment gets
  // taken with no order attached.
  const idleActive = !['welcome', 'success', 'payment'].includes(page);

  return (
    <>
      {idleActive && (
        <IdleWarning
          t={t}
          lang={lang}
          timeoutSeconds={config?.inactivityTimeoutSeconds ?? 60}
          onTimeout={resetSession}
        />
      )}
      {page === 'welcome' && (
        <Welcome {...common} onStart={() => go('menu')} offline={menuState.offline} />
      )}
      {page === 'menu' && (
        <Menu
          {...common}
          {...menuState}
          error={menuError}
          onRetry={loadMenu}
          onBack={() => go('welcome')}
          onCart={() => go('cart')}
          cartCount={cartCount}
          onChoose={(product) => { setSelected(product); go('customize'); }}
        />
      )}
      {page === 'customize' && selected && (
        <CustomizeDrink
          {...common}
          product={productsById.get(selected.posProductId) ?? selected}
          onBack={() => go('menu')}
          onCart={() => go('cart')}
          cartCount={cartCount}
          onAdd={addToCart}
        />
      )}
      {page === 'cart' && (
        <Cart
          {...common}
          cart={cart}
          quote={quote}
          quoting={quoting}
          quoteError={quoteError}
          onBack={() => go('menu')}
          cartCount={cartCount}
          onCheckout={() => { setOrderError(null); go('checkout'); }}
          onChangeQty={changeQuantity}
          onRemove={removeItem}
        />
      )}
      {page === 'checkout' && (
        <Checkout
          {...common}
          cart={cart}
          quote={quote}
          quoting={quoting}
          quoteError={quoteError}
          config={config}
          fulfillment={fulfillment}
          onFulfillment={setFulfillment}
          onBack={() => go('cart')}
          cartCount={cartCount}
          onPlace={goToPayment}
          placing={placing}
          error={orderError}
          onFixCart={() => go('cart')}
        />
      )}
      {page === 'payment' && quote && (
        <Payment
          {...common}
          quote={quote}
          clientRequestId={requestIdRef.current}
          kioskId={KIOSK_ID}
          onBack={() => go('checkout')}
          onPaid={handlePaid}
          onCancelled={handlePaymentAbandoned}
        />
      )}
      {page === 'success' && order && (
        <Confirmation {...common} order={order} onNew={resetSession} />
      )}
    </>
  );
}

function loadCart() {
  try {
    const stored = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}
