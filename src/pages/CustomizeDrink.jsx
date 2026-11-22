import React, { useState, useEffect, useMemo } from 'react';
import { Check, Plus, AlertCircle } from 'lucide-react';
import { productName, productDescription, formatMinor, formatDeltaMinor, pickLang } from '../config.js';
import TopBar from '../components/TopBar.jsx';
import { defaultSelection, toggleModifier, unmetGroups, unitPriceMinor } from '../lib/modifiers.js';
import Stepper from '../components/Stepper.jsx';

/**
 * Item customisation, driven entirely by the POS's modifier groups.
 *
 * The old screen hardcoded size/milk/syrup/sugar for every product, which meant
 * a croissant was offered a milk choice and an espresso was offered milk it
 * does not take. Groups now come from the POS per product, with its own
 * min/max rules.
 *
 * Validation here is for the customer's benefit only — it stops them reaching
 * checkout with an invalid combination. The server re-validates everything and
 * remains the authority.
 */
export default function CustomizeDrink({
  t, lang, currency, product, onLanguage, onBack, onCart, cartCount, onAdd,
}) {
  const groups = product.modifierGroups ?? [];
  const [chosen, setChosen] = useState(() => defaultSelection(groups));
  const [quantity, setQuantity] = useState(1);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    setChosen(defaultSelection(product.modifierGroups ?? []));
    setQuantity(1);
    setShowErrors(false);
  }, [product.posProductId]);

  const selectedIds = useMemo(() => Object.values(chosen).flat(), [chosen]);

  const selectedModifiers = useMemo(() => {
    const byId = new Map();
    for (const group of groups) for (const m of group.modifiers) byId.set(m.modifierId, m);
    return selectedIds.map((id) => byId.get(id)).filter(Boolean);
  }, [groups, selectedIds]);

  const unitPrice = unitPriceMinor(product, selectedModifiers);
  const canAdd = unmetGroups(chosen, groups).length === 0 && product.available;

  function toggle(group, modifierId) {
    setChosen((old) => toggleModifier(old, group, modifierId));
  }

  function handleAdd() {
    if (!canAdd) {
      setShowErrors(true);
      return;
    }
    onAdd(product, selectedIds, selectedModifiers, quantity, unitPrice);
  }

  const name = productName(product, lang);

  return (
    <div className="inner-screen">
      <TopBar {...{ t, lang, onLanguage, onBack, onCart, cartCount }} section={t.customizeSection} />
      <main className="page-width customize-page">
        <div className="custom-left">
          <div className="large-product-photo">
            {product.imageUrl
              ? <img src={product.imageUrl} alt={name} />
              : <span className="product-photo-fallback large" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>}
          </div>
          <div className="custom-product-intro">
            <div className="eyebrow">✳ {t.yourDrink}</div>
            <h1>{name}</h1>
            <p>{productDescription(product, lang)}</p>
          </div>
        </div>

        <div className="custom-right">
          <h2>{t.customize}</h2>

          {groups.length === 0 && <p className="muted-note">{t.noOptionsNeeded}</p>}

          {groups.map((group) => {
            const current = chosen[group.groupId] ?? [];
            const missing = showErrors && current.length < group.minSelect;
            return (
              <section className={`custom-section ${missing ? 'section-missing' : ''}`} key={group.groupId}>
                <h3>
                  {pickLang(lang, group.nameEn, group.nameAr)}
                  {group.minSelect > 0
                    ? <span className="required-tag">{t.required}</span>
                    : <span className="optional-tag">{t.optional}</span>}
                  {group.maxSelect > 1 && (
                    <span className="optional-tag">{t.chooseUpTo.replace('{n}', group.maxSelect)}</span>
                  )}
                </h3>
                <div className="choice-row">
                  {group.modifiers.map((modifier) => {
                    const isSelected = current.includes(modifier.modifierId);
                    const atLimit = !isSelected && group.maxSelect > 1 && current.length >= group.maxSelect;
                    return (
                      <button
                        key={modifier.modifierId}
                        type="button"
                        disabled={!modifier.available || atLimit}
                        onClick={() => toggle(group, modifier.modifierId)}
                        className={`choice-button ${isSelected ? 'selected' : ''} ${!modifier.available ? 'choice-unavailable' : ''}`}
                      >
                        <span>
                          {pickLang(lang, modifier.nameEn, modifier.nameAr)}
                          {modifier.priceDeltaMinor !== 0 && (
                            <small>{formatDeltaMinor(modifier.priceDeltaMinor, currency, lang)}</small>
                          )}
                          {!modifier.available && <small>{t.unavailable}</small>}
                        </span>
                        {isSelected && <Check size={19} />}
                      </button>
                    );
                  })}
                </div>
                {missing && (
                  <p className="field-error"><AlertCircle size={15} /> {t.pleaseChoose}</p>
                )}
              </section>
            );
          })}

          <div className="order-quantity-row">
            <span>{t.quantity}</span>
            <Stepper value={quantity} onChange={setQuantity} min={1} max={20} />
          </div>

          <button className="primary-button add-button" onClick={handleAdd} disabled={!product.available}>
            <span><Plus size={21} />{t.addToCart}</span>
            <strong>{formatMinor(unitPrice * quantity, currency, lang)}</strong>
          </button>
          <p className="demo-hint">{t.vatIncluded}</p>
        </div>
      </main>
    </div>
  );
}
