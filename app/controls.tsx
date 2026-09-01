'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'

/**
 * Dropdowns för omgång och systemstorlek. Navigerar via query-parametrar så
 * att servern räknar om — ingen logik dupliceras i klienten.
 */
export function Controls({
  products,
  draws,
  sizes,
  currentProduct,
  currentDraw,
  currentRows,
}: {
  products: { value: string; label: string }[]
  draws: { drawNumber: number; label: string }[]
  sizes: number[]
  currentProduct: string
  currentDraw: number
  currentRows: number
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  const go = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString())
    next.set(key, value)
    // Byte av produkt måste nolla omgångsvalet — omgångsnumren är olika
    // serier (Stryktipset ~4969, Europatipset ~2604), så ett kvarhängande
    // draw-värde ger ingen träff.
    if (key === 'produkt') next.delete('draw')
    startTransition(() => router.push(`/?${next.toString()}`))
  }

  return (
    <div className="controls" style={{ opacity: pending ? 0.6 : 1 }}>
      <label className="field">
        Spel
        <select
          value={currentProduct}
          onChange={(e) => go('produkt', e.target.value)}
          disabled={pending}
        >
          {products.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Omgång
        <select
          value={currentDraw}
          onChange={(e) => go('draw', e.target.value)}
          disabled={pending}
        >
          {draws.map((d) => (
            <option key={d.drawNumber} value={d.drawNumber}>
              {d.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Systemstorlek
        <select
          value={currentRows}
          onChange={(e) => go('rader', e.target.value)}
          disabled={pending}
        >
          {sizes.map((n) => (
            <option key={n} value={n}>
              {n} rader — {n} kr
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
