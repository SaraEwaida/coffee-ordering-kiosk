import React, { useState, useMemo } from 'react';
import { Coffee, Snowflake, LayoutGrid, Croissant, Cookie, WifiOff, Clock } from 'lucide-react';
import ProductCard from '../components/ProductCard.jsx';
import TopBar from '../components/TopBar.jsx';

/**
 * The menu screen.
 *
 * Categories come from the POS, not a hardcoded list — which is why pastries
 * and snacks appear here without any code change when the shop adds them.
 */
const CATEGORY_ICONS = {
  'CAT-HOT': Coffee,
  'CAT-ICED': Snowflake,
  'CAT-PASTRY': Croissant,
  'CAT-SNACK': Cookie,
};

export default function Menu({
  t, lang, currency, products, categories, onLanguage, onBack, onCart, cartCount,
  onChoose, error, onRetry, stale, offline, ageSeconds,
}) {
  const [active, setActive] = useState('all');

  const tabs = useMemo(() => ([
    { id: 'all', name: t.all, Icon: LayoutGrid },
    ...categories.map((c) => ({
      id: c.id,
      name: lang === 'ar' ? c.nameAr : c.nameEn,
      Icon: CATEGORY_ICONS[c.id] ?? LayoutGrid,
    })),
  ]), [categories, lang, t.all]);

  const listed = products.filter((p) => active === 'all' || p.categoryId === active);

  return (
    <div className="inner-screen">
      <TopBar {...{ t, lang, onLanguage, onBack, onCart, cartCount }} section={t.menuSection} />
      <main className="page-width menu-page">
        <div className="page-heading">
          <div>
            <div className="eyebrow">✳ {t.menu}</div>
            <h1>{t.menuTitle}</h1>
            <p>{t.menuSub}</p>
          </div>
          <div className="heading-art">☕</div>
        </div>

        {/* The customer is told when prices may be out of date, rather than
            being shown stale figures as though they were current. */}
        {offline && (
          <div className="status-banner status-banner-bad">
            <WifiOff size={18} /><span>{t.posOffline}</span>
          </div>
        )}
        {!offline && stale && (
          <div className="status-banner status-banner-warn">
            <Clock size={18} /><span>{t.menuStale}</span>
          </div>
        )}

        <div className="category-tabs" role="tablist" aria-label={t.menu}>
          {tabs.map(({ id, name, Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={active === id}
              className={active === id ? 'active' : ''}
              onClick={() => setActive(id)}
            >
              <Icon size={20} />{name}
            </button>
          ))}
        </div>

        {error && products.length === 0 ? (
          <div className="error-card">
            <p>{t.loadError}</p>
            <button className="outline-button" onClick={onRetry}>{t.retry}</button>
          </div>
        ) : products.length === 0 ? (
          <p className="empty-loading">{t.loading}</p>
        ) : listed.length === 0 ? (
          <p className="empty-loading">{t.noItemsInCategory}</p>
        ) : (
          <div className="products-grid">
            {listed.map((p) => (
              <ProductCard
                key={p.posProductId}
                product={p}
                lang={lang}
                t={t}
                currency={currency}
                onClick={onChoose}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
